# Changelog

## 1.0.0 - 2026-08-24

Première version majeure. Aucun réappairage : l'identifiant HomeKit de l'accessoire
(`ondilo:pool:<id>`) et les sous-types de service (`ondilo:*`) sont inchangés.

### FR

**Corrections**

- Le plugin ne meurt plus sur un échec au démarrage : le timer est armé avant la première requête
  et la découverte est rejouée avec un délai croissant (30 s → 5 min) tant qu'aucun bassin n'a
  répondu. Une coupure réseau au boot ne demande plus de redémarrer Homebridge.
- `/lastmeasures` est enfin appelé au format documenté (`types[]=` répété au lieu d'une liste
  séparée par des virgules), ce qui supprime la quasi-totalité des appels de repli.
- Les 401 sont traités : le jeton d'accès en cache est invalidé et l'appel rejoué une seule fois.
  Un `refresh_token` révoqué produit maintenant un message qui nomme la cause et la commande à
  relancer, au lieu d'un avertissement `/lastmeasures` trompeur.
- Les réessais couvrent 429, 500, 502, 503, 504 et les erreurs réseau, avec repli exponentiel,
  gigue et respect de `Retry-After`. Auparavant seul un dépassement de délai était retenté, et un
  hoquet de trois secondes coûtait une heure de données.
- `is_valid` et `exclusion_reason` sont respectés sur le chemin principal : une mesure qu'Ondilo
  déclare invalide n'est plus publiée dans HomeKit comme si elle était bonne.
- Fraîcheur : chaque capteur qui l'accepte porte `StatusActive` et `StatusFault` — HAP ne les
  prévoit pas sur le service Batterie, seule tuile qui ne peut donc pas signaler une valeur
  périmée. Une valeur qui n'a pas été
  rafraîchie depuis trois cycles est signalée au lieu de rester indéfiniment crédible. Une mesure
  arrivée sans horodatage exploitable est traitée comme suspecte, et non plus comme fraîche : sa
  fraîcheur ne peut pas être vérifiée.
- La tuile « Qualité de l'eau » n'annonce plus « Excellent » sur des données partielles. Elle exige
  que toutes les mesures dotées d'un seuil aient été relevées et soient fraîches ; sinon elle
  affiche « Inconnu » et se marque en défaut. Un dépassement constaté reste signalé même quand une
  autre mesure manque — l'incertitude ne masque jamais un problème.
- Un bassin encore présent sur le compte mais écarté par la configuration est conservé (appairage,
  pièce, scènes intacts) **et marqué en défaut** : ses tuiles ne restent plus figées sur les valeurs
  d'une configuration précédente en se faisant passer pour des mesures fraîches.
- Le renommage de l'accessoire ne lève plus d'exception sur Homebridge 1.8, où `updateDisplayName`
  n'existe pas encore (arrivée en 1.9) : le plugin le détecte et l'explique dans le journal.
- pH : la valeur est mise à l'échelle avant d'être écrite en lux (7,24 → 724 lx). L'app Maison
  arrondit les lux à l'entier, ce qui écrasait toute la plage utile sur deux valeurs. Réglable par
  « Facteur d'échelle du pH ».
- ORP en mode humidité : pleine échelle portée à 1200 mV, plus de saturation à 1000 mV.
- `salt` et `tds` ne sont plus des cases décoratives : elles créent de vrais services, et le plugin
  n'interroge que le type correspondant à la désinfection déclarée sur le compte.
- `npm run oauth` existe (le script était référencé partout mais absent de `package.json`).
- Les services obsolètes sont retirés : basculer le pH de « luminosité » à « humidité » ne laisse
  plus deux tuiles pH dont l'une figée à vie.
- Les accessoires orphelins sont désenregistrés — uniquement quand le bassin a réellement disparu
  du compte. Un bassin simplement écarté par la configuration, ou un `poolId` erroné, ne détruit
  rien.
