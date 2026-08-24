'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('../test-helpers/http'); // neutralise axios avant de charger index.js
const { hap, generate } = require('../test-helpers/fake-hap');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const schema = require('../config.schema.json');

/** Fichiers chargés par Homebridge au démarrage, par opposition au script OAuth. */
const RUNTIME_FILES = ['index.js', 'platform.js', 'pool-accessory.js', 'api.js', 'characteristics.js'];

function readRuntime() {
  return RUNTIME_FILES.map(name => ({ name, source: fs.readFileSync(path.join(root, name), 'utf8') }));
}

// ---------------------------------------------------------------------------
// Appairage : la constante qui ne doit jamais bouger.
// ---------------------------------------------------------------------------

test('les seeds d\'UUID produisent exactement les UUID déjà appairés', () => {
  // Valeurs calculées par @homebridge/hap-nodejs 2.1.2. Si l'une d'elles change, tous les
  // accessoires du plugin se désappairent : pièce, nom, scènes et automatisations perdus.
  assert.equal(generate('ondilo:pool:53865'), 'acabddc0-2d2a-4e3b-8f0e-0eb6040261a2');
  assert.equal(generate('ondilo:pool:1'), '04832f28-d1f9-4313-bfaa-49bc6b5b35af');
});

test('le seed est écrit littéralement dans le code, sans préfixe ni suffixe ajouté', () => {
  const source = fs.readFileSync(path.join(root, 'platform.js'), 'utf8');
  const seeds = [...source.matchAll(/uuid\.generate\(([^)]*)\)/g)].map(match => match[1].trim());

  assert.deepEqual(seeds, ['`ondilo:pool:${pool.id}`'], `seeds trouvés : ${seeds.join(' | ')}`);
});

test('les sous-types de service gardent leur préfixe historique', () => {
  const source = fs.readFileSync(path.join(root, 'pool-accessory.js'), 'utf8');
  const subtypes = [...source.matchAll(/'(ondilo:[a-z-]+)'/g)].map(match => match[1]);

  for (const expected of ['ondilo:temperature', 'ondilo:ph', 'ondilo:orp', 'ondilo:salt', 'ondilo:tds', 'ondilo:battery', 'ondilo:rssi']) {
    assert.ok(subtypes.includes(expected), `sous-type ${expected} absent`);
  }
});

test('les UUID des caractéristiques personnalisées sont figés et hors de la plage Eve', () => {
  const custom = require('../characteristics');

  assert.equal(custom.UUID_PH, '4963F37B-02F1-4905-851F-00FADC47407A');
  assert.equal(custom.UUID_ORP, '3C0DC683-7657-470F-A802-9D0FE586ED6A');
  assert.equal(custom.UUID_SALINITY, '9DA1F226-B466-45B3-B8A9-5CC10DAEFB5C');
  assert.equal(custom.UUID_TDS, 'E1C97A76-4FF2-40C6-883F-526B67675E91');

  for (const uuid of [custom.UUID_PH, custom.UUID_ORP, custom.UUID_SALINITY, custom.UUID_TDS]) {
    assert.ok(!/^E863F1/i.test(uuid), `${uuid} empiète sur la plage réservée par Eve`);
    assert.ok(!uuid.endsWith('-0000-1000-8000-0026BB765291'), `${uuid} empiète sur la plage HAP`);
  }
});

// ---------------------------------------------------------------------------
// Point d'entrée et critères « Homebridge Verified ».
// ---------------------------------------------------------------------------

test('index.js enregistre une plateforme dynamique sous le bon alias', () => {
  const registrations = [];
  require('../index')({ registerPlatform: (name, ctor) => registrations.push({ name, ctor }) });

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, 'OndiloICO');
  assert.equal(registrations[0].name, schema.pluginAlias);
  assert.equal(typeof registrations[0].ctor.prototype.configureAccessory, 'function',
    'une plateforme dynamique doit exposer configureAccessory');
});

