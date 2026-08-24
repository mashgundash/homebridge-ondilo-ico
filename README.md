# homebridge-ondilo-ico

Publishes the measurements of an **Ondilo ICO** pool or spa probe in Apple Home: water temperature,
pH, ORP (redox), salinity or TDS, probe battery and a computed water-quality tile. Reads the
official Ondilo cloud API — no local gateway, no polling of your probe.

[![npm version](https://img.shields.io/npm/v/homebridge-ondilo-ico.svg)](https://www.npmjs.com/package/homebridge-ondilo-ico)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-ondilo-ico.svg)](https://www.npmjs.com/package/homebridge-ondilo-ico)
[![node](https://img.shields.io/node/v/homebridge-ondilo-ico.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/homebridge-ondilo-ico.svg)](LICENSE)

Français : [README.fr.md](README.fr.md)

## Supported hardware

- **Ondilo ICO Pool** or **Ondilo ICO Spa**, any firmware.
- An **Ondilo account** with the probe already paired in the Ondilo mobile app.
- Nothing else: the plugin talks to `interop.ondilo.com`, never to the probe directly.

The probe takes one measurement per hour, so the plugin refreshes once per hour too. Ondilo caps
its API at 30 calls per hour and the plugin stays around 3.

## What appears in HomeKit

One accessory per pool. Tile names are in French by default (the plugin is French-authored); rename
them in the Home app if you prefer.

| Measurement | HomeKit service | Tile name | Displayed value | Notes |
|---|---|---|---|---|
| Water temperature | Temperature sensor | `Température eau` | °C | Native, nothing is faked. |
| pH | Light sensor + a `pH` characteristic | `pH` | `724 lx` for pH 7.24 | See *Why lux* below. |
| ORP (redox) | Light sensor + an `ORP` characteristic | `ORP` | `712 lx` = 712 mV | |
| Salinity | Light sensor + a `Salinité` characteristic | `Salinité` | lux = mg/L | Salt pools only. |
| TDS | Light sensor + a `TDS` characteristic | `TDS` | lux = ppm | Non-salt pools only. |
| Probe battery | Battery | `Batterie ICO` | % | Low-battery warning at 20 % or below. HAP gives the Battery service no `Status Active` / `Status Fault`, so this tile alone cannot signal a stale reading. |
| Radio signal | Light sensor | `Signal radio` | lux = % | Off by default. |
| Water quality | Air quality sensor | `Qualité de l'eau` | Excellent / Fair / Poor / Unknown | Computed from the target ranges you set in the Ondilo app. `Excellent` only when every measurement that has a range was read and is fresh — otherwise `Unknown`. |
| Out of range | Contact sensor | `pH hors plage`, … | Open / closed | Optional, one per measurement. |
| Ondilo recommendation | Contact sensor | `Recommandation Ondilo` | Open / closed | Optional. |
| Mark as done | Switch | `Recommandation traitée` | On / off | Optional, and the only thing this plugin ever writes. |

Every sensor also carries the HomeKit fault characteristics: a measurement that Ondilo declares
invalid, or one that has not been refreshed for three cycles, is flagged instead of being shown as
if it were fresh.

### Why lux

Apple Home has no pH, ORP, salinity or TDS sensor, and neither has HomeKit itself. Those values
therefore ride on a light sensor, which is the only numeric tile Home renders with enough range.
Home rounds light levels to whole numbers, so pH is multiplied by 100 by default: **pH 7.24 shows
as 724 lx**. Set *pH scale factor* to `1` if an existing automation depends on the raw number.

Alongside the light sensor, the plugin adds a plugin-specific characteristic carrying the real
value with the right unit. **Eve**, **Controller for HomeKit** and **Home+** display it as `7.24`
and `712 mV`; the Home app ignores it silently, which is exactly why the light sensor stays.

## Requirements

- Homebridge 1.8 or later, including Homebridge 2.
- Node.js 22 or 24.

## Installation

The Homebridge UI is the supported path: **Plugins → search `homebridge-ondilo-ico` → Install**.

From a terminal on an `hb-service` installation:

```bash
sudo hb-service add homebridge-ondilo-ico
```

Do not use a bare `npm install -g`: on an `hb-service` setup it installs into the wrong prefix and
Homebridge will not find the plugin.

## Getting a refresh token

Ondilo only issues API tokens through an OAuth2 consent screen, so this step needs a browser once.
The token does not expire and does not rotate: you do this exactly one time.

```bash
# The plugin folder is shown in the Homebridge UI under Plugins > Ondilo ICO > Settings > "Plugin path".
# On an hb-service install it is usually under the Homebridge storage path, not the global npm prefix:
cd /var/lib/homebridge/node_modules/homebridge-ondilo-ico   # hb-service
cd "$(npm root -g)/homebridge-ondilo-ico"                   # global npm install
npm run oauth
```

The script prints an authorisation URL and waits five minutes on `http://127.0.0.1:19239`. Open the
URL, sign in to Ondilo, approve the access — the token is then printed **in the terminal only**,
never in the browser page.

If Homebridge runs on another machine (a Raspberry Pi, for instance), forward the port first so the
redirect can reach the script:

```bash
ssh -L 19239:localhost:19239 user@homebridge-host
```

Then paste the value into the **Refresh token** field of the plugin settings.

## Configuration

All fields are optional except **Name** and **Refresh token**.

| Setting | Default | What it does |
|---|---|---|
| **Name** | `Ondilo ICO` | Label used in the Homebridge log. |
| **Refresh token** | — | The OAuth2 token obtained above. Required. |
| **Pool identifier** | empty | Leave empty to use the pool that is already paired if it is still on the account, otherwise the first pool Ondilo returns. A value that matches nothing is reported in the log with the list of real identifiers, and no accessory is created. |
| **Accessory layout** | `Legacy` | `Legacy` keeps one accessory with an unchanged HomeKit identifier. `Grouped` exposes every pool of the account and takes the serial number from the probe. |
| **Measurements to expose** | temperature, pH, ORP, battery | Salinity and TDS are mutually exclusive; the plugin asks for whichever matches the disinfection declared in your account. |
| **HomeKit service used for pH** | Light sensor | Light sensor or humidity sensor (pH as a percentage of 0-14). |
| **pH scale factor** | `100` | `100` shows pH 7.24 as 724 lx. `1` restores the raw 0.x behaviour. |
| **HomeKit service used for ORP** | Light sensor | Humidity mode uses a 1200 mV full scale. |
| **Refresh interval (seconds)** | `3600` | Between 1800 and 21600. Up to 3900 s the plugin aligns itself on the timestamp of the last measurement instead of polling blindly; above that it simply waits the interval you asked for. |
| **Recover missing values from the 24-hour history** | on | Fetches the last valid point of the day for a missing measurement, at most two per cycle. |
| **Add a water quality tile** | on | The Excellent / Fair / Poor summary, `Unknown` while the data is incomplete. |
| **Add one out-of-range contact sensor per measurement** | off | One extra tile per measurement, usable as an automation trigger. |
| **Expose Ondilo recommendations** | off | Contact sensor that opens while a recommendation is pending. |
| **Allow marking a recommendation as done from HomeKit** | off | Adds a switch that validates the recommendation on your Ondilo account. Cannot be undone. |
| **Log level** | `Normal` | `Detailed` promotes diagnostic messages to the main log. |

```json
{
  "platforms": [
    {
      "platform": "OndiloICO",
      "name": "Ondilo ICO",
      "refreshToken": "YOUR_REFRESH_TOKEN",
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

To run the plugin in its own child bridge, use **Bridge Settings** in the Homebridge UI. There is no
`childBridge` option in this plugin — earlier versions offered one and it did nothing.

## Troubleshooting

| Symptom | Log line to look for | What to do |
|---|---|---|
| No accessory at all | `Aucun refresh token` | The **Refresh token** field is empty. Cached tiles are kept and flagged, never deleted. |
| Tiles frozen, everything flagged in Home | `Authentification refusée` | The refresh token was revoked. Run `npm run oauth` again and paste the new value. |
| `Identifiant de bassin introuvable` | same line lists the real identifiers | Copy one of them into **Pool identifier**, or clear the field. |
| Values are hours old | `Mesure … écartée du bilan` | The probe is out of the water, out of battery or off the network. Check the Ondilo app first. |
| `quota Ondilo atteint` | same line gives the retry delay | Something else is using the same Ondilo account through the API. Raise **Refresh interval**. |
| pH reads `724` | — | That is the ×100 scale. Set **pH scale factor** to `1` to get the raw value back. |
| Water quality stuck on `Unknown` | `écartée du bilan` | A measurement is missing or stale, or no target range is set for it in the Ondilo app. The tile never claims `Excellent` on partial data. |

Add `"logLevel": "debug"` for the per-measurement detail, including the reason Ondilo gave for
rejecting a measurement.

## Changelog

[GitHub releases](https://github.com/mashgundash/homebridge-ondilo-ico/releases) — and
[CHANGELOG.md](CHANGELOG.md) in the package.

## Support

Bugs and feature requests: [GitHub issues](https://github.com/mashgundash/homebridge-ondilo-ico/issues).

If this plugin is useful to you, you can [☕ buy me a coffee](https://paypal.me/mashgundash).

## Licence

MIT — see [LICENSE](LICENSE). Not affiliated with Ondilo.
