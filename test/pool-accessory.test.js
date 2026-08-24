'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { httpError } = require('../test-helpers/http');
const {
  buildPlatform, happyRoutes, poolPayload, measure, isoMinutesAgo, cachedAccessory,
  RECOMMENDATION_PUT,
} = require('../test-helpers/platform');
const { hap, boundsViolations, resetBoundsViolations } = require('../test-helpers/fake-hap');

const C = hap.Characteristic;
const S = hap.Service;

/** Monte la plateforme, joue un cycle complet, rend l'accessoire du bassin. */
async function cycle(config = {}, routes = {}, options = {}) {
  const ctx = buildPlatform(config, options);
  happyRoutes(ctx.http, routes);
  ctx.api.emit('didFinishLaunching');
  await ctx.platform._tick();
  const poolAccessory = ctx.platform.poolAccessories.values().next().value;
  return { ...ctx, poolAccessory, accessory: poolAccessory && poolAccessory.accessory };
}

function svc(accessory, subtype) {
  return accessory.services.find(service => service.subtype === subtype) || null;
}

const ALL_MEASURES = ['temperature', 'ph', 'orp', 'salt', 'tds', 'battery', 'rssi'];

// ---------------------------------------------------------------------------
// Conversion du pH — le changement de comportement de la 1.0.0.
// ---------------------------------------------------------------------------

test('le pH est publié en lux à l\'échelle 100 : 7,24 devient 724 lx', async () => {
  const { accessory, platform } = await cycle({}, { lastmeasures: [measure('ph', 7.24)] });
  const ph = svc(accessory, 'ondilo:ph');

  assert.equal(ph.UUID, S.LightSensor.UUID, 'le pH reste porté par un capteur de luminosité');
  assert.equal(ph.read(C.CurrentAmbientLightLevel), 724);
  assert.equal(ph.read(platform.customCharacteristics.WaterPh), 7.24, 'la valeur brute reste lisible dans Eve');
});

test('les bornes de la plage utile restent distinctes une fois arrondies à l\'entier', async () => {
  const seen = [];
  for (const value of [6.8, 7.0, 7.24, 7.6, 8.2]) {
    const { accessory } = await cycle({}, { lastmeasures: [measure('ph', value)] });
    seen.push(svc(accessory, 'ondilo:ph').read(C.CurrentAmbientLightLevel));
  }

  assert.deepEqual(seen, [680, 700, 724, 760, 820]);
  // C'est tout l'objet du correctif : à l'échelle 1:1 l'app Maison n'affichait que 7 et 8.
  assert.equal(new Set(seen.map(Math.round)).size, seen.length);
});

test('phLuxScale = 1 restaure le comportement brut de la 0.5.x', async () => {
  const { accessory } = await cycle({ phLuxScale: 1 }, { lastmeasures: [measure('ph', 7.24)] });
  assert.equal(svc(accessory, 'ondilo:ph').read(C.CurrentAmbientLightLevel), 7.24);
});

test('phLuxScale s\'applique tel quel aux valeurs intermédiaires', async () => {
  const { accessory } = await cycle({ phLuxScale: 10 }, { lastmeasures: [measure('ph', 7.24)] });
  assert.equal(svc(accessory, 'ondilo:ph').read(C.CurrentAmbientLightLevel), 72.4);
});

test('les bornes de la plage physique du pH sont publiées telles quelles', async () => {
  resetBoundsViolations();

  for (const [raw, expectedLux, expectedPh] of [[0, 0.0001, 0], [14, 1400, 14], [6.8, 680, 6.8]]) {
    const { accessory, platform } = await cycle({}, { lastmeasures: [measure('ph', raw)] });
    const ph = svc(accessory, 'ondilo:ph');
    assert.equal(ph.read(C.CurrentAmbientLightLevel), expectedLux, `pH brut ${raw}`);
    assert.equal(ph.read(platform.customCharacteristics.WaterPh), expectedPh, `pH brut ${raw}`);
  }

  assert.deepEqual(boundsViolations, [], 'aucune valeur ne doit sortir des bornes HAP');
});

test('une valeur physiquement impossible n\'est pas écrêtée mais refusée', async () => {
  for (const raw of [99, -3, 500]) {
    const { accessory, platform, log } = await cycle({}, { lastmeasures: [measure('ph', raw)] });
    const ph = svc(accessory, 'ondilo:ph');
    // Écrêter un pH de 99 à 14 publierait une mesure inventée, parfaitement crédible dans Maison.
    assert.equal(ph.read(platform.customCharacteristics.WaterPh), 0, `pH brut ${raw}`);
    assert.equal(ph.read(C.StatusActive), false, `pH brut ${raw}`);
    assert.equal(ph.read(C.StatusFault), C.StatusFault.GENERAL_FAULT, `pH brut ${raw}`);
    assert.ok(log.has('debug', 'hors de toute plage physique'), log.text);
  }
});

test('même au facteur d\'échelle maximal le pH reste sous le plafond HAP de 100 000 lx', async () => {
  resetBoundsViolations();
  const { accessory } = await cycle({ phLuxScale: 1000 }, { lastmeasures: [measure('ph', 14)] });

  assert.equal(svc(accessory, 'ondilo:ph').read(C.CurrentAmbientLightLevel), 14000);
  assert.deepEqual(boundsViolations, []);
});