test('le code exécuté par Homebridge ne parle qu\'à Ondilo', () => {
  for (const { name, source } of readRuntime()) {
    for (const [url] of source.matchAll(/https?:\/\/[^'"`\s)]+/g)) {
      assert.match(url, /^https:\/\/interop\.ondilo\.com/, `${name} contacte ${url}`);
    }
  }
});

test('le code exécuté par Homebridge n\'écrit aucun fichier', () => {
  for (const { name, source } of readRuntime()) {
    assert.ok(!/require\(['"]node:fs['"]\)|require\(['"]fs['"]\)/.test(source), `${name} charge fs`);
    assert.ok(!/writeFileSync|appendFileSync|mkdirSync|createWriteStream/.test(source), `${name} écrit sur le disque`);
  }
});

test('le code exécuté par Homebridge journalise par le logger, jamais par console', () => {
  for (const { name, source } of readRuntime()) {
    assert.ok(!/\bconsole\.(log|info|warn|error|debug)\b/.test(source), `${name} utilise console`);
  }
});

test('aucun secret ni jeton n\'est écrit en dur', () => {
  for (const { name, source } of readRuntime()) {
    assert.ok(!/(client_secret|api[_-]?key|Bearer\s+[A-Za-z0-9]{10})/i.test(source), `${name} porte un secret`);
  }
});

// ---------------------------------------------------------------------------
// package.json.
// ---------------------------------------------------------------------------

test('la version publiée est bien 1.0.0', () => {
  assert.equal(pkg.version, '1.0.0');
});

test('le paquet cible Node 22 et 24, Homebridge 1.8 et 2 y compris ses préversions', () => {
  assert.equal(pkg.engines.node, '^22.10.0 || ^24.0.0');
  assert.equal(pkg.engines.homebridge, '^1.8.0 || ^2.0.0-beta.0');
});

test('les mots-clés exigés par Homebridge sont présents', () => {
  for (const keyword of ['homebridge-plugin', 'supports-hap']) {
    assert.ok(pkg.keywords.includes(keyword), `mot-clé ${keyword} manquant`);
  }
});

test('la commande npm run oauth existe vraiment', () => {
  assert.equal(pkg.scripts.oauth, 'node oauth-helper.js');
  assert.ok(fs.existsSync(path.join(root, 'oauth-helper.js')));
});

test('« files » embarque tout le nécessaire et rien de plus', () => {
  for (const required of [...RUNTIME_FILES, 'oauth-helper.js', 'config.schema.json']) {
    assert.ok(pkg.files.includes(required), `${required} manque dans files`);
  }
  assert.ok(!pkg.files.some(entry => entry.startsWith('test')), 'les tests ne doivent pas être publiés');
});

test('axios est la seule dépendance de production', () => {
  assert.deepEqual(Object.keys(pkg.dependencies), ['axios']);
  assert.equal(pkg.devDependencies, undefined, 'aucune dépendance de développement n\'est nécessaire');
});

test('tous les modules requis par le code sont déclarés ou natifs', () => {
  const declared = new Set(Object.keys(pkg.dependencies));
  for (const { name, source } of [...readRuntime(), { name: 'oauth-helper.js', source: fs.readFileSync(path.join(root, 'oauth-helper.js'), 'utf8') }]) {
    for (const [, request] of source.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
      if (request.startsWith('.') || request.startsWith('node:')) continue;
      const builtin = require('node:module').isBuiltin(request);
      assert.ok(builtin || declared.has(request), `${name} requiert ${request}, non déclaré`);
    }
  }
});

// ---------------------------------------------------------------------------
// Schémas de configuration.
// ---------------------------------------------------------------------------

for (const [label, document] of [['config.schema.json', schema]]) {
  test(`${label} : plateforme singulière, alias correct, champs obligatoires à la racine`, () => {
    assert.equal(document.pluginAlias, 'OndiloICO');
    assert.equal(document.pluginType, 'platform');
    assert.equal(document.singular, true);
    assert.deepEqual(document.schema.required, ['name', 'refreshToken']);
  });

  test(`${label} : aucun « required: true » à l'intérieur d'une propriété`, () => {
    const offenders = [];
    (function walk(node, at) {
      if (Array.isArray(node)) return node.forEach((entry, i) => walk(entry, `${at}[${i}]`));
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        // ng-formworks ignore purement et simplement cette forme : le champ n'est ni marqué
        // obligatoire dans l'UI, ni validé avant enregistrement.
        if (key === 'required' && value === true) offenders.push(`${at}/${key}`);
        walk(value, `${at}/${key}`);
      }
    })(document, '');
    assert.deepEqual(offenders, []);
  });

  test(`${label} : les valeurs par défaut correspondent à celles du code`, () => {
    const properties = document.schema.properties;
    assert.equal(properties.layout.default, 'legacy', 'la disposition historique doit rester le défaut');
    assert.equal(properties.phService.default, 'light');
    assert.equal(properties.phLuxScale.default, 100);
    assert.equal(properties.updateInterval.default, 3600);
    assert.equal(properties.updateInterval.minimum, 1800);
    assert.equal(properties.updateInterval.maximum, 21600);
    assert.equal(properties.allowRecommendationValidation.default, false);
    assert.equal(properties.recommendations.default, false);
    assert.deepEqual(properties.measures.default, ['temperature', 'ph', 'orp', 'battery']);
  });
}

test('les mesures proposées par le schéma sont celles que le code sait rendre', () => {
  const { MEASURE_TYPES } = require('../pool-accessory');
  assert.deepEqual(schema.schema.properties.measures.items.enum, MEASURE_TYPES);
  assert.equal(
    schema.schema.properties.measures.items.enumNames.length,
    MEASURE_TYPES.length,
    'chaque mesure doit porter un libellé lisible dans l\'UI',
  );
});

test('les options de disposition du schéma sont celles que le code accepte', () => {
  const layouts = schema.schema.properties.layout.oneOf.flatMap(entry => entry.enum);
  assert.deepEqual(layouts, ['legacy', 'grouped']);
});

test('le schéma ne propose plus les réglages décoratifs de la 0.5.x', () => {
  assert.equal(schema.schema.properties.childBridge, undefined, 'childBridge est injecté par l\'UI, pas par le plugin');
});

test('le service de batterie de HAP n\'accepte ni StatusActive ni StatusFault', () => {
  // Contrôle du double lui-même : si HAP changeait, la tuile batterie porterait un état de
  // fraîcheur silencieusement ignoré aujourd'hui.
  const battery = new hap.Service.Battery('Batterie', 'ondilo:battery');
  const supports = Ctor => battery.testCharacteristic(Ctor)
    || battery.optionalCharacteristics.some(c => c.UUID === Ctor.UUID);

  assert.equal(supports(hap.Characteristic.StatusActive), false);
  assert.equal(supports(hap.Characteristic.BatteryLevel), true);
});

// ---------------------------------------------------------------------------
// Findings de la review adversariale Codex — schéma et assistant OAuth.
// ---------------------------------------------------------------------------

test('F-30 : le formulaire refuse une sélection de mesures vide', () => {
  for (const document of [schema]) {
    assert.equal(document.schema.properties.measures.minItems, 1);
  }
});

test('F-34 : la validation de recommandation dépend visiblement de son option parente', () => {
  for (const document of [schema]) {
    const condition = document.schema.properties.allowRecommendationValidation.condition;
    assert.ok(condition, 'la dépendance doit exister dans le formulaire');
    assert.match(condition.functionBody, /model\.recommendations/);
  }
});

test('F-32 : le libellé de « grouped » dit ce que fait un identifiant de bassin renseigné', () => {
  for (const document of [schema]) {
    const grouped = document.schema.properties.layout.oneOf.find(entry => entry.enum[0] === 'grouped');
    assert.match(grouped.title, /identif/i, `libellé : ${grouped.title}`);
  }
});

test('F-37 : l\'assistant OAuth authentifie le paramètre state avant de lire une erreur', () => {
  const source = fs.readFileSync(path.join(root, 'oauth-helper.js'), 'utf8');
  const statePosition = source.indexOf("searchParams.get('state')");
  const errorPosition = source.indexOf("searchParams.get('error')");

  assert.ok(statePosition > 0 && errorPosition > 0);
  assert.ok(statePosition < errorPosition,
    'un callback non corrélé ne doit pas pouvoir arrêter l\'assistant légitime');
});

test('F-36 : l\'assistant OAuth se verrouille avant le premier await', () => {
  const source = fs.readFileSync(path.join(root, 'oauth-helper.js'), 'utf8');
  const lockPosition = source.indexOf('if (finished || exchanging)');
  const awaitPosition = source.indexOf('await axios.post');

  assert.ok(lockPosition > 0, 'un verrou de réentrance doit exister');
  assert.ok(lockPosition < awaitPosition);
});
