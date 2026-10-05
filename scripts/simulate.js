#!/usr/bin/env node
'use strict';
// Talk to Sarah in the terminal: no email, no calendar, no database.
//
//   LITELLM_KEY=sk-... node scripts/simulate.js
//
// It runs Sarah's real decision code (src/) against your real model through
// LiteLLM, and keeps one thread in memory, so you can play the client for
// several rounds and see exactly what she understood and what she'd send.
//
// You type as the CLIENT. Commands:
//   /me <text>     you (the employee) reply to Sarah's "Confirm: …" email
//   /busy <ISO start> <ISO end>   add a busy block to the fake calendar
//   /new           start over with a fresh request
//   /state         show the thread
//   /quit
//
// Settings come from env vars (defaults match BZB-AI-1 as of 2026-10-05):
//   LITELLM_URL   http://100.69.55.113:4000/v1/chat/completions (via Tailscale)
//   LITELLM_KEY   the "Scheduling Agent" virtual key (asked for if unset)
//   LLM_MODEL     Qwen3.8-Flash-Next-GGUF-UD-Q3_K_XL
//   LLM_JSON_SCHEMA  false     LLM_THINKING  off
//   EMPLOYEE_NAME "Casey Cutshall"   EMPLOYEE_TZ  America/New_York
const readline = require('readline');
const D = require('../src/decide');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

function makeWorld(o = {}) {
  const name = o.employeeName || env('EMPLOYEE_NAME', 'Casey Cutshall');
  const employee = {
    id: 1, upn: 'employee@bluzonebio.com', mail: 'employee@bluzonebio.com', display_name: name, first_name: name.split(' ')[0],
    timezone: o.tz || env('EMPLOYEE_TZ', 'America/New_York'),
    working_hours: { mon: ['09:00', '17:00'], tue: ['09:00', '17:00'], wed: ['09:00', '17:00'], thu: ['09:00', '17:00'], fri: ['09:00', '17:00'], sat: null, sun: null },
    preferred_start: '09:30', preferred_end: '16:00', default_duration_min: 30, default_location: 'teams', office_address: null,
    hard_gap_min: 5, preferred_gap_min: 30, in_person_buffer_min: 30, max_meetings_per_day: 6, min_notice_hours: 24,
    search_window_days: 10, offers_per_round: 3, bcc_after_intro: true, enrolled: true, calendar_auth: 'app',
    signature_title: `Scheduling Assistant to ${name} (AI)`,
  };
  const thinkingOff = (o.thinking || env('LLM_THINKING', 'off')) === 'off';
  const settings = {
    mode: 'live', sarah_upn: 'sarah.johnson@bluzonebio.com', sarah_name: 'Sarah Johnson', company_name: 'Blu Zone Bio',
    internal_domains: ['bluzonebio.com'], alert_address: 'admin@bluzonebio.com', graph_base_url: 'https://graph.invalid/v1.0',
    litellm_url: o.litellmUrl || env('LITELLM_URL', 'http://100.69.55.113:4000/v1/chat/completions'),
    llm_model: o.model || env('LLM_MODEL', 'Qwen3.8-Flash-Next-GGUF-UD-Q3_K_XL'),
    llm_json_schema: (o.jsonSchema !== undefined ? String(o.jsonSchema) : env('LLM_JSON_SCHEMA', 'false')) === 'true',
    llm_extra_body: thinkingOff ? { chat_template_kwargs: { enable_thinking: false } } : null,
    max_rounds: 4, holds_enabled: true, slot_step_min: 30, widen_window_days: 7, max_horizon_days: 90, require_internal_auth: true,
  };
  return { employee, settings, thread: null, offers: [], busy: [], seq: 1, msgSeq: 1, clientEmail: 'client@example.com', clientName: 'Dana Whitfield' };
}

