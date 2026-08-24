'use strict';

const { OndiloAuthError, OndiloQuotaError } = require('./api');

const MEASURE_TYPES = ['temperature', 'ph', 'orp', 'salt', 'tds', 'battery', 'rssi'];
const THRESHOLD_TYPES = ['temperature', 'ph', 'orp', 'salt', 'tds'];

const LUX_MIN = 0.0001;
const LUX_MAX = 100000;
const ORP_FULL_SCALE_MV = 1200;
const METADATA_TTL_MS = 24 * 3600 * 1000;
const METADATA_RETRY_MS = 3600 * 1000;
const FALLBACK_MAX_PER_CYCLE = 2;
// Tolérance d'horloge. Au-delà, un horodatage dans le futur ne vient pas d'un décalage NTP mais
// d'une donnée corrompue : sans cette borne, une mesure datée de 2035 resterait « fraîche » des
// années durant.
const CLOCK_SKEW_MS = 300000;

// Plages physiquement possibles par grandeur. Une valeur au-delà n'est pas à écrêter — l'écrêter
// reviendrait à inventer une mesure — mais à refuser comme la sonde le ferait elle-même.
const PHYSICAL_RANGE = {
  temperature: [-30, 80],
  ph: [0, 14],
  orp: [-2000, 2000],
  salt: [0, 100000],
  tds: [0, 50000],
  battery: [0, 100],
  rssi: [0, 100],
};

function isPhysicallyPossible(type, value) {
  const range = PHYSICAL_RANGE[type];
  if (!range) return true;
  return value >= range[0] && value <= range[1];
}