test('en mode humidité le pH devient un pourcentage de la plage 0-14', async () => {
  const { accessory } = await cycle({ phService: 'humidity' }, { lastmeasures: [measure('ph', 7)] });
  const ph = svc(accessory, 'ondilo:ph');

  assert.equal(ph.UUID, S.HumiditySensor.UUID);
  assert.equal(ph.read(C.CurrentRelativeHumidity), 50);
});

test('la caractéristique Eve s\'ajoute à côté du capteur de luminosité, jamais à sa place', async () => {
  const { accessory, platform } = await cycle({ measures: ALL_MEASURES }, {
    pools: [poolPayload({ disinfection: { primary: 'salt' } })],
    lastmeasures: [measure('ph', 7.2), measure('orp', 700), measure('salt', 3200)],
  });
  const custom = platform.customCharacteristics;

  for (const [subtype, Ctor] of [['ondilo:ph', custom.WaterPh], ['ondilo:orp', custom.WaterOrp], ['ondilo:salt', custom.WaterSalinity]]) {
    const service = svc(accessory, subtype);
    assert.equal(service.UUID, S.LightSensor.UUID, subtype);
    assert.ok(service.testCharacteristic(C.CurrentAmbientLightLevel), `${subtype} garde CurrentAmbientLightLevel`);
    assert.ok(service.testCharacteristic(Ctor), `${subtype} porte aussi sa caractéristique Eve`);
  }
});

// ---------------------------------------------------------------------------
// Mesures invalides et fraîcheur.
// ---------------------------------------------------------------------------

test('une mesure marquée is_valid: false n\'est pas publiée et le capteur passe en défaut', async () => {
  const { accessory, platform } = await cycle({}, {
    lastmeasures: [
      measure('temperature', 26.4),
      measure('ph', 3.1, { is_valid: false, exclusion_reason: 'probe out of water' }),
    ],
  });
  const ph = svc(accessory, 'ondilo:ph');

  assert.equal(ph.read(C.CurrentAmbientLightLevel), 0.0001, 'la valeur reste à son défaut, jamais 310 lx');
  assert.equal(ph.read(platform.customCharacteristics.WaterPh), 0);
  assert.equal(ph.read(C.StatusActive), false);
  assert.equal(ph.read(C.StatusFault), C.StatusFault.GENERAL_FAULT);
});

test('le motif d\'exclusion d\'Ondilo est journalisé', async () => {
  const { log } = await cycle({}, {
    lastmeasures: [measure('ph', 3.1, { is_valid: false, exclusion_reason: 'probe out of water' })],
  });

  assert.ok(log.has('debug', 'probe out of water'), log.text);
  assert.ok(log.has('debug', 'déclarée invalide'), log.text);
});

test('une mesure invalide n\'écrase pas la dernière valeur connue', async () => {
  const cached = cachedAccessory();
  const ctx = buildPlatform({}, { cached: [cached] });
  happyRoutes(ctx.http, { lastmeasures: [measure('ph', 7.24)] });
  ctx.api.emit('didFinishLaunching');
  await ctx.platform._tick();
  assert.equal(svc(cached, 'ondilo:ph').read(C.CurrentAmbientLightLevel), 724);

  ctx.http.on('/lastmeasures', { data: [measure('ph', 3.1, { is_valid: false })] });
  ctx.platform.discovered = true;
  await ctx.platform._tick();

  const ph = svc(cached, 'ondilo:ph');
  assert.equal(ph.read(C.CurrentAmbientLightLevel), 724, 'la dernière valeur crédible est conservée');
  assert.equal(ph.read(C.StatusActive), false, 'mais elle est signalée comme non fiable');
});

test('une mesure fraîche est active et sans défaut', async () => {
  const { accessory } = await cycle({}, { lastmeasures: [measure('temperature', 26.4)] });
  const temperature = svc(accessory, 'ondilo:temperature');

  assert.equal(temperature.read(C.CurrentTemperature), 26.4);
  assert.equal(temperature.read(C.StatusActive), true);
  assert.equal(temperature.read(C.StatusFault), C.StatusFault.NO_FAULT);
});

test('une mesure périmée reste affichée mais passe en défaut', async () => {
  const stale = measure('temperature', 26.4, { value_time: isoMinutesAgo(4 * 60) });
  const { accessory, log } = await cycle({ updateInterval: 3600 }, { lastmeasures: [stale] });
  const temperature = svc(accessory, 'ondilo:temperature');

  assert.equal(temperature.read(C.CurrentTemperature), 26.4);
  assert.equal(temperature.read(C.StatusActive), false);
  assert.equal(temperature.read(C.StatusFault), C.StatusFault.GENERAL_FAULT);
  assert.ok(log.has('debug', 'horodatage'), log.text);
});

test('une mesure sans horodatage exploitable est traitée comme suspecte', async () => {
  for (const value_time of [undefined, null, '', 'pas une date']) {
    const { accessory } = await cycle({}, { lastmeasures: [measure('temperature', 26.4, { value_time })] });
    const temperature = svc(accessory, 'ondilo:temperature');
    assert.equal(temperature.read(C.StatusActive), false, `value_time = ${String(value_time)}`);
    assert.equal(temperature.read(C.StatusFault), C.StatusFault.GENERAL_FAULT);
  }
});

test('un doublon dans /lastmeasures : c\'est la mesure la plus récente qui gagne', async () => {
  const { accessory } = await cycle({}, {
    lastmeasures: [
      measure('temperature', 20, { value_time: isoMinutesAgo(180) }),
      measure('temperature', 26.4, { value_time: isoMinutesAgo(5) }),
      measure('temperature', 22, { value_time: isoMinutesAgo(90) }),
    ],
  });

  assert.equal(svc(accessory, 'ondilo:temperature').read(C.CurrentTemperature), 26.4);
});

