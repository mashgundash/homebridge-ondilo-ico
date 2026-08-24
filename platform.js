'use strict';

const { OndiloApi, OndiloAuthError } = require('./api');
const { PoolAccessory, MEASURE_TYPES, displayNameForPool, markServicesUnavailable } = require('./pool-accessory');
const { createCustomCharacteristics } = require('./characteristics');

const PLUGIN_NAME = 'homebridge-ondilo-ico';
const PLATFORM_NAME = 'OndiloICO';
const VERSION = require('./package.json').version;

const DEFAULT_MEASURES = ['temperature', 'ph', 'orp', 'battery'];
const DEFAULT_UPDATE_INTERVAL_S = 3600;
const MIN_UPDATE_INTERVAL_S = 1800;
const MAX_UPDATE_INTERVAL_S = 21600;
const DEFAULT_PH_LUX_SCALE = 100;
const MIN_PH_LUX_SCALE = 1;
// 14 (pH maximal) x 1000 = 14 000 lx, très en dessous du plafond HAP de 100 000 lx.
const MAX_PH_LUX_SCALE = 1000;

// L'ICO ne produit une mesure qu'une fois par heure : on vise le relevé suivant avec cinq
// minutes de marge plutôt que de sonder à l'aveugle.
const MEASURE_PERIOD_MS = 3900000;
// Plancher de l'alignement : assez court pour rattraper un relevé imminent, assez long pour
// qu'aucune suite de cycles ne se transforme en boucle serrée.
const ALIGNED_FLOOR_MS = 300000;
const DISCOVERY_BACKOFF_S = [30, 60, 120, 300];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

class OndiloIcoPlatform {
  constructor(log, config, api) {
    // Rien avant ces trois lignes : configureAccessory peut être appelé dès la fin du
    // constructeur, y compris quand la configuration est incomplète.
    this.accessories = new Map();
    this.poolAccessories = new Map();
    this.log = log;

    this.config = config || {};
    this.api = api;
    this.BatteryServiceCtor = api.hap.Service.Battery || api.hap.Service.BatteryService || null;
    this.customCharacteristics = createCustomCharacteristics(api.hap);

    this.stopped = false;
    this.discovered = false;
    this.discoveryFailures = 0;
    this.ticking = false;
    this.pollTimer = null;
    this.units = null;
    this.unitsFetched = false;
    this.missingPoolReported = false;
    this.untargetedReported = new Set();

    this._readConfig();

    this.api.on('shutdown', () => this._stop());

    if (!this.refreshToken) {
      this.log.error(
        '[OndiloICO] Aucun refresh token : le plugin ne démarrera pas. Lance « npm run oauth » dans le ' +
        'dossier du plugin pour en obtenir un, puis colle-le dans le champ « Refresh token » des réglages.',
      );
      this.api.on('didFinishLaunching', () => {
        try {
          this._reportUnconfigured();
        } catch (err) {
          this.log.error(`[OndiloICO] Signalement des accessoires non configurés en échec : ${err?.message || err}`);
        }
      });
      return;
    }

    this.client = new OndiloApi(this._apiLogger(), this.refreshToken);
    this.api.on('didFinishLaunching', () => {
      try {
        this._start();
      } catch (err) {
        this.log.error(`[OndiloICO] Démarrage impossible : ${err?.message || err}`);
      }
    });
  }

