'use strict';
// Minimal Microsoft Graph client. Returns { status, body } and never throws for
// an HTTP error; a network failure returns { status: 0, error }.

function createGraph({ baseUrl, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  async function call(method, path, token, { body, headers = {} } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
                   ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        redirect: 'error',
      });
      const text = await res.text();
      let parsed = null;
      if (text) { try { parsed = JSON.parse(text); } catch (_) { parsed = { error: { code: 'NonJsonResponse', message: 'Graph returned a non-JSON body' } }; } }
      return { status: res.status, body: parsed };
    } catch (e) {
      return { status: 0, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
    }
  }
  return { call };
}

module.exports = { createGraph };
