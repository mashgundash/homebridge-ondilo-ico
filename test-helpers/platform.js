'use strict';

// Doit précéder tout require du plugin : c'est lui qui neutralise axios.
const { HttpStub, tokenResponse } = require('./http');
const { FakeHomebridgeApi, FakeAccessory, FakeLog } = require('./fake-homebridge');
const { hap } = require('./fake-hap');

const { OndiloIcoPlatform } = require('../platform');

const POOL_ID = 53865;
/** UUID HomeKit réellement appairé chez l'utilisateur, calculé par hap-nodejs 2.1.2. */
const POOL_UUID = 'acabddc0-2d2a-4e3b-8f0e-0eb6040261a2';
/** URL de validation d'une recommandation : PUT /pools/{id}/recommendations/{recommendationId}. */
const RECOMMENDATION_PUT = /\/recommendations\/\d+$/;

function poolPayload(overrides = {}) {
  return {
    id: POOL_ID,
    name: 'Piscine',
    type: 'outdoor_inground_pool',
    volume: 40,
    disinfection: { primary: 'chlorine', secondary: { uv_sanitizer: false, ozonator: false } },
    updated_at: '2026-08-24T10:00:00+0000',
    ...overrides,
  };
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60000).toISOString();
}

function measure(dataType, value, extra = {}) {
  return {
    data_type: dataType,
    value,
    value_time: isoMinutesAgo(10),
    is_valid: true,
    exclusion_reason: null,
    ...extra,
  };
}

/**
 * Monte une plateforme complète : client HTTP substitué, planification neutralisée par défaut.
 * Les cycles se déclenchent à la main via `await platform._tick()`.
 *
 * @param {object} config configuration du plugin (fusionnée avec un refreshToken de test)
 * @param {{ cached?: Array, realTimers?: boolean, api?: object }} [options]
 */
function buildPlatform(config = {}, options = {}) {
  const log = new FakeLog();
  const api = new FakeHomebridgeApi(options.api);
  const http = new HttpStub();

  const merged = { platform: 'OndiloICO', refreshToken: 'rt-test', ...config };
  if (merged.refreshToken === null) delete merged.refreshToken;

  const platform = new OndiloIcoPlatform(log, merged, api);

  // Homebridge restaure le cache entre le constructeur et didFinishLaunching.
  for (const accessory of options.cached || []) platform.configureAccessory(accessory);

  if (platform.client) {
    platform.client.http = http.handler;
    // Les repli exponentiels sont vérifiés dans api.test.js ; ici ils ne feraient qu'allonger
    // la suite de plusieurs secondes par cycle en échec.
    if (options.realSleep !== true) platform.client._sleep = async () => {};
  }

  const scheduled = [];
  if (options.realTimers !== true) {
    platform._schedule = (delayMs) => { scheduled.push(delayMs); };
  }

  http.on('/oauth2/token', () => tokenResponse());

  return { platform, log, api, http, scheduled };
}

const DEFAULT_MEASURES = () => [
  measure('temperature', 26.4),
  measure('ph', 7.24),
  measure('orp', 690),
  measure('battery', 87),
];

/**
 * Routes « tout va bien » pour un compte à un seul bassin. L'ordre compte : `HttpStub` retient la
 * première route dont le fragment est contenu dans l'URL, donc `/pools` doit rester en dernier.
 */
function happyRoutes(http, options = {}) {
  const { pools, lastmeasures, device, configuration, units, recommendations, history, validate, extraPools } = options;
  // Les bassins supplémentaires se déclarent en premier : leurs URL contiennent les fragments
  // génériques (« /lastmeasures », « /pools ») et la première route qui correspond répond.
  for (const extra of extraPools || []) {
    http.on(`/pools/${extra.id}/device`, { data: extra.device ?? {} });
    http.on(`/pools/${extra.id}/configuration`, { data: extra.configuration ?? {} });
    http.on(`/pools/${extra.id}/recommendations`, { data: extra.recommendations ?? [] });
    http.on(`/pools/${extra.id}/lastmeasures`, { data: extra.lastmeasures ?? [] });
  }
  // Doit précéder la liste des recommandations : « /pools/53865/recommendations » est un préfixe
  // de l'URL de validation, et c'est la première route qui répond.
  http.on(RECOMMENDATION_PUT, validate ?? { data: 'Done' });
  http.on('/pools/53865/device', { data: device ?? { uuid: 'ico-uuid', serial_number: 'ICO123456', sw_version: '1.5.1-stable' } });
  http.on('/pools/53865/configuration', {
    data: configuration ?? {
      temperature_low: 10, temperature_high: 32,
      ph_low: 6.8, ph_high: 7.8,
      orp_low: 550, orp_high: 900,
    },
  });
  http.on('/pools/53865/recommendations', { data: recommendations ?? [] });
  http.on('/lastmeasures', { data: lastmeasures ?? DEFAULT_MEASURES() });
  // Repli historique : /pools/{id}/measures?type=X&period=day. Le « / » devant « measures »
  // suffit à le distinguer de « lastmeasures? ».
  http.on(/\/measures\?type=/, history ?? { data: [] });
  http.on('/user/units', { data: units ?? { salt: 'MILLIGRAM_PER_LITER', temperature: 'CELSIUS' } });
  http.on('/pools', { data: pools ?? [poolPayload()] });
  return http;
}

/**
 * Accessoire tel que Homebridge le restaure depuis son cache : bon UUID, contexte rempli,
 * quelques services `ondilo:*` déjà présents.
 */
function cachedAccessory(poolId = POOL_ID, name = 'ICO Piscine') {
  const accessory = new FakeAccessory(name, hap.uuid.generate(`ondilo:pool:${poolId}`));
  accessory.context.poolId = poolId;
  accessory.context.poolName = name;
  accessory.addService(hap.Service.TemperatureSensor, 'Température eau', 'ondilo:temperature');
  accessory.addService(hap.Service.LightSensor, 'pH', 'ondilo:ph');
  return accessory;
}

module.exports = {
  buildPlatform, happyRoutes, poolPayload, measure, isoMinutesAgo, cachedAccessory,
  DEFAULT_MEASURES, POOL_ID, POOL_UUID, RECOMMENDATION_PUT,
};
