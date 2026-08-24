'use strict';

/**
 * Assistant OAuth : obtient un refresh_token pour l'API Ondilo.
 *
 *   npm run oauth
 *
 * Ouvre l'URL affichée, connecte-toi et autorise l'accès. La redirection revient sur
 * http://localhost:19239/callback — c'est l'URI enregistrée côté Ondilo, à ne pas changer — et
 * le serveur n'écoute que sur la boucle locale 127.0.0.1. Le jeton s'affiche dans ce terminal,
 * jamais dans la page du navigateur. Si Homebridge tourne sur une autre machine, ouvre un tunnel :
 *   ssh -L 19239:localhost:19239 <utilisateur>@<hôte>
 */

const http = require('http');
const crypto = require('crypto');
const axios = require('axios');

const AUTH_BASE = 'https://interop.ondilo.com';
const PORT = Number(process.env.ONDILO_OAUTH_PORT) || 19239;
const TIMEOUT_MS = 5 * 60 * 1000;

const redirectUri = `http://localhost:${PORT}/callback`;
const state = crypto.randomBytes(16).toString('hex');
const authorizeUrl = `${AUTH_BASE}/oauth2/authorize?client_id=customer_api&response_type=code`
  + `&redirect_uri=${encodeURIComponent(redirectUri)}&scope=api&state=${state}`;

let finished = false;
let exchanging = false;
let guardTimer = null;

function respond(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.end(text);
}

function finish(code, message) {
  if (finished) return;
  finished = true;
  if (guardTimer) clearTimeout(guardTimer);
  if (message) (code === 0 ? console.log : console.error)(message);
  process.exitCode = code;
  server.closeAllConnections();
  server.close();
}

const server = http.createServer(async (req, res) => {
  // Un navigateur rejoue volontiers la redirection. Sans ce verrou posé avant le premier await,
  // le second échange — plus rapide à échouer — fermerait le serveur et emporterait le jeton que
  // le premier était en train d'obtenir.
  if (finished || exchanging) {
    respond(res, 409, 'Procédure déjà en cours. Retourne au terminal.');
    return;
  }
  let url;
  try {
    url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    respond(res, 400, 'Requête invalide.');
    return;
  }

  if (url.pathname !== '/callback') {
    respond(res, 404, 'Not Found');
    return;
  }

  // Le state est authentifié AVANT toute autre lecture, y compris celle de `error` : une page
  // quelconque du navigateur peut viser ce port, et un faux refus arrêterait l'assistant légitime.
  const returnedState = url.searchParams.get('state');
  if (returnedState !== state) {
    respond(res, 400, 'Réponse inattendue, ignorée.');
    console.error('\nCallback reçu avec un paramètre « state » incorrect : ignoré, l\'assistant continue d\'attendre.');
    return;
  }

  const error = url.searchParams.get('error');
  if (error) {
    const description = url.searchParams.get('error_description') || '';
    respond(res, 400, 'Autorisation refusée. Retourne au terminal.');
    finish(1, `\nAutorisation refusée côté Ondilo (${error})${description ? ` : ${description}` : ''}.`
      + '\nRelance la commande et clique sur « Autoriser ».');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    respond(res, 400, 'Réponse incomplète. Retourne au terminal.');
    finish(1, '\nLa redirection ne contient aucun code d\'autorisation.');
    return;
  }

  exchanging = true;
  const params = new URLSearchParams();
  params.append('code', code);
  params.append('grant_type', 'authorization_code');
  params.append('client_id', 'customer_api');
  params.append('redirect_uri', redirectUri);

  try {
    const { data } = await axios.post(`${AUTH_BASE}/oauth2/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      timeout: 15000,
    });
    const refreshToken = data?.refresh_token;
    if (!refreshToken) {
      respond(res, 502, 'Réponse inattendue d\'Ondilo. Retourne au terminal.');
      finish(1, '\nOndilo n\'a renvoyé aucun refresh_token. Réponse reçue sans jeton exploitable.');
      return;
    }
    // Le jeton ne part jamais dans la page : le navigateur en garderait une trace.
    respond(res, 200, 'Jeton reçu. Tu peux fermer cet onglet et retourner au terminal.');
    finish(0, '\n=== Refresh token Ondilo ===\n\n' + refreshToken
      + '\n\nColle cette valeur dans le champ « Refresh token » des réglages du plugin, puis redémarre Homebridge.');
  } catch (err) {
    const status = err?.response?.status;
    respond(res, 502, 'Échange du code impossible. Retourne au terminal.');
    finish(1, `\nÉchange du code d'autorisation en échec : ${status ? `HTTP ${status}` : (err?.message || err)}.`);
  } finally {
    exchanging = false;
  }
});

server.on('error', err => {
  if (err?.code === 'EADDRINUSE') {
    console.error(`\nLe port ${PORT} est déjà occupé. Ferme le processus qui l'utilise, ou relance avec `
      + `ONDILO_OAUTH_PORT=<autre port> npm run oauth (le port doit correspondre à l'URL de redirection).`);
  } else {
    console.error(`\nServeur local en échec : ${err?.message || err}`);
  }
  process.exitCode = 1;
});

// Sans ce garde-fou, un utilisateur qui ferme son navigateur laisse le script en vie et le
// port occupé, ce qui fait échouer la tentative suivante.
guardTimer = setTimeout(() => {
  finish(1, `\nAucune réponse reçue en ${TIMEOUT_MS / 60000} minutes : abandon.`);
}, TIMEOUT_MS);
guardTimer.unref();

server.listen(PORT, '127.0.0.1', () => {
  console.log('\n=== Assistant OAuth Ondilo ===\n');
  console.log('1) Ouvre cette URL dans un navigateur, connecte-toi et valide l\'accès :\n');
  console.log(authorizeUrl + '\n');
  console.log(`2) Tu seras redirigé vers ${redirectUri} et ce script terminera la procédure.\n`);
  console.log(`En attente sur http://127.0.0.1:${PORT} (5 minutes maximum)...\n`);
});
