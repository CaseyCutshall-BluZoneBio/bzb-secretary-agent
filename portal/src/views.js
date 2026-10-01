'use strict';
// Server-rendered pages. No JavaScript at all (the CSP forbids it). Every
// value is HTML-escaped; flash messages are fixed strings chosen by code, never
// text from the request.
const { DAYS, DAY_NAMES } = require('./settings');
const { COMMON_ZONES } = require('./tz');

const h = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const FLASH = {
  connected: ['ok', 'Your calendar is connected. Check your settings below, then you can start using Sarah.'],
  saved: ['ok', 'Settings saved. Sarah uses them from the next request.'],
  paused: ['ok', 'Sarah is paused. She won\'t start anything new for you until you resume. Threads already running continue.'],
  resumed: ['ok', 'Sarah is back on. CC her on an email to start.'],
  test_sent: ['ok', 'Test email queued. It should arrive from Sarah within a couple of minutes.'],
  test_not_sent: ['warn', 'Test email recorded, but Sarah is in %MODE% mode, so it won\'t actually be sent. Ask your admin.'],
  consent_missing: ['warn', 'Microsoft didn\'t grant calendar access. Try again; if it keeps happening, ask your admin to approve Sarah for the organization.'],
  connect_failed: ['warn', 'Connecting your calendar didn\'t work. Try again in a minute.'],
  wrong_account: ['warn', 'You connected a different Microsoft account than the one you\'re signed in with. Sign out and use one account.'],
};

function layout({ title, emp, csrf, admin = false, body, flash, mode }) {
  let flashHtml = '';
  if (flash && FLASH[flash]) {
    const [kind, text] = FLASH[flash];
    flashHtml = `<p class="flash ${kind}" role="status">${h(text.replace('%MODE%', mode || ''))}</p>`;
  }
  const nav = emp ? `<nav aria-label="Main">
      <a href="/">Home</a><a href="/settings">Settings</a><a href="/threads">My threads</a><a href="/help">How to use Sarah</a>${admin ? '<a href="/admin">Admin</a>' : ''}
      <form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="link">Sign out</button></form>
    </nav>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${h(title)} · Sarah</title>
<link rel="stylesheet" href="/static/portal.css">
</head>
<body>
<header class="top">
  <div class="brand"><span class="mark" aria-hidden="true">S</span><span>Sarah <small>AI scheduling assistant · Blu Zone Bio</small></span></div>
  ${emp ? `<div class="who">${h(emp.display_name)}</div>` : ''}
</header>
${nav}
<main>
${flashHtml}
${body}
</main>
</body>
</html>`;
}

const GENERIC_ERROR = 'Sign-in didn\'t work. Try again. If you\'re new, ask your admin to add you to the "Sarah users" group.';

function loginPage({ error } = {}) {
  return layout({ title: 'Sign in', body: `
<section class="card narrow">
  <h1>Sign in to set up Sarah</h1>
  <p>Sarah finds meeting times with people outside BZB and books them on your calendar. Sign in with your Blu Zone Bio Microsoft 365 account to connect your calendar and choose your preferences.</p>
  ${error ? `<p class="flash warn" role="alert">${h(GENERIC_ERROR)}</p>` : ''}
  <form method="post" action="/login"><button class="primary">Sign in with Microsoft</button></form>
</section>` });
}

function statusRows(emp, mode) {
  let cal;
  if (emp.calendar_auth === 'app') cal = ['ok', 'Connected by your admin (legacy setup). Connect it yourself to keep using Sarah after the switch-over.'];
  else if (!emp.calendar_connected_at) cal = ['warn', 'Not connected yet. Connect it to start using Sarah.'];
  else if (emp.needs_reconnect) cal = ['bad', 'Sarah lost access to your calendar. Reconnect it.'];
  else cal = ['ok', 'Connected.'];
  return `<dl class="status">
    <dt>Calendar</dt><dd><span class="pill ${cal[0]}">${h(cal[0] === 'ok' ? 'OK' : cal[0] === 'warn' ? 'Set up' : 'Action needed')}</span> ${h(cal[1])}</dd>
    <dt>Sarah for you</dt><dd>${emp.paused ? '<span class="pill warn">Paused</span> She ignores new requests from you.' : '<span class="pill ok">On</span> CC her to start.'}</dd>
    <dt>Sarah overall</dt><dd><span class="pill ${mode === 'live' ? 'ok' : 'warn'}">${h(mode)}</span> ${mode === 'live' ? 'Running.' : mode === 'shadow' ? 'Running, with your admin reviewing emails to clients before they go out.' : 'Not sending anything right now.'}</dd>
  </dl>`;
}

