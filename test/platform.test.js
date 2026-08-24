'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { httpError, networkError } = require('../test-helpers/http');
const {
  buildPlatform, happyRoutes, poolPayload, cachedAccessory, measure, isoMinutesAgo,
  POOL_ID, POOL_UUID,
} = require('../test-helpers/platform');
const { hap } = require('../test-helpers/fake-hap');

// ---------------------------------------------------------------------------
// Appairage : le seed d'UUID est l'invariant le plus critique du plugin.
// ---------------------------------------------------------------------------

test('le seed d\'UUID reste « ondilo:pool:<id> » et produit l\'UUID déjà appairé', async () => {
  const { platform, api, http } = buildPlatform();
  happyRoutes(http);
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.ok(api.uuidSeeds.includes(`ondilo:pool:${POOL_ID}`), `seeds observés : ${api.uuidSeeds.join(', ')}`);
  assert.deepEqual([...new Set(api.uuidSeeds)], [`ondilo:pool:${POOL_ID}`], 'aucun autre seed ne doit être calculé');
  assert.equal(api.registeredAccessories[0].UUID, POOL_UUID);
});

test('un accessoire déjà en cache est réutilisé, jamais recréé ni désenregistré', async () => {
  const cached = cachedAccessory();
  const { platform, api, http, log } = buildPlatform({}, { cached: [cached] });
  happyRoutes(http);
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.registered.length, 0, 'aucun registerPlatformAccessories sur un accessoire restauré');
  assert.equal(api.unregistered.length, 0);
  assert.equal(platform.accessories.get(POOL_UUID), cached);
  assert.ok(log.has('info', 'Accessoire existant réutilisé'));
});

// ---------------------------------------------------------------------------
// Démarrage : le plugin ne doit jamais rester mort.
// ---------------------------------------------------------------------------

test('un échec réseau au démarrage replanifie un cycle, puis la reprise crée l\'accessoire', async () => {
  const { platform, api, http, scheduled } = buildPlatform();
  happyRoutes(http);
  http.on('/pools', () => networkError('EAI_AGAIN'));
  api.emit('didFinishLaunching');

  assert.deepEqual(scheduled, [0], 'le timer est armé avant la première requête');

  await platform._tick();
  assert.equal(platform.discovered, false);
  assert.equal(api.registered.length, 0);
  assert.deepEqual(scheduled, [0, 30000], 'un nouveau cycle doit être planifié malgré l\'échec');

  http.on('/pools', { data: [poolPayload()] });
  await platform._tick();

  assert.equal(platform.discovered, true);
  assert.equal(api.registeredAccessories.length, 1);
  assert.equal(api.registeredAccessories[0].UUID, POOL_UUID);
});

test('les échecs de découverte successifs suivent le repli 30 s → 60 s → 120 s → 300 s', async () => {
  const { platform, api, http, scheduled } = buildPlatform();
  happyRoutes(http);
  http.on('/pools', () => httpError(503));
  api.emit('didFinishLaunching');

  for (let i = 0; i < 5; i++) await platform._tick();

  assert.deepEqual(scheduled, [0, 30000, 60000, 120000, 300000, 300000]);
});

test('le timer réel se déclenche vraiment au démarrage', async () => {
  const { platform, api, http } = buildPlatform({}, { realTimers: true });
  happyRoutes(http);
  const firstCall = new Promise((resolve) => {
    http.on('/pools', () => { resolve(); return { data: [poolPayload()] }; });
  });

  api.emit('didFinishLaunching');
  await firstCall;

  assert.ok(http.countMatching('/pools') >= 1);
  platform._stop();
});

// ---------------------------------------------------------------------------
// Configuration absente : Verified impose de ne pas démarrer, sans rien détruire.
// ---------------------------------------------------------------------------

