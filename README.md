
# homebridge-ondilo-ico

Plugin Homebridge (plateforme) pour exposer les mesures **ICO Ondilo** dans Apple Home : température de l'eau, pH, ORP (RedOx), batterie, etc.

## Caractéristiques

- Authentification OAuth2 officielle Ondilo (client_id `customer_api`) pour obtenir un **refresh token** non expirant.
- Lecture via `/pools/{id}/lastmeasures` avec **fallback** sur `/pools/{id}/measures?type=...&period=day` si nécessaire.
- Mapping HomeKit :
  - Température → `TemperatureSensor` (°C)
  - pH → `LightSensor` (valeur affichée en lux) **ou** `HumiditySensor` (0–14 → 0–100 %)
  - ORP → `LightSensor` (ou `HumiditySensor` %)
  - Batterie → `BatteryService`

> Apple Maison n'a pas de capteurs pH/ORP natifs : on détourne des services existants pour les afficher.

## Installation

### 1) Obtenir un refresh_token (sur votre Mac ou le RPi)

```bash
# depuis le dossier du plugin (cloné ou extrait)
npm install
npm run oauth
```
Ouvrez l'URL affichée, connectez-vous, et récupérez les tokens. Copiez **refresh_token**.

### 2) Installer le plugin (UI Homebridge ou npm)

- UI Homebridge : Plugins → rechercher `homebridge-ondilo-ico` → Install.
- npm global (alternative) :
```bash
sudo npm install -g homebridge-ondilo-ico
```

### 3) Configurer

Dans l'UI Homebridge : **Ondilo ICO** → renseignez `refreshToken`, éventuellement `poolId`. Vous pouvez choisir le service pour pH/ORP et l'intervalle (par défaut 3600 s).

## Configuration (exemple)

```json
{
  "platforms": [
    {
      "platform": "OndiloICO",
      "name": "Ondilo ICO",
      "refreshToken": "VOTRE_REFRESH_TOKEN",
      "poolId": 123,
      "measures": ["temperature","ph","orp","battery"],
      "phService": "light",
      "orpService": "light",
      "updateInterval": 3600,
      "useMeasuresFallback": true,
      "childBridge": true,
      "logLevel": "info"
    }
  ]
}
```

## Bonnes pratiques

- Respecter **≤ 30 requêtes/heure** (l'ICO mesure environ 1×/h). Gardez `updateInterval` à 3600 s.
- Si `/lastmeasures` est vide, le plugin tente `/measures` (period=day) pour prendre la dernière valeur valide.
- Renommez les accessoires pH/ORP dans Maison pour éviter la confusion d'unités.

Licence : MIT
