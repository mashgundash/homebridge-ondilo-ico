'use strict';

const { hap } = require('./fake-hap');

class FakeAccessory {
  constructor(displayName, uuid) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.context = {};
    this.services = [];
    this.addService(hap.Service.AccessoryInformation, displayName);
  }

  addService(Ctor, displayName, subtype) {
    const service = new Ctor(displayName, subtype);
    this.services.push(service);
    return service;
  }

  removeService(service) {
    const index = this.services.indexOf(service);
    if (index >= 0) this.services.splice(index, 1);
  }

  getService(Ctor) {
    return this.services.find(s => s.UUID === Ctor.UUID && !s.subtype) || null;
  }

  getServiceById(Ctor, subtype) {
    return this.services.find(s => s.UUID === Ctor.UUID && s.subtype === subtype) || null;
  }

  updateDisplayName(name) {
    this.displayName = name;
  }
}

class FakeLog {
  constructor() {
    this.entries = [];
  }

  _push(level, args) {
    this.entries.push({ level, message: args.map(String).join(' ') });
  }

  info(...args) { this._push('info', args); }
  warn(...args) { this._push('warn', args); }
  error(...args) { this._push('error', args); }
  debug(...args) { this._push('debug', args); }

  of(level) {
    return this.entries.filter(entry => entry.level === level).map(entry => entry.message);
  }

  /** Vrai si un message de ce niveau contient le fragment donné. */
  has(level, fragment) {
    return this.of(level).some(message => message.includes(fragment));
  }

  get text() {
    return this.entries.map(entry => `${entry.level}: ${entry.message}`).join('\n');
  }
}

class FakeHomebridgeApi {
  /** @param {{ withUpdateDisplayName?: boolean }} [options] */
  constructor(options = {}) {
    this.hap = hap;
    this.handlers = new Map();
    this.registered = [];
    this.unregistered = [];
    this.updated = [];
    this.uuidSeeds = [];

    const withRename = options.withUpdateDisplayName !== false;
    const api = this;
    this.platformAccessory = class extends FakeAccessory {
      constructor(displayName, uuid) {
        super(displayName, uuid);
        if (!withRename) this.updateDisplayName = undefined;
        api.created = (api.created || 0) + 1;
      }
    };

    // Les seeds passés à uuid.generate sont mémorisés : c'est l'invariant d'appairage,
    // le seul qu'un test puisse vérifier sans dépendre de l'algorithme de HAP.
    const realGenerate = hap.uuid.generate;
    this.hap = {
      ...hap,
      uuid: {
        generate: (seed) => {
          this.uuidSeeds.push(seed);
          return realGenerate(seed);
        },
      },
    };
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
    return this;
  }

  emit(event, ...args) {
    for (const handler of this.handlers.get(event) || []) handler(...args);
  }

  registerPlatformAccessories(pluginName, platformName, accessories) {
    this.registered.push({ pluginName, platformName, accessories: [...accessories] });
  }

  unregisterPlatformAccessories(pluginName, platformName, accessories) {
    this.unregistered.push({ pluginName, platformName, accessories: [...accessories] });
  }

  updatePlatformAccessories(accessories) {
    this.updated.push([...accessories]);
  }

  /** Tous les accessoires désenregistrés, à plat. */
  get unregisteredAccessories() {
    return this.unregistered.flatMap(entry => entry.accessories);
  }

  get registeredAccessories() {
    return this.registered.flatMap(entry => entry.accessories);
  }
}

module.exports = { FakeHomebridgeApi, FakeAccessory, FakeLog };