- Un `poolId` introuvable est une erreur explicite qui liste les identifiants disponibles, au lieu
  d'un repli silencieux sur le premier bassin.
- Sans jeton de rafraîchissement, les accessoires en cache sont conservés et marqués en défaut :
  ils ne sont jamais supprimés, pour ne pas détruire appairage, pièce, scènes et automatisations.
- Cycle de vie : timer unique, `unref()`, arrêt propre sur l'événement `shutdown`, requêtes en vol
  annulées, garde de réentrance qui empêche deux cycles de se chevaucher et d'émettre deux
  renouvellements de jeton concurrents.
- `updateInterval` est normalisé : plancher relevé à 1800 s, plafond 21600 s, valeur non numérique
  rejetée avec un avertissement au lieu de produire une boucle à 1 ms.
- Le repli sur l'historique choisit le point le plus récent au lieu du dernier du tableau, et se
  limite à deux mesures par cycle, en tourniquet.
- Un compteur de quota glissant sur 60 minutes refuse l'appel au-delà de 25 requêtes plutôt que de
  se faire couper par Ondilo.
- Le nom de l'accessoire suit le renommage du bassin côté Ondilo, et les noms sont assainis pour la
  validation HAP.
- Un identifiant de bassin d'un seul chiffre ne casse plus le numéro de série : HAP refusait la
  valeur et l'accessoire affichait « Default-SerialNumber ». Ces comptes publient désormais
  `ICO-<identifiant>`. Les identifiants de deux chiffres ou plus sont inchangés.
- Le sélecteur « Niveau de journalisation » agit réellement.
- Assistant OAuth : écoute sur `127.0.0.1` seulement, ne renvoie plus le jeton dans la page du
  navigateur, ferme le serveur sur tous les chemins terminaux (dont le refus de consentement, qui
  laissait le processus pendu et le port occupé), et abandonne au bout de cinq minutes.
- Le premier réessai de découverte part bien à 30 s : le compteur d'échecs était lu après avoir été
  incrémenté, et le premier rang du repli n'était jamais utilisé.
- Sur un compte à plusieurs bassins en disposition `legacy`, c'est le bassin déjà appairé qui est
  conservé, et non la première entrée de `/pools`. L'ordre de cette réponse n'est garanti par rien :
  un changement d'ordre côté Ondilo aurait fait basculer l'accessoire, avec sa pièce, ses scènes et
  ses automatisations.
- `/user/units` est réessayé si le premier appel échoue, au lieu de figer la salinité en mg/L pour
  toute la durée de vie du processus.
- Un facteur d'échelle du pH hors bornes est signalé au lieu d'être ramené en silence.
- Un intervalle de rafraîchissement plus long que la période de mesure de la sonde est enfin
  respecté. L'alignement sur le dernier relevé écrasait la valeur demandée : six heures
  configurées donnaient un cycle toutes les cinquante-cinq minutes, soit six fois plus d'appels
  que ce que l'utilisateur avait choisi.
- Une liste de services modifiée est réécrite dans le cache de Homebridge : la réconciliation
  n'était appliquée qu'en mémoire et se rejouait à chaque redémarrage.
- Le réalignement différé de l'interrupteur de recommandation est protégé et `unref` : une
  exception dans ce rappel se produisait hors de toute pile rattrapable et aurait fait tomber le
  processus Homebridge entier, avec tous les autres plugins.
- Le titre de la recommandation en attente est journalisé. Il était écrit dans `ConfiguredName`, que
  HAP ne propose pas sur un capteur de contact : le code ne s'exécutait jamais, et s'il s'était
  exécuté il aurait écrasé à chaque cycle le nom donné à la tuile dans l'app Maison.

**Corrections issues de la revue adversariale externe**

Une seconde relecture, conduite par un moteur tiers avec exécution des scénarios, a produit
42 constats. Ceux qui portaient sur du code réel sont corrigés ici.