function homePage({ emp, csrf, admin, mode, flash }) {
  const needsConnect = emp.calendar_auth !== 'delegated' || !emp.calendar_connected_at || emp.needs_reconnect;
  return layout({ title: 'Home', emp, csrf, admin, flash, mode, body: `
<section class="card">
  <h1>Hi ${h(emp.first_name)}</h1>
  ${statusRows(emp, mode)}
  <div class="actions">
    ${needsConnect ? '<a class="button primary" href="/connect">Connect your calendar</a>' : ''}
    <a class="button" href="/settings">Settings</a>
    <form method="post" action="/pause" class="inline"><input type="hidden" name="csrf" value="${h(csrf)}">
      <input type="hidden" name="action" value="${emp.paused ? 'resume' : 'pause'}">
      <button>${emp.paused ? 'Resume Sarah' : 'Pause Sarah'}</button></form>
    <form method="post" action="/test-email" class="inline"><input type="hidden" name="csrf" value="${h(csrf)}"><button>Send me a test email</button></form>
  </div>
</section>
<section class="card">
  <h2>Start a request</h2>
  <p>Email the client, CC <b>Sarah</b>, and write something like <q>Sarah will find us a time.</q> She replies to everyone, offers three times that fit your calendar, and asks you to confirm before anything is booked. <a href="/help">How it works</a>.</p>
</section>` });
}

function connectPage({ emp, csrf, admin, mode, flash }) {
  return layout({ title: 'Connect your calendar', emp, csrf, admin, flash, mode, body: `
<section class="card narrow">
  <h1>Connect your calendar</h1>
  <p>Microsoft will ask you to let <b>BZB Sarah Portal</b>:</p>
  <ul>
    <li><b>Read and write your calendar</b>, so Sarah can see when you're free, place private "Hold" blocks while a client decides, and book the meeting you confirm. The invite comes from your calendar.</li>
    <li><b>Read your mailbox settings</b>, once, to copy your working hours and timezone.</li>
    <li><b>Sign you in and keep access</b>, so Sarah keeps working when you're not here.</li>
  </ul>
  <p>Sarah never reads your email and never sends anything from your address. All her email comes from her own mailbox.</p>
  <p>You can disconnect any time: pause Sarah here, or remove "BZB Sarah Portal" at <b>myapps.microsoft.com</b>.</p>
  <form method="post" action="/connect"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="primary">Continue to Microsoft</button></form>
</section>` });
}

function field(name, errors) {
  return errors && errors[name] ? `<span class="err" id="${h(name)}-err">${h(errors[name])}</span>` : '';
}

