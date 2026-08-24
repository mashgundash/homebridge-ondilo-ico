'use strict';

// Double de test du sous-ensemble de HAP-NodeJS utilisé par le plugin. Les UUID, les propriétés
// par défaut et les listes de caractéristiques requises/optionnelles ont été relevés sur
// @homebridge/hap-nodejs 2.1.2 : un service qui n'accepte pas StatusActive ici ne l'accepte pas
// non plus en vrai, et le test le voit.
//
// Différence assumée avec HAP : une valeur hors bornes est enregistrée dans `boundsViolations`
// avant d'être écrêtée. HAP écrête en silence ; ici la violation reste observable, sinon aucun
// test ne pourrait échouer sur un dépassement de plage.

const crypto = require('node:crypto');

const boundsViolations = [];

function resetBoundsViolations() {
  boundsViolations.length = 0;
}

/**
 * Algorithme de HAP-NodeJS (uuid.generate) : SHA-1 du seed coulé dans un gabarit d'UUID v4, dont
 * le « 4 » est littéral. La valeur produite est vérifiée contre l'UUID réellement appairé chez
 * l'utilisateur dans packaging.test.js — c'est ce qui empêche ce double de mentir.
 */
function generate(data) {
  const digest = crypto.createHash('sha1').update(data).digest('hex');
  let i = -1;
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    i += 1;
    if (c === 'y') return ((parseInt(`0x${digest[i]}`, 16) & 0x3) | 0x8).toString(16);
    return digest[i];
  });
}

const Formats = Object.freeze({
  BOOL: 'bool', INT: 'int', FLOAT: 'float', STRING: 'string', UINT8: 'uint8',
  UINT16: 'uint16', UINT32: 'uint32', UINT64: 'uint64', DATA: 'data', TLV8: 'tlv8',
});

const Perms = Object.freeze({
  PAIRED_READ: 'pr', PAIRED_WRITE: 'pw', NOTIFY: 'ev', HIDDEN: 'hd',
  ADDITIONAL_AUTHORIZATION: 'aa', TIMED_WRITE: 'tw', WRITE_RESPONSE: 'wr',
});

class Characteristic {
  constructor(displayName, uuid, props) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.props = { format: Formats.STRING, perms: [Perms.PAIRED_READ, Perms.NOTIFY], ...(props || {}) };
    this.value = this.getDefaultValue();
    this.setHandler = null;
    this.updates = [];
  }

  getDefaultValue() {
    switch (this.props.format) {
      case Formats.BOOL: return false;
      case Formats.STRING: return '';
      case Formats.DATA:
      case Formats.TLV8: return null;
      default: return typeof this.props.minValue === 'number' ? this.props.minValue : 0;
    }
  }

  setProps(props) {
    Object.assign(this.props, props);
    return this;
  }

  onSet(handler) {
    this.setHandler = handler;
    return this;
  }

  onGet() {
    return this;
  }

  updateValue(value) {
    this.updates.push(value);
    this.value = this._coerce(value);
    return this;
  }

  _coerce(value) {
    const { format, minValue, maxValue, minStep } = this.props;
    if (format === Formats.BOOL || format === Formats.STRING) return value;
    if (typeof value !== 'number' || !Number.isFinite(value)) return value;
    let out = value;
    if (typeof minValue === 'number' && out < minValue) {
      boundsViolations.push({ characteristic: this.displayName, value, minValue, maxValue });
      out = minValue;
    }
    if (typeof maxValue === 'number' && out > maxValue) {
      boundsViolations.push({ characteristic: this.displayName, value, minValue, maxValue });
      out = maxValue;
    }
    if (typeof minStep === 'number' && minStep > 0) {
      const base = typeof minValue === 'number' ? minValue : 0;
      out = base + Math.round((out - base) / minStep) * minStep;
      out = Math.round(out * 1e6) / 1e6;
    }
    return out;
  }
}

const HAP_SUFFIX = '-0000-1000-8000-0026BB765291';
const registry = {};

/**
 * Comme dans HAP-NodeJS, les caractéristiques nommées sont des propriétés statiques de la classe
 * de base : `hap.Characteristic` sert à la fois de classe à étendre (characteristics.js le fait)
 * et de catalogue (`hap.Characteristic.StatusActive`). `defineProperty` est obligatoire —
 * `Object.assign` échouerait sur `Name`, qui entrerait en collision avec `Function.prototype.name`.
 */