  _readConfig() {
    const config = this.config;

    this.name = typeof config.name === 'string' && config.name.trim() ? config.name.trim() : 'Ondilo ICO';
    this.refreshToken = typeof config.refreshToken === 'string' ? config.refreshToken.trim() : '';
    this.layout = config.layout === 'grouped' ? 'grouped' : 'legacy';
    this.poolIds = this._normalizePoolIds(config.poolId);
    this.measures = this._normalizeMeasures(config.measures);
    this.phServiceType = config.phService === 'humidity' ? 'humidity' : 'light';
    this.orpServiceType = config.orpService === 'humidity' ? 'humidity' : 'light';
    this.phLuxScale = this._normalizePhLuxScale(config.phLuxScale);
    this.updateInterval = this._normalizeUpdateInterval(config.updateInterval);
    this.staleAfterMs = 3 * this.updateInterval * 1000;
    this.useMeasuresFallback = config.useMeasuresFallback !== false;
    this.waterQuality = config.waterQuality !== false;
    this.outOfRangeSensors = config.outOfRangeSensors === true;
    this.recommendations = config.recommendations === true;
    this.allowRecommendationValidation = this.recommendations && config.allowRecommendationValidation === true;
    this.debugEnabled = config.logLevel === 'debug';
  }

  /** Journal de diagnostic déjà préfixé : visible en info quand l'utilisateur a choisi « Détaillé ». */
  diag(message) {
    if (this.debugEnabled) this.log.info(message);
    else this.log.debug?.(message);
  }

  dbg(message) {
    this.diag(`[OndiloICO] ${message}`);
  }

  /** Logger passé au client HTTP : son `debug` suit lui aussi l'option « Niveau de journal ». */
  _apiLogger() {
    return {
      info: (...args) => this.log.info(...args),
      warn: (...args) => this.log.warn(...args),
      error: (...args) => this.log.error(...args),
      debug: (message) => this.diag(message),
    };
  }

  _normalizePoolIds(raw) {
    if (raw === undefined || raw === null || raw === '') return [];
    const list = Array.isArray(raw) ? raw : [raw];
    const out = [];
    for (const entry of list) {
      const value = String(entry).trim();
      if (!value) continue;
      if (!out.includes(value)) out.push(value);
    }
    return out;
  }

