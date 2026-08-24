'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { HttpStub, httpError, networkError, tokenResponse } = require('../test-helpers/http');
const { OndiloApi, OndiloAuthError, OndiloQuotaError, QUOTA_MAX } = require('../api');

function silentLog() {
  const entries = [];
  const push = level => (...args) => entries.push({ level, message: args.map(String).join(' ') });
  return { entries, info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') };
}

/** @returns {{ client: OndiloApi, http: HttpStub, log: ReturnType<typeof silentLog> }} */
function build({ instantSleep = true } = {}) {
  const log = silentLog();
  const client = new OndiloApi(log, 'rt-test');
  const http = new HttpStub();
  client.http = http.handler;
  if (instantSleep) client._sleep = async () => {};
  http.on('/oauth2/token', () => tokenResponse());
  return { client, http, log };
}

test('getLastMeasures envoie la forme tableau types[] répétée, pas une liste virgulée', async () => {
  const { client, http } = build();
  http.on('/lastmeasures', { data: [] });

  await client.getLastMeasures(53865, ['temperature', 'ph', 'orp', 'battery']);

  const url = http.urls.find(u => u.includes('lastmeasures'));
  const decoded = decodeURIComponent(url);
  assert.ok(decoded.includes('types[]=temperature'), `forme tableau attendue, reçu ${decoded}`);
  assert.equal((decoded.match(/types\[\]=/g) || []).length, 4);
  assert.ok(!/types=[a-z]+,/.test(decoded), 'la liste virgulée du 0.5.x ne doit plus apparaître');
});

test('getLastMeasures sans type ne pose aucune query string', async () => {
  const { client, http } = build();
  http.on('/lastmeasures', { data: [] });

  await client.getLastMeasures(53865, []);

  assert.ok(http.urls.some(u => u.endsWith('/pools/53865/lastmeasures')));
});

test('le jeton est demandé une fois puis réutilisé tant qu\'il est valide', async () => {
  const { client, http } = build();
  http.on('/pools', { data: [] });

  await client.getPools();
  await client.getPools();

  assert.equal(http.countMatching('/oauth2/token'), 1);
  assert.equal(http.countMatching('/pools'), 2);
});

test('deux appels concurrents ne déclenchent qu\'un seul POST /oauth2/token', async () => {
  const { client, http } = build();
  let resolveToken;
  http.on('/oauth2/token', () => new Promise(resolve => { resolveToken = () => resolve(tokenResponse()); }));
  http.on('/pools', { data: [] });

  const both = Promise.all([client.getPools(), client.getPools()]);
  await new Promise(setImmediate);
  resolveToken();
  await both;

  assert.equal(http.countMatching('/oauth2/token'), 1);
});

test('un 401 métier invalide le jeton en cache et rejoue une seule fois', async () => {
  const { client, http } = build();
  let attempt = 0;
  http.on('/pools', () => {
    attempt += 1;
    if (attempt === 1) throw httpError(401);
    return { data: [{ id: 53865 }] };
  });

  const pools = await client.getPools();

  assert.deepEqual(pools, [{ id: 53865 }]);
  assert.equal(http.countMatching('/oauth2/token'), 2, 'le jeton doit avoir été renouvelé');
  assert.equal(http.countMatching('/pools'), 2, 'exactement un rejeu, pas davantage');
});

test('un 401 persistant remonte une OndiloAuthError qui nomme la cause et la commande', async () => {
  const { client, http } = build();
  http.on('/pools', () => httpError(401));

  await assert.rejects(client.getPools(), (err) => {
    assert.ok(err instanceof OndiloAuthError, `OndiloAuthError attendue, reçu ${err?.name}`);
    assert.match(err.message, /refresh_token/);
    assert.match(err.message, /npm run oauth/);
    return true;
  });
  assert.equal(http.countMatching('/pools'), 2, 'un seul rejeu : pas de boucle sur un jeton mort');
});

test('un refresh_token révoqué (400) donne une OndiloAuthError, pas une erreur de transport', async () => {
  const { client, http } = build();
  http.on('/oauth2/token', () => httpError(400));
  http.on('/pools', { data: [] });

  await assert.rejects(client.getPools(), (err) => {
    assert.ok(err instanceof OndiloAuthError);
    assert.match(err.message, /invalide ou révoqué/);
    return true;
  });
  assert.equal(http.countMatching('/pools'), 0, 'aucun appel métier ne doit partir sans jeton');
});

test('une réponse OAuth sans access_token est refusée', async () => {
  const { client, http } = build();
  http.on('/oauth2/token', { data: { token_type: 'Bearer' } });

  await assert.rejects(client.getPools(), (err) => {
    assert.ok(err instanceof OndiloAuthError);
    assert.match(err.message, /access_token/);
    return true;
  });
});

test('un 502 passager est retenté puis réussit', async () => {
  const { client, http } = build();
  let attempt = 0;
  http.on('/pools', () => {
    attempt += 1;
    if (attempt < 3) throw httpError(502);
    return { data: [{ id: 1 }] };
  });

  assert.deepEqual(await client.getPools(), [{ id: 1 }]);
  assert.equal(attempt, 3);
});

test('une panne réseau est retentée', async () => {
  const { client, http } = build();
  let attempt = 0;
  http.on('/pools', () => {
    attempt += 1;
    if (attempt === 1) throw networkError('EAI_AGAIN');
    return { data: [] };
  });

  await client.getPools();
  assert.equal(attempt, 2);
});

test('un 404 n\'est jamais retenté', async () => {
  const { client, http } = build();
  http.on('/pools', () => httpError(404));

  await assert.rejects(client.getPools(), err => err?.response?.status === 404);
  assert.equal(http.countMatching('/pools'), 1);
});

test('Retry-After est honoré au lieu du repli exponentiel', async () => {
  const { client, http } = build({ instantSleep: false });
  const delays = [];
  client._sleep = async (ms) => { delays.push(ms); };
  let attempt = 0;
  http.on('/pools', () => {
    attempt += 1;
    if (attempt === 1) throw httpError(429, { 'retry-after': '7' });
    return { data: [] };
  });

  await client.getPools();
  assert.ok(delays.includes(7000), `délais observés : ${delays.join(', ')}`);
});

test('un Retry-After trop long met fin au cycle au lieu de réessayer trop tôt', async () => {
  const { client, http } = build();
  http.on('/pools', () => httpError(429, { 'retry-after': '3600' }));

  await assert.rejects(client.getPools(), err => err?.response?.status === 429);
  assert.equal(http.countMatching('/pools'), 1, 'aucun réessai avant l\'échéance annoncée par Ondilo');
});

test('les appels sont espacés pour rester sous les 5 requêtes par seconde d\'Ondilo', async () => {
  const { client, http } = build({ instantSleep: false });
  const waits = [];
  client._sleep = async (ms) => { waits.push(ms); };
  http.on('/pools', { data: [] });

  await client.getPools();
  await client.getPools();
  await client.getPools();

  const spacing = waits.filter(ms => ms > 0 && ms <= 250);
  assert.ok(spacing.length >= 2, `espacements observés : ${waits.join(', ')}`);
});

test('un 401 tardif ne détruit pas un jeton déjà renouvelé par un autre appel', async () => {
  const { client } = build();
  client.accessToken = 'neuf';
  client.accessTokenExpiresAt = Date.now() + 3600000;

  assert.equal(client.invalidateAccessToken('perime'), false, 'le jeton neuf doit survivre');
  assert.equal(client.accessToken, 'neuf');

  assert.equal(client.invalidateAccessToken('neuf'), true);
  assert.equal(client.accessToken, null);
});

test('une attente de repli est coupée net par l\'arrêt du plugin', async () => {
  const { client } = build({ instantSleep: false });
  const started = Date.now();
  const waiting = client._sleep(5000);
  client.abortAll();
  await waiting;

  assert.ok(Date.now() - started < 1000, 'l\'arrêt ne doit pas attendre la fin du repli');
});

test('le quota horaire refuse le 26e appel au lieu de le lancer', async () => {
  const { client, http } = build();
  http.on('/pools', { data: [] });

  // Un POST /oauth2/token + (QUOTA_MAX - 1) GET consomment exactement le quota.
  await client.getPools();
  for (let i = 0; i < QUOTA_MAX - 2; i++) await client.getPools();
  assert.equal(client.quotaUsed(), QUOTA_MAX);

  const before = http.calls.length;
  await assert.rejects(client.getPools(), (err) => {
    assert.ok(err instanceof OndiloQuotaError);
    assert.match(err.message, /plafond 25/);
    return true;
  });
  assert.equal(http.calls.length, before, 'aucune requête ne doit sortir une fois le quota atteint');
});

test('la fenêtre de quota glisse : les appels de plus d\'une heure ne comptent plus', async () => {
  const { client, http } = build();
  http.on('/pools', { data: [] });
  await client.getPools();
  assert.ok(client.quotaUsed() > 0);

  client._calls = client._calls.map(stamp => stamp - 3600001);
  assert.equal(client.quotaUsed(), 0);
});

test('abortAll coupe le trafic : plus aucune requête, erreur ERR_CANCELED', async () => {
  const { client, http } = build();
  http.on('/pools', { data: [] });
  await client.getPools();
  const before = http.calls.length;

  client.abortAll();

  assert.equal(client.aborted, true);
  await assert.rejects(client.getPools(), err => err?.code === 'ERR_CANCELED');
  assert.equal(http.calls.length, before, 'aucune requête après l\'arrêt');
});

test('les endpoints construisent les URL attendues', async () => {
  const { client, http } = build();
  http.on('/pools/53865/device', { data: {} });
  http.on('/pools/53865/configuration', { data: {} });
  http.on('/pools/53865/recommendations/9', { data: 'Done' });
  http.on('/pools/53865/recommendations', { data: [] });
  http.on(/\/measures\?type=/, { data: [] });
  http.on('/user/units', { data: {} });

  await client.getDevice(53865);
  await client.getConfiguration(53865);
  await client.getRecommendations(53865);
  await client.validateRecommendation(53865, 9);
  await client.getMeasuresSet(53865, 'ph', 'day');
  await client.getUserUnits();

  const urls = http.urls.join('\n');
  assert.match(urls, /\/api\/customer\/v1\/pools\/53865\/device/);
  assert.match(urls, /\/api\/customer\/v1\/pools\/53865\/configuration/);
  assert.match(urls, /\/api\/customer\/v1\/pools\/53865\/recommendations$/m);
  assert.match(urls, /\/api\/customer\/v1\/pools\/53865\/recommendations\/9/);
  assert.match(urls, /\/api\/customer\/v1\/pools\/53865\/measures\?type=ph&period=day/);
  assert.match(urls, /\/api\/customer\/v1\/user\/units/);

  const put = http.calls.find(call => String(call.url).includes('recommendations/9'));
  assert.equal(put.method, 'put');
});

test('toutes les requêtes portent le jeton, un délai et le signal d\'annulation', async () => {
  const { client, http } = build();
  http.on('/pools', { data: [] });
  await client.getPools();

  const call = http.calls.find(entry => String(entry.url).endsWith('/pools'));
  assert.match(call.headers.Authorization, /^Bearer at-/);
  assert.equal(call.headers.Accept, 'application/json');
  assert.equal(typeof call.timeout, 'number');
  assert.ok(call.signal, 'le signal d\'AbortController doit être transmis à axios');
});