function settingsPage({ emp, csrf, admin, mode, flash, values, errors }) {
  const v = values || emp;
  const wh = v.working_hours || {};
  const zones = [...new Set([v.timezone, ...COMMON_ZONES].filter(Boolean))];
  const num = (name, label, min, max, hint) => `
    <label for="${name}">${h(label)}${hint ? ` <small>${h(hint)}</small>` : ''}</label>
    <input id="${name}" name="${name}" type="number" min="${min}" max="${max}" step="1" value="${h(v[name])}" required>
    ${field(name, errors)}`;
  const dayRows = DAYS.map((d) => {
    const on = Array.isArray(wh[d]);
    return `<tr><th scope="row"><label><input type="checkbox" name="${d}_on" ${on ? 'checked' : ''}> ${DAY_NAMES[d]}</label></th>
      <td><input aria-label="${DAY_NAMES[d]} start" type="time" name="${d}_start" value="${h(on ? wh[d][0] : '09:00')}"></td>
      <td><input aria-label="${DAY_NAMES[d]} end" type="time" name="${d}_end" value="${h(on ? wh[d][1] : '17:00')}"></td>
      <td>${field(`${d}_hours`, errors)}</td></tr>`;
  }).join('');
  return layout({ title: 'Settings', emp, csrf, admin, flash, mode, body: `
<section class="card">
  <h1>Your settings</h1>
  ${errors && Object.keys(errors).length ? '<p class="flash warn" role="alert">Some settings need fixing. See the notes below.</p>' : ''}
  ${!emp.settings_saved_at ? '<p class="hint">These start from your Outlook working hours and timezone. Check them and save.</p>' : ''}
  <form method="post" action="/settings" class="settings">
    <input type="hidden" name="csrf" value="${h(csrf)}">
    <fieldset><legend>You</legend>
      <label for="first_name">First name <small>how Sarah refers to you in emails</small></label>
      <input id="first_name" name="first_name" value="${h(v.first_name)}" maxlength="40" required>${field('first_name', errors)}
      <label for="timezone">Timezone <small>every time Sarah offers is in this zone</small></label>
      <select id="timezone" name="timezone">${zones.map((z) => `<option ${z === v.timezone ? 'selected' : ''}>${h(z)}</option>`).join('')}</select>
      ${field('timezone', errors)}
    </fieldset>
    <fieldset><legend>Working hours <small>Sarah only offers times inside these</small></legend>
      <div class="scroll"><table class="days"><tbody>${dayRows}</tbody></table></div>${field('working_hours', errors)}
      <label for="preferred_start">Preferred meeting hours <small>soft: times outside rank lower</small></label>
      <div class="pair"><input id="preferred_start" type="time" name="preferred_start" value="${h(v.preferred_start)}" required>
        <span>to</span><input aria-label="Preferred end" type="time" name="preferred_end" value="${h(v.preferred_end)}" required></div>
      ${field('preferred_hours', errors)}
    </fieldset>
    <fieldset><legend>Meetings</legend>
      ${num('default_duration_min', 'Default length (minutes)', 10, 240)}
      <label for="default_location">Default place</label>
      <select id="default_location" name="default_location">
        ${[['teams', 'Teams'], ['in_person', 'In person'], ['phone', 'Phone']].map(([k, l]) => `<option value="${k}" ${v.default_location === k ? 'selected' : ''}>${l}</option>`).join('')}
      </select>${field('default_location', errors)}
      <label for="office_address">Office address <small>for "in person at our office"</small></label>
      <input id="office_address" name="office_address" value="${h(v.office_address || '')}" maxlength="200">${field('office_address', errors)}
      ${num('hard_gap_min', 'Minimum gap between meetings (minutes)', 0, 120)}
      ${num('preferred_gap_min', 'Preferred gap (minutes)', 0, 240, 'back-to-back slots are offered only as a last resort')}
      ${num('in_person_buffer_min', 'Travel buffer for in-person meetings (minutes, each side)', 0, 240)}
      ${num('max_meetings_per_day', 'Most meetings in a day', 1, 20)}
    </fieldset>
    <fieldset><legend>How Sarah offers times</legend>
      ${num('min_notice_hours', 'Minimum notice (hours)', 0, 336)}
      ${num('search_window_days', 'Look this many days ahead', 1, 60)}
      ${num('offers_per_round', 'Times per email', 1, 5)}
      <label class="check"><input type="checkbox" name="bcc_after_intro" ${v.bcc_after_intro ? 'checked' : ''}> Move me to BCC after Sarah's first reply</label>
    </fieldset>
    <button class="primary">Save settings</button>
  </form>
</section>` });
}

function helpPage({ emp, csrf, admin, mode, sarahUpn }) {
  return layout({ title: 'How to use Sarah', emp, csrf, admin, mode, body: `
<section class="card prose">
  <h1>How to use Sarah</h1>
  <h2>Start</h2>
  <p>Reply to (or write) an email with the client on it, <b>CC ${h(sarahUpn)}</b>, and say something like <q>Sarah will find us a time.</q> She has to be on To or CC; forwarding or BCC doesn't start anything.</p>
  <p>Add details and she'll use them: a length (<q>45 min</q>), a place (<q>on Teams</q>, <q>in person at our office</q>, <q>by phone</q>), or a window (<q>next week</q>, <q>Thursday afternoon</q>, <q>three weeks from today</q>). Otherwise she uses your settings.</p>
  <h2>What she does</h2>
  <ul>
    <li>Replies to everyone, moves you to BCC (if that's your setting), and offers times that fit your calendar.</li>
    <li>Puts private "Hold" blocks on your calendar while the client decides. They disappear on their own.</li>
    <li>When the client picks a time, emails you <b>Confirm: …</b>. Reply <b>YES</b> to book it, <b>NO</b> for other times, or suggest another day.</li>
    <li>Books it on your calendar (the invite comes from you, with a Teams link if it's a Teams meeting) and confirms with the client.</li>
  </ul>
  <h2>When she hands it back</h2>
  <p>Sarah stops and emails you <b>Needs you: …</b> when a client asks something only you can answer, when no time works, or when she loses access to your calendar. From then on the thread is yours. To take over yourself at any point, reply in the thread that you've got it.</p>
  <h2>Pausing</h2>
  <p>Pause Sarah on the <a href="/">home page</a> when you're away. While paused she ignores new requests from you and tells you so; threads already running continue.</p>
  <h2>She can't</h2>
  <ul><li>Reschedule or cancel a booked meeting.</li><li>Offer times in a client's timezone (she always writes yours, with the UTC offset).</li><li>Read your email or send from your address.</li></ul>
</section>` });
}