function attach(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function defineCharacteristic(name, shortUuid, props, constants) {
  const uuid = `${shortUuid}${HAP_SUFFIX}`;
  class Named extends Characteristic {
    constructor() {
      super(name, uuid, props);
    }
  }
  attach(Named, 'name', name);
  Named.UUID = uuid;
  for (const [key, value] of Object.entries(constants || {})) attach(Named, key, value);
  registry[name] = Named;
  attach(Characteristic, name, Named);
  return Named;
}

// Propriétés par défaut relevées sur hap-nodejs 2.1.2.
defineCharacteristic('CurrentAmbientLightLevel', '0000006B', { format: Formats.FLOAT, unit: 'lux', minValue: 0.0001, maxValue: 100000 });
defineCharacteristic('CurrentRelativeHumidity', '00000010', { format: Formats.FLOAT, unit: 'percentage', minValue: 0, maxValue: 100, minStep: 1 });
defineCharacteristic('CurrentTemperature', '00000011', { format: Formats.FLOAT, unit: 'celsius', minValue: -270, maxValue: 100, minStep: 0.1 });
defineCharacteristic('BatteryLevel', '00000068', { format: Formats.UINT8, unit: 'percentage', minValue: 0, maxValue: 100, minStep: 1 });
defineCharacteristic('StatusLowBattery', '00000079', { format: Formats.UINT8, minValue: 0, maxValue: 1, minStep: 1 }, { BATTERY_LEVEL_NORMAL: 0, BATTERY_LEVEL_LOW: 1 });
defineCharacteristic('ChargingState', '0000008F', { format: Formats.UINT8, minValue: 0, maxValue: 2, minStep: 1 }, { NOT_CHARGING: 0, CHARGING: 1, NOT_CHARGEABLE: 2 });
defineCharacteristic('StatusActive', '00000075', { format: Formats.BOOL });
defineCharacteristic('StatusFault', '00000077', { format: Formats.UINT8, minValue: 0, maxValue: 1, minStep: 1 }, { NO_FAULT: 0, GENERAL_FAULT: 1 });
defineCharacteristic('StatusTampered', '0000007A', { format: Formats.UINT8, minValue: 0, maxValue: 1, minStep: 1 });
defineCharacteristic('AirQuality', '00000095', { format: Formats.UINT8, minValue: 0, maxValue: 5, minStep: 1 }, { UNKNOWN: 0, EXCELLENT: 1, GOOD: 2, FAIR: 3, INFERIOR: 4, POOR: 5 });
defineCharacteristic('ContactSensorState', '0000006A', { format: Formats.UINT8, minValue: 0, maxValue: 1, minStep: 1 }, { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 });
defineCharacteristic('On', '00000025', { format: Formats.BOOL });
defineCharacteristic('Name', '00000023', { format: Formats.STRING });
defineCharacteristic('ConfiguredName', '000000E3', { format: Formats.STRING });
defineCharacteristic('Manufacturer', '00000020', { format: Formats.STRING });
defineCharacteristic('Model', '00000021', { format: Formats.STRING });
defineCharacteristic('SerialNumber', '00000030', { format: Formats.STRING });
defineCharacteristic('FirmwareRevision', '00000052', { format: Formats.STRING });
defineCharacteristic('Identify', '00000014', { format: Formats.BOOL });

class Service {
  constructor(displayName, uuid, subtype, required, optional) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.subtype = subtype;
    this.characteristics = [];
    this.optionalCharacteristics = (optional || []).map(Ctor => new Ctor());
    for (const Ctor of required || []) this.addCharacteristic(Ctor);
  }

  addCharacteristic(Ctor) {
    const existing = this.characteristics.find(c => c.UUID === Ctor.UUID);
    if (existing) return existing;
    const characteristic = new Ctor();
    this.characteristics.push(characteristic);
    return characteristic;
  }

  addOptionalCharacteristic(Ctor) {
    if (!this.optionalCharacteristics.some(c => c.UUID === Ctor.UUID)) {
      this.optionalCharacteristics.push(new Ctor());
    }
    return this;
  }

  testCharacteristic(Ctor) {
    return this.characteristics.some(c => c.UUID === Ctor.UUID);
  }

  getCharacteristic(Ctor) {
    return this.characteristics.find(c => c.UUID === Ctor.UUID) || this.addCharacteristic(Ctor);
  }

  updateCharacteristic(Ctor, value) {
    this.getCharacteristic(Ctor).updateValue(value);
    return this;
  }

  /** Confort de test : dernière valeur publiée, ou undefined si la caractéristique est absente. */
  read(Ctor) {
    const characteristic = this.characteristics.find(c => c.UUID === Ctor.UUID);
    return characteristic ? characteristic.value : undefined;
  }
}

const serviceRegistry = {};

function defineService(name, shortUuid, required, optional) {
  const uuid = `${shortUuid}${HAP_SUFFIX}`;
  class NamedService extends Service {
    constructor(displayName, subtype) {
      super(displayName, uuid, subtype, required, optional);
    }
  }
  attach(NamedService, 'name', name);
  NamedService.UUID = uuid;
  serviceRegistry[name] = NamedService;
  attach(Service, name, NamedService);
  return NamedService;
}

const C = registry;
const sensorOptional = [C.Name, C.StatusActive, C.StatusFault, C.StatusLowBattery, C.StatusTampered];

defineService('TemperatureSensor', '0000008A', [C.Name, C.CurrentTemperature], sensorOptional);
defineService('LightSensor', '00000084', [C.Name, C.CurrentAmbientLightLevel], sensorOptional);
defineService('HumiditySensor', '00000082', [C.Name, C.CurrentRelativeHumidity], sensorOptional);
defineService('ContactSensor', '00000080', [C.Name, C.ContactSensorState], sensorOptional);
defineService('AirQualitySensor', '0000008D', [C.Name, C.AirQuality], sensorOptional);
// Battery n'accepte ni StatusActive ni StatusFault : c'est le cas réel, pas une simplification.
defineService('Battery', '00000096', [C.Name, C.StatusLowBattery], [C.BatteryLevel, C.ChargingState, C.Name]);
defineService('Switch', '00000049', [C.Name, C.On], [C.Name]);
defineService('AccessoryInformation', '0000003E', [C.Name, C.Identify, C.Manufacturer, C.Model, C.SerialNumber, C.FirmwareRevision], [C.ConfiguredName]);

class HAPStatusError extends Error {
  constructor(status) {
    super(`HAP status ${status}`);
    this.name = 'HapStatusError';
    this.hapStatus = status;
  }
}

const HAPStatus = Object.freeze({
  SUCCESS: 0,
  SERVICE_COMMUNICATION_FAILURE: -70402,
  RESOURCE_BUSY: -70403,
});

const hap = {
  Characteristic,
  Service,
  Formats,
  Perms,
  uuid: { generate },
  HapStatusError: HAPStatusError,
  HAPStatus,
};

module.exports = { hap, Characteristic, Service, boundsViolations, resetBoundsViolations, generate };
