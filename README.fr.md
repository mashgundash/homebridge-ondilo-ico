# homebridge-ondilo-ico

Publie les mesures d'une sonde **Ondilo ICO** (piscine ou spa) dans l'app Maison : température de
l'eau, pH, ORP (RedOx), salinité ou TDS, batterie de la sonde et une tuile de qualité de l'eau
calculée. Le plugin lit l'API officielle Ondilo — aucune passerelle locale, aucun accès direct à la
sonde.

[![version npm](https://img.shields.io/npm/v/homebridge-ondilo-ico.svg)](https://www.npmjs.com/package/homebridge-ondilo-ico)
[![téléchargements](https://img.shields.io/npm/dt/homebridge-ondilo-ico.svg)](https://www.npmjs.com/package/homebridge-ondilo-ico)
[![node](https://img.shields.io/node/v/homebridge-ondilo-ico.svg)](https://nodejs.org)
[![licence](https://img.shields.io/npm/l/homebridge-ondilo-ico.svg)](LICENSE)

English: [README.md](README.md)

## Matériel pris en charge

- **Ondilo ICO Pool** ou **Ondilo ICO Spa**, quel que soit le firmware.
- Un **compte Ondilo** avec la sonde déjà appairée dans l'application mobile.
- Rien d'autre : le plugin parle à `interop.ondilo.com`, jamais à la sonde.

La sonde ne prend qu'une mesure par heure : le plugin se rafraîchit à la même cadence. Ondilo
plafonne son API à 30 appels par heure, le plugin en consomme environ 3.

## Ce qui apparaît dans HomeKit

Un accessoire par bassin.

| Mesure | Service HomeKit | Nom de la tuile | Valeur affichée | Remarque |
|---|---|---|---|---|
| Température de l'eau | Capteur de température | `Température eau` | °C | Natif, rien n'est détourné. |
| pH | Capteur de luminosité + caractéristique `pH` | `pH` | `724 lx` pour un pH de 7,24 | Voir *Pourquoi des lux*. |
| ORP (RedOx) | Capteur de luminosité + caractéristique `ORP` | `ORP` | `712 lx` = 712 mV | |
| Salinité | Capteur de luminosité + caractéristique `Salinité` | `Salinité` | lux = mg/L | Bassins au sel seulement. |
| TDS | Capteur de luminosité + caractéristique `TDS` | `TDS` | lux = ppm | Bassins hors sel seulement. |
| Batterie de la sonde | Batterie | `Batterie ICO` | % | Alerte batterie faible à 20 % ou moins. HAP ne prévoit ni `Status Active` ni `Status Fault` sur le service Batterie : cette tuile seule ne peut donc pas signaler une valeur périmée. |
| Signal radio | Capteur de luminosité | `Signal radio` | lux = % | Désactivé par défaut. |
| Qualité de l'eau | Capteur de qualité de l'air | `Qualité de l'eau` | Excellent / Moyen / Mauvais / Inconnu | Calculé à partir des plages cibles réglées dans l'app Ondilo. « Excellent » seulement si toutes les mesures dotées d'une plage ont été relevées et sont fraîches — sinon « Inconnu ». |
| Hors plage | Capteur de contact | `pH hors plage`, … | Ouvert / fermé | Optionnel, un par mesure. |
| Recommandation Ondilo | Capteur de contact | `Recommandation Ondilo` | Ouvert / fermé | Optionnel. |
| Marquer comme fait | Interrupteur | `Recommandation traitée` | Allumé / éteint | Optionnel, et seule écriture dont ce plugin soit capable. |

Chaque capteur porte en plus les caractéristiques de défaut HomeKit : une mesure qu'Ondilo déclare
invalide, ou qui n'a pas été rafraîchie depuis trois cycles, est signalée comme telle au lieu d'être
affichée comme si elle était fraîche.

### Pourquoi des lux

L'app Maison n'a ni capteur de pH, ni d'ORP, ni de salinité, ni de TDS — et HomeKit non plus. Ces
valeurs voyagent donc sur un capteur de luminosité, seule tuile numérique que Maison affiche avec
une plage suffisante. Maison arrondit les lux à l'entier : le pH est donc multiplié par 100 par
défaut, et **un pH de 7,24 s'affiche 724 lx**. Règle *Facteur d'échelle du pH* sur `1` si une
automatisation existante dépend de la valeur brute.

À côté du capteur de luminosité, le plugin ajoute une caractéristique qui lui est propre et qui
porte la vraie valeur avec la bonne unité. **Eve**, **Controller for HomeKit** et **Home+**
l'affichent en `7,24` et `712 mV` ; l'app Maison l'ignore en silence — c'est exactement pour cela
que le capteur de luminosité reste en place.

## Prérequis

- Homebridge 1.8 ou plus récent, Homebridge 2 compris.
- Node.js 22 ou 24.

## Installation

Le chemin recommandé est l'interface Homebridge : **Plugins → chercher `homebridge-ondilo-ico` →
Install**.

Depuis un terminal, sur une installation `hb-service` :

```bash
sudo hb-service add homebridge-ondilo-ico
```

N'utilise pas un simple `npm install -g` : sur une installation `hb-service`, il écrit dans le
mauvais préfixe et Homebridge ne trouvera pas le plugin.

## Obtenir un jeton de rafraîchissement

Ondilo ne délivre ses jetons d'API qu'à travers un écran de consentement OAuth2 : cette étape
demande un navigateur, une fois. Le jeton n'expire pas et ne tourne pas — on ne le fait qu'une fois.

```bash
# Le dossier du plugin est affiché dans l'interface Homebridge : Plugins > Ondilo ICO > Réglages > « Plugin path ».
# Sur une installation hb-service, il est sous le répertoire de stockage Homebridge, pas sous le préfixe npm global :
cd /var/lib/homebridge/node_modules/homebridge-ondilo-ico   # hb-service
cd "$(npm root -g)/homebridge-ondilo-ico"                   # installation npm globale
npm run oauth
```

Le script affiche une URL d'autorisation et attend cinq minutes sur `http://127.0.0.1:19239`. Ouvre
l'URL, connecte-toi à Ondilo, autorise l'accès : le jeton s'affiche **dans le terminal seulement**,
jamais dans la page du navigateur.

Si Homebridge tourne sur une autre machine (un Raspberry Pi par exemple), ouvre d'abord un tunnel
pour que la redirection atteigne le script :

```bash
ssh -L 19239:localhost:19239 utilisateur@hôte-homebridge
```

Colle ensuite la valeur dans le champ **Jeton de rafraîchissement** des réglages du plugin.

## Configuration

Tous les champs sont facultatifs sauf **Nom** et **Jeton de rafraîchissement**.

| Réglage | Défaut | Effet |
|---|---|---|
| **Nom** | `Ondilo ICO` | Libellé utilisé dans le journal de Homebridge. |
| **Jeton de rafraîchissement** | — | Le jeton OAuth2 obtenu ci-dessus. Obligatoire. |
| **Identifiant du bassin** | vide | Vide = le bassin déjà appairé s'il est toujours sur le compte, sinon le premier bassin renvoyé par Ondilo. Une valeur qui ne correspond à rien est signalée dans le journal avec la liste des identifiants réels, et aucun accessoire n'est créé. |
| **Disposition des accessoires** | `Historique` | `Historique` conserve un accessoire unique, identifiant HomeKit inchangé. `Groupée` expose tous les bassins du compte et reprend le numéro de série de la sonde. |
| **Mesures à exposer** | température, pH, ORP, batterie | Salinité et TDS s'excluent : le plugin demande celle qui correspond à la désinfection déclarée sur ton compte. |
| **Service HomeKit utilisé pour le pH** | Capteur de luminosité | Luminosité, ou humidité (pH en pourcentage de la plage 0-14). |
| **Facteur d'échelle du pH** | `100` | `100` affiche un pH de 7,24 en 724 lx. `1` rétablit le comportement des versions 0.x. |
| **Service HomeKit utilisé pour l'ORP** | Capteur de luminosité | Le mode humidité utilise une pleine échelle de 1200 mV. |
| **Intervalle de rafraîchissement (secondes)** | `3600` | Entre 1800 et 21600. Jusqu'à 3900 s le plugin s'aligne sur l'horodatage de la dernière mesure au lieu de sonder à l'aveugle ; au-delà, il attend simplement l'intervalle demandé. |
| **Rattraper une valeur manquante dans l'historique de 24 h** | activé | Va chercher le dernier point valide de la journée, au plus deux mesures par cycle. |
| **Ajouter une tuile « qualité de l'eau »** | activé | La synthèse Excellent / Moyen / Mauvais, « Inconnu » tant que les données sont incomplètes. |
| **Ajouter un capteur de contact « hors plage » par mesure** | désactivé | Une tuile de plus par mesure, utilisable comme déclencheur d'automatisation. |
| **Exposer les recommandations Ondilo** | désactivé | Capteur de contact ouvert tant qu'une recommandation est en attente. |
| **Autoriser la validation d'une recommandation depuis HomeKit** | désactivé | Ajoute un interrupteur qui valide la recommandation sur ton compte Ondilo. Non annulable. |
| **Niveau de journalisation** | `Normal` | `Détaillé` remonte les messages de diagnostic dans le journal principal. |

```json
{
  "platforms": [
    {
      "platform": "OndiloICO",
      "name": "Ondilo ICO",
      "refreshToken": "TON_JETON_DE_RAFRAICHISSEMENT",
      "poolId": 53865,
      "layout": "legacy",
      "measures": ["temperature", "ph", "orp", "battery"],
      "phService": "light",
      "phLuxScale": 100,
      "orpService": "light",
      "updateInterval": 3600,
      "useMeasuresFallback": true,
      "waterQuality": true,
      "outOfRangeSensors": false,
      "recommendations": false,
      "allowRecommendationValidation": false,
      "logLevel": "info"
    }
  ]
}
```

Pour exécuter le plugin dans un bridge enfant, passe par **Bridge Settings** dans l'interface
Homebridge. Il n'y a plus d'option `childBridge` dans ce plugin : les versions précédentes en
proposaient une, elle ne servait à rien.

## Dépannage

| Symptôme | Ligne de journal à chercher | Quoi faire |
|---|---|---|
| Aucun accessoire | `Aucun refresh token` | Le champ **Jeton de rafraîchissement** est vide. Les tuiles en cache sont conservées et signalées en défaut, jamais supprimées. |
| Tuiles figées, tout en défaut dans Maison | `Authentification refusée` | Le jeton a été révoqué. Relance `npm run oauth` et colle la nouvelle valeur. |
| `Identifiant de bassin introuvable` | la même ligne liste les identifiants réels | Recopie l'un d'eux dans **Identifiant du bassin**, ou vide le champ. |
| Valeurs vieilles de plusieurs heures | `Mesure … écartée du bilan` | Sonde hors de l'eau, à plat, ou hors réseau. Vérifie d'abord dans l'app Ondilo. |
| `quota Ondilo atteint` | la même ligne donne le délai de réessai | Autre chose utilise le même compte Ondilo via l'API. Augmente l'**intervalle de rafraîchissement**. |
| Le pH affiche `724` | — | C'est l'échelle ×100. Règle **Facteur d'échelle du pH** sur `1` pour retrouver la valeur brute. |
| La qualité de l'eau reste sur « Inconnu » | `écartée du bilan` | Une mesure manque ou est périmée, ou aucune plage cible n'est réglée pour elle dans l'app Ondilo. La tuile n'annonce jamais « Excellent » sur des données partielles. |

Passe `"logLevel": "debug"` pour le détail mesure par mesure, y compris le motif de rejet donné par
Ondilo.

## Journal des modifications

[Releases GitHub](https://github.com/mashgundash/homebridge-ondilo-ico/releases) — et
[CHANGELOG.md](CHANGELOG.md) dans le paquet.

## Support

Bugs et demandes : [issues GitHub](https://github.com/mashgundash/homebridge-ondilo-ico/issues).

Si ce plugin t'est utile, tu peux [☕ m'offrir un café](https://paypal.me/mashgundash).

## Licence

MIT — voir [LICENSE](LICENSE). Sans lien avec la société Ondilo.