const fmtTime = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');

function threadsPage({ emp, csrf, admin, mode, threads }) {
  const rows = (threads || []).map((t) => `<tr><td>${h(t.id)}</td><td><span class="state">${h(t.state)}</span></td>
      <td>${h(t.subject)}</td><td>${h(t.clients)}</td><td>${h(fmtTime(t.updated_at))}</td><td>${h(t.reason || '')}</td></tr>`).join('');
  return layout({ title: 'My threads', emp, csrf, admin, mode, body: `
<section class="card">
  <h1>My threads</h1>
  ${rows ? `<div class="scroll"><table class="grid"><thead><tr><th>#</th><th>State</th><th>Subject</th><th>Clients</th><th>Updated</th><th>Note</th></tr></thead>
  <tbody>${rows}</tbody></table></div>` : '<p>No threads yet. CC Sarah on an email with a client to start one.</p>'}
  <p class="hint">PROPOSED: times offered · AWAITING_VIC: waiting on your YES · BOOKED: on your calendar · NEEDS_VIC: handed back to you · STALLED: no reply after a follow-up.</p>
</section>` });
}

function adminPage({ emp, csrf, admin, mode, rows }) {
  const body = (rows || []).map((r) => {
    const health = r.calendar_auth === 'app' ? '<span class="pill ok">app (legacy)</span>'
      : !r.connected ? '<span class="pill warn">not connected</span>'
        : r.needs_reconnect ? `<span class="pill bad">reconnect</span> <code>${h(r.reconnect_reason || '')}</code>`
          : '<span class="pill ok">OK</span>';
    return `<tr><td>${h(r.display_name)}<br><small>${h(r.upn)}</small></td><td>${r.enrolled ? 'yes' : '<b>no</b>'}</td>
      <td>${health}</td><td>${h(fmtTime(r.last_refresh_ok_at))}${r.last_error_code ? `<br><small>last error <code>${h(r.last_error_code)}</code></small>` : ''}</td>
      <td>${r.paused ? 'paused' : ''}</td><td>${h(fmtTime(r.last_sign_in_at))}</td><td>${h(fmtTime(r.last_activity_at))}</td><td>${h(r.open_threads)}</td></tr>`;
  }).join('');
  return layout({ title: 'Admin', emp, csrf, admin, mode, body: `
<section class="card">
  <h1>Employees</h1>
  <p>Mode: <b>${h(mode)}</b>. Token health is checked every day; a failed refresh flags the employee and emails them a reconnect link once.</p>
  <div class="scroll"><table class="grid"><thead><tr><th>Employee</th><th>Enrolled</th><th>Calendar</th><th>Last token refresh</th><th>Paused</th><th>Last sign-in</th><th>Last activity</th><th>Open threads</th></tr></thead>
  <tbody>${body}</tbody></table></div>
  <p class="hint">Offboarding and reconnect handling: docs/07-runbook.md.</p>
</section>` });
}

function notFoundPage({ emp, csrf, admin, mode }) {
  return layout({ title: 'Not found', emp, csrf, admin, mode, body: '<section class="card narrow"><h1>Not found</h1><p><a href="/">Back to home</a></p></section>' });
}

function errorPage({ emp, csrf, admin, mode, message }) {
  return layout({ title: 'Something went wrong', emp, csrf, admin, mode, body: `<section class="card narrow"><h1>Something went wrong</h1><p>${h(message)}</p><p><a href="/">Back to home</a></p></section>` });
}

module.exports = { h, layout, loginPage, homePage, connectPage, settingsPage, helpPage, threadsPage, adminPage, notFoundPage, errorPage, GENERIC_ERROR, FLASH };
