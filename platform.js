
'use strict';

const { OndiloApi } = require('./api');

const PLUGIN_NAME = 'homebridge-ondilo-ico';
const PLATFORM_NAME = 'OndiloICO';

class OndiloIcoPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    // compat BatteryService/Battery selon HAP
    this.BatteryServiceCtor = this.api.hap.Service.BatteryService || this.api.hap.Service.Battery || null;
    this.accessories = new Map();

    this.name = this.config.name || 'Ondilo ICO';
    this.refreshToken = this.config.refreshToken;
    this.poolId = this.config.poolId || null;
    this.measures = Array.isArray(this.config.measures) && this.config.measures.length
      ? this.config.measures
      : ['temperature','ph','orp','battery'];
    this.updateInterval = Math.max(600, this.config.updateInterval || 3600);
    this.useMeasuresFallback = this.config.useMeasuresFallback !== false;
    this.phServiceType = (this.config.phService || 'light');     
    this.orpServiceType = (this.config.orpService || 'light');   
    this.logLevel = this.config.logLevel || 'info';

    if (!this.refreshToken) {
      this.log.warn('[OndiloICO] Aucun refreshToken fourni. Exécutez "npm run oauth" dans ce plugin pour en générer un, puis remplissez la configuration.');
      return;
    }

    this.client = new OndiloApi(this.log, this.refreshToken);

    this.api.on('didFinishLaunching', () => {
      this.discoverAndSetup().catch(err => {
        this.log.error('[OndiloICO] Erreur init:', err?.message || err);
      });
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  getServiceBySubtype(accessory, ServiceCtor, subtype) {
    if (!ServiceCtor) {
      this.log.warn?.(`[OndiloICO] ServiceCtor absent pour ${subtype}.`);
      return null;
    }
    return accessory.getServiceById(ServiceCtor, subtype);
  }

  ensureService(accessory, key, ServiceCtor, displayName) {
    const subtype = `ondilo:${key}`;
    let service = this.getServiceBySubtype(accessory, ServiceCtor, subtype);
    if (!service) {
      service = accessory.addService(ServiceCtor, displayName, subtype);
      this.log.debug?.(`[OndiloICO] Service ajouté: ${displayName}`);
    }
    return service;
  }

  async discoverAndSetup() {
    const pools = await this.client.getPools();
    if (!Array.isArray(pools) || pools.length === 0) {
      this.log.warn('[OndiloICO] Aucun pool/spa trouvé sur votre compte.');
      return;
    }
    let target = pools;
    if (this.poolId) {
      target = pools.filter(p => String(p.id) === String(this.poolId));
      if (target.length === 0) {
        this.log.warn(`[OndiloICO] poolId ${this.poolId} introuvable. Utilisation du premier pool.`);
        target = [pools[0]];
      }
    } else {
      target = [pools[0]];
    }

    for (const pool of target) {
      await this.setupAccessoryForPool(pool);
    }
  }

  async setupAccessoryForPool(pool) {
    const uuid = this.api.hap.uuid.generate(`ondilo:pool:${pool.id}`);
    let accessory = this.accessories.get(uuid);
    if (!accessory) {
      accessory = new this.api.platformAccessory(`ICO ${pool.name || pool.id}`, uuid);
      accessory.context.poolId = pool.id;
      accessory.context.poolName = pool.name;
      accessory.getService(this.Service.AccessoryInformation)
        .setCharacteristic(this.Characteristic.Manufacturer, 'Ondilo')
        .setCharacteristic(this.Characteristic.Model, 'ICO')
        .setCharacteristic(this.Characteristic.SerialNumber, String(pool.id));
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info(`[OndiloICO] Accessoire créé pour le pool "${pool.name}" (#${pool.id}).`);
    } else {
      accessory.context.poolId = pool.id;
      accessory.context.poolName = pool.name;
      this.log.info(`[OndiloICO] Accessoire existant: "${pool.name}" (#${pool.id}).`);
    }

    if (this.measures.includes('temperature')) {
      this.ensureService(accessory, 'temperature', this.Service.TemperatureSensor, 'Température eau');
    }
    if (this.measures.includes('ph')) {
      if (this.phServiceType === 'humidity') {
        this.ensureService(accessory, 'ph', this.Service.HumiditySensor, 'pH');
      } else {
        this.ensureService(accessory, 'ph', this.Service.LightSensor, 'pH');
      }
    }
    if (this.measures.includes('orp')) {
      if (this.orpServiceType === 'humidity') {
        this.ensureService(accessory, 'orp', this.Service.HumiditySensor, 'ORP');
      } else {
        this.ensureService(accessory, 'orp', this.Service.LightSensor, 'ORP');
      }
    }
    if (this.measures.includes('battery')) {
      this.ensureService(accessory, 'battery', this.BatteryServiceCtor, 'Batterie ICO');
    }
    if (this.measures.includes('rssi')) {
      this.ensureService(accessory, 'rssi', this.Service.LightSensor, 'RSSI (%)');
    }

    await this.updateAccessory(accessory);
    setInterval(() => {
      this.updateAccessory(accessory).catch(err => this.log.error('[OndiloICO] update error:', err?.message || err));
    }, this.updateInterval * 1000);
  }

  pickValid(list) {
    if (!Array.isArray(list)) return null;
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i];
      if (!x) continue;
      if (typeof x.value === 'number' && (x.is_valid === undefined || x.is_valid === true)) {
        return x;
      }
    }
    return null;
  }

  async updateAccessory(accessory) {
    const poolId = accessory.context.poolId;
    const wanted = this.measures.slice();

    let last = [];
    try {
      last = await this.client.getLastMeasures(poolId, wanted);
    } catch (e) {
      this.log.warn(`[OndiloICO] Échec /lastmeasures: ${e?.message || e}`);
      last = [];
    }

    const byType = new Map();
    if (Array.isArray(last)) {
      for (const m of last) {
        if (m && (m.data_type || m.type)) {
          byType.set(m.data_type || m.type, m);
        }
      }
    }

    if (this.useMeasuresFallback) {
      for (const t of wanted) {
        if (!byType.has(t)) {
          try {
            const histo = await this.client.getMeasuresSet(poolId, t, 'day');
            const lastValid = this.pickValid(histo);
            if (lastValid) {
              byType.set(t, lastValid);
            }
          } catch (e) {
            this.log.debug?.(`[OndiloICO] Fallback /measures échoué pour ${t}: ${e?.message || e}`);
          }
        }
      }
    }

    // temperature
    if (this.measures.includes('temperature')) {
      const s = this.getServiceBySubtype(accessory, this.Service.TemperatureSensor, 'ondilo:temperature');
      const m = byType.get('temperature');
      const val = typeof m?.value === 'number' ? m.value : null;
      if (s && typeof val === 'number') {
        s.updateCharacteristic(this.Characteristic.CurrentTemperature, val);
      }
    }

    // pH
    if (this.measures.includes('ph')) {
      const m = byType.get('ph');
      if (this.phServiceType === 'humidity') {
        const s = this.getServiceBySubtype(accessory, this.Service.HumiditySensor, 'ondilo:ph');
        const val = typeof m?.value === 'number' ? Math.max(0, Math.min(14, m.value)) : null;
        if (s && typeof val === 'number') {
          const pct = Math.round((val / 14) * 1000) / 10;
          s.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, pct);
        }
      } else {
        const s = this.getServiceBySubtype(accessory, this.Service.LightSensor, 'ondilo:ph');
        const val = typeof m?.value === 'number' ? Math.max(0.0001, Math.min(100000, m.value)) : null;
        if (s && typeof val === 'number') {
          s.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, val);
        }
      }
    }

    // ORP
    if (this.measures.includes('orp')) {
      const m = byType.get('orp');
      if (this.orpServiceType === 'humidity') {
        const s = this.getServiceBySubtype(accessory, this.Service.HumiditySensor, 'ondilo:orp');
        const raw = typeof m?.value === 'number' ? m.value : null;
        if (s && typeof raw === 'number') {
          const pct = Math.max(0, Math.min(100, Math.round((raw / 1000) * 1000) / 10));
          s.updateCharacteristic(this.Characteristic.CurrentRelativeHumidity, pct);
        }
      } else {
        const s = this.getServiceBySubtype(accessory, this.Service.LightSensor, 'ondilo:orp');
        const raw = typeof m?.value === 'number' ? m.value : null;
        if (s && typeof raw === 'number') {
          const lux = Math.max(0.0001, Math.min(100000, raw));
          s.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, lux);
        }
      }
    }

    // battery
    if (this.measures.includes('battery')) {
      const s = this.getServiceBySubtype(accessory, this.BatteryServiceCtor, 'ondilo:battery');
      const m = byType.get('battery');
      const pct = typeof m?.value === 'number' ? Math.round(Math.max(0, Math.min(100, m.value))) : null;
      if (s && typeof pct === 'number') {
        s.updateCharacteristic(this.Characteristic.BatteryLevel, pct);
        s.updateCharacteristic(this.Characteristic.StatusLowBattery, pct <= 20
          ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL);
        s.updateCharacteristic(this.Characteristic.ChargingState, this.Characteristic.ChargingState.NOT_CHARGING);
      }
    }

    // rssi
    if (this.measures.includes('rssi')) {
      const s = this.getServiceBySubtype(accessory, this.Service.LightSensor, 'ondilo:rssi');
      const m = byType.get('rssi');
      const val = typeof m?.value === 'number' ? Math.max(0.0001, Math.min(100000, m.value)) : null;
      if (s && typeof val === 'number') {
        s.updateCharacteristic(this.Characteristic.CurrentAmbientLightLevel, val);
      }
    }

    this.log.debug?.('[OndiloICO] Mise à jour terminée.');
  }
}

module.exports = { OndiloIcoPlatform, PLUGIN_NAME, PLATFORM_NAME };
