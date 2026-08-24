'use strict';

const axios = require('axios');

const AUTH_BASE = 'https://interop.ondilo.com';
const API_BASE = 'https://interop.ondilo.com/api/customer/v1';

const REQUEST_TIMEOUT_MS = 15000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 15000;
// Au-delà, on ne tient pas un timer d'attente dans la requête : on rend la main et le cycle
// replanifiera. Réessayer plus tôt que demandé ne ferait que consommer du quota pour un 429.
const MAX_HONORED_RETRY_AFTER_MS = 60000;
// Ondilo plafonne aussi à 5 requêtes par seconde : 250 ms d'écart laissent de la marge.
const MIN_CALL_SPACING_MS = 250;
const TOKEN_SKEW_MS = 60000;

// Ondilo plafonne à 30 requêtes par heure et par utilisateur. On s'arrête à 25 pour garder
// de quoi renouveler le jeton et rattraper une mesure manquante sans se faire couper.
const QUOTA_WINDOW_MS = 3600000;
const QUOTA_MAX = 25;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_NETWORK',
]);

class OndiloAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OndiloAuthError';
  }
}

class OndiloQuotaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OndiloQuotaError';
  }
}

/** Même code que celui posé par axios sur une requête avortée : un seul cas à traiter en aval. */
function abortedError(label) {
  const err = new Error(`${label} annulé (arrêt du plugin)`);
  err.code = 'ERR_CANCELED';
  return err;
}

/** Délai demandé par le serveur, en millisecondes, sans plafonnement : l'appelant décide. */
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

class OndiloApi {
  constructor(log, refreshToken) {
    this.log = log;
    this.refreshToken = refreshToken;
    this.http = axios;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this._refreshPromise = null;
    this._calls = [];
    this._abort = new AbortController();
    this._lastCallAt = 0;
  }

  abortAll() {
    this._abort.abort();
  }

  get aborted() {
    return this._abort.signal.aborted;
  }

  quotaUsed() {
    this._pruneQuota();
    return this._calls.length;
  }

  _pruneQuota() {
    const cutoff = Date.now() - QUOTA_WINDOW_MS;
    while (this._calls.length && this._calls[0] < cutoff) this._calls.shift();
  }

  _reserveQuota(label) {
    this._pruneQuota();
    if (this._calls.length >= QUOTA_MAX) {
      const waitMs = QUOTA_WINDOW_MS - (Date.now() - this._calls[0]);
      throw new OndiloQuotaError(
        `quota Ondilo atteint (${this._calls.length} appels sur la dernière heure, plafond ${QUOTA_MAX}) : ` +
        `${label} refusé, réessai possible dans ${Math.ceil(waitMs / 1000)} s`,
      );
    }
    this._calls.push(Date.now());
  }