function message(w, from, body, extra = {}) {
  const id = w.msgSeq++;
  return {
    id, direction: 'in', internet_message_id: `<sim${id}@sim>`, graph_message_id: `SIM-${id}`, conversation_id: 'SIM-CONV',
    from_address: from, from_name: from === w.clientEmail ? w.clientName : w.employee.display_name,
    to_addresses: [], cc_addresses: [], recipient_names: {}, subject: 'Meeting', body_text: body,
    headers: { auth_as: from === w.clientEmail ? 'Anonymous' : 'Internal' }, event_at: new Date().toISOString(), ...extra,
  };
}

function context(w, msg, matchKind) {
  const live = w.offers.filter((o) => o.status === 'offered' || o.status === 'accepted');
  return {
    now: new Date().toISOString(), event: { type: 'message', message_id: msg.id }, settings: w.settings, employees: [w.employee],
    message: msg, match_kind: matchKind, thread: w.thread, thread_offers: w.offers, live_offers: live,
    reply_target: w.lastClientMessage || msg, history: [], open_outbox: [],
  };
}

function calendarFor(w) {
  const ev = (s, e) => ({ id: `B-${s}`, subject: 'Busy', showAs: 'busy', isAllDay: false, isCancelled: false, categories: [],
    responseStatus: { response: 'organizer' },
    start: { dateTime: new Date(s).toISOString().replace('Z', '').replace(/\.\d{3}$/, '.0000000'), timeZone: 'UTC' },
    end: { dateTime: new Date(e).toISOString().replace('Z', '').replace(/\.\d{3}$/, '.0000000'), timeZone: 'UTC' } });
  return { value: w.busy.map(([s, e]) => ev(s, e)) };
}

// apply_plan, in memory: just enough for the next turn.
function applyPlan(w, plan) {
  if (plan.thread.create) {
    w.thread = { id: 1, state: 'NEW', round_count: 0, constraints: {}, plan_version: 0, accepted_offer_id: null,
                 vic_clarify_asked: false, employee_moved_to_bcc: false, other_internal: [], ...plan.thread.create };
  }
  if (!w.thread) return;
  const refs = {};
  for (const u of plan.offers.update) { const o = w.offers.find((x) => x.id === u.id); if (o) o.status = u.status; }
  for (const ins of plan.offers.insert) {
    const o = { id: w.seq++, thread_id: 1, employee_id: 1, status: ins.status || 'offered', flags: ins.flags || [], hold_event_id: null, ...ins };
    delete o.ref;
    w.offers.push(o);
    refs[ins.ref] = o.id;
  }
  const set = { ...plan.thread.set };
  if (set.accepted_offer_ref) { set.accepted_offer_id = refs[set.accepted_offer_ref]; delete set.accepted_offer_ref; }
  delete set.touch_inbound;
  Object.assign(w.thread, set);
  if (plan.thread.transitions.length) w.thread.state = plan.thread.transitions[plan.thread.transitions.length - 1];
  w.thread.plan_version += 1;
  if (plan.outbox.some((o) => o.kind === 'create_booking')) w.thread.state = 'BOOKED';   // pretend the booking succeeded
}

/**
 * One turn. llm(body) → OpenAI-style response (real fetch, or a fake in tests).
 * Returns a readable report.
 */
async function turn(w, who, text, llm) {
  let msg;
  let matchKind;
  if (who === 'trigger') {
    msg = message(w, w.employee.upn, text, { to_addresses: [w.clientEmail], cc_addresses: [w.settings.sarah_upn],
                                           recipient_names: { [w.clientEmail]: w.clientName } });
    matchKind = null;
  } else if (who === 'me') {
    msg = message(w, w.employee.upn, text, { to_addresses: [w.settings.sarah_upn] });
    matchKind = 'confirmation';
  } else {
    msg = message(w, w.clientEmail, text, { to_addresses: [w.settings.sarah_upn] });
    matchKind = 'conversation';
    w.lastClientMessage = msg;
  }
  if (who === 'trigger') w.lastClientMessage = msg;

  const call = async (req) => (req ? llm(req.body) : null);
  let S = D.start(context(w, msg, matchKind));
  S = D.interpret(S, await call(S.llm));
  S = D.act(S, S.calendar ? calendarFor(w) : null);
  S = D.finish(S, await call(S.llm));
  if (S.llm) S = D.finish(S, await call(S.llm));   // the one redraft

  const plan = S.plan;
  const report = { understood: S.classification, action: S.action && S.action.type, log: S.log, emails: [] };
  if (plan) {
    for (const o of plan.outbox) {
      if (o.kind === 'reply') report.emails.push({ to: 'client', purpose: o.purpose, source: o.payload.draft_source, body: o.payload.body_text, errors: o.payload.draft_errors });
      if (o.kind === 'new_mail' || o.kind === 'notify_internal') report.emails.push({ to: 'you', purpose: o.purpose, subject: o.payload.subject, body: o.payload.body_text });
    }
    report.offered = plan.offers.insert.filter((o) => (o.status || 'offered') === 'offered').length;
    applyPlan(w, plan);
  }
  report.state = w.thread ? w.thread.state : '(no thread)';
  return report;
}

