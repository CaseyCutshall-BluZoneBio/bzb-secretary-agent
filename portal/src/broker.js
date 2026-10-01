'use strict';
// The token broker: the INTERNAL listener (compose network only, never
// published, never routed by the public server). n8n names an employee and one
// of three calendar operations; the broker calls Graph on /me with that
// employee's token and returns Graph's status and body unchanged. Tokens never
// leave this process.
//
//   POST /internal/v1/calendar   (header X-Sarah-Broker-Key)
//     {"employee_upn","op":"calendar_view","start","end"}
//     {"employee_upn","op":"create_event","event":{…}}
//     {"employee_upn","op":"delete_event","event_id"}
//   GET  /internal/v1/health
//
//   Graph's status + body       the call went through (on a Graph 401 the
//                               broker refreshes once and retries first)
//   401 BrokerAuth              missing or wrong key
//   400 BadRequest              malformed request
//   422 EmployeeNotDelegated    unknown employee, or not on delegated calendars
//   409 NeedsReconnect          refresh failed for good (flagged, one email queued)
//   503 TokenServiceUnavailable Entra/network/app problem; retry later
const { safeEqual } = require('./crypto');

const SELECT = 'subject,start,end,showAs,isAllDay,isCancelled,categories,responseStatus';
const MAX_BODY = 256 * 1024;
const MAX_RANGE_MS = 400 * 86400e3;

function sendJson(res, status, body) {
  const text = body === undefined || body === null ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
                          'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
const err = (res, status, code, message) => sendJson(res, status, { error: { code, message } });

function readJson(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { resolve({ tooLarge: true }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (_) { resolve({ bad: true }); }
    });
    req.on('error', () => resolve({ bad: true }));
  });
}

// Request body → Graph call on /me. Returns { method, path, body, headers } or { error }.
function graphCallFor(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'body must be a JSON object' };
  if (typeof b.employee_upn !== 'string' || !b.employee_upn.includes('@')) return { error: 'employee_upn is required' };
  switch (b.op) {
    case 'calendar_view': {
      const s = Date.parse(b.start);
      const e = Date.parse(b.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > MAX_RANGE_MS) return { error: 'start/end must be ISO times, end after start, at most 400 days apart' };
      const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const qs = [`startDateTime=${encodeURIComponent(iso(s))}`, `endDateTime=${encodeURIComponent(iso(e))}`,
                  `$select=${encodeURIComponent(SELECT)}`, '$top=500'].join('&');
      return { method: 'GET', path: `/me/calendarView?${qs}`, headers: { Prefer: 'outlook.timezone="UTC"' } };
    }
    case 'create_event':
      if (!b.event || typeof b.event !== 'object' || Array.isArray(b.event)) return { error: 'event must be an object' };
      return { method: 'POST', path: '/me/events', body: b.event };
    case 'delete_event':
      if (typeof b.event_id !== 'string' || !b.event_id || b.event_id.length > 512) return { error: 'event_id is required' };
      return { method: 'DELETE', path: `/me/events/${encodeURIComponent(b.event_id)}` };
    default:
      return { error: 'op must be calendar_view, create_event or delete_event' };
  }
}

function createBrokerApp({ config, db, tokens, graph, logger }) {
  async function calendar(req, res) {
    const parsed = await readJson(req);
    if (parsed.tooLarge) return err(res, 413, 'BadRequest', 'body too large');
    if (parsed.bad) return err(res, 400, 'BadRequest', 'body must be JSON');
    const call = graphCallFor(parsed.value);
    if (call.error) return err(res, 400, 'BadRequest', call.error);
    const upn = parsed.value.employee_upn.trim().toLowerCase();

    const emp = await db.employeeByUpn(upn);
    if (!emp || !emp.enrolled || emp.calendar_auth !== 'delegated') {
      return err(res, 422, 'EmployeeNotDelegated', 'this employee is not on delegated calendar access');
    }
    if (!emp.connected) return err(res, 409, 'NeedsReconnect', 'the employee has not connected their calendar yet');

    let t = await tokens.getAccessToken(emp.id);
    if (!t.ok) return tokenError(res, t);
    let r = await graph.call(call.method, call.path, t.token, { body: call.body, headers: call.headers });
    if (r.status === 401) {
      // Revoked mid-life (or consent withdrawn): refresh once, then decide.
      t = await tokens.getAccessToken(emp.id, { forceRefresh: true });
      if (!t.ok) return tokenError(res, t);
      r = await graph.call(call.method, call.path, t.token, { body: call.body, headers: call.headers });
    }
    if (r.status === 0) return err(res, 503, 'GraphUnreachable', 'could not reach Microsoft Graph');
    logger.info('broker_call', { employee_id: emp.id, op: parsed.value.op, status: r.status });
    if (r.status === 204 || r.body === null) { res.writeHead(r.status, { 'Cache-Control': 'no-store' }); return res.end(); }
    return sendJson(res, r.status, r.body);
  }

  function tokenError(res, t) {
    if (t.kind === 'reconnect') return err(res, 409, 'NeedsReconnect', 'the employee must reconnect their calendar');
    return err(res, 503, 'TokenServiceUnavailable', 'could not get a token right now; retry later');
  }

  return async function brokerHandler(req, res) {
    try {
      const path = (req.url || '').split('?')[0];
      if (req.method === 'GET' && path === '/internal/v1/health') return sendJson(res, 200, { ok: true });
      if (path !== '/internal/v1/calendar') return err(res, 404, 'NotFound', 'not found');
      if (!safeEqual(String(req.headers['x-sarah-broker-key'] || ''), config.brokerKey)) {
        return err(res, 401, 'BrokerAuth', 'missing or wrong broker key');
      }
      if (req.method !== 'POST') return err(res, 405, 'BadRequest', 'POST only');
      return await calendar(req, res);
    } catch (e) {
      logger.error('broker_error', { message: e && e.message });
      if (!res.headersSent) return err(res, 500, 'BrokerError', 'internal error');
      return res.end();
    }
  };
}

module.exports = { createBrokerApp, graphCallFor };