test('une valeur non numérique est ignorée', async () => {
  const { accessory } = await cycle({}, {
    lastmeasures: [measure('temperature', 'chaud'), measure('ph', Number.NaN), measure('orp', 690)],
  });

  assert.equal(svc(accessory, 'ondilo:temperature').read(C.StatusActive), false);
  assert.equal(svc(accessory, 'ondilo:ph').read(C.StatusActive), false);
  assert.equal(svc(accessory, 'ondilo:orp').read(C.StatusActive), true);
});

test('une réponse /lastmeasures qui n\'est pas un tableau est refusée sans faire tomber le cycle', async () => {
  const { accessory, log, platform } = await cycle({}, { lastmeasures: { error: 'nope' } });

  assert.ok(log.has('warn', 'autre chose qu\'un tableau'), log.text);
  assert.equal(svc(accessory, 'ondilo:temperature').read(C.StatusActive), false);
  assert.equal(platform.discovered, true, 'le plugin reste vivant');
});

test('un /lastmeasures en erreur marque l\'accessoire indisponible sans le supprimer', async () => {
  const ctx = buildPlatform();
  happyRoutes(ctx.http);
  ctx.http.on('/lastmeasures', () => httpError(500));
  ctx.api.emit('didFinishLaunching');
  await ctx.platform._tick();

  const accessory = ctx.api.registeredAccessories[0];
  assert.equal(ctx.api.unregistered.length, 0);
  assert.equal(svc(accessory, 'ondilo:temperature').read(C.StatusActive), false);
  assert.ok(ctx.log.has('warn', 'Échec /lastmeasures'), ctx.log.text);
});

// ---------------------------------------------------------------------------
// Repli sur l'historique 24 h.
// ---------------------------------------------------------------------------

test('une mesure absente de /lastmeasures est récupérée dans l\'historique', async () => {
  const { accessory, http } = await cycle({}, {
    lastmeasures: [measure('temperature', 26.4)],
    history: { data: [measure('ph', 7.31, { value_time: isoMinutesAgo(30) })] },
  });

  assert.ok(http.urls.some(url => url.includes('/measures?type=')));
  assert.equal(svc(accessory, 'ondilo:ph').read(C.CurrentAmbientLightLevel), 731);
});

test('le repli est plafonné à deux types par cycle', async () => {
  const { http } = await cycle({}, { lastmeasures: [], history: { data: [] } });

  const fallbackCalls = http.urls.filter(url => url.includes('/measures?type=')).length;
  assert.equal(fallbackCalls, 2, '4 mesures manquantes, mais au plus 2 requêtes de repli');
});

test('le repli tourne d\'un cycle à l\'autre au lieu de rejouer les deux mêmes types', async () => {
  const ctx = buildPlatform();
  happyRoutes(ctx.http, { lastmeasures: [], history: { data: [] } });
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();
  const firstRound = ctx.http.urls.filter(url => url.includes('/measures?type='));
  await ctx.platform._tick();
  const secondRound = ctx.http.urls.filter(url => url.includes('/measures?type=')).slice(firstRound.length);

  assert.equal(firstRound.length, 2);
  assert.equal(secondRound.length, 2);
  assert.notDeepEqual(firstRound, secondRound, 'le tourniquet doit changer de types');
});

test('le repli ne va pas rechercher un type qu\'Ondilo vient de déclarer invalide', async () => {
  const { http } = await cycle({}, {
    lastmeasures: [
      measure('temperature', 26.4),
      measure('orp', 690),
      measure('battery', 87),
      measure('ph', 3.1, { is_valid: false }),
    ],
    history: { data: [measure('ph', 3.1)] },
  });

  assert.equal(http.urls.filter(url => url.includes('/measures?type=')).length, 0);
});

test('l\'historique retient le point valide le plus récent', async () => {
  const { accessory } = await cycle({}, {
    lastmeasures: [measure('temperature', 26.4), measure('orp', 690), measure('battery', 87)],
    history: {
      data: [
        measure('ph', 7.9, { value_time: isoMinutesAgo(20) }),
        measure('ph', 9.9, { value_time: isoMinutesAgo(5), is_valid: false }),
        measure('ph', 7.1, { value_time: isoMinutesAgo(200) }),
      ],
    },
  });

  assert.equal(svc(accessory, 'ondilo:ph').read(C.CurrentAmbientLightLevel), 790);
});

test('le repli peut être désactivé', async () => {
  const { http } = await cycle({ useMeasuresFallback: false }, { lastmeasures: [] });
  assert.equal(http.urls.filter(url => url.includes('/measures?type=')).length, 0);
});

// ---------------------------------------------------------------------------
// Tuile de synthèse et seuils.
// ---------------------------------------------------------------------------

test('la qualité de l\'eau n\'annonce « Excellent » que sur des données complètes et fraîches', async () => {
  const { accessory } = await cycle();
  const quality = svc(accessory, 'ondilo:quality');

  assert.equal(quality.read(C.AirQuality), C.AirQuality.EXCELLENT);
  assert.equal(quality.read(C.StatusActive), true);
});

test('une mesure manquante fait retomber la qualité de l\'eau sur « Inconnu »', async () => {
  const { accessory } = await cycle({}, {
    lastmeasures: [measure('temperature', 26.4), measure('orp', 690), measure('battery', 87)],
    history: { data: [] },
  });
  const quality = svc(accessory, 'ondilo:quality');

  assert.equal(quality.read(C.AirQuality), C.AirQuality.UNKNOWN);
  assert.equal(quality.read(C.StatusFault), C.StatusFault.GENERAL_FAULT);
});