- **Appairage.** Une réponse `/pools` contenant une entrée sans identifiant était traitée comme une
  vue complète du compte : un bassin absent de cette vue partielle était désenregistré, avec sa
  pièce, ses scènes et ses automatisations. L'élagage est désormais suspendu dès qu'une entrée est
  inexploitable.
- Les tuiles restaurées du cache sont marquées invérifiables avant le premier cycle. Un redémarrage
  sans réseau republiait la dernière valeur connue comme si elle venait d'être mesurée.
- La découverte ne se déclare plus terminée quand une seule cible a abouti : l'échec d'un second
  bassin n'est plus masqué définitivement par la réussite du premier.
- Un enregistrement refusé par Homebridge ne laisse plus d'accessoire fantôme rafraîchi dans le vide.
- Un service qui refuse d'être créé n'emporte plus les autres tuiles du bassin.
- Une panne de `/lastmeasures` laisse de nouveau le repli historique travailler : la 1.0.0 ne
  publiait plus rien là où la 0.5.1 récupérait les dernières valeurs valides.
- La mesure la plus récente est choisie **avant** que sa validité soit examinée. Une invalidation en
  cours pouvait sinon être remplacée par une ancienne valeur saine, republiée comme fraîche.
- Une valeur physiquement impossible n'est plus écrêtée mais refusée : un pH de 99 devenait un pH
  de 14 parfaitement crédible dans l'app Maison.
- Un seuil `null` ou vide dans `/configuration` ne devient plus une limite à zéro — la qualité de
  l'eau annonçait « Excellent » sur une plage inventée.
- Un horodatage dans le futur n'est plus crédible indéfiniment ; une avance de quelques minutes
  reste tolérée.
- Un refus d'authentification interrompt le cycle au premier endpoint au lieu de faire recommencer
  à chacun son cycle 401-renouvellement-401, qui vidait le quota horaire en un tour.
- `Retry-After` n'est plus écrasé à 60 s : au-delà, le cycle est abandonné et le suivant réessaiera.
- Les appels sont espacés pour respecter le second plafond d'Ondilo, cinq requêtes par seconde.
- Un 401 arrivé en retard ne détruit plus un jeton qu'un autre appel vient de renouveler.
- L'attente d'un repli est coupée net à l'arrêt de Homebridge.
- La prochaine échéance sert le bassin le plus en retard, et l'ordre des bassins tourne d'un cycle
  à l'autre : un quota trop juste ne condamne plus toujours le même.
- La seule écriture du plugin est verrouillée : impossible de valider une recommandation dont le
  dernier relevé n'a pas abouti, impossible d'en valider deux fois la même, et le capteur de
  contact se ferme dès le succès.
- « Niveau de journalisation : Détaillé » remonte enfin les diagnostics du bassin **et** du client
  HTTP, au lieu du seul sous-ensemble qui passait par la plateforme.
- Deux bassins sans nom exploitable ne s'appellent plus tous les deux « ICO ».
- En disposition groupée, une panne de `/device` ne remplace plus le numéro de série de la sonde
  par l'identifiant du bassin.
- La tuile « Qualité de l'eau » n'est plus créée quand aucune mesure sélectionnée ne peut porter de
  seuil : elle serait restée « Inconnu » à vie.
- Assistant OAuth : le paramètre `state` est authentifié avant toute autre lecture — un faux refus
  émis par n'importe quelle page locale arrêtait l'assistant légitime — et un rejeu de la
  redirection ne peut plus transformer un succès en échec.
- Schéma : la sélection de mesures ne peut plus être vide, et l'option de validation des
  recommandations n'apparaît que si les recommandations sont activées.

**Constats écartés, et pourquoi**

- *Persister le compteur de quota sur disque* : le plugin n'écrit aujourd'hui aucun fichier. Le
  scénario visé demande plusieurs redémarrages en moins d'une heure, et sa conséquence est un 429
  que le client sait déjà absorber. Le gain ne vaut pas l'état sur disque.