const LABELS = {
  temperature: 'Température',
  ph: 'pH',
  orp: 'ORP',
  salt: 'Salinité',
  tds: 'TDS',
  battery: 'Batterie',
  rssi: 'Signal radio',
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// HAP refuse un nom qui ne commence ni ne finit par un caractère alphanumérique, et
// n'accepte qu'un jeu restreint de séparateurs. Un nom de bassin saisi dans l'app Ondilo
// peut contenir n'importe quoi.
function sanitizeName(raw, fallback) {
  const cleaned = String(raw ?? '')
    .replace(/[^\p{L}\p{N} '.,-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
    .trim();
  return cleaned.length ? cleaned : fallback;
}

function displayNameForPool(pool) {
  // Le nom du bassin est assaini seul : préfixer d'abord par « ICO » rendrait le résultat non
  // vide même pour un nom illisible, et tous les bassins sans nom s'appelleraient « ICO ».
  const name = sanitizeName(pool?.name, '');
  return name ? `ICO ${name}` : sanitizeName(`ICO ${pool?.id}`, 'ICO');
}

function serviceSupports(service, Ctor) {
  if (!Ctor) return false;
  return service.testCharacteristic(Ctor)
    || service.optionalCharacteristics.some(c => c.UUID === Ctor.UUID);
}

/** Marque toutes les tuiles du plugin comme non fiables, sans effacer la dernière valeur connue. */
function markServicesUnavailable(hap, accessory) {
  const C = hap.Characteristic;
  for (const service of accessory.services) {
    if (!service.subtype || !service.subtype.startsWith('ondilo:')) continue;
    if (serviceSupports(service, C.StatusActive)) service.updateCharacteristic(C.StatusActive, false);
    if (serviceSupports(service, C.StatusFault)) {
      service.updateCharacteristic(C.StatusFault, C.StatusFault.GENERAL_FAULT);
    }
    if (service.UUID === hap.Service.AirQualitySensor.UUID) {
      service.updateCharacteristic(C.AirQuality, C.AirQuality.UNKNOWN);
    }
  }
}

/** Nombre fini, ou null. Contrairement à Number(), refuse null, '' et les booléens. */
function toFiniteNumber(raw) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function measureTime(measure) {
  const parsed = Date.parse(measure?.value_time ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

class PoolAccessory {
  constructor(platform, accessory, pool) {
    this.platform = platform;
    this.log = platform.log;
    this.accessory = accessory;
    this.pool = pool;
    this.hap = platform.api.hap;
    this.Service = this.hap.Service;
    this.Characteristic = this.hap.Characteristic;

    this.thresholds = {};
    this.device = null;
    this.deviceFetchedAt = 0;
    this.configFetchedAt = 0;
    this._fallbackCursor = 0;
    this._pendingRecommendation = null;
    this._ackWired = false;
    this._unsupportedWarned = new Set();
  }

  get poolId() {
    return this.pool.id;
  }

  _saltInGramsPerLiter() {
    return this.platform.units?.salt === 'GRAM_PER_LITER';
  }

  get expectedName() {
    return displayNameForPool(this.pool);
  }

  /** Types réellement interrogeables sur ce bassin : salt et tds s'excluent mutuellement. */
  effectiveMeasures() {
    const primary = this.pool?.disinfection?.primary;
    const out = [];
    if (!primary && this.platform.measures.some(type => type === 'salt' || type === 'tds')) {
      this._warnOnce(
        'disinfection',
        'Ondilo ne déclare pas le mode de désinfection de ce bassin. La salinité et le TDS ' +
        'demandés sont donc interrogés tels quels ; celui que la sonde ne mesure pas restera en défaut',
      );
    }
    for (const type of this.platform.measures) {
      if (primary === 'salt' && type === 'tds') {
        this._warnOnce(type, `Mesure « ${LABELS[type]} » demandée mais ignorée : ce bassin est `
          + 'déclaré au sel côté Ondilo, le TDS n\'y est pas mesuré');
        continue;
      }
      if (primary && primary !== 'salt' && type === 'salt') {
        this._warnOnce(type, `Mesure « ${LABELS[type]} » demandée mais ignorée : ce bassin est déclaré `
          + `en désinfection « ${primary} », la salinité n'y est pas mesurée`);
        continue;
      }
      out.push(type);
    }
    return out;
  }

  _warnOnce(key, message) {
    if (this._unsupportedWarned.has(key)) return;
    this._unsupportedWarned.add(key);
    this.log.warn(`[OndiloICO] ${message}.`);
  }

  /** Sous-types attendus par la configuration courante, et le type de service de chacun. */
  servicePlan() {
    const S = this.Service;
    const plan = new Map();
    const measures = this.effectiveMeasures();
    const has = type => measures.includes(type);

    if (has('temperature')) plan.set('ondilo:temperature', { ctor: S.TemperatureSensor, name: 'Température eau' });
    if (has('ph')) {
      plan.set('ondilo:ph', {
        ctor: this.platform.phServiceType === 'humidity' ? S.HumiditySensor : S.LightSensor,
        name: 'pH',
      });
    }
    if (has('orp')) {
      plan.set('ondilo:orp', {
        ctor: this.platform.orpServiceType === 'humidity' ? S.HumiditySensor : S.LightSensor,
        name: 'ORP',
      });
    }
    if (has('salt')) plan.set('ondilo:salt', { ctor: S.LightSensor, name: 'Salinité' });
    if (has('tds')) plan.set('ondilo:tds', { ctor: S.LightSensor, name: 'TDS' });
    if (has('battery') && this.platform.BatteryServiceCtor) {
      plan.set('ondilo:battery', { ctor: this.platform.BatteryServiceCtor, name: 'Batterie ICO' });
    }
    if (has('rssi')) plan.set('ondilo:rssi', { ctor: S.LightSensor, name: 'Signal radio' });

    // Sans une seule mesure susceptible d'avoir des seuils, la tuile resterait « Inconnu » à vie.
    if (this.platform.waterQuality && THRESHOLD_TYPES.some(has)) {
      plan.set('ondilo:quality', { ctor: S.AirQualitySensor, name: "Qualité de l'eau" });
    }
    if (this.platform.outOfRangeSensors) {
      for (const type of THRESHOLD_TYPES) {
        if (has(type)) {
          plan.set(`ondilo:range:${type}`, { ctor: S.ContactSensor, name: `${LABELS[type]} hors plage` });
        }
      }
    }
    if (this.platform.recommendations) {
      plan.set('ondilo:recommendations', { ctor: S.ContactSensor, name: 'Recommandation Ondilo' });
      if (this.platform.allowRecommendationValidation) {
        plan.set('ondilo:recommendation-ack', { ctor: S.Switch, name: 'Recommandation traitée' });
      }
    }
    return plan;
  }

  /** @returns {boolean} vrai si la liste des services a changé et doit être réécrite au cache. */
  syncServices() {
    const plan = this.servicePlan();
    let changed = false;

    for (const [subtype, spec] of plan) {
      // Chaque service est isolé : une tuile qui refuse d'être créée ne doit pas priver
      // l'utilisateur de la température et de la batterie, ni faire échouer tout l'accessoire.
      try {
        let service = this.accessory.getServiceById(spec.ctor, subtype);
        if (!service) {
          service = this.accessory.addService(spec.ctor, spec.name, subtype);
          changed = true;
          this.log.info(`[OndiloICO] Service ajouté : ${spec.name} (${subtype}).`);
        }
        this._prepareService(subtype, service);
      } catch (err) {
        this.log.error(
          `[OndiloICO] Service « ${spec.name} » (${subtype}) indisponible : ${err?.message || err}. ` +
          'Les autres tuiles de ce bassin restent actives.',
        );
      }
    }

    // Réconciliation : tout service ondilo:* qui n'est plus au plan disparaît, y compris
    // le cas d'un même sous-type porté par un autre type de service (bascule light → humidity).
    for (const service of [...this.accessory.services]) {
      const subtype = service.subtype;
      if (!subtype || !subtype.startsWith('ondilo:')) continue;
      const spec = plan.get(subtype);
      if (spec && spec.ctor.UUID === service.UUID) continue;
      this.accessory.removeService(service);
      changed = true;
      this.log.info(`[OndiloICO] Service retiré : ${service.displayName || subtype}.`);
    }

    this._syncIdentity();
    return changed;
  }

  _prepareService(subtype, service) {
    const C = this.Characteristic;
    const custom = this.platform.customCharacteristics;

    if (subtype === 'ondilo:temperature') {
      // La plage HAP par défaut démarre à 0 °C : une eau qui gèle serait écrêtée en silence.
      service.getCharacteristic(C.CurrentTemperature).setProps({ minValue: -50, maxValue: 100 });
    }
    if (subtype === 'ondilo:ph' && this.platform.phServiceType !== 'humidity') {
      this._registerOptional(service, custom.WaterPh);
    }
    if (subtype === 'ondilo:orp' && this.platform.orpServiceType !== 'humidity') {
      this._registerOptional(service, custom.WaterOrp);
    }
    if (subtype === 'ondilo:salt') {
      this._registerOptional(service, custom.WaterSalinity);
      if (this._saltInGramsPerLiter()) {
        service.getCharacteristic(custom.WaterSalinity)
          .setProps({ unit: 'g/L', minValue: 0, maxValue: 20, minStep: 0.01 });
      }
    }
    if (subtype === 'ondilo:tds') this._registerOptional(service, custom.WaterTds);

    if (subtype === 'ondilo:recommendation-ack' && !this._ackWired) {
      this._ackWired = true;
      service.getCharacteristic(C.On).onSet(value => this._onAckSet(service, value));
    }
  }

  _registerOptional(service, Ctor) {
    if (!Ctor) return;
    if (service.testCharacteristic(Ctor)) return;
    if (!service.optionalCharacteristics.some(c => c.UUID === Ctor.UUID)) {
      service.addOptionalCharacteristic(Ctor);
    }
    service.getCharacteristic(Ctor);
  }

  _supports(service, Ctor) {
    return serviceSupports(service, Ctor);
  }

  _setStatus(service, { active, fault }) {
    const C = this.Characteristic;
    if (this._supports(service, C.StatusActive)) service.updateCharacteristic(C.StatusActive, active);
    if (this._supports(service, C.StatusFault)) {
      service.updateCharacteristic(
        C.StatusFault,
        fault ? C.StatusFault.GENERAL_FAULT : C.StatusFault.NO_FAULT,
      );
    }
  }

  _syncIdentity() {
    const C = this.Characteristic;
    const info = this.accessory.getService(this.Service.AccessoryInformation);
    if (!info) return;

    // En grouped, tant que /device n'a pas répondu, on ne réécrit pas le numéro de série : un
    // redémarrage hors réseau remplacerait celui de la sonde par l'identifiant du bassin.
    if (this.platform.layout === 'grouped' && !this.device?.serial_number
        && info.getCharacteristic(C.SerialNumber).value) {
      this._syncName(info);
      return;
    }
    const raw = this.platform.layout === 'grouped' && this.device?.serial_number
      ? String(this.device.serial_number)
      : String(this.poolId);
    // HAP ignore un numéro de série d'un seul caractère : l'accessoire publierait
    // « Default-SerialNumber » et HomeKit peut le refuser.
    const serial = raw.length >= 2 ? raw : `ICO-${raw}`;

    info.updateCharacteristic(C.Manufacturer, 'Ondilo');
    info.updateCharacteristic(C.Model, 'ICO');
    info.updateCharacteristic(C.SerialNumber, serial);
    if (this.device?.sw_version) {
      info.updateCharacteristic(C.FirmwareRevision, String(this.device.sw_version));
    }

    this._syncName(info);
  }

  _syncName(info) {
    const C = this.Characteristic;
    const expected = this.expectedName;
    if (this.accessory.displayName === expected) return;

    // updateDisplayName n'existe qu'à partir de Homebridge 1.9 ; le paquet accepte 1.8.
    if (typeof this.accessory.updateDisplayName !== 'function') {
      if (!this._renameUnsupportedWarned) {
        this._renameUnsupportedWarned = true;
        this.log.warn(
          `[OndiloICO] Le bassin s'appelle désormais « ${expected} » mais cette version de Homebridge ne sait pas ` +
          'renommer un accessoire (fonction ajoutée en 1.9). Renomme-le dans l\'app Maison, ou mets Homebridge à jour.',
        );
      }
      return;
    }

    this.log.info(`[OndiloICO] Renommage de l'accessoire : « ${this.accessory.displayName} » → « ${expected} ».`);
    this.accessory.updateDisplayName(expected);
    info.updateCharacteristic(C.Name, expected);
    this.platform.api.updatePlatformAccessories([this.accessory]);
  }

  markUnavailable() {
    markServicesUnavailable(this.hap, this.accessory);
    // La seule écriture du plugin est irréversible : elle ne doit jamais partir sur un état
    // que le dernier cycle n'a pas confirmé.
    this._forgetRecommendation();
  }

  _forgetRecommendation() {
    this._pendingRecommendation = null;
    const ack = this._serviceFor('ondilo:recommendation-ack', this.Service.Switch);
    if (ack) ack.updateCharacteristic(this.Characteristic.On, false);
  }

  async refresh() {
    await this._refreshMetadata();
    const { byType, invalid, reachable } = await this._collectMeasures();
    if (!reachable) {
      this.markUnavailable();
      return null;
    }
    this._render(byType, invalid);
    if (this.platform.recommendations) await this._refreshRecommendations();
    return this._freshestTimestamp(byType);
  }

  _freshestTimestamp(byType) {
    let newest = null;
    for (const measure of byType.values()) {
      const time = measureTime(measure);
      if (time !== null && (newest === null || time > newest)) newest = time;
    }
    return newest;
  }

  /**
   * /device et /configuration ne bougent quasiment jamais : une fois par jour suffit, et le quota
   * horaire ne supporterait pas un appel par cycle. Les deux échéances sont suivies séparément,
   * sinon la réussite de l'une gèlerait l'échec de l'autre pendant vingt-quatre heures.
   */
  async _refreshMetadata() {
    const now = Date.now();

    if (now - this.deviceFetchedAt >= METADATA_TTL_MS) {
      try {
        this.device = await this.platform.client.getDevice(this.poolId);
        this.deviceFetchedAt = Date.now();
        this._syncIdentity();
      } catch (err) {
        this._logApiError('/device', err);
        this.deviceFetchedAt = this._retryStamp();
        // Insister après un refus d'authentification ferait recommencer à chaque endpoint son
        // propre cycle 401-renouvellement-401 et viderait le quota horaire en un seul tour.
        if (err instanceof OndiloAuthError) throw err;
      }
    }

    if (now - this.configFetchedAt >= METADATA_TTL_MS) {
      try {
        const config = await this.platform.client.getConfiguration(this.poolId);
        this.thresholds = this._parseThresholds(config);
        this.configFetchedAt = Date.now();
      } catch (err) {
        this._logApiError('/configuration', err);
        this.configFetchedAt = this._retryStamp();
        if (err instanceof OndiloAuthError) throw err;
      }
    }
  }

  /** Échéance reculée d'une heure au lieu du cycle suivant : un endpoint en panne ne doit pas
   *  consommer le quota à chaque tick. */
  _retryStamp() {
    return Date.now() - METADATA_TTL_MS + METADATA_RETRY_MS;
  }

  _parseThresholds(config) {
    const out = {};
    if (!config || typeof config !== 'object') return out;
    for (const type of THRESHOLD_TYPES) {
      // Number(null) et Number('') valent 0 : sans ce filtre, un seuil bas non réglé devient une
      // limite basse à zéro et la qualité de l'eau annonce « Excellent » sur une plage inventée.
      const low = toFiniteNumber(config[`${type}_low`]);
      const high = toFiniteNumber(config[`${type}_high`]);
      if (low !== null && high !== null && high > low) out[type] = { low, high };
    }
    return out;
  }

  async _collectMeasures() {
    const wanted = this.effectiveMeasures();
    const byType = new Map();
    const invalid = new Map();

    let last;
    let liveFailed = false;
    try {
      last = await this.platform.client.getLastMeasures(this.poolId, wanted);
    } catch (err) {
      this._logApiError('/lastmeasures', err);
      if (err instanceof OndiloAuthError) throw err;
      liveFailed = true;
    }

    if (Array.isArray(last)) {
      // La mesure la plus récente est retenue d'abord, son état est appliqué ensuite. L'ordre
      // inverse laissait une invalidation récente se faire remplacer par une ancienne valeur
      // saine, republiée comme fraîche.
      const latest = new Map();
      for (const measure of last) {
        const type = measure?.data_type || measure?.type;
        if (!type || !wanted.includes(type)) continue;
        const previous = latest.get(type);
        if (!previous || (measureTime(measure) ?? 0) >= (measureTime(previous) ?? 0)) {
          latest.set(type, measure);
        }
      }
      for (const [type, measure] of latest) {
        if (measure.is_valid === false) {
          invalid.set(type, measure);
          continue;
        }
        if (typeof measure.value !== 'number' || !Number.isFinite(measure.value)) continue;
        if (!isPhysicallyPossible(type, measure.value)) {
          // Écrêter reviendrait à inventer une mesure : un pH de 99 deviendrait un pH de 14
          // parfaitement crédible dans l'app Maison.
          this.platform.diag(
            `[OndiloICO] Mesure « ${LABELS[type] || type} » hors de toute plage physique ` +
            `(${measure.value}) : valeur refusée.`,
          );
          invalid.set(type, measure);
          continue;
        }
        byType.set(type, measure);
      }
    } else {
      this.log.warn('[OndiloICO] /lastmeasures a répondu autre chose qu\'un tableau ; réponse ignorée.');
    }

    if (this.platform.useMeasuresFallback) {
      await this._fillFromHistory(wanted, byType, invalid);
    }
    // F-18 : une panne de /lastmeasures ne condamne le bassin que si le repli n'a rien donné non
    // plus. La 0.5.1 récupérait dans ce cas, la 1.0.0 ne doit pas faire moins.
    return { byType, invalid, reachable: !liveFailed || byType.size > 0 };
  }

  /** Repli borné : au plus deux types par cycle, en tourniquet, pour tenir le quota. */
  async _fillFromHistory(wanted, byType, invalid) {
    const missing = wanted.filter(type => !byType.has(type) && !invalid.has(type));
    if (!missing.length) return;
    this._fallbackCursor %= missing.length;
    const picked = [];
    for (let i = 0; i < Math.min(FALLBACK_MAX_PER_CYCLE, missing.length); i++) {
      picked.push(missing[(this._fallbackCursor + i) % missing.length]);
    }
    this._fallbackCursor += picked.length;

    for (const type of picked) {
      try {
        const history = await this.platform.client.getMeasuresSet(this.poolId, type, 'day');
        const best = this._pickFreshestValid(history, type);
        if (best) byType.set(type, best);
      } catch (err) {
        this._logApiError(`/measures (${type})`, err);
        if (err instanceof OndiloQuotaError) return;
        if (err instanceof OndiloAuthError) throw err;
      }
    }
  }

  _pickFreshestValid(list, type) {
    if (!Array.isArray(list)) return null;
    let best = null;
    for (const item of list) {
      if (typeof item?.value !== 'number' || !Number.isFinite(item.value)) continue;
      if (item.is_valid === false) continue;
      if (!isPhysicallyPossible(type, item.value)) continue;
      if (!best || (measureTime(item) ?? 0) >= (measureTime(best) ?? 0)) best = item;
    }
    return best;
  }

  /** Sans horodatage exploitable, la fraîcheur ne peut pas être affirmée : la mesure est suspecte. */
  _isStale(measure) {
    const time = measureTime(measure);
    if (time === null) return true;
    const age = Date.now() - time;
    if (age < -CLOCK_SKEW_MS) return true;
    return age > this.platform.staleAfterMs;
  }

  _render(byType, invalid) {
    const C = this.Characteristic;
    const measures = this.effectiveMeasures();
    const outOfRange = new Set();
    const fresh = new Set();
    let considered = 0;
    let evaluable = 0;

    for (const type of measures) {
      const subtype = `ondilo:${type}`;
      const service = this._serviceFor(subtype);
      if (!service) continue;
      if (this.thresholds[type]) evaluable++;

      const measure = byType.get(type);
      if (!measure) {
        const reason = invalid.get(type)?.exclusion_reason;
        if (invalid.has(type)) {
          this.platform.diag(
            `[OndiloICO] Mesure « ${LABELS[type] || type} » déclarée invalide par Ondilo` +
            `${reason ? ` (${reason})` : ''} : valeur non publiée.`,
          );
        }
        this._setStatus(service, { active: false, fault: true });
        continue;
      }

      const stale = this._isStale(measure);
      if (!stale) fresh.add(type);
      this._writeValue(type, service, measure.value);
      this._setStatus(service, { active: !stale, fault: stale });

      const range = this.thresholds[type];
      if (range && !stale) {
        considered++;
        if (measure.value < range.low || measure.value > range.high) outOfRange.add(type);
      }
      if (stale) {
        this.platform.diag(
          `[OndiloICO] Mesure « ${LABELS[type] || type} » écartée du bilan : ` +
          `${measure.value_time ? `horodatage ${measure.value_time} suspect` : 'aucun horodatage'}.`,
        );
      }
    }

    if (this.platform.outOfRangeSensors) {
      for (const type of THRESHOLD_TYPES) {
        const service = this._serviceFor(`ondilo:range:${type}`, this.Service.ContactSensor);
        if (!service) continue;
        const known = Boolean(this.thresholds[type]) && fresh.has(type);
        service.updateCharacteristic(
          C.ContactSensorState,
          outOfRange.has(type) ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED,
        );
        this._setStatus(service, { active: known, fault: !known });
      }
    }

    const quality = this._serviceFor('ondilo:quality', this.Service.AirQualitySensor);
    if (quality) {
      // « Excellent » est une affirmation sur la baignade : elle exige que toutes les mesures
      // dotées d'un seuil aient été relevées et soient fraîches. Un dépassement constaté reste
      // signalé même sur données partielles — l'incertitude ne doit jamais masquer un problème.
      const complete = evaluable > 0 && considered === evaluable;
      let level = C.AirQuality.UNKNOWN;
      if (outOfRange.size >= 2) level = C.AirQuality.POOR;
      else if (outOfRange.size === 1) level = C.AirQuality.FAIR;
      else if (complete) level = C.AirQuality.EXCELLENT;
      quality.updateCharacteristic(C.AirQuality, level);
      this._setStatus(quality, { active: complete, fault: !complete });
    }
  }

  _serviceFor(subtype, ctor) {
    if (ctor) return this.accessory.getServiceById(ctor, subtype);
    for (const service of this.accessory.services) {
      if (service.subtype === subtype) return service;
    }
    return null;
  }

  _writeValue(type, service, raw) {
    const C = this.Characteristic;
    const custom = this.platform.customCharacteristics;

    switch (type) {
      case 'temperature':
        service.updateCharacteristic(C.CurrentTemperature, round(clamp(raw, -50, 100), 2));
        break;

      case 'ph': {
        const ph = clamp(raw, 0, 14);
        if (this.platform.phServiceType === 'humidity') {
          service.updateCharacteristic(C.CurrentRelativeHumidity, round(clamp((ph / 14) * 100, 0, 100), 1));
        } else {
          // L'app Maison arrondit les lux à l'entier : sans facteur d'échelle, toute la plage
          // utile du pH (6,8 à 8,2) s'écrase sur deux valeurs affichables.
          const lux = clamp(ph * this.platform.phLuxScale, LUX_MIN, LUX_MAX);
          service.updateCharacteristic(C.CurrentAmbientLightLevel, round(lux, 4));
          service.updateCharacteristic(custom.WaterPh, round(ph, 2));
        }
        break;
      }

      case 'orp': {
        const mv = Math.max(0, raw);
        if (this.platform.orpServiceType === 'humidity') {
          service.updateCharacteristic(
            C.CurrentRelativeHumidity,
            round(clamp((mv / ORP_FULL_SCALE_MV) * 100, 0, 100), 1),
          );
        } else {
          service.updateCharacteristic(C.CurrentAmbientLightLevel, clamp(round(mv, 2), LUX_MIN, LUX_MAX));
          service.updateCharacteristic(custom.WaterOrp, clamp(round(mv, 1), 0, 2000));
        }
        break;
      }

      case 'salt': {
        const mgl = Math.max(0, raw);
        service.updateCharacteristic(C.CurrentAmbientLightLevel, clamp(round(mgl, 2), LUX_MIN, LUX_MAX));
        service.updateCharacteristic(
          custom.WaterSalinity,
          this._saltInGramsPerLiter()
            ? clamp(round(mgl / 1000, 2), 0, 20)
            : clamp(round(mgl, 1), 0, 20000),
        );
        break;
      }

      case 'tds': {
        const ppm = Math.max(0, raw);
        service.updateCharacteristic(C.CurrentAmbientLightLevel, clamp(round(ppm, 2), LUX_MIN, LUX_MAX));
        service.updateCharacteristic(custom.WaterTds, clamp(round(ppm, 1), 0, 10000));
        break;
      }

      case 'battery': {
        const pct = Math.round(clamp(raw, 0, 100));
        service.updateCharacteristic(C.BatteryLevel, pct);
        service.updateCharacteristic(
          C.StatusLowBattery,
          pct <= 20 ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL,
        );
        service.updateCharacteristic(C.ChargingState, C.ChargingState.NOT_CHARGING);
        break;
      }

      case 'rssi':
        service.updateCharacteristic(C.CurrentAmbientLightLevel, clamp(round(raw, 2), LUX_MIN, LUX_MAX));
        break;

      default:
        break;
    }
  }

  async _refreshRecommendations() {
    const C = this.Characteristic;
    const contact = this._serviceFor('ondilo:recommendations', this.Service.ContactSensor);
    const ack = this._serviceFor('ondilo:recommendation-ack', this.Service.Switch);

    let list;
    try {
      list = await this.platform.client.getRecommendations(this.poolId);
    } catch (err) {
      this._logApiError('/recommendations', err);
      if (contact) this._setStatus(contact, { active: false, fault: true });
      this._forgetRecommendation();
      if (err instanceof OndiloAuthError) throw err;
      return;
    }

    if (!Array.isArray(list)) {
      // Sans cette garde, une réponse d'erreur se lirait « aucune recommandation en attente ».
      this.log.warn('[OndiloICO] /recommendations a répondu autre chose qu\'un tableau ; réponse ignorée.');
      if (contact) this._setStatus(contact, { active: false, fault: true });
      this._forgetRecommendation();
      return;
    }

    const pending = list
      .filter(item => item && (item.status === undefined || String(item.status).toLowerCase() === 'waiting'))
      .sort((a, b) => (Date.parse(a.deadline ?? '') || Infinity) - (Date.parse(b.deadline ?? '') || Infinity));

    const previousId = this._pendingRecommendation && this._pendingRecommendation.id;
    this._pendingRecommendation = pending[0] || null;
    if (this._pendingRecommendation && this._pendingRecommendation.id !== previousId) {
      this.log.info(
        `[OndiloICO] Recommandation Ondilo en attente : ` +
        `« ${this._pendingRecommendation.title || this._pendingRecommendation.id} ».`,
      );
    }

    if (contact) {
      contact.updateCharacteristic(
        C.ContactSensorState,
        pending.length ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED,
      );
      // Pas de ConfiguredName ici : HAP ne le propose pas sur un ContactSensor, et l'y ajouter
      // écraserait à chaque cycle le nom que l'utilisateur a donné à la tuile dans l'app Maison.
      // Le titre de la recommandation part dans le journal, juste au-dessus.
      this._setStatus(contact, { active: true, fault: false });
    }
    if (ack) ack.updateCharacteristic(C.On, pending.length > 0);
  }

  /**
   * Réaligne l'interrupteur après coup. Le rappel d'un `setTimeout` est hors de toute pile qu'un
   * appelant pourrait rattraper : une exception y ferait tomber le processus Homebridge entier,
   * avec tous les autres plugins de l'utilisateur. `unref` évite en prime de retenir l'arrêt.
   */
  _restoreAckLater(service, value) {
    setTimeout(() => {
      try {
        service.updateCharacteristic(this.Characteristic.On, value);
      } catch (err) {
        this.log.warn(`[OndiloICO] Interrupteur de recommandation non réaligné : ${err?.message || err}`);
      }
    }, 300).unref();
  }

  async _onAckSet(service, value) {
    if (value) {
      // L'interrupteur reflète l'existence d'une recommandation : on ne peut pas en créer une.
      if (!this._pendingRecommendation) this._restoreAckLater(service, false);
      return;
    }
    const recommendation = this._pendingRecommendation;
    if (!recommendation?.id) return;

    // La recommandation est consommée AVANT l'attente : HomeKit rejoue volontiers une commande
    // dont la réponse tarde, et deux PUT partiraient pour le même identifiant.
    this._pendingRecommendation = null;
    try {
      await this.platform.client.validateRecommendation(this.poolId, recommendation.id);
      this.log.info(`[OndiloICO] Recommandation « ${recommendation.title || recommendation.id} » marquée comme traitée.`);
      // Le capteur de contact reflète la même chose que l'interrupteur : le laisser ouvert
      // jusqu'au prochain cycle horaire ferait croire à un échec.
      const contact = this._serviceFor('ondilo:recommendations', this.Service.ContactSensor);
      if (contact) {
        contact.updateCharacteristic(
          this.Characteristic.ContactSensorState,
          this.Characteristic.ContactSensorState.CONTACT_DETECTED,
        );
      }
    } catch (err) {
      this._pendingRecommendation = recommendation;
      this._logApiError('PUT /recommendations', err);
      this._restoreAckLater(service, true);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  _logApiError(label, err) {
    if (err && typeof err === 'object') err.__ondiloLogged = true;
    // Une requête annulée par notre propre arrêt est attendue : elle n'a pas à salir le journal
    // à chaque redémarrage de Homebridge.
    if (err?.code === 'ERR_CANCELED') {
      this.platform.diag(`[OndiloICO] ${label} annulé par l'arrêt du plugin.`);
      return;
    }
    if (err instanceof OndiloAuthError) {
      this.log.error(`[OndiloICO] Authentification refusée : ${err.message}`);
      return;
    }
    if (err instanceof OndiloQuotaError) {
      this.log.warn(`[OndiloICO] ${err.message}`);
      return;
    }
    const status = err?.response?.status;
    const detail = typeof status === 'number' ? `HTTP ${status}` : (err?.code || err?.message || String(err));
    this.log.warn(`[OndiloICO] Échec ${label} : ${detail}`);
  }
}

module.exports = {
  PoolAccessory,
  MEASURE_TYPES,
  THRESHOLD_TYPES,
  LABELS,
  sanitizeName,
  displayNameForPool,
  markServicesUnavailable,
};