test('un dépassement de seuil est signalé même sur données partielles', async () => {
  const { accessory } = await cycle({}, {
    lastmeasures: [measure('temperature', 26.4), measure('ph', 8.6), measure('battery', 87)],
    history: { data: [] },
  });

  assert.equal(svc(accessory, 'ondilo:quality').read(C.AirQuality), C.AirQuality.FAIR);
});

test('deux dépassements donnent « Médiocre »', async () => {
  const { accessory } = await cycle({}, {
    lastmeasures: [measure('temperature', 26.4), measure('ph', 8.6), measure('orp', 300), measure('battery', 87)],
  });

  assert.equal(svc(accessory, 'ondilo:quality').read(C.AirQuality), C.AirQuality.POOR);
});

test('des seuils indisponibles ne produisent jamais « Excellent »', async () => {
  const { accessory } = await cycle({}, { configuration: {} });

  assert.equal(svc(accessory, 'ondilo:quality').read(C.AirQuality), C.AirQuality.UNKNOWN);
});

test('les capteurs de contact « hors plage » suivent les seuils du compte Ondilo', async () => {
  const { accessory } = await cycle({ outOfRangeSensors: true }, {
    lastmeasures: [measure('temperature', 26.4), measure('ph', 8.6), measure('orp', 690), measure('battery', 87)],
  });

  assert.equal(svc(accessory, 'ondilo:range:ph').read(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
  assert.equal(svc(accessory, 'ondilo:range:orp').read(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
  assert.equal(svc(accessory, 'ondilo:range:ph').read(C.StatusActive), true);
});

// ---------------------------------------------------------------------------
// Les autres grandeurs.
// ---------------------------------------------------------------------------

test('toutes les grandeurs restent dans les bornes HAP sur un cycle complet', async () => {
  resetBoundsViolations();
  await cycle({ measures: ALL_MEASURES, outOfRangeSensors: true }, {
    pools: [poolPayload({ disinfection: { primary: 'salt' } })],
    lastmeasures: [
      measure('temperature', 26.4), measure('ph', 7.24), measure('orp', 690),
      measure('salt', 3200), measure('battery', 87), measure('rssi', 64),
    ],
  });

  assert.deepEqual(boundsViolations, []);
});

test('valeurs extrêmes : rien ne sort des bornes HAP', async () => {
  resetBoundsViolations();
  await cycle({ measures: ALL_MEASURES }, {
    pools: [poolPayload({ disinfection: { primary: 'salt' } })],
    lastmeasures: [
      measure('temperature', -80), measure('ph', 20), measure('orp', -50),
      measure('salt', 9999999), measure('battery', 250), measure('rssi', 0),
    ],
  });

  assert.deepEqual(boundsViolations, []);
});

test('la batterie publie son niveau et l\'alerte de charge basse', async () => {
  const normal = await cycle({}, { lastmeasures: [measure('battery', 87)] });
  const battery = svc(normal.accessory, 'ondilo:battery');
  assert.equal(battery.read(C.BatteryLevel), 87);
  assert.equal(battery.read(C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_NORMAL);

  const low = await cycle({}, { lastmeasures: [measure('battery', 12)] });
  assert.equal(svc(low.accessory, 'ondilo:battery').read(C.StatusLowBattery), C.StatusLowBattery.BATTERY_LEVEL_LOW);
});

test('l\'ORP est publié en millivolts, brut en lux et exact dans Eve', async () => {
  const { accessory, platform } = await cycle({}, { lastmeasures: [measure('orp', 690)] });
  const orp = svc(accessory, 'ondilo:orp');

  assert.equal(orp.read(C.CurrentAmbientLightLevel), 690);
  assert.equal(orp.read(platform.customCharacteristics.WaterOrp), 690);
});

test('la salinité suit l\'unité choisie par l\'utilisateur', async () => {
  const mgl = await cycle({ measures: ['salt'] }, {
    pools: [poolPayload({ disinfection: { primary: 'salt' } })],
    lastmeasures: [measure('salt', 3200)],
  });
  assert.equal(svc(mgl.accessory, 'ondilo:salt').read(mgl.platform.customCharacteristics.WaterSalinity), 3200);

  const gl = await cycle({ measures: ['salt'] }, {
    pools: [poolPayload({ disinfection: { primary: 'salt' } })],
    lastmeasures: [measure('salt', 3200)],
    units: { salt: 'GRAM_PER_LITER' },
  });
  assert.equal(svc(gl.accessory, 'ondilo:salt').read(gl.platform.customCharacteristics.WaterSalinity), 3.2);
});

test('le TDS n\'est pas demandé sur un bassin au sel, et la salinité pas sur un bassin au chlore', async () => {
  const salt = await cycle({ measures: ['salt', 'tds'] }, {
    pools: [poolPayload({ disinfection: { primary: 'salt' } })],
    lastmeasures: [measure('salt', 3200)],
  });
  assert.ok(svc(salt.accessory, 'ondilo:salt'));
  assert.equal(svc(salt.accessory, 'ondilo:tds'), null);
  assert.ok(salt.log.has('warn', 'le TDS n\'y est pas mesuré'), salt.log.text);

  const chlorine = await cycle({ measures: ['salt', 'tds'] }, { lastmeasures: [measure('tds', 900)] });
  assert.ok(svc(chlorine.accessory, 'ondilo:tds'));
  assert.equal(svc(chlorine.accessory, 'ondilo:salt'), null);
});

// ---------------------------------------------------------------------------
// Identité et réconciliation des services.
// ---------------------------------------------------------------------------

test('en disposition legacy le numéro de série reste l\'identifiant du bassin', async () => {
  const { accessory } = await cycle();
  const info = accessory.getService(S.AccessoryInformation);

  assert.equal(info.read(C.SerialNumber), '53865');
  assert.equal(info.read(C.Manufacturer), 'Ondilo');
  assert.equal(info.read(C.FirmwareRevision), '1.5.1-stable');
});

test('en disposition grouped le numéro de série vient de la sonde', async () => {
  const { accessory } = await cycle({ layout: 'grouped' });
  assert.equal(accessory.getService(S.AccessoryInformation).read(C.SerialNumber), 'ICO123456');
});

test('un numéro de série d\'un seul caractère est complété, jamais laissé tel quel', async () => {
  const { accessory } = await cycle({}, { pools: [poolPayload({ id: 7 })] });
  assert.equal(accessory.getService(S.AccessoryInformation).read(C.SerialNumber), 'ICO-7');
});

test('renommer le bassin côté Ondilo renomme l\'accessoire sans toucher à son UUID', async () => {
  const cached = cachedAccessory();
  const ctx = buildPlatform({}, { cached: [cached] });
  happyRoutes(ctx.http, { pools: [poolPayload({ name: 'Grand bassin' })] });
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();

  assert.equal(cached.displayName, 'ICO Grand bassin');
  assert.equal(cached.UUID, hap.uuid.generate('ondilo:pool:53865'));
  assert.equal(ctx.api.unregistered.length, 0);
  assert.ok(ctx.api.updated.length > 0, 'le cache Homebridge doit être mis à jour');
});

test('un nom de bassin illisible pour HAP est assaini', async () => {
  const { accessory } = await cycle({}, { pools: [poolPayload({ name: '  ***Piscine (jardin)!!  ' })] });
  assert.equal(accessory.displayName, 'ICO Piscine jardin');
});

test('sur Homebridge 1.8 le renommage est annoncé au lieu d\'échouer', async () => {
  const cached = cachedAccessory();
  cached.updateDisplayName = undefined;
  const ctx = buildPlatform({}, { cached: [cached], api: { withUpdateDisplayName: false } });
  happyRoutes(ctx.http, { pools: [poolPayload({ name: 'Grand bassin' })] });
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();

  assert.equal(cached.displayName, 'ICO Piscine', 'le nom ne change pas sans updateDisplayName');
  assert.ok(ctx.log.has('warn', 'ne sait pas renommer'), ctx.log.text);
});

test('changer phService retire l\'ancien service au lieu d\'en laisser deux', async () => {
  const first = await cycle();
  const accessory = first.api.registeredAccessories[0];
  assert.equal(svc(accessory, 'ondilo:ph').UUID, S.LightSensor.UUID);

  const second = buildPlatform({ phService: 'humidity' }, { cached: [accessory] });
  happyRoutes(second.http);
  second.api.emit('didFinishLaunching');
  await second.platform._tick();

  const phServices = accessory.services.filter(service => service.subtype === 'ondilo:ph');
  assert.equal(phServices.length, 1, 'un seul service pH, pas un doublon figé');
  assert.equal(phServices[0].UUID, S.HumiditySensor.UUID);
  assert.ok(second.log.has('info', 'Service retiré'), second.log.text);
});

test('décocher une mesure retire sa tuile sans toucher à l\'accessoire', async () => {
  const first = await cycle();
  const accessory = first.api.registeredAccessories[0];
  assert.ok(svc(accessory, 'ondilo:orp'));

  const second = buildPlatform({ measures: ['temperature', 'ph'] }, { cached: [accessory] });
  happyRoutes(second.http);
  second.api.emit('didFinishLaunching');
  await second.platform._tick();

  assert.equal(svc(accessory, 'ondilo:orp'), null);
  assert.ok(svc(accessory, 'ondilo:temperature'));
  assert.equal(second.api.unregistered.length, 0);
});

// ---------------------------------------------------------------------------
// Recommandations (option désactivée par défaut).
// ---------------------------------------------------------------------------

test('une recommandation en attente ouvre le capteur de contact', async () => {
  const { accessory } = await cycle({ recommendations: true }, {
    recommendations: [{ id: 42, title: 'Nettoyer le filtre', status: 'waiting', deadline: '2026-08-30T10:00:00+0000' }],
  });
  const contact = svc(accessory, 'ondilo:recommendations');

  assert.equal(contact.read(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);
  assert.equal(contact.read(C.StatusActive), true);
});

test('sans recommandation le capteur reste fermé', async () => {
  const { accessory } = await cycle({ recommendations: true });
  assert.equal(svc(accessory, 'ondilo:recommendations').read(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
});

test('une réponse /recommendations qui n\'est pas un tableau ne se lit pas « rien à faire »', async () => {
  const { accessory, log } = await cycle({ recommendations: true }, { recommendations: { message: 'error' } });
  const contact = svc(accessory, 'ondilo:recommendations');

  assert.ok(log.has('warn', 'autre chose qu\'un tableau'), log.text);
  assert.equal(contact.read(C.StatusActive), false);
  assert.equal(contact.read(C.StatusFault), C.StatusFault.GENERAL_FAULT);
});

test('éteindre l\'interrupteur valide la recommandation sur le compte Ondilo', async () => {
  const { accessory, http, log } = await cycle(
    { recommendations: true, allowRecommendationValidation: true },
    { recommendations: [{ id: 42, title: 'Nettoyer le filtre', status: 'waiting' }] },
  );
  const ack = svc(accessory, 'ondilo:recommendation-ack');

  assert.equal(ack.read(C.On), true);
  await ack.getCharacteristic(C.On).setHandler(false);

  const put = http.calls.find(call => String(call.url).endsWith('recommendations/42'));
  assert.ok(put, 'un PUT doit partir');
  assert.equal(put.method, 'put');
  assert.ok(log.has('info', 'marquée comme traitée'), log.text);
});

test('allumer l\'interrupteur sans recommandation en attente n\'écrit rien sur le compte', async () => {
  const { accessory, http } = await cycle({ recommendations: true, allowRecommendationValidation: true });
  const ack = svc(accessory, 'ondilo:recommendation-ack');
  const before = http.calls.length;

  await ack.getCharacteristic(C.On).setHandler(true);

  assert.equal(http.calls.length, before, 'aucune requête ne doit partir');
});

test('l\'interrupteur de validation n\'existe pas tant que l\'option n\'est pas cochée', async () => {
  const { accessory } = await cycle({ recommendations: true });
  assert.equal(svc(accessory, 'ondilo:recommendation-ack'), null);
});

test('un échec du PUT rallume l\'interrupteur et remonte une erreur HAP', async () => {
  const { accessory, http } = await cycle(
    { recommendations: true, allowRecommendationValidation: true },
    { recommendations: [{ id: 42, title: 'Nettoyer le filtre', status: 'waiting' }] },
  );
  const ack = svc(accessory, 'ondilo:recommendation-ack');
  http.on(RECOMMENDATION_PUT, () => httpError(503));

  await assert.rejects(
    ack.getCharacteristic(C.On).setHandler(false),
    err => err instanceof hap.HapStatusError,
  );
});

test('le titre de la recommandation part dans le journal, une seule fois par recommandation', async () => {
  const ctx = buildPlatform({ recommendations: true });
  const pending = [{ id: 42, title: 'Nettoyer le filtre', status: 'waiting' }];
  happyRoutes(ctx.http, { recommendations: pending });
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();
  assert.ok(ctx.log.has('info', 'Nettoyer le filtre'), ctx.log.text);

  const before = ctx.log.of('info').filter(line => line.includes('Nettoyer le filtre')).length;
  await ctx.platform._tick();
  const after = ctx.log.of('info').filter(line => line.includes('Nettoyer le filtre')).length;
  assert.equal(after, before, 'la même recommandation ne doit pas être répétée à chaque cycle');
});

test('le nom de la tuile de recommandation n\'est jamais écrasé par le plugin', async () => {
  const { accessory } = await cycle({ recommendations: true }, {
    recommendations: [{ id: 42, title: 'Nettoyer le filtre', status: 'waiting' }],
  });
  const contact = svc(accessory, 'ondilo:recommendations');

  // ConfiguredName écraserait le nom donné par l'utilisateur dans l'app Maison à chaque cycle.
  assert.equal(contact.testCharacteristic(C.ConfiguredName), false);
});

test('une liste de services modifiée est réécrite dans le cache de Homebridge', async () => {
  const first = await cycle();
  const accessory = first.api.registeredAccessories[0];

  const unchanged = buildPlatform({}, { cached: [accessory] });
  happyRoutes(unchanged.http);
  unchanged.api.emit('didFinishLaunching');
  await unchanged.platform._tick();
  assert.equal(unchanged.api.updated.length, 0, 'rien à réécrire quand la configuration n\'a pas bougé');

  const changed = buildPlatform({ measures: ['temperature'] }, { cached: [accessory] });
  happyRoutes(changed.http);
  changed.api.emit('didFinishLaunching');
  await changed.platform._tick();
  assert.ok(changed.api.updated.length > 0, 'le retrait d\'une tuile doit être persisté');
});

test('le réalignement différé de l\'interrupteur ne peut pas faire tomber le processus', async () => {
  const { poolAccessory, log } = await cycle({ recommendations: true, allowRecommendationValidation: true });
  const exploding = {
    updateCharacteristic() { throw new Error('service démonté entre-temps'); },
  };

  poolAccessory._restoreAckLater(exploding, false);
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.ok(log.has('warn', 'non réaligné'), log.text);
});

test('l\'interrupteur revient de lui-même à zéro s\'il n\'y a rien à valider', async () => {
  const { accessory } = await cycle({ recommendations: true, allowRecommendationValidation: true });
  const ack = svc(accessory, 'ondilo:recommendation-ack');
  ack.updateCharacteristic(C.On, true);

  await ack.getCharacteristic(C.On).setHandler(true);
  await new Promise(resolve => setTimeout(resolve, 350));

  assert.equal(ack.read(C.On), false);
});

test('un endpoint de métadonnées en panne n\'est pas rappelé au cycle suivant', async () => {
  const ctx = buildPlatform();
  happyRoutes(ctx.http);
  ctx.http.on('/pools/53865/configuration', () => httpError(500));
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();
  const first = ctx.http.countMatching('/configuration');
  await ctx.platform._tick();

  assert.ok(first >= 1);
  assert.equal(ctx.http.countMatching('/configuration'), first,
    'l\'échéance est reculée d\'une heure : un endpoint en panne ne doit pas manger le quota');
  assert.ok(ctx.log.has('warn', 'Échec /configuration'), ctx.log.text);
});

test('les métadonnées ne sont pas redemandées à chaque cycle quand elles ont abouti', async () => {
  const ctx = buildPlatform();
  happyRoutes(ctx.http);
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();
  const after = { device: ctx.http.countMatching('/device'), config: ctx.http.countMatching('/configuration') };
  await ctx.platform._tick();
  await ctx.platform._tick();

  assert.equal(ctx.http.countMatching('/device'), after.device);
  assert.equal(ctx.http.countMatching('/configuration'), after.config);
  assert.equal(after.device, 1);
});

// ---------------------------------------------------------------------------
// Findings de la review adversariale Codex.
// ---------------------------------------------------------------------------

test('F-5 : un service qui refuse d\'être créé n\'emporte pas les autres tuiles', async () => {
  const ctx = buildPlatform();
  happyRoutes(ctx.http);
  const accessoryProto = ctx.api.platformAccessory.prototype;
  const realAdd = accessoryProto.addService;
  accessoryProto.addService = function addService(Ctor, name, subtype) {
    if (subtype === 'ondilo:ph') throw new Error('service pH refusé');
    return realAdd.call(this, Ctor, name, subtype);
  };
  try {
    ctx.api.emit('didFinishLaunching');
    await ctx.platform._tick();
  } finally {
    accessoryProto.addService = realAdd;
  }

  const accessory = ctx.api.registeredAccessories[0];
  assert.ok(accessory, 'l\'accessoire doit exister malgré le service refusé');
  assert.ok(svc(accessory, 'ondilo:temperature'), 'la température reste publiée');
  assert.ok(svc(accessory, 'ondilo:battery'), 'la batterie reste publiée');
  assert.equal(svc(accessory, 'ondilo:ph'), null);
  assert.ok(ctx.log.has('error', 'indisponible'), ctx.log.text);
});

test('F-18 : une panne de /lastmeasures laisse le repli historique faire son travail', async () => {
  const ctx = buildPlatform();
  happyRoutes(ctx.http, { history: { data: [measure('ph', 7.31, { value_time: isoMinutesAgo(20) })] } });
  ctx.http.on('/lastmeasures', () => httpError(400));
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();

  const accessory = ctx.api.registeredAccessories[0];
  assert.ok(ctx.http.urls.some(url => url.includes('/measures?type=')), 'le repli doit être tenté');
  assert.equal(svc(accessory, 'ondilo:ph').read(C.CurrentAmbientLightLevel), 731);
  assert.equal(svc(accessory, 'ondilo:ph').read(C.StatusActive), true);
});

test('F-18 : si le repli ne donne rien non plus, le bassin est déclaré injoignable', async () => {
  const ctx = buildPlatform();
  happyRoutes(ctx.http, { history: { data: [] } });
  ctx.http.on('/lastmeasures', () => httpError(400));
  ctx.api.emit('didFinishLaunching');

  await ctx.platform._tick();

  const accessory = ctx.api.registeredAccessories[0];
  assert.equal(svc(accessory, 'ondilo:temperature').read(C.StatusActive), false);
});

test('F-19 : une invalidation récente n\'est pas remplacée par une ancienne valeur saine', async () => {
  const { accessory, http, platform } = await cycle({}, {
    lastmeasures: [
      measure('temperature', 26.4),
      measure('ph', 7.3, { value_time: isoMinutesAgo(90) }),
      measure('ph', null, { value_time: isoMinutesAgo(5), is_valid: false }),
    ],
    history: { data: [measure('ph', 7.3, { value_time: isoMinutesAgo(90) })] },
  });
  const ph = svc(accessory, 'ondilo:ph');

  assert.equal(http.urls.filter(url => url.includes('/measures?type=ph')).length, 0,
    'le repli ne doit pas contourner une invalidation en cours');
  assert.equal(ph.read(platform.customCharacteristics.WaterPh), 0, 'aucune ancienne valeur republiée');
  assert.equal(ph.read(C.StatusActive), false);
  assert.equal(ph.read(C.StatusFault), C.StatusFault.GENERAL_FAULT);
});

test('F-20 : un seuil absent ne devient pas une limite à zéro', async () => {
  const { accessory } = await cycle({}, {
    configuration: { ph_low: null, ph_high: 8.2, temperature_low: '', temperature_high: 32 },
    lastmeasures: [measure('ph', 6.2), measure('temperature', 26.4), measure('orp', 690), measure('battery', 87)],
  });

  // Avec un seuil bas fantôme à 0, un pH de 6,2 aurait été déclaré « Excellent ».
  assert.equal(svc(accessory, 'ondilo:quality').read(C.AirQuality), C.AirQuality.UNKNOWN);
});

test('F-21 : un horodatage dans le futur n\'est pas crédible', async () => {
  const future = new Date(Date.now() + 9 * 365 * 24 * 3600 * 1000).toISOString();
  const { accessory } = await cycle({}, { lastmeasures: [measure('temperature', 26.4, { value_time: future })] });
  const temperature = svc(accessory, 'ondilo:temperature');

  assert.equal(temperature.read(C.StatusActive), false);
  assert.equal(temperature.read(C.StatusFault), C.StatusFault.GENERAL_FAULT);
});

test('F-21 : un décalage d\'horloge de quelques minutes reste toléré', async () => {
  const slightlyAhead = new Date(Date.now() + 60000).toISOString();
  const { accessory } = await cycle({}, { lastmeasures: [measure('temperature', 26.4, { value_time: slightlyAhead })] });

  assert.equal(svc(accessory, 'ondilo:temperature').read(C.StatusActive), true);
});

test('F-24 : une recommandation non confirmée ne peut plus être validée', async () => {
  const ctx = buildPlatform({ recommendations: true, allowRecommendationValidation: true });
  happyRoutes(ctx.http, { recommendations: [{ id: 7, title: 'Nettoyer le filtre', status: 'waiting' }] });
  ctx.api.emit('didFinishLaunching');
  await ctx.platform._tick();

  const accessory = ctx.api.registeredAccessories[0];
  const ack = svc(accessory, 'ondilo:recommendation-ack');
  assert.equal(ack.read(C.On), true);

  ctx.http.on('/pools/53865/recommendations', () => httpError(404));
  ctx.platform.discovered = true;
  await ctx.platform._tick();

  const before = ctx.http.calls.length;
  await ack.getCharacteristic(C.On).setHandler(false);

  assert.equal(ctx.http.calls.length, before, 'aucune écriture sur un état de recommandation périmé');
  assert.equal(ack.read(C.On), false);
});

test('F-25 : deux commandes concurrentes ne valident la recommandation qu\'une fois', async () => {
  const { accessory, http } = await cycle(
    { recommendations: true, allowRecommendationValidation: true },
    { recommendations: [{ id: 42, title: 'Nettoyer le filtre', status: 'waiting' }] },
  );
  const ack = svc(accessory, 'ondilo:recommendation-ack');
  let release;
  http.on(RECOMMENDATION_PUT, () => new Promise((resolve) => { release = () => resolve({ data: 'Done' }); }));
  const handler = ack.getCharacteristic(C.On).setHandler;

  const both = Promise.all([handler(false), handler(false)]);
  await new Promise(setImmediate);
  release();
  await both;

  assert.equal(http.urls.filter(url => url.endsWith('recommendations/42')).length, 1,
    'une écriture irréversible ne doit jamais partir deux fois');
});

test('F-26 : une validation réussie ferme aussi le capteur de contact', async () => {
  const { accessory } = await cycle(
    { recommendations: true, allowRecommendationValidation: true },
    { recommendations: [{ id: 42, title: 'Nettoyer le filtre', status: 'waiting' }] },
  );
  const contact = svc(accessory, 'ondilo:recommendations');
  const ack = svc(accessory, 'ondilo:recommendation-ack');
  assert.equal(contact.read(C.ContactSensorState), C.ContactSensorState.CONTACT_NOT_DETECTED);

  await ack.getCharacteristic(C.On).setHandler(false);

  assert.equal(contact.read(C.ContactSensorState), C.ContactSensorState.CONTACT_DETECTED);
});

test('F-28 : deux bassins sans nom exploitable gardent des noms distincts', async () => {
  const empty = await cycle({}, { pools: [poolPayload({ name: '' })] });
  assert.equal(empty.accessory.displayName, 'ICO 53865');

  const emoji = await cycle({}, { pools: [poolPayload({ id: 77777, name: '🏊🏊' })] });
  assert.equal(emoji.accessory.displayName, 'ICO 77777');
});

test('F-29 : un /device en panne ne remplace pas le numéro de série de la sonde', async () => {
  const first = await cycle({ layout: 'grouped' });
  const accessory = first.api.registeredAccessories[0];
  assert.equal(accessory.getService(S.AccessoryInformation).read(C.SerialNumber), 'ICO123456');

  const second = buildPlatform({ layout: 'grouped' }, { cached: [accessory] });
  happyRoutes(second.http);
  second.http.on('/pools/53865/device', () => httpError(404));
  second.api.emit('didFinishLaunching');
  await second.platform._tick();

  assert.equal(accessory.getService(S.AccessoryInformation).read(C.SerialNumber), 'ICO123456',
    'la dernière identité connue est conservée jusqu\'au retour de /device');
});

test('F-31 : pas de tuile « Qualité de l\'eau » quand aucune mesure ne peut porter de seuil', async () => {
  const { accessory } = await cycle({ measures: ['battery'], waterQuality: true }, {
    lastmeasures: [measure('battery', 87)],
  });

  assert.equal(svc(accessory, 'ondilo:quality'), null);
});

test('l\'écriture HAP écrête en dernier ressort, même si l\'appelant a laissé passer une aberration', async () => {
  // Le filtre de plage physique est la première barrière ; celle-ci est la dernière, juste avant
  // HomeKit. Elle est éprouvée en appelant _writeValue directement, sans passer par le filtre.
  resetBoundsViolations();
  // Sans mode de désinfection déclaré, le plugin expose salinité ET TDS : les deux branches
  // d'écriture sont donc atteignables dans le même accessoire.
  const { poolAccessory, accessory, platform } = await cycle({ measures: ALL_MEASURES }, {
    pools: [poolPayload({ disinfection: undefined })],
    lastmeasures: [],
  });

  for (const [type, raw] of [
    ['ph', 99], ['ph', -50], ['temperature', 5000], ['temperature', -5000],
    ['orp', -900], ['salt', 9e9], ['tds', 9e9], ['battery', 900], ['rssi', -900],
  ]) {
    const service = svc(accessory, `ondilo:${type}`);
    assert.ok(service, `service ${type} attendu`);
    poolAccessory._writeValue(type, service, raw);
  }

  assert.deepEqual(boundsViolations, [], 'aucune valeur ne doit atteindre HAP hors de ses bornes');
  assert.equal(svc(accessory, 'ondilo:ph').read(platform.customCharacteristics.WaterPh), 0,
    'un pH de -50 doit être ramené dans 0-14, pas publié tel quel');
});