- *Marquer le capteur en défaut quand la mesure sort des plages cibles* : `StatusFault` signale un
  capteur en panne, pas une eau à corriger. Le capteur de contact « hors plage » et la tuile de
  qualité portent déjà cette information.
- *Redécouvrir périodiquement les bassins* : la liste est figée après le démarrage, ce qui est
  assumé. Y toucher rouvrirait précisément le chemin qui peut désappairer un accessoire.
- *Déclarer `poolId` en nombre ou tableau dans le schéma* : le rendu du formulaire Homebridge n'est
  pas vérifiable ici, et casser l'écran de réglages coûterait le badge Verified. Le contrat tableau
  reste utilisable en configuration manuelle.
- *Interface OAuth intégrée, historique Eve, RSSI en caractéristique HAP native* : trois chantiers
  du plan non réalisés en 1.0.0, hors du périmètre de cette passe.

**Nouveautés

- Caractéristiques propres au plugin pour le pH, l'ORP, la salinité et le TDS, ajoutées **à côté**
  du capteur de luminosité : Eve, Controller for HomeKit et Home+ affichent la vraie valeur avec la
  bonne unité. Eve ne définit aucune caractéristique de chimie de l'eau, ces UUID sont donc propres
  au plugin et hors de la plage réservée par Eve.
- Tuile « Qualité de l'eau » (capteur de qualité de l'air, Excellent / Moyen / Mauvais) calculée à
  partir des plages cibles réglées dans l'app Ondilo, via `/pools/{id}/configuration`.
- Capteurs de contact « hors plage » par mesure, en option.
- Recommandations Ondilo exposées en capteur de contact, en option, avec un interrupteur facultatif
  qui les valide sur le compte.
- `FirmwareRevision` renseigné depuis `/pools/{id}/device`.
- Salinité convertie en g/L quand c'est l'unité choisie dans les préférences Ondilo.
- Cadence alignée sur l'horodatage de la dernière mesure plutôt que sur un intervalle aveugle.
- Option « Disposition des accessoires » : `grouped` expose tous les bassins d'un compte
  multi-bassins. Le défaut `legacy` reproduit exactement le comportement d'appairage précédent.

**Paquet et interface**

- `engines` : Node 22 ou 24, Homebridge 1.8 ou 2.
- Schéma de réglages entièrement réécrit — champs obligatoires réellement déclarés, jeton masqué,
  libellés et descriptions sur chaque champ, bornes cohérentes. Le schéma racine passe en anglais,
  la traduction française est servie automatiquement depuis `schemas/`.
- Options mortes retirées : `childBridge` (Homebridge gère les bridges enfants par `_bridge`).
- `axios-retry` et `qs`, déclarés mais jamais utilisés, sont retirés des dépendances.
- README anglais et français reconstruits, avec le tableau des services HomeKit et le dépannage.

**Tests**

Le plugin n'avait aucun test. Il en porte désormais 169, exécutés par `npm test` (`node --test`,
sans dépendance de développement) et non publiés sur npm. Le client HTTP est substitué : **aucun
test ne touche l'API Ondilo**, dont le jeton de production ne doit jamais être exercé.

Couvert par des tests : le format `types[]`, le renouvellement du jeton et sa concurrence, le rejeu
unique sur 401 et le message d'un 401 persistant, un `refresh_token` révoqué, la politique de
réessai et `Retry-After`, le compteur de quota et sa fenêtre glissante, l'annulation à l'arrêt, la
reprise après un échec réseau au démarrage et le repli de découverte, le refus de démarrer sans
jeton, une entrée `/pools` sans identifiant, l'élagage qui ne désinscrit rien quand l'API est muette,
la stabilité du seed d'UUID `ondilo:pool:<id>` contre l'UUID réellement appairé, la conversion du pH
et ses bornes HAP, `phLuxScale`, les mesures `is_valid: false`, la fraîcheur, le repli historique et
son tourniquet, la tuile de qualité de l'eau, la réconciliation des services et les recommandations.

