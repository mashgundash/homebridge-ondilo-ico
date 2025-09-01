# Changelog

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