test('sans refresh token le plugin n\'émet aucune requête et le dit clairement', async () => {
  const cached = cachedAccessory();
  const { platform, api, http, log } = buildPlatform({ refreshToken: null }, { cached: [cached] });
  happyRoutes(http);

  api.emit('didFinishLaunching');
  await new Promise(setImmediate);

  assert.equal(platform.client, undefined, 'aucun client HTTP ne doit être construit');
  assert.equal(http.calls.length, 0);
  assert.ok(log.has('error', 'Aucun refresh token'));
  assert.ok(log.has('error', 'npm run oauth'));
});

test('sans refresh token les accessoires en cache sont conservés et marqués en défaut', async () => {
  const cached = cachedAccessory();
  const { api, log } = buildPlatform({ refreshToken: '   ' }, { cached: [cached] });

  api.emit('didFinishLaunching');
  await new Promise(setImmediate);

  assert.equal(api.unregistered.length, 0, 'un champ vidé par erreur ne doit jamais désappairer');
  const ph = cached.getServiceById(hap.Service.LightSensor, 'ondilo:ph');
  assert.equal(ph.read(hap.Characteristic.StatusActive), false);
  assert.equal(ph.read(hap.Characteristic.StatusFault), hap.Characteristic.StatusFault.GENERAL_FAULT);
  assert.ok(log.has('error', 'conservés'));
});

// ---------------------------------------------------------------------------
// Réponses hostiles de /pools.
// ---------------------------------------------------------------------------