Non couvert : le comportement réel de l'API Ondilo, qui n'a pas été appelée.

### EN

**Fixes** — the plugin no longer dies on a startup failure (the timer is armed before any request
and discovery is retried with a growing delay); `/lastmeasures` now uses the documented repeated
`types[]` form; 401 responses invalidate the cached access token and replay once; a revoked refresh
token is reported for what it is; retries cover 429/5xx and network errors with exponential backoff,
jitter and `Retry-After`; `is_valid` and `exclusion_reason` are honoured on the main path; every
sensor that accepts them carries `StatusActive` and `StatusFault` (HAP defines neither on the
Battery service, so that one tile cannot flag a stale reading) so a stale value is flagged instead of looking
fresh, and a measurement that arrives without a usable timestamp counts as suspect rather than
fresh; the water-quality tile no longer claims `Excellent` on partial data — it requires every
measurement that has a target range to be present and fresh, otherwise it reports `Unknown` and
flags itself, while an out-of-range reading is still surfaced even when another measurement is
missing; a pool that is still on the account but excluded by the configuration is kept and flagged
instead of leaving frozen tiles that look live; renaming an accessory no longer throws on
Homebridge 1.8, where `updateDisplayName` does not exist yet; pH is scaled before being written as lux (7.24 → 724 lx) because the Home app rounds light
levels to whole numbers; ORP in humidity mode no longer saturates at 1000 mV; `salt` and `tds`
create real services and only the type matching the account's disinfection is requested;
`npm run oauth` exists; obsolete services are removed; orphan accessories are unregistered only
when the pool actually vanished from the account; an unknown `poolId` is an explicit error listing
the real identifiers; without a refresh token cached accessories are kept and flagged, never
deleted; clean lifecycle with a single timer, `unref()`, shutdown handling, in-flight cancellation
and a reentrancy guard; `updateInterval` is normalised; the history fallback picks the newest point
and is capped at two measurements per cycle; a sliding hourly quota counter refuses a call past 25
requests; the accessory name follows a pool renamed in Ondilo; a single-digit pool identifier no longer
breaks the serial number (HAP rejected the value and the accessory showed `Default-SerialNumber`) —
those accounts now publish `ICO-<id>`, longer identifiers are unchanged; the log level selector works; the
OAuth helper binds to `127.0.0.1`, never returns the token in the browser page, closes on every
terminal path and gives up after five minutes.
The first discovery retry now really waits 30 s (the failure counter was read after being
incremented, so the first backoff rung was never used); on a multi-pool account in `legacy` layout
the already-paired pool wins over the first `/pools` entry, whose order nothing guarantees;
`/user/units` is retried after a failure instead of freezing salinity in mg/L for the life of the
process; an out-of-bounds pH scale factor is reported instead of being clamped silently; a refresh interval
longer than the probe's measurement period is now honoured instead of being overridden by the
alignment logic (six configured hours used to mean a cycle every fifty-five minutes); a changed
service list is written back to the Homebridge cache; the pending recommendation title goes to the
log — it used to be written to `ConfiguredName`, which HAP does not offer on a contact sensor, so
the code never ran, and had it run it would have overwritten the tile name set in the Home app;
the deferred realignment of the recommendation switch is now guarded and `unref`ed — an exception
in that callback happened outside any catchable stack and would have taken the whole Homebridge
process down along with every other plugin.