  _normalizeMeasures(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_MEASURES];
    const out = [];
    for (const entry of raw) {
      const type = String(entry).trim().toLowerCase();
      if (!MEASURE_TYPES.includes(type)) {
        this.log.warn(`[OndiloICO] Mesure inconnue « ${entry} » ignorée (valeurs acceptées : ${MEASURE_TYPES.join(', ')}).`);
        continue;
      }
      if (!out.includes(type)) out.push(type);
    }
    if (!out.length) {
      this.log.warn('[OndiloICO] Aucune mesure valide sélectionnée : retour à la sélection par défaut.');
      return [...DEFAULT_MEASURES];
    }
    return out;
  }

  _normalizePhLuxScale(raw) {
    if (raw === undefined || raw === null) return DEFAULT_PH_LUX_SCALE;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      this.log.warn(`[OndiloICO] Facteur d'échelle du pH invalide (« ${raw} ») : ${DEFAULT_PH_LUX_SCALE} appliqué.`);
      return DEFAULT_PH_LUX_SCALE;
    }
    const clamped = clamp(value, MIN_PH_LUX_SCALE, MAX_PH_LUX_SCALE);
    if (clamped !== value) {
      this.log.warn(
        `[OndiloICO] Facteur d'échelle du pH ramené à ${clamped} : la valeur doit rester entre ` +
        `${MIN_PH_LUX_SCALE} et ${MAX_PH_LUX_SCALE}.`,
      );
    }
    return clamped;
  }

  _normalizeUpdateInterval(raw) {
    if (raw === undefined || raw === null || raw === '') return DEFAULT_UPDATE_INTERVAL_S;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      this.log.warn(`[OndiloICO] Intervalle de mise à jour invalide (« ${raw} ») : ${DEFAULT_UPDATE_INTERVAL_S} s appliqué.`);
      return DEFAULT_UPDATE_INTERVAL_S;
    }
    const clamped = clamp(Math.round(value), MIN_UPDATE_INTERVAL_S, MAX_UPDATE_INTERVAL_S);
    if (clamped !== Math.round(value)) {
      this.log.warn(
        `[OndiloICO] Intervalle de mise à jour ramené à ${clamped} s : la sonde ne mesure qu'une fois par heure ` +
        `et l'API Ondilo est plafonnée à 30 requêtes par heure.`,
      );
    }
    return clamped;
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  _reportUnconfigured() {
    if (!this.accessories.size) return;
    // On ne désenregistre pas : un champ vidé par erreur détruirait l'appairage, la pièce,
    // les scènes et les automatisations. Les tuiles restent, visiblement en défaut.
    this.log.error(
      `[OndiloICO] ${this.accessories.size} accessoire(s) en cache sont conservés mais ne seront pas mis à jour ` +
      'tant que le refresh token est absent. Ils apparaissent en défaut dans HomeKit.',
    );
    for (const accessory of this.accessories.values()) {
      markServicesUnavailable(this.api.hap, accessory);
    }
  }

  _start() {
    this.log.info(
      `[OndiloICO] ${this.name} v${VERSION} — mesures : ${this.measures.join(', ')} ; ` +
      `rafraîchissement toutes les ${this.updateInterval} s ; disposition « ${this.layout} ».`,
    );
    // Les tuiles restaurées du cache portent les valeurs du dernier arrêt : tant qu'un cycle
    // n'a rien confirmé, elles sont invérifiables et doivent le dire. Sans ça, un redémarrage
    // sans réseau republie un pH vieux de plusieurs jours comme s'il venait d'être mesuré.
    for (const accessory of this.accessories.values()) {
      try {
        markServicesUnavailable(this.api.hap, accessory);
      } catch (err) {
        this.log.warn(`[OndiloICO] Marquage initial de « ${accessory.displayName} » impossible : ${err?.message || err}`);
      }
    }
    // Le timer est armé avant la moindre requête : un échec de découverte ne peut plus
    // laisser le plugin définitivement inerte.
    this._schedule(0);
  }

  _stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.client?.abortAll();
    this.dbg('Arrêt de Homebridge : polling stoppé et requêtes en vol annulées.');
  }

  _schedule(delayMs) {
    if (this.stopped) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this._tick().catch(err => {
        this.log.error(`[OndiloICO] Cycle en échec inattendu : ${err?.message || err}`);
        this._schedule(this.updateInterval * 1000);
      });
    }, delayMs);
    this.pollTimer.unref();
  }

  /** Le compteur est déjà incrémenté quand on arrive ici : le premier échec doit lire le rang 0. */
  _discoveryBackoffMs() {
    const rank = Math.max(this.discoveryFailures - 1, 0);
    return DISCOVERY_BACKOFF_S[Math.min(rank, DISCOVERY_BACKOFF_S.length - 1)] * 1000;
  }

  async _tick() {
    if (this.stopped || this.ticking) {
      if (this.ticking) this.dbg('Cycle précédent encore en cours : ce tick est sauté.');
      return;
    }
    this.ticking = true;
    let nextDelayMs = this.updateInterval * 1000;

    try {
      if (!this.discovered) {
        const outcome = await this._discover();
        if (outcome !== 'ok') {
          nextDelayMs = outcome === 'slow' ? this.updateInterval * 1000 : this._discoveryBackoffMs();
        }
      }
      if (this.discovered && !this.stopped) {
        const freshest = await this._refreshAll();
        nextDelayMs = this._nextDelayMs(freshest);
      }
    } catch (err) {
      if (!err?.__ondiloLogged) {
        this.log.error(`[OndiloICO] Cycle interrompu : ${err?.message || err}`);
      }
      nextDelayMs = this.discovered ? this.updateInterval * 1000 : this._discoveryBackoffMs();
    } finally {
      this.ticking = false;
      this._schedule(nextDelayMs);
    }
  }

  _nextDelayMs(freshestMeasureAt) {
    const nominal = this.updateInterval * 1000;
    if (freshestMeasureAt === null || freshestMeasureAt === undefined) return nominal;
    // Viser le relevé suivant n'a de sens que si la cadence demandée est celle de la sonde.
    // Au-delà, l'utilisateur demande explicitement moins d'appels : s'aligner lui en imposerait
    // davantage — six heures configurées devenaient une heure réelle.
    if (nominal > MEASURE_PERIOD_MS) return nominal;
    const target = freshestMeasureAt + MEASURE_PERIOD_MS - Date.now();
    // Relevé attendu depuis plus d'une période : la sonde ne publie plus, l'alignement n'a plus
    // de repère et sonder vite ne ferait que brûler du quota.
    if (target < -MEASURE_PERIOD_MS) return nominal;
    return clamp(target, ALIGNED_FLOOR_MS, nominal);
  }

  /** @returns {'ok'|'retry'|'slow'} */
  async _discover() {
    let pools;
    try {
      pools = await this.client.getPools();
    } catch (err) {
      this.discoveryFailures++;
      this._logError('/pools', err);
      return 'retry';
    }

    if (!Array.isArray(pools)) {
      this.discoveryFailures++;
      this.log.warn('[OndiloICO] /pools a répondu autre chose qu\'un tableau ; réponse ignorée.');
      return 'retry';
    }
    if (pools.length === 0) {
      this.discoveryFailures++;
      this.log.warn('[OndiloICO] Aucun bassin trouvé sur ce compte Ondilo.');
      return 'slow';
    }

    const known = new Map();
    let unusable = 0;
    for (const pool of pools) {
      if (pool && pool.id !== undefined && pool.id !== null) known.set(String(pool.id), pool);
      else unusable++;
    }
    if (!known.size) {
      this.discoveryFailures++;
      this.log.warn(
        `[OndiloICO] /pools a renvoyé ${pools.length} entrée(s) mais aucune ne porte d'identifiant : ` +
        'rien à publier.',
      );
      return 'retry';
    }

    const targets = this._selectTargets(known);
    if (!targets.length) {
      this.discoveryFailures++;
      return 'slow';
    }

    await this._fetchUnitsOnce();

    let configured = 0;
    for (const pool of targets) {
      try {
        this._setupPool(pool);
        configured++;
      } catch (err) {
        this.log.error(`[OndiloICO] Configuration du bassin ${pool?.id} impossible : ${err?.message || err}`);
      }
    }

    // Une réponse dont une entrée est inexploitable est une vue partielle du compte : un bassin
    // absent de cette vue n'est pas un bassin supprimé. Désenregistrer sur cette base coûterait
    // la pièce, les scènes et les automatisations de l'accessoire, sans retour possible.
    if (unusable) {
      this.log.warn(
        `[OndiloICO] ${unusable} entrée(s) de /pools sans identifiant : réponse jugée incomplète, ` +
        'aucun accessoire ne sera désenregistré ce cycle-ci.',
      );
    } else {
      this._pruneVanishedPools(known);
    }
    this._markUntargetedAccessories();

    if (!this.poolAccessories.size) return 'slow';
    // Tant qu'une cible n'a pas abouti, la découverte n'est pas finie : sans ça la réussite du
    // premier bassin masquerait définitivement l'échec du second.
    if (configured < targets.length) {
      this.discoveryFailures++;
      return 'retry';
    }
    this.discovered = true;
    this.discoveryFailures = 0;
    return 'ok';
  }

  _selectTargets(known) {
    if (this.poolIds.length) {
      const targets = this.poolIds.map(id => known.get(id)).filter(Boolean);
      const missing = this.poolIds.filter(id => !known.has(id));
      if (missing.length && !this.missingPoolReported) {
        this.missingPoolReported = true;
        const available = [...known.values()].map(p => `${p.id} (${p.name || 'sans nom'})`).join(', ');
        this.log.error(
          `[OndiloICO] Identifiant de bassin introuvable : ${missing.join(', ')}. ` +
          `Bassins disponibles sur ce compte : ${available}. Corrige le champ « Identifiant du bassin » ; ` +
          'aucun accessoire ne sera créé pour un identifiant inconnu.',
        );
      }
      return targets;
    }

    if (this.layout === 'grouped') return [...known.values()];

    // L'ordre des entrées de /pools n'est garanti par rien. Prendre la première ferait changer
    // d'accessoire — donc de pièce, de scènes et d'automatisations — le jour où Ondilo réordonne
    // sa réponse : un bassin déjà appairé et toujours présent sur le compte garde la main.
    const first = this._alreadyPairedPool(known) || known.values().next().value;
    if (known.size > 1) {
      this.log.info(
        `[OndiloICO] ${known.size} bassins sur ce compte ; la disposition « legacy » n'en expose qu'un ` +
        `(${first.id}). Passe « Disposition » à « grouped » ou renseigne un identifiant de bassin pour les autres.`,
      );
    }
    return [first];
  }

  /**
   * Un bassin déjà appairé et toujours servi par l'API, sinon null. Le tri ne cherche pas l'ordre
   * numérique mais un ordre stable : deux démarrages doivent choisir le même bassin.
   */
  _alreadyPairedPool(known) {
    const paired = [];
    for (const accessory of this.accessories.values()) {
      const poolId = accessory.context?.poolId;
      if (poolId === undefined || poolId === null) continue;
      const key = String(poolId);
      if (known.has(key) && !paired.includes(key)) paired.push(key);
    }
    paired.sort();
    return paired.length ? known.get(paired[0]) : null;
  }

  async _fetchUnitsOnce() {
    if (this.unitsFetched || !this.measures.includes('salt')) return;
    try {
      this.units = await this.client.getUserUnits();
      // Marqué seulement en cas de succès : sinon un hoquet réseau au démarrage figerait la
      // salinité en mg/L pour toute la durée de vie du processus.
      this.unitsFetched = true;
    } catch (err) {
      this.units = null;
      this._logError('/user/units', err);
    }
  }

  _setupPool(pool) {
    const uuid = this.api.hap.uuid.generate(`ondilo:pool:${pool.id}`);
    let accessory = this.accessories.get(uuid);
    const created = !accessory;

    if (created) {
      accessory = new this.api.platformAccessory(displayNameForPool(pool), uuid);
    }
    accessory.context.poolId = pool.id;
    accessory.context.poolName = pool.name;

    const existing = this.poolAccessories.get(uuid);
    const poolAccessory = existing || new PoolAccessory(this, accessory, pool);
    if (existing) existing.pool = pool;

    // Rien n'entre dans les maps avant que Homebridge ait accepté l'accessoire : un enregistrement
    // refusé laisserait sinon un objet invisible que le cycle rafraîchirait dans le vide, sans
    // jamais retenter de l'enregistrer.
    const servicesChanged = poolAccessory.syncServices();

    if (created) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.poolAccessories.set(uuid, poolAccessory);
      this.log.info(`[OndiloICO] Accessoire créé pour le bassin « ${pool.name} » (#${pool.id}).`);
    } else {
      this.poolAccessories.set(uuid, poolAccessory);
      // Sans cette réécriture, le cache disque de Homebridge garderait la liste de services de la
      // configuration précédente et la réconciliation serait à refaire à chaque redémarrage.
      if (servicesChanged) this.api.updatePlatformAccessories([accessory]);
      this.log.info(`[OndiloICO] Accessoire existant réutilisé : « ${pool.name} » (#${pool.id}).`);
    }
  }

  /**
   * Ne retire que les accessoires dont le bassin a réellement disparu du compte : un bassin
   * simplement écarté par la configuration reste appairé. Désenregistrer sur un filtre de
   * configuration détruirait pièce, scènes et automatisations sans possibilité de retour.
   */
  _pruneVanishedPools(known) {
    const stale = [];
    for (const [uuid, accessory] of this.accessories) {
      const poolId = accessory.context?.poolId;
      if (poolId === undefined || poolId === null) continue;
      if (known.has(String(poolId))) continue;
      stale.push({ uuid, accessory });
    }
    if (!stale.length) return;

    for (const { uuid } of stale) {
      this.accessories.delete(uuid);
      this.poolAccessories.delete(uuid);
    }
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale.map(entry => entry.accessory));
    this.log.info(
      `[OndiloICO] ${stale.length} accessoire(s) désenregistré(s) : ` +
      `${stale.map(entry => entry.accessory.displayName).join(', ')} — bassin absent du compte Ondilo.`,
    );
  }

  /**
   * Un bassin encore présent sur le compte mais hors du périmètre choisi garde son appairage :
   * ses tuiles resteraient sinon figées sur les dernières valeurs d'une configuration passée,
   * indiscernables de valeurs fraîches.
   */
  _markUntargetedAccessories() {
    for (const [uuid, accessory] of this.accessories) {
      if (this.poolAccessories.has(uuid)) continue;
      markServicesUnavailable(this.api.hap, accessory);
      if (this.untargetedReported.has(uuid)) continue;
      this.untargetedReported.add(uuid);
      this.log.info(
        `[OndiloICO] « ${accessory.displayName} » est hors du périmètre configuré : conservé et marqué en défaut, ` +
        'jamais supprimé.',
      );
    }
  }

  async _refreshAll() {
    // Réessai des unités hors découverte : celle-ci ne repasse plus une fois le bassin configuré.
    await this._fetchUnitsOnce();
    let oldest = null;
    for (const poolAccessory of this.poolAccessories.values()) {
      if (this.stopped) break;
      try {
        const measuredAt = await poolAccessory.refresh();
        if (measuredAt !== null && measuredAt !== undefined && (oldest === null || measuredAt < oldest)) {
          oldest = measuredAt;
        }
      } catch (err) {
        if (!err?.__ondiloLogged) {
          this.log.error(`[OndiloICO] Mise à jour du bassin ${poolAccessory.poolId} en échec : ${err?.message || err}`);
        }
        poolAccessory.markUnavailable();
        // Un refus d'authentification vaut pour le compte entier : insister bassin par bassin
        // ferait recommencer à chacun son cycle 401-renouvellement-401 et viderait le quota.
        if (err instanceof OndiloAuthError) {
          for (const other of this.poolAccessories.values()) {
            if (other !== poolAccessory) other.markUnavailable();
          }
          break;
        }
      }
    }
    // F-17 : l'ordre tourne d'un cycle à l'autre pour qu'un quota trop juste ne condamne pas
    // toujours le même bassin.
    this._rotatePools();
    this.dbg(`Cycle terminé — ${this.client.quotaUsed()} appel(s) sur la dernière heure.`);
    return oldest;
  }

  _rotatePools() {
    if (this.poolAccessories.size < 2) return;
    const [firstKey] = this.poolAccessories.keys();
    const first = this.poolAccessories.get(firstKey);
    this.poolAccessories.delete(firstKey);
    this.poolAccessories.set(firstKey, first);
  }

  _logError(label, err) {
    if (err && typeof err === 'object') err.__ondiloLogged = true;
    // Une requête annulée par notre propre arrêt est attendue : elle n'a pas à salir le journal
    // à chaque redémarrage de Homebridge.
    if (err?.code === 'ERR_CANCELED') {
      this.dbg(`${label} annulé par l'arrêt du plugin.`);
      return;
    }
    if (err instanceof OndiloAuthError) {
      this.log.error(`[OndiloICO] Authentification refusée : ${err.message}`);
      return;
    }
    const status = err?.response?.status;
    const detail = typeof status === 'number' ? `HTTP ${status}` : (err?.code || err?.message || String(err));
    this.log.warn(`[OndiloICO] Échec ${label} : ${detail}`);
  }
}

module.exports = { OndiloIcoPlatform, PLUGIN_NAME, PLATFORM_NAME };