test('une entrée de /pools sans id ne crée aucun accessoire et le journal le nomme', async () => {
  const { platform, api, http, log, scheduled } = buildPlatform();
  happyRoutes(http, { pools: [{ name: 'Piscine sans identifiant' }, { id: null, name: 'Spa' }] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.registered.length, 0);
  assert.equal(api.unregistered.length, 0);
  assert.equal(platform.discovered, false);
  assert.ok(log.has('warn', 'aucune ne porte d\'identifiant'));
  assert.ok(scheduled.at(-1) > 0, 'un nouveau cycle reste planifié');
});

test('un /pools vide ne désenregistre rien', async () => {
  const cached = cachedAccessory();
  const { platform, api, http, log } = buildPlatform({}, { cached: [cached] });
  happyRoutes(http, { pools: [] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.unregistered.length, 0);
  assert.ok(log.has('warn', 'Aucun bassin trouvé'));
});

test('une entrée de /pools sans id ne fait pas passer un id valide à l\'écart', async () => {
  const { platform, api, http } = buildPlatform();
  happyRoutes(http, { pools: [{ name: 'sans id' }, poolPayload()] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.registeredAccessories.length, 1);
  assert.equal(api.registeredAccessories[0].UUID, POOL_UUID);
});

// ---------------------------------------------------------------------------
// Élagage : ne jamais désappairer sur une API muette.
// ---------------------------------------------------------------------------

test('l\'élagage ne désinscrit rien quand /pools échoue', async () => {
  const cached = cachedAccessory();
  const { platform, api, http } = buildPlatform({}, { cached: [cached] });
  happyRoutes(http);
  http.on('/pools', () => httpError(500));
  api.emit('didFinishLaunching');

  await platform._tick();
  await platform._tick();

  assert.equal(api.unregistered.length, 0);
  assert.equal(platform.accessories.size, 1);
});

test('l\'élagage ne désinscrit rien sur un 401 persistant, et le message nomme la cause', async () => {
  const cached = cachedAccessory();
  const { platform, api, http, log } = buildPlatform({}, { cached: [cached] });
  happyRoutes(http);
  http.on('/pools', () => httpError(401));
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.unregistered.length, 0);
  assert.ok(log.has('error', 'Authentification refusée'), log.text);
  assert.ok(log.has('error', 'npm run oauth'), log.text);
});

test('l\'élagage désinscrit un bassin réellement disparu du compte', async () => {
  const gone = cachedAccessory(99999, 'ICO Ancien spa');
  const { platform, api, http, log } = buildPlatform({}, { cached: [gone] });
  happyRoutes(http);
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.unregisteredAccessories.length, 1);
  assert.equal(api.unregisteredAccessories[0], gone);
  assert.ok(log.has('info', 'bassin absent du compte Ondilo'));
});

// ---------------------------------------------------------------------------
// Comptes à plusieurs bassins.
// ---------------------------------------------------------------------------

test('en disposition legacy un compte multi-bassins n\'en expose qu\'un et le dit', async () => {
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const { platform, api, http, log } = buildPlatform();
  happyRoutes(http, { pools: [poolPayload(), spa] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(platform.poolAccessories.size, 1);
  assert.deepEqual(api.uuidSeeds, ['ondilo:pool:53865']);
  assert.ok(log.has('info', 'n\'en expose qu\'un'), log.text);
});

test('un bassin hors du périmètre configuré est conservé, marqué en défaut, jamais supprimé', async () => {
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const keptOutOfScope = cachedAccessory(77777, 'ICO Spa');
  const { platform, api, http, log } = buildPlatform(
    { poolId: 53865 },
    { cached: [cachedAccessory(), keptOutOfScope] },
  );
  happyRoutes(http, { pools: [poolPayload(), spa] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(platform.poolAccessories.size, 1);
  assert.equal(api.unregistered.length, 0, 'un filtre de configuration ne doit jamais désappairer');
  const ph = keptOutOfScope.getServiceById(hap.Service.LightSensor, 'ondilo:ph');
  assert.equal(ph.read(hap.Characteristic.StatusActive), false);
  assert.equal(ph.read(hap.Characteristic.StatusFault), hap.Characteristic.StatusFault.GENERAL_FAULT);
  assert.ok(log.has('info', 'hors du périmètre configuré'), log.text);
});

test('en legacy, un bassin déjà appairé est préféré à l\'ordre de la réponse /pools', async () => {
  // /pools renvoie la piscine en premier, mais c'est le spa qui est appairé chez l'utilisateur.
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const pairedSpa = cachedAccessory(77777, 'ICO Spa');
  const { platform, api, http } = buildPlatform({}, { cached: [pairedSpa] });
  happyRoutes(http, { pools: [poolPayload(), spa], extraPools: [{ id: 77777 }] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.registered.length, 0, 'aucun nouvel accessoire ne doit apparaître');
  assert.deepEqual([...platform.poolAccessories.keys()], [pairedSpa.UUID]);
});

test('en disposition grouped tous les bassins du compte sont exposés', async () => {
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const { platform, api, http } = buildPlatform({ layout: 'grouped' });
  happyRoutes(http, { pools: [poolPayload(), spa], extraPools: [{ id: 77777 }] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(platform.poolAccessories.size, 2);
  assert.deepEqual(
    api.uuidSeeds.slice().sort(),
    ['ondilo:pool:53865', 'ondilo:pool:77777'],
  );
});

test('un poolId inconnu ne crée rien et journalise les identifiants disponibles', async () => {
  const { platform, api, http, log } = buildPlatform({ poolId: 12345 });
  happyRoutes(http);
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.registered.length, 0);
  assert.ok(log.has('error', 'Identifiant de bassin introuvable'));
  assert.ok(log.has('error', '53865 (Piscine)'), log.text);
});

test('un poolId explicite cible bien ce bassin', async () => {
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const { platform, api, http } = buildPlatform({ poolId: 77777 });
  happyRoutes(http, { pools: [poolPayload(), spa], extraPools: [{ id: 77777 }] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.deepEqual(api.uuidSeeds, ['ondilo:pool:77777']);
});

// ---------------------------------------------------------------------------
// Normalisation de la configuration.
// ---------------------------------------------------------------------------

test('phLuxScale : défaut 100, valeur 1 respectée, valeur absurde ramenée au défaut', () => {
  assert.equal(buildPlatform({}).platform.phLuxScale, 100);
  assert.equal(buildPlatform({ phLuxScale: 1 }).platform.phLuxScale, 1);
  assert.equal(buildPlatform({ phLuxScale: 100 }).platform.phLuxScale, 100);

  for (const bad of [0, -5, 'abc', NaN, Infinity]) {
    const { platform, log } = buildPlatform({ phLuxScale: bad });
    assert.equal(platform.phLuxScale, 100, `phLuxScale=${String(bad)}`);
    assert.ok(log.has('warn', 'Facteur d\'échelle du pH invalide'));
  }
});

test('phLuxScale hors plage est ramené dans les bornes et signalé', () => {
  const high = buildPlatform({ phLuxScale: 99999 });
  assert.equal(high.platform.phLuxScale, 1000);
  assert.ok(high.log.has('warn', 'Facteur d\'échelle du pH'), high.log.text);

  const low = buildPlatform({ phLuxScale: 0.25 });
  assert.equal(low.platform.phLuxScale, 1);
});

test('updateInterval : défaut, plancher, plafond et valeurs absurdes', () => {
  assert.equal(buildPlatform({}).platform.updateInterval, 3600);
  assert.equal(buildPlatform({ updateInterval: 7200 }).platform.updateInterval, 7200);

  const floored = buildPlatform({ updateInterval: 60 });
  assert.equal(floored.platform.updateInterval, 1800);
  assert.ok(floored.log.has('warn', 'ramené à 1800 s'));

  const capped = buildPlatform({ updateInterval: 999999 });
  assert.equal(capped.platform.updateInterval, 21600);

  const bad = buildPlatform({ updateInterval: 'souvent' });
  assert.equal(bad.platform.updateInterval, 3600);
  assert.ok(bad.log.has('warn', 'Intervalle de mise à jour invalide'));
});

test('staleAfterMs vaut trois cycles', () => {
  assert.equal(buildPlatform({ updateInterval: 3600 }).platform.staleAfterMs, 3 * 3600 * 1000);
});

test('les mesures inconnues sont écartées, une sélection vide retombe sur le défaut', () => {
  const partial = buildPlatform({ measures: ['temperature', 'chlore', 'PH'] });
  assert.deepEqual(partial.platform.measures, ['temperature', 'ph']);
  assert.ok(partial.log.has('warn', 'Mesure inconnue'));

  const empty = buildPlatform({ measures: ['chlore'] });
  assert.deepEqual(empty.platform.measures, ['temperature', 'ph', 'orp', 'battery']);
  assert.ok(empty.log.has('warn', 'Aucune mesure valide'));
});

test('poolId accepte un scalaire comme un tableau, et déduplique', () => {
  assert.deepEqual(buildPlatform({ poolId: 53865 }).platform.poolIds, ['53865']);
  assert.deepEqual(buildPlatform({ poolId: [53865, '53865', 77777] }).platform.poolIds, ['53865', '77777']);
  assert.deepEqual(buildPlatform({ poolId: '' }).platform.poolIds, []);
  assert.deepEqual(buildPlatform({}).platform.poolIds, []);
});

// ---------------------------------------------------------------------------
// Cycle de vie.
// ---------------------------------------------------------------------------

test('l\'arrêt de Homebridge coupe la planification et annule les requêtes en vol', async () => {
  const { platform, api, http, scheduled } = buildPlatform();
  happyRoutes(http);
  api.emit('didFinishLaunching');
  await platform._tick();
  const before = http.calls.length;

  api.emit('shutdown');

  assert.equal(platform.stopped, true);
  assert.equal(platform.client.aborted, true);
  scheduled.length = 0;
  await platform._tick();
  assert.equal(http.calls.length, before, 'aucune requête après l\'arrêt');
  assert.deepEqual(scheduled, [], 'aucun cycle replanifié après l\'arrêt');
});

test('deux cycles ne se chevauchent pas', async () => {
  const { platform, api, http, log } = buildPlatform();
  happyRoutes(http);
  let release;
  http.on('/pools', () => new Promise((resolve) => { release = () => resolve({ data: [poolPayload()] }); }));
  api.emit('didFinishLaunching');

  const first = platform._tick();
  await new Promise(setImmediate);
  const second = platform._tick();
  await second;
  release();
  await first;

  const discoveryCalls = http.urls.filter(url => url.endsWith('/v1/pools')).length;
  assert.equal(discoveryCalls, 1, 'le second cycle doit avoir été sauté');
  assert.ok(log.has('debug', 'ce tick est sauté') || log.has('info', 'ce tick est sauté'), log.text);
});

test('le prochain cycle vise le relevé suivant, pas un intervalle aveugle', () => {
  const { platform } = buildPlatform({ updateInterval: 3600 });
  const nominal = 3600 * 1000;

  assert.equal(platform._nextDelayMs(null), nominal);
  // Mesure vieille de 10 min : le relevé suivant tombe dans ~55 min, sous le nominal.
  const target = platform._nextDelayMs(Date.now() - 10 * 60000);
  assert.ok(target > 3000000 && target < nominal, `délai calculé : ${target}`);
  // Relevé imminent : on l'attend vraiment au lieu de le manquer d'une demi-heure.
  const almostDue = platform._nextDelayMs(Date.now() - 59 * 60000);
  assert.ok(almostDue > 0 && almostDue <= 6 * 60000, `délai calculé : ${almostDue}`);
  // Sonde muette depuis des heures : retour à la cadence nominale, pas de cycle serré.
  assert.equal(platform._nextDelayMs(Date.now() - 10 * 3600 * 1000), nominal);
});

test('logLevel « debug » remonte les messages de diagnostic dans le journal principal', () => {
  const quiet = buildPlatform({});
  quiet.platform.dbg('coucou');
  assert.ok(quiet.log.has('debug', 'coucou'));
  assert.ok(!quiet.log.has('info', 'coucou'));

  const verbose = buildPlatform({ logLevel: 'debug' });
  verbose.platform.dbg('coucou');
  assert.ok(verbose.log.has('info', 'coucou'));
});

test('rien ne part avant didFinishLaunching, même avec une configuration complète', async () => {
  const { http, scheduled, platform } = buildPlatform();
  happyRoutes(http);

  await new Promise(setImmediate);

  assert.equal(http.calls.length, 0, 'aucune requête avant le signal de démarrage de Homebridge');
  assert.deepEqual(scheduled, [], 'aucun cycle planifié avant le signal de démarrage');
  assert.equal(platform.discovered, false);
});

test('une panne réseau prolongée ne fait pas dépasser le quota Ondilo, et le plugin repart après', async () => {
  const { platform, api, http, scheduled } = buildPlatform();
  happyRoutes(http);
  http.on('/pools', () => networkError('ENOTFOUND'));
  api.emit('didFinishLaunching');

  for (let i = 0; i < 20; i++) await platform._tick();

  assert.ok(http.calls.length <= 25, `${http.calls.length} requêtes émises pour un plafond de 25`);
  assert.equal(platform.discovered, false);
  assert.ok(scheduled.at(-1) > 0, 'le plugin continue de planifier des cycles');

  // La fenêtre de quota glisse et le réseau revient : la reprise doit se faire seule.
  platform.client._calls = [];
  http.on('/pools', { data: [poolPayload()] });
  await platform._tick();

  assert.equal(platform.discovered, true);
  assert.equal(api.registeredAccessories.length, 1);
});

test('un intervalle plus long que la période de mesure est respecté, pas raccourci par l\'alignement', () => {
  const tenMinutesAgo = Date.now() - 10 * 60000;

  // Cadence de la sonde : l'alignement affine, la mesure devient plus fraîche à coût égal.
  assert.ok(buildPlatform({ updateInterval: 3600 }).platform._nextDelayMs(tenMinutesAgo) < 3600 * 1000);

  // Cadence volontairement plus lente : l'utilisateur veut moins d'appels, pas plus.
  for (const seconds of [7200, 10800, 21600]) {
    const { platform } = buildPlatform({ updateInterval: seconds });
    assert.equal(platform._nextDelayMs(tenMinutesAgo), seconds * 1000, `updateInterval ${seconds}`);
  }
});

// ---------------------------------------------------------------------------
// Findings de la review adversariale Codex.
// ---------------------------------------------------------------------------

test('F-1 : une réponse /pools contenant une entrée illisible ne désenregistre rien', async () => {
  const spa = cachedAccessory(77777, 'ICO Spa');
  const { platform, api, http, log } = buildPlatform({}, { cached: [cachedAccessory(), spa] });
  happyRoutes(http, { pools: [poolPayload(), { name: 'entrée sans identifiant' }] });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(api.unregistered.length, 0, 'une vue partielle du compte ne prouve aucune suppression');
  assert.ok(platform.accessories.has(spa.UUID));
  assert.ok(log.has('warn', 'réponse jugée incomplète'), log.text);
});

test('F-2 : les tuiles restaurées sont invérifiables tant qu\'aucun cycle n\'a abouti', async () => {
  const cached = cachedAccessory();
  const ph = cached.getServiceById(hap.Service.LightSensor, 'ondilo:ph');
  ph.updateCharacteristic(hap.Characteristic.StatusActive, true);
  ph.updateCharacteristic(hap.Characteristic.StatusFault, hap.Characteristic.StatusFault.NO_FAULT);

  const { api, http } = buildPlatform({}, { cached: [cached] });
  happyRoutes(http);
  http.on('/pools', () => httpError(404));
  api.emit('didFinishLaunching');

  assert.equal(ph.read(hap.Characteristic.StatusActive), false,
    'une valeur héritée du dernier arrêt ne doit jamais passer pour fraîche');
  assert.equal(ph.read(hap.Characteristic.StatusFault), hap.Characteristic.StatusFault.GENERAL_FAULT);
});

test('F-3 : la réussite d\'un bassin ne clôt pas la découverte quand un autre a échoué', async () => {
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const { platform, api, http } = buildPlatform({ layout: 'grouped' });
  happyRoutes(http, { pools: [poolPayload(), spa] });
  http.on('/pools/77777/device', { data: {} });
  http.on('/pools/77777/configuration', { data: {} });
  http.on('/pools/77777/lastmeasures', { data: [] });

  const original = platform._setupPool.bind(platform);
  platform._setupPool = (pool) => {
    if (String(pool.id) === '77777') throw new Error('échec simulé de configuration');
    return original(pool);
  };
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(platform.discovered, false, 'le spa doit rester à découvrir');
  assert.equal(platform.poolAccessories.size, 1, 'la piscine reste opérationnelle');
});

test('F-4 : un enregistrement refusé ne laisse pas d\'accessoire fantôme', async () => {
  const { platform, api, http } = buildPlatform();
  happyRoutes(http);
  api.registerPlatformAccessories = () => { throw new Error('Homebridge refuse'); };
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.equal(platform.poolAccessories.size, 0, 'rien ne doit être rafraîchi dans le vide');
  assert.equal(platform.accessories.size, 0);
  assert.equal(platform.discovered, false, 'la découverte doit être retentée');
});

test('F-6 : une réponse /pools inexploitable est retentée vite, un compte vide lentement', async () => {
  const malformed = buildPlatform();
  happyRoutes(malformed.http, { pools: [{ name: 'sans id' }] });
  malformed.api.emit('didFinishLaunching');
  await malformed.platform._tick();
  assert.equal(malformed.scheduled.at(-1), 30000, 'anomalie serveur : repli court');

  const empty = buildPlatform();
  happyRoutes(empty.http, { pools: [] });
  empty.api.emit('didFinishLaunching');
  await empty.platform._tick();
  assert.equal(empty.scheduled.at(-1), 3600 * 1000, 'compte réellement vide : cadence nominale');
});

test('F-7 : les unités sont réessayées aux cycles suivants après un échec', async () => {
  const ctx = buildPlatform({ measures: ['salt'] });
  happyRoutes(ctx.http, {
    pools: [poolPayload({ disinfection: { primary: 'salt' } })],
    lastmeasures: [measure('salt', 3200)],
  });
  ctx.http.on('/user/units', () => httpError(500));
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();
  const afterFirst = ctx.http.countMatching('/user/units');
  assert.ok(afterFirst >= 1);

  ctx.http.on('/user/units', { data: { salt: 'GRAM_PER_LITER' } });
  await ctx.platform._tick();

  assert.ok(ctx.http.countMatching('/user/units') > afterFirst, 'le cycle suivant doit retenter');
  assert.equal(ctx.platform.units?.salt, 'GRAM_PER_LITER');
});

test('F-10 : la prochaine échéance sert le bassin le plus en retard, pas le plus récent', async () => {
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const { platform, api, http, scheduled } = buildPlatform({ layout: 'grouped' });
  happyRoutes(http, {
    pools: [poolPayload(), spa],
    lastmeasures: [measure('temperature', 26, { value_time: isoMinutesAgo(1) })],
    extraPools: [{ id: 77777, lastmeasures: [measure('temperature', 30, { value_time: isoMinutesAgo(59) })] }],
  });
  api.emit('didFinishLaunching');

  await platform._tick();

  assert.ok(scheduled.at(-1) <= 6 * 60000,
    `le spa a 59 min de retard, le cycle suivant doit venir vite (${scheduled.at(-1)} ms)`);
});

test('F-14 : un refus d\'authentification arrête le cycle au lieu de le rejouer endpoint par endpoint', async () => {
  const { platform, api, http } = buildPlatform();
  happyRoutes(http);
  for (const route of ['/pools/53865/device', '/pools/53865/configuration', '/lastmeasures']) {
    http.on(route, () => httpError(401));
  }
  api.emit('didFinishLaunching');

  await platform._tick();

  const tokenPosts = http.countMatching('/oauth2/token');
  assert.ok(tokenPosts <= 2, `${tokenPosts} renouvellements de jeton pour un seul cycle`);
  assert.equal(http.urls.filter(u => u.includes('/configuration')).length, 0,
    'le premier refus doit couper le cycle avant les endpoints suivants');
});

test('F-17 : l\'ordre des bassins tourne d\'un cycle à l\'autre', async () => {
  const spa = poolPayload({ id: 77777, name: 'Spa' });
  const { platform, api, http } = buildPlatform({ layout: 'grouped' });
  happyRoutes(http, { pools: [poolPayload(), spa], extraPools: [{ id: 77777 }] });
  api.emit('didFinishLaunching');

  await platform._tick();
  const first = [...platform.poolAccessories.keys()];
  await platform._tick();
  const second = [...platform.poolAccessories.keys()];

  assert.notDeepEqual(first, second, 'le même bassin ne doit pas être servi en dernier à chaque cycle');
  assert.deepEqual([...first].sort(), [...second].sort(), 'aucun bassin ne disparaît au passage');
});

test('F-27 : « Détaillé » remonte aussi les diagnostics du bassin et du client HTTP', async () => {
  const ctx = buildPlatform({ logLevel: 'debug' });
  happyRoutes(ctx.http, {
    lastmeasures: [measure('ph', 3.1, { is_valid: false, exclusion_reason: 'probe out of water' })],
  });
  ctx.api.emit('didFinishLaunching');
  await ctx.platform._tick();

  assert.ok(ctx.log.has('info', 'probe out of water'),
    'le motif de rejet doit être visible sans passer Homebridge entier en debug');
});

test('F-27 : « Détaillé » remonte aussi les messages du client HTTP', async () => {
  const quiet = buildPlatform({});
  happyRoutes(quiet.http);
  quiet.api.emit('didFinishLaunching');
  await quiet.platform._tick();
  assert.ok(quiet.log.has('debug', 'Jeton d\'accès renouvelé'), quiet.log.text);
  assert.ok(!quiet.log.has('info', 'Jeton d\'accès renouvelé'));

  const verbose = buildPlatform({ logLevel: 'debug' });
  happyRoutes(verbose.http);
  verbose.api.emit('didFinishLaunching');
  await verbose.platform._tick();

  assert.ok(verbose.log.has('info', 'Jeton d\'accès renouvelé'),
    'le client HTTP doit suivre l\'option, pas le logger debug global de Homebridge');
});