function realLlm(world, key) {
  return async (body) => {
    const r = await fetch(world.settings.litellm_url, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.replace(/^Bearer\s+/i, '')}` }, body: JSON.stringify(body) });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch (_) { json = null; }
    if (r.status < 200 || r.status >= 300) return { error: { status: r.status, body: json || text.slice(0, 300) } };
    return json;
  };
}

function print(rep) {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const c = rep.understood;
  if (c) {
    const bits = Object.entries(c).filter(([k, v]) => k !== '_log' && v !== null && !(Array.isArray(v) && !v.length) && v !== 'any' && v !== '')
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    console.log(dim(`  understood: ${bits.join('  ')}`));
  }
  console.log(dim(`  decided:    ${rep.action}   →   thread ${rep.state}`));
  for (const l of rep.log || []) console.log(dim(`  log:        ${l}`));
  for (const e of rep.emails) {
    if (e.to === 'client') {
      console.log(`\n\x1b[36m── Sarah → client  (${e.purpose}, wording: ${e.source}) ──\x1b[0m\n${e.body}\n`);
      if (e.errors && e.errors.length) console.log(dim(`  rejected drafts: ${e.errors.join(' | ')}`));
    } else {
      console.log(`\n\x1b[33m── Sarah → you  (${e.purpose}) ── ${e.subject}\x1b[0m\n${e.body.split('\n').slice(0, 14).join('\n')}\n`);
    }
  }
}

async function main() {
  const world = makeWorld();
  let key = env('LITELLM_KEY', '');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  if (!key) key = (await ask('LiteLLM key (sk-…): ')).trim();
  const llm = realLlm(world, key);
  console.log(`\nSimulating Sarah for ${world.employee.display_name} (${world.employee.timezone}), model ${world.settings.llm_model}.`);
  console.log('Nothing is emailed, booked or saved. Type /quit to stop.\n');
  let fresh = true;
  for (;;) {
    if (fresh) {
      const t = (await ask('Your request to Sarah (as the employee, e.g. "Sarah will find us a time next week"):\n> ')).trim();
      if (t === '/quit') break;
      try { print(await turn(world, 'trigger', t || 'Sarah will find us a time.', llm)); } catch (e) { console.log(`  error: ${e.message}`); }
      fresh = false;
      continue;
    }
    const line = (await ask('client> ')).trim();
    if (!line) continue;
    if (line === '/quit') break;
    if (line === '/new') { Object.assign(world, makeWorld(), { busy: world.busy }); fresh = true; continue; }
    if (line === '/state') { console.log(JSON.stringify({ thread: world.thread, offers: world.offers.map((o) => ({ option: o.option_no, start: o.start, status: o.status })) }, null, 2)); continue; }
    if (line.startsWith('/busy ')) { const [, s, e] = line.split(/\s+/); world.busy.push([s, e]); console.log('  added busy block'); continue; }
    try {
      if (line.startsWith('/me ')) print(await turn(world, 'me', line.slice(4), llm));
      else print(await turn(world, 'client', line, llm));
    } catch (e) { console.log(`  error: ${e.message}`); }
  }
  rl.close();
}

if (require.main === module) main();

module.exports = { makeWorld, turn, applyPlan };
