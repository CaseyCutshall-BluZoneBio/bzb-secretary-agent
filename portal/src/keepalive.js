'use strict';
// Daily token refresh for every connected employee. It keeps refresh tokens
// from expiring after 90 days without use, and finds a dead token (revoked,
// account disabled, Conditional Access) before a client email arrives: the
// employee gets the one reconnect email then, not mid-negotiation.

async function refreshAll({ db, tokens, logger }) {
  const list = await db.keepaliveList();
  let ok = 0;
  for (const e of list) {
    const r = await tokens.getAccessToken(e.id, { forceRefresh: true });
    if (r.ok) ok += 1;
  }
  logger.info('keepalive_done', { employees: list.length, ok });
  return { employees: list.length, ok };
}

function startKeepalive({ db, tokens, logger, hours = 24 }) {
  const run = () => refreshAll({ db, tokens, logger }).catch((e) => logger.error('keepalive_failed', { message: e && e.message }));
  const first = setTimeout(run, 60 * 1000 + Math.floor(Math.random() * 60 * 1000));
  const every = setInterval(run, hours * 3600 * 1000);
  first.unref();
  every.unref();
  return () => { clearTimeout(first); clearInterval(every); };
}

module.exports = { refreshAll, startKeepalive };
