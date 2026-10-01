'use strict';
// Who is this email from, and what kind of event is it? Pure function of the
// context loaded from Postgres. No model involved: authorization is code.
const { lower, isInternal, setting, delegated } = require('./util');

const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|undeliverable|delivery (status notification|has failed)|mail delivery (failed|subsystem)|returned mail|read:|not read:)/i;
const DAEMON_FROM = /^(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/i;

function isAutoReply(msg) {
  const h = msg.headers || {};
  const auto = lower(h.auto_submitted);
  if (auto && auto !== 'no') return true;
  if (['bulk', 'junk', 'list', 'auto_reply', 'auto-reply'].includes(lower(h.precedence))) return true;
  if (h.x_autoreply || h.x_autorespond) return true;
  if (AUTO_SUBJECT.test(String(msg.subject || '').trim())) return true;
  if (DAEMON_FROM.test(lower(msg.from_address))) return true;
  return false;
}

/**
 * Returns { kind, ... }:
 *   skip                 — already processed / not found
 *   ignore               — log it and do nothing ({ disposition })
 *   new_trigger          — enrolled employee CC'd Sarah on a new thread
 *                          (ignored with a notice while they're paused or
 *                          their delegated calendar isn't connected)
 *   client_reply         — someone outside BZB replied on a known thread
 *   employee_confirmation — employee answered Sarah's confirmation request
 *   employee_in_thread   — employee wrote in the client thread itself
 *   timer                — follow-up / stall / reminder event
 */
// A new request from an employee, unless they can't use Sarah right now.
// Threads already running are not affected by either check.
function newTrigger(employee, extra = {}) {
  if (employee.paused) return { kind: 'ignore', disposition: 'ignored_paused', notice: 'paused', employee };
  if (delegated(employee) && (!employee.calendar_connected_at || employee.needs_reconnect)) {
    return { kind: 'ignore', disposition: 'ignored_needs_reconnect', notice: 'not_connected', employee };
  }
  return { kind: 'new_trigger', employee, ...extra };
}

function route(ctx) {
  if (!ctx || ctx.skip) return { kind: 'skip', reason: ctx && ctx.reason };

  const mode = setting(ctx, 'mode', 'off');
  const thread = ctx.thread || null;

  if (ctx.event && ctx.event.type === 'timer') {
    if (!thread) return { kind: 'ignore', disposition: 'timer_no_thread' };
    const expect = { client_followup: 'PROPOSED', mark_stalled: 'PROPOSED', remind_vic: 'AWAITING_VIC' }[ctx.event.action];
    if (!expect || thread.state !== expect) return { kind: 'ignore', disposition: 'timer_stale' };
    return { kind: 'timer', action: ctx.event.action };
  }

  if (mode === 'off') return { kind: 'ignore', disposition: 'ignored_mode_off' };

  const msg = ctx.message;
  if (!msg) return { kind: 'skip', reason: 'no message' };

  const from = lower(msg.from_address);
  const sarah = lower(setting(ctx, 'sarah_upn', ''));
  const domains = setting(ctx, 'internal_domains', []);

  if (from === sarah) return { kind: 'ignore', disposition: 'ignored_self' };
  if (isAutoReply(msg)) return { kind: 'ignore', disposition: 'ignored_autoreply', attach: !!thread };

  const employee = (ctx.employees || []).find((e) => e.enrolled && (lower(e.upn) === from || (e.mail && lower(e.mail) === from)));

  if (employee) {
    const auth = lower((msg.headers || {}).auth_as);
    if (setting(ctx, 'require_internal_auth', true) && auth !== 'internal') {
      // Looks like Vic but Exchange didn't authenticate it as internal mail:
      // possible spoof. Never let it drive the calendar.
      return { kind: 'ignore', disposition: 'ignored_unauthenticated', alert: true };
    }
    if (thread && (ctx.match_kind === 'confirmation' || ctx.match_kind === 'token')) {
      if (thread.state === 'AWAITING_VIC' && thread.employee_id === employee.id) {
        return { kind: 'employee_confirmation', employee };
      }
      return { kind: 'ignore', disposition: 'ignored_employee_note', attach: true };
    }
    const addressed = [...(msg.to_addresses || []), ...(msg.cc_addresses || [])].map(lower).includes(sarah);
    if (thread && ctx.match_kind === 'conversation') {
      // A finished negotiation in this email thread: Vic may be asking for a
      // new meeting ("Sarah, find us a follow-up time"). The trigger
      // classifier decides; a plain "thanks" is ignored there.
      if (['BOOKED', 'CLOSED', 'STALLED'].includes(thread.state)) {
        return addressed ? newTrigger(employee, { reuseConversation: true })
                         : { kind: 'ignore', disposition: 'ignored_thread_finished', attach: true };
      }
      return { kind: 'employee_in_thread', employee };
    }
    if (!addressed) return { kind: 'ignore', disposition: 'ignored_not_addressed' };
    return newTrigger(employee);
  }

  if (isInternal(from, domains)) {
    // A non-enrolled colleague (Brad, Josh...). Never actionable in v1.
    return { kind: 'ignore', disposition: 'ignored_internal_other', attach: !!thread };
  }

  if (!thread) return { kind: 'ignore', disposition: 'ignored_no_thread' };
  if (thread.state === 'CLOSED') return { kind: 'ignore', disposition: 'ignored_thread_closed', attach: true };
  if (thread.state === 'NEEDS_VIC') return { kind: 'ignore', disposition: 'ignored_thread_escalated', attach: true };
  // Fallback matches (broken thread) require the sender to already be a client.
  if (ctx.match_kind !== 'conversation' && !(thread.client_addresses || []).map(lower).includes(from)) {
    return { kind: 'ignore', disposition: 'ignored_unknown_sender' };
  }
  return { kind: 'client_reply' };
}

module.exports = { route, isAutoReply };