**New** — plugin-specific pH, ORP, salinity and TDS characteristics added next to the light sensors
(Eve, Controller for HomeKit and Home+ show the real value and unit); a computed water-quality tile
based on the target ranges set in the Ondilo app; optional out-of-range contact sensors; optional
Ondilo recommendations, with an optional switch to validate them; `FirmwareRevision` from
`/pools/{id}/device`; salinity in g/L when that is the account unit; polling aligned on the last
measurement timestamp; an `Accessory layout` option whose `grouped` value exposes every pool of a
multi-pool account, `legacy` reproducing the previous pairing behaviour exactly.

**External adversarial review** — a second pass by a third-party engine, running the scenarios
rather than reading them, produced 42 findings; every one that pointed at real code is fixed above.
The heaviest was a pairing hazard: a `/pools` response containing one malformed entry was treated
as a complete view of the account, so a pool missing from that partial view was unregistered along
with its room, scenes and automations. Also fixed: restored tiles now start unverifiable, discovery
no longer completes on a partial success, a rejected registration leaves no ghost accessory, one
failing service no longer takes the others down, a `/lastmeasures` outage lets the history fallback
work again, the most recent reading is picked before its validity is judged, physically impossible
values are refused instead of clamped, `null` thresholds no longer become zero, future timestamps
expire, an auth refusal stops the cycle at the first endpoint, `Retry-After` is no longer capped at
60 s, calls are spaced to respect Ondilo's five-per-second limit, the recommendation write is
locked against stale state and double submission, the log-level option now reaches every
diagnostic, and the OAuth helper authenticates `state` before anything else.

**Packaging** — Node 22/24 and Homebridge 1.8/2; settings schema fully rewritten with real required
fields, a masked token, labels, descriptions and sane bounds; English root schema with an automatic
French translation from `schemas/`; the dead `childBridge` option removed; unused `axios-retry` and
`qs` dependencies dropped; English and French READMEs rebuilt.

**Tests** — the plugin had none; it now ships 169, run by `npm test` (`node --test`, no dev
dependency) and excluded from the npm package. The HTTP client is substituted: **no test ever
reaches the Ondilo API**. Covered: transport and authentication, quota, startup recovery, pruning
safety, UUID seed stability against the real paired UUID, pH conversion and HAP bounds, `is_valid`,
staleness, history fallback, water quality, service reconciliation and recommendations. Not
covered: the real behaviour of the Ondilo API, which was never called.

## 0.5.1 - 2025-08-12
### FR
- Correction critique : instanciation explicite du client API dans `platform.js` et restauration des méthodes `getPools`, `getLastMeasures`, `getMeasuresSet` dans `api.js`.
- Robustesse : timeout API 30 s et réessais (x2) en cas de timeout.
- HomeKit : noms de services conformes (`pH`, `ORP` sans parenthèses).
- UI Homebridge : `CHANGELOG.md` inclus dans le package ; champ `changelog` de `package.json` → **GitHub Releases**.

### EN
- Critical fix: explicit API client instantiation in `platform.js` and restored `getPools`, `getLastMeasures`, `getMeasuresSet` in `api.js`.
- Robustness: 30s API timeout and built-in retries (x2) on timeout.
- HomeKit: compliant service names (`pH`, `ORP` without parentheses).
- Homebridge UI: `CHANGELOG.md` shipped in the package; `package.json` `changelog` → **GitHub Releases**.

## 0.5.0 - 2025-08-12
### FR
- Correctif : restauration explicite des appels API (`getPools`, `getLastMeasures`, `getMeasuresSet`) avec timeout 30 s et réessais intégrés (x2) en cas de timeout.
- Changelog : publié à la racine du paquet NPM et champ `changelog` pointant vers les **releases GitHub** (ou unpkg si GitHub indisponible) pour que l’UI Homebridge affiche les notes.
### EN
- Fix: explicitly restored API methods (`getPools`, `getLastMeasures`, `getMeasuresSet`) with 30s timeout and built‑in retries (x2) on timeout.
- Changelog: published at the NPM package root and `changelog` field pointing to **GitHub Releases** (or unpkg fallback) so Homebridge UI displays the notes.

