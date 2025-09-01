'use strict';

const axios = require('axios');

const AUTH_BASE = 'https://interop.ondilo.com';
const API_BASE  = 'https://interop.ondilo.com/api/customer/v1';

class OndiloApi {
  constructor(log, refreshToken) {
    this.log = log;
    this.refreshToken = refreshToken;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async requestWithRetry(fn, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try { return await fn(); }
      catch (err) {
        lastErr = err;
        const isTimeout = err?.code === 'ECONNABORTED' || (err?.message && err.message.includes('timeout'));
        if (isTimeout) {
          this.log?.warn?.(`[OndiloICO] Timeout API, tentative ${attempt + 1} sur ${retries + 1}`);
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
        }
        break;
      }
    }
    throw lastErr;
  }

  async ensureAccessToken() {
    const now = Date.now();
    if (this.accessToken && now < this.accessTokenExpiresAt - 10_000) return this.accessToken;

    const params = new URLSearchParams();
    params.append('refresh_token', this.refreshToken);
    params.append('grant_type', 'refresh_token');
    params.append('client_id', 'customer_api');

    const { data } = await this.requestWithRetry(() => axios.post(
      `${AUTH_BASE}/oauth2/token`,
      params,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30000 }
    ));

    this.accessToken = data?.access_token || null;
    const expiresIn = Number(data?.expires_in || 1800);
    this.accessTokenExpiresAt = Date.now() + expiresIn * 1000;
    if (!this.accessToken) throw new Error('No access_token from OAuth refresh');
    return this.accessToken;
  }

  async getPools() {
    const token = await this.ensureAccessToken();
    const { data } = await this.requestWithRetry(() => axios.get(
      `${API_BASE}/pools`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 30000 }
    ));
    return data;
  }

  async getLastMeasures(poolId, measures) {
    const token = await this.ensureAccessToken();
    const qs = encodeURIComponent((measures || []).join(','));
    const { data } = await this.requestWithRetry(() => axios.get(
      `${API_BASE}/pools/${poolId}/lastmeasures?types=${qs}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 30000 }
    ));
    return data;
  }

  async getMeasuresSet(poolId, type, period) {
    const token = await this.ensureAccessToken();
    const params = new URLSearchParams();
    params.append('type', type);
    params.append('period', period);
    const { data } = await this.requestWithRetry(() => axios.get(
      `${API_BASE}/pools/${poolId}/measures?${params.toString()}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, timeout: 30000 }
    ));
    return data;
  }
}

module.exports = { OndiloApi };