  async _sleep(ms) {
    if (this.aborted) return;
    await new Promise((resolve) => {
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      const signal = this._abort.signal;
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      }
      signal.addEventListener('abort', finish, { once: true });
    });
  }

  /** F-16 : lisse les rafales pour rester sous les 5 requêtes par seconde d'Ondilo. */
  async _spaceOutCall() {
    const wait = MIN_CALL_SPACING_MS - (Date.now() - this._lastCallAt);
    if (wait > 0) await this._sleep(wait);
    this._lastCallAt = Date.now();
  }

  _isRetryable(err) {
    if (this.aborted || err?.code === 'ERR_CANCELED') return false;
    const status = err?.response?.status;
    if (typeof status === 'number') return RETRYABLE_STATUS.has(status);
    return RETRYABLE_CODES.has(err?.code);
  }

  async _send(config, label) {
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.aborted) throw abortedError(label);
      this._reserveQuota(label);
      await this._spaceOutCall();
      if (this.aborted) throw abortedError(label);
      try {
        return await this.http({
          timeout: REQUEST_TIMEOUT_MS,
          signal: this._abort.signal,
          ...config,
        });
      } catch (err) {
        lastErr = err;
        if (attempt >= MAX_ATTEMPTS || !this._isRetryable(err)) break;
        const retryAfter = parseRetryAfter(err?.response?.headers?.['retry-after']);
        if (retryAfter !== null && retryAfter > MAX_HONORED_RETRY_AFTER_MS) {
          this.log?.debug?.(
            `[OndiloICO] ${label} : Ondilo demande ${Math.round(retryAfter / 1000)} s d'attente — ` +
            'ce cycle est abandonné, le suivant réessaiera.',
          );
          break;
        }
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
        const delay = retryAfter !== null ? retryAfter : backoff + Math.floor(Math.random() * 500);
        this.log?.debug?.(
          `[OndiloICO] ${label} : échec ${this._describe(err)}, nouvelle tentative dans ${Math.round(delay / 1000)} s ` +
          `(${attempt}/${MAX_ATTEMPTS - 1})`,
        );
        await this._sleep(delay);
      }
    }
    throw lastErr;
  }

  _describe(err) {
    const status = err?.response?.status;
    if (typeof status === 'number') return `HTTP ${status}`;
    return err?.code || err?.message || String(err);
  }

  async ensureAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - TOKEN_SKEW_MS) {
      return this.accessToken;
    }
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this._refreshAccessToken();
    try {
      return await this._refreshPromise;
    } finally {
      this._refreshPromise = null;
    }
  }

  async _refreshAccessToken() {
    const params = new URLSearchParams();
    params.append('refresh_token', this.refreshToken);
    params.append('grant_type', 'refresh_token');
    params.append('client_id', 'customer_api');

    let response;
    try {
      response = await this._send({
        method: 'post',
        url: `${AUTH_BASE}/oauth2/token`,
        data: params.toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      }, 'renouvellement du jeton');
    } catch (err) {
      const status = err?.response?.status;
      if (status === 400 || status === 401) {
        throw new OndiloAuthError(
          'refresh_token invalide ou révoqué — relance "npm run oauth" puis remets à jour le champ ' +
          '« Refresh token » dans la configuration du plugin',
        );
      }
      throw err;
    }

    const data = response?.data;
    const token = typeof data?.access_token === 'string' ? data.access_token : null;
    if (!token) throw new OndiloAuthError("la réponse OAuth ne contient aucun access_token");

    const expiresIn = Number(data?.expires_in);
    this.accessToken = token;
    this.accessTokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000;
    this.log?.debug?.('[OndiloICO] Jeton d\'accès renouvelé.');
    return token;
  }

  /**
   * @param {string} [onlyIf] n'invalide que si le jeton en cache est encore celui-ci. Sans quoi un
   *   401 arrivé en retard détruirait le jeton qu'un autre appel vient déjà de renouveler.
   */
  invalidateAccessToken(onlyIf) {
    if (onlyIf !== undefined && this.accessToken !== onlyIf) return false;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    return true;
  }

  async _authed(config, label) {
    for (let pass = 0; pass < 2; pass++) {
      const token = await this.ensureAccessToken();
      try {
        const response = await this._send({
          ...config,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(config.headers || {}) },
        }, label);
        return response.data;
      } catch (err) {
        if (err?.response?.status !== 401) throw err;
        // Un 401 sur un appel métier signifie que le jeton en cache est mort avant son échéance
        // annoncée : on le jette et on rejoue une seule fois avec un jeton frais.
        if (pass === 0) {
          this.log?.debug?.(`[OndiloICO] ${label} : 401, jeton d'accès invalidé et rejoué une fois.`);
          this.invalidateAccessToken(token);
          continue;
        }
        throw new OndiloAuthError(
          `${label} : refusé (401) malgré un jeton d'accès fraîchement renouvelé — le refresh_token ` +
          'est probablement révoqué. Relance « npm run oauth » et remets à jour le champ « Refresh token ».',
        );
      }
    }
  }

  getPools() {
    return this._authed({ method: 'get', url: `${API_BASE}/pools` }, 'GET /pools');
  }

  getDevice(poolId) {
    return this._authed({ method: 'get', url: `${API_BASE}/pools/${poolId}/device` }, 'GET /device');
  }

  getConfiguration(poolId) {
    return this._authed({ method: 'get', url: `${API_BASE}/pools/${poolId}/configuration` }, 'GET /configuration');
  }

  getUserUnits() {
    return this._authed({ method: 'get', url: `${API_BASE}/user/units` }, 'GET /user/units');
  }

  getRecommendations(poolId) {
    return this._authed({ method: 'get', url: `${API_BASE}/pools/${poolId}/recommendations` }, 'GET /recommendations');
  }

  validateRecommendation(poolId, recommendationId) {
    return this._authed({
      method: 'put',
      url: `${API_BASE}/pools/${poolId}/recommendations/${recommendationId}`,
    }, 'PUT /recommendations');
  }

  getLastMeasures(poolId, measures) {
    // La doc impose la forme tableau répétée (types[]=a&types[]=b) ; la liste séparée par des
    // virgules envoyée jusqu'en 0.5.x était ignorée, d'où le repli systématique sur /measures.
    const params = new URLSearchParams();
    for (const type of measures || []) params.append('types[]', type);
    const query = params.toString();
    return this._authed({
      method: 'get',
      url: `${API_BASE}/pools/${poolId}/lastmeasures${query ? `?${query}` : ''}`,
    }, 'GET /lastmeasures');
  }

  getMeasuresSet(poolId, type, period) {
    const params = new URLSearchParams();
    params.append('type', type);
    params.append('period', period);
    return this._authed({
      method: 'get',
      url: `${API_BASE}/pools/${poolId}/measures?${params.toString()}`,
    }, `GET /measures (${type})`);
  }
}

module.exports = { OndiloApi, OndiloAuthError, OndiloQuotaError, QUOTA_MAX };
