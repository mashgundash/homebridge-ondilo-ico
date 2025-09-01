
'use strict';

/**
 * OAuth helper pour obtenir un refresh_token pour l'API Ondilo.
 * Utilisation :
 *   npm run oauth
 * Puis ouvrir l'URL affichée, se connecter et autoriser l'accès.
 * La redirection revient sur http://localhost:19239/callback et le script affiche les tokens.
 */

const http = require('http');
const axios = require('axios');
const crypto = require('crypto');

const AUTH_BASE = 'https://interop.ondilo.com';

const port = 19239;
const redirectUri = `http://localhost:${port}/callback`;
const state = crypto.randomBytes(8).toString('hex');

const authorizeUrl = `${AUTH_BASE}/oauth2/authorize?client_id=customer_api&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=api&state=${state}`;

console.log('\n=== Ondilo OAuth helper ===');
console.log('1) Ouvrez cette URL dans votre navigateur, connectez-vous et validez l\'accès :\n');
console.log(authorizeUrl + '\n');
console.log('2) Après connexion, vous serez redirigé vers', redirectUri, 'et ce script terminera automatiquement la procédure.\n');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    if (!code || returnedState !== state) {
      res.statusCode = 400;
      res.end('Invalid response');
      return;
    }
    const params = new URLSearchParams();
    params.append('code', code);
    params.append('grant_type', 'authorization_code');
    params.append('client_id', 'customer_api');
    params.append('redirect_uri', redirectUri);
    const tokenUrl = `${AUTH_BASE}/oauth2/token`;
    const { data } = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const pretty = JSON.stringify(data, null, 2);
    console.log('\n=== Tokens reçus ===\n');
    console.log(pretty);
    console.log('\nCopiez le "refresh_token" dans la configuration Homebridge de ce plugin.');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('OK, tokens received. You can close this tab.\n' + pretty);
    server.close();
  } catch (err) {
    console.error('OAuth error:', err?.message || err);
    res.statusCode = 500;
    res.end('OAuth error: ' + (err?.message || String(err)));
    server.close();
  }
});

server.listen(port, () => {
  console.log(`\nÉcoute sur http://localhost:${port} pour la redirection OAuth...\n`);
});
