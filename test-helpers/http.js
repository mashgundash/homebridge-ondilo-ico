'use strict';

// Substitution du client HTTP. Deux verrous plutôt qu'un :
//   1. `require('axios')` est intercepté et rendu explosif — le module n'a même pas besoin d'être
//      installé, et toute tentative de s'en servir fait échouer le test au lieu de partir sur le
//      réseau. L'API Ondilo est en production : un seul appel réel suffirait à invalider le jeton.
//   2. chaque instance d'OndiloApi reçoit son propre `http`, une fonction locale.

const Module = require('node:module');

const explodingAxios = () => {
  throw new Error('axios réel appelé depuis un test : aucune requête réseau ne doit sortir');
};
explodingAxios.get = explodingAxios;
explodingAxios.post = explodingAxios;
explodingAxios.put = explodingAxios;
explodingAxios.request = explodingAxios;
explodingAxios.default = explodingAxios;

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'axios') return explodingAxios;
  return originalLoad.call(this, request, parent, isMain);
};

/** Erreur telle qu'axios la construit pour une réponse HTTP d'échec. */
function httpError(status, headers = {}) {
  const err = new Error(`Request failed with status code ${status}`);
  err.isAxiosError = true;
  err.response = { status, headers, data: null };
  return err;
}

/** Erreur telle qu'axios la construit pour une panne de transport (pas de réponse). */
function networkError(code = 'ECONNREFUSED') {
  const err = new Error(`network failure ${code}`);
  err.isAxiosError = true;
  err.code = code;
  return err;
}

class HttpStub {
  constructor() {
    this.routes = [];
    this.calls = [];
  }

  /**
   * Enregistre une route. La première route dont le fragment est contenu dans l'URL répond, donc
   * les fragments les plus spécifiques se déclarent en premier. Réenregistrer exactement le même
   * fragment remplace la réponse sans changer sa position : un test peut ainsi surcharger une
   * route posée par un helper.
   *
   * @param {string|RegExp} match fragment d'URL, ou expression régulière
   * @param {Function|object} responder réponse (`{ data }`), erreur à lever, ou fonction
   */
  on(match, responder) {
    const key = String(match);
    const existing = this.routes.find(entry => String(entry.match) === key);
    if (existing) existing.responder = responder;
    else this.routes.push({ match, responder });
    return this;
  }

  /** Fonction à poser sur `client.http`. */
  get handler() {
    return async (config) => {
      this.calls.push(config);
      if (config.signal?.aborted) {
        const err = new Error('canceled');
        err.code = 'ERR_CANCELED';
        throw err;
      }
      const url = String(config.url || '');
      const route = this.routes.find(entry => (
        entry.match instanceof RegExp ? entry.match.test(url) : url.includes(entry.match)
      ));
      if (!route) throw new Error(`aucune route de test pour ${config.method || 'get'} ${url}`);
      const value = typeof route.responder === 'function' ? await route.responder(config) : route.responder;
      if (value instanceof Error) throw value;
      return value;
    };
  }

  /** URLs appelées, dans l'ordre. */
  get urls() {
    return this.calls.map(call => String(call.url));
  }

  countMatching(fragment) {
    return this.urls.filter(url => url.includes(fragment)).length;
  }
}

/** Réponse OAuth valide, réutilisée par presque tous les tests. */
function tokenResponse(expiresIn = 3600) {
  return { data: { access_token: `at-${Math.random().toString(16).slice(2)}`, expires_in: expiresIn } };
}

module.exports = { HttpStub, httpError, networkError, tokenResponse, explodingAxios };
