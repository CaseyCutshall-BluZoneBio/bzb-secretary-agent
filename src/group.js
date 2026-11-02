'use strict';
// Group meetings: who still has to answer, and which offered times work for
// everyone who has.
//
// thread.responders: the people who must each agree to a time (everyone Vic
//   put in the meeting, set when the thread starts). Fewer than two means an
//   ordinary one-person thread, where any reply speaks for the meeting.
// thread.responses:  { address: { starts: [iso, ...], at: iso } }, the offered
//   times each responder said work this round. A new round clears it.
const U = require('./util');

const isGroup = (t) => !!t && (t.responders || []).length > 1;

const ms = (iso) => Date.parse(iso);

// The responders this reply answers for: the sender (if a responder), anyone
// they say they answer for ("Raj and I can do Tuesday"), and, when the sender
// isn't a responder (an assistant), the unanswered responders at their domain.
function voters(t, from, answeringFor, displayNames) {
  const responders = (t.responders || []).map(U.lower);
  const sender = U.lower(from);
  const out = responders.includes(sender) ? [sender] : [];
  const words = (s) => U.lower(s).split(/[^\p{L}'-]+/u).filter(Boolean);
  for (const raw of Array.isArray(answeringFor) ? answeringFor : []) {
    const name = words(U.sanitizeName(raw));
    if (!name.length) continue;
    for (const a of responders) {
      const display = words((displayNames || {})[a]);
      const pool = display.length ? display : words(a.split('@')[0].replace(/[._]/g, ' '));
      if (name.every((w) => pool.includes(w)) && !out.includes(a)) out.push(a);
    }
  }
  if (!out.length && !responders.includes(sender)) {
    const answered = new Set(Object.keys(t.responses || {}));
    const dom = U.domainOf(sender);
    for (const a of responders) if (U.domainOf(a) === dom && !answered.has(a)) out.push(a);
  }
  return out;
}

function record(responses, who, starts, at) {
  const next = { ...(responses || {}) };
  for (const a of who) next[a] = { starts: [...starts], at };
  return next;
}

const pending = (t, responses) => (t.responders || []).map(U.lower).filter((a) => !(responses || {})[a]);

// Offers that every responder who has answered said yes to.
function viable(offers, responses) {
  const sets = Object.values(responses || {}).map((r) => new Set((r.starts || []).map(ms)));
  return offers.filter((o) => sets.every((s) => s.has(ms(o.start))));
}

module.exports = { isGroup, voters, record, pending, viable };
