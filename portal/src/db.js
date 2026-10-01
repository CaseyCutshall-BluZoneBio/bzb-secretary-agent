'use strict';
// The portal's only way into Postgres: the sched.portal_* functions
// (db/004_portal.sql). It connects as sched_portal, which can execute those
// and nothing else. Everything is parameterized.

function createDb(pool) {
  const one = async (sql, params) => {
    const r = await pool.query(sql, params);
    return r.rows[0] ? r.rows[0].v : null;
  };
  const json = (x) => JSON.stringify(x);
  return {
    config: () => one('SELECT sched.portal_config() AS v'),
    signIn: (profile) => one('SELECT sched.portal_sign_in($1::jsonb) AS v', [json(profile)]),
    employee: (id) => one('SELECT sched.portal_employee($1) AS v', [id]),
    employeeByUpn: (upn) => one('SELECT sched.portal_employee_by_upn($1) AS v', [upn]),
    connected: (id, prefill) => one('SELECT sched.portal_connected($1, $2::jsonb) AS v', [id, prefill ? json(prefill) : null]),
    saveSettings: (id, value) => one('SELECT sched.portal_save_settings($1, $2::jsonb) AS v', [id, json(value)]),
    setPaused: (id, paused) => one('SELECT sched.portal_set_paused($1, $2) AS v', [id, paused]),
    tokenGet: (id) => one('SELECT sched.portal_token_get($1) AS v', [id]),
    tokenPut: (id, rec) => one('SELECT sched.portal_token_put($1, $2::jsonb) AS v', [id, json(rec)]),
    tokenIds: async () => (await pool.query('SELECT sched.portal_token_ids() AS v')).rows.map((r) => r.v),
    keepaliveList: async () => (await pool.query('SELECT sched.portal_keepalive_list() AS v')).rows.map((r) => r.v),
    tokenOk: (id) => one('SELECT sched.portal_token_ok($1) AS v', [id]),
    markReconnect: (id, code, notifyEmployee) => one('SELECT sched.portal_mark_reconnect($1, $2, $3) AS v', [id, code, notifyEmployee]),
    queueTestMail: (id) => one('SELECT sched.portal_queue_test_mail($1) AS v', [id]),
    myThreads: (id) => one('SELECT sched.portal_my_threads($1) AS v', [id]),
    overview: () => one('SELECT sched.portal_overview() AS v'),
    sessionCreate: (hash, id, csrf, ttl) => one('SELECT sched.portal_session_create($1, $2, $3, $4) AS v', [hash, id, csrf, ttl]),
    sessionGet: (hash) => one('SELECT sched.portal_session_get($1) AS v', [hash]),
    sessionDelete: (hash) => one('SELECT sched.portal_session_delete($1) AS v', [hash]),
  };
}

module.exports = { createDb };
