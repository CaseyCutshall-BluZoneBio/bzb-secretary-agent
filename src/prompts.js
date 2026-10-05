'use strict';
// Every prompt the agent sends. Edit here, then `npm run build` to regenerate
// the n8n workflows. The model only ever (a) classifies an email into a fixed
// JSON shape, or (b) writes the words of a client email with placeholders
// where code inserts the facts. It never decides times, recipients, or actions.

// Optional style examples for client emails (few-shot). Keep them short and in
// Sarah's voice, using the same placeholders. {EMPLOYEE} becomes the
// employee's first name. Replace with real approved emails after shadow mode.
const STYLE_EXAMPLES = [
  {
    purpose: 'intro',
    body: 'Thanks for the intro, {EMPLOYEE}. I\'ll move you to BCC so your inbox stays quiet.\n\nHi Dana, great to meet you. I help {EMPLOYEE} with scheduling. Would one of these work for a 30-minute Teams call?\n\n{{SLOTS}}\n\nJust reply with the number, or tell me what suits you and I\'ll work around it.',
  },
  {
    purpose: 'new_round',
    body: 'No worries at all, Dana. Here are a few more options:\n\n{{SLOTS}}\n\nAny of these better?',
  },
  {
    purpose: 'counter_unavailable',
    body: 'Thanks for suggesting that, Dana. Unfortunately {EMPLOYEE} is already booked then, but these are open:\n\n{{SLOTS}}',
  },
  {
    purpose: 'followup',
    body: 'Hi Dana, circling back on finding a time with {EMPLOYEE}. These are still open:\n\n{{SLOTS}}\n\nIf none of them fit, tell me what works and I\'ll find something.',
  },
  {
    purpose: 'ack',
    body: 'Perfect, {{TIME}} it is. I\'ll confirm with {EMPLOYEE} and send the invite over shortly.',
  },
  {
    purpose: 'confirmed',
    body: 'You\'re all set, Dana: {{TIME}}. The invite is on its way from {EMPLOYEE}\'s calendar.',
  },
  {
    purpose: 'handoff',
    body: 'Thanks, Dana. That one is best answered by {EMPLOYEE}, so I\'ve passed it along and {EMPLOYEE} will be in touch.',
  },
];

const CONSTRAINTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['earliest_date', 'latest_date', 'days_of_week', 'time_of_day'],
  properties: {
    earliest_date: { type: ['string', 'null'], description: 'YYYY-MM-DD from the calendar table, or null' },
    latest_date: { type: ['string', 'null'], description: 'YYYY-MM-DD from the calendar table, or null' },
    days_of_week: { type: 'array', items: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] } },
    time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'any'] },
  },
};

const PROPOSED_TIMES_SCHEMA = {
  type: 'array',
  maxItems: 3,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['date', 'time'],
    properties: {
      date: { type: 'string', description: 'YYYY-MM-DD from the calendar table' },
      time: { type: 'string', description: '24-hour HH:MM, as the writer stated it' },
    },
  },
};

const SCHEMAS = {
  trigger: {
    type: 'object',
    additionalProperties: false,
    required: ['is_scheduling_request', 'duration_min', 'location', 'location_detail', 'constraints', 'topic'],
    properties: {
      is_scheduling_request: { type: 'boolean' },
      duration_min: { type: ['integer', 'null'] },
      location: { type: ['string', 'null'], enum: ['teams', 'in_person', 'phone', null] },
      location_detail: { type: ['string', 'null'] },
      constraints: CONSTRAINTS_SCHEMA,
      topic: { type: ['string', 'null'], description: 'Short meeting topic for the calendar title, or null' },
    },
  },
  client: {
    type: 'object',
    additionalProperties: false,
    required: ['intent', 'accepted_option', 'proposed_times', 'constraints', 'other_timezone', 'question', 'summary'],
    properties: {
      intent: {
        type: 'string',
        enum: ['accept', 'counter', 'reject_all', 'question', 'thanks', 'reschedule', 'cancel', 'own_link', 'delegate', 'other'],
      },
      accepted_option: { type: ['integer', 'null'] },
      proposed_times: PROPOSED_TIMES_SCHEMA,
      constraints: CONSTRAINTS_SCHEMA,
      other_timezone: { type: ['string', 'null'] },
      question: { type: ['string', 'null'] },
      summary: { type: 'string' },
    },
  },
  confirmation: {
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'proposed_times', 'constraints'],
    properties: {
      decision: { type: 'string', enum: ['yes', 'no', 'alternative', 'unclear'] },
      proposed_times: PROPOSED_TIMES_SCHEMA,
      constraints: CONSTRAINTS_SCHEMA,
    },
  },
  employee_in_thread: {
    type: 'object',
    additionalProperties: false,
    required: ['intent'],
    properties: { intent: { type: 'string', enum: ['take_over', 'other'] } },
  },
  draft: {
    type: 'object',
    additionalProperties: false,
    required: ['body'],
    properties: { body: { type: 'string' } },
  },
};

const OUTPUT_RULE = 'Respond with a single JSON object that matches the schema. No prose before or after it, no code fences.';

function classifyTriggerPrompt({ employeeFirst, zone, table, from, subject, body }) {
  return {
    system: [
      `You read an email that ${employeeFirst} sent with Sarah, their AI scheduling assistant, copied.`,
      'Decide whether they are asking Sarah to schedule a meeting with the other people on the email, and extract only the meeting details they actually stated.',
      '- is_scheduling_request: true if they ask Sarah (by name or as "my assistant") to find/schedule/set up a time.',
      '- duration_min: only if they state a length ("45 min", "an hour" → 60). Otherwise null.',
      '- location: "teams" for Teams/video/virtual, "in_person" for in person/at our office/coffee, "phone" for a call by phone. null if not stated.',
      '- location_detail: an address or place they name, else null.',
      `- constraints: any window they state. Dates must come from the calendar table (${zone}). Use [] / "any" / null when not stated.`,
      '- topic: a 2–6 word topic for the calendar title if obvious, else null.',
      OUTPUT_RULE,
    ].join('\n'),
    user: `Calendar table (${zone}):\n${table}\n\nFrom: ${from}\nSubject: ${subject || ''}\n-----\n${body || ''}\n-----`,
    schema: 'trigger',
  };
}

function classifyClientPrompt({ employeeFirst, zone, table, optionsText, from, subject, body, state }) {
  return {
    system: [
      `Sarah is the AI scheduling assistant for ${employeeFirst}. She is arranging a meeting with the sender.`,
      state === 'BOOKED'
        ? 'The meeting is already booked. Classify the latest reply.'
        : `The options currently on the table (all ${zone}):\n${optionsText || '(none)'}`,
      'Classify the sender\'s latest reply. Intents:',
      '- accept: they clearly pick one of the numbered options (by number, day, or time). Set accepted_option to that number.',
      '- counter: they propose specific other times, or give a window ("Thursday afternoon", "the week of the 20th", "the following week", "anything later?").',
      '- reject_all: none of the options work and they give no alternative.',
      '- question: they ask something that needs a person (agenda, attendees, prep, pricing, anything not about picking a time).',
      '- thanks: pure acknowledgement with nothing to act on.',
      '- reschedule / cancel: they want to move or cancel an already-agreed meeting.',
      `- own_link: they send their own booking link (Calendly etc.) or ask ${employeeFirst} to book with them.`,
      '- delegate: they hand scheduling to someone else ("looping in my assistant who will find a time").',
      '- other: anything else.',
      `proposed_times: specific times they propose, with dates from the calendar table and 24-hour HH:MM exactly as they wrote them. constraints: general windows (dates from the table).`,
      'Relative windows are relative to the options on the table: "the following week" / "the week after" means the calendar week after the last option, so set earliest_date to its Monday and latest_date to its Friday; "later that week" means the days after the option they mention, up to that Friday. Work the dates out from the calendar table.',
      `other_timezone: if they state a timezone other than ${zone} (e.g. "2pm PT", "London time"), write it; else null.`,
      'question: their question in one sentence, else null. summary: one sentence describing the reply.',
      OUTPUT_RULE,
    ].join('\n'),
    user: `Calendar table (${zone}):\n${table}\n\nFrom: ${from}\nSubject: ${subject || ''}\n-----\n${body || ''}\n-----`,
    schema: 'client',
  };
}

// No client names in here: they come from email headers the client controls.
function classifyConfirmationPrompt({ employeeFirst, zone, table, whenText, body }) {
  return {
    system: [
      `${employeeFirst} is replying to Sarah (their AI scheduling assistant), who asked them to confirm a client meeting at ${whenText}.`,
      'decision:',
      '- yes: they approve ("yes", "book it", "sounds good", "👍", "confirmed").',
      '- no: they decline that time without suggesting another.',
      '- alternative: they suggest other times or a window instead.',
      '- unclear: anything else.',
      `proposed_times / constraints: only for "alternative"; dates from the calendar table (${zone}), 24-hour HH:MM.`,
      OUTPUT_RULE,
    ].join('\n'),
    user: `Calendar table (${zone}):\n${table}\n\n-----\n${body || ''}\n-----`,
    schema: 'confirmation',
  };
}

function classifyEmployeeInThreadPrompt({ employeeFirst, body }) {
  return {
    system: [
      `${employeeFirst} replied in an email thread where Sarah, their AI scheduling assistant, is arranging a meeting for them.`,
      '- take_over: they say they will handle it, tells Sarah to stand down, or says the time is already set.',
      '- other: anything else.',
      OUTPUT_RULE,
    ].join('\n'),
    user: `-----\n${body || ''}\n-----`,
    schema: 'employee_in_thread',
  };
}

const PURPOSE_GUIDE = {
  intro: (f) => `This is Sarah's first email on the thread. Briefly thank ${f.employee_first} for the introduction${f.bcc ? " and say you're moving them to BCC" : ''}. Introduce yourself as ${f.employee_first}'s scheduling assistant and ask which option works for a ${f.duration_min}-minute ${f.location}. Put {{SLOTS}} on its own line.`,
  new_round: (f) => (f.asked
    ? 'The client asked about {{ASKED}}; these options fit that. Reply naturally (you can refer to it as {{ASKED}}) and offer them. Put {{SLOTS}} on its own line.'
    : 'None of the earlier options worked. Acknowledge that naturally and offer the new options. Put {{SLOTS}} on its own line.'),
  counter_unavailable: (f) => (f.asked
    ? 'The client suggested {{ASKED}}, but that is not available. Say so kindly (refer to it as {{ASKED}}) and offer these instead. Put {{SLOTS}} on its own line.'
    : 'The time the client suggested is not available. Say so briefly and offer these options instead. Put {{SLOTS}} on its own line.'),
  window_unavailable: (f) => `The client asked about ${f.asked ? '{{ASKED}}' : 'a particular day'}, but ${f.employee_first} has nothing open then. Say so kindly${f.asked ? ' (refer to it as {{ASKED}})' : ''}, then offer these, the closest open times. Put {{SLOTS}} on its own line.`,
  taken: () => 'The option the client picked was just taken. Apologize briefly and offer new options. Put {{SLOTS}} on its own line.',
  employee_declined: (f) => `That time no longer works for ${f.employee_first}. Apologize briefly and offer new options. Put {{SLOTS}} on its own line.`,
  followup: () => 'The client has not replied to the earlier options. Write a short, friendly nudge and re-share the options. Put {{SLOTS}} on its own line.',
  ack: (f) => `The client picked {{TIME}}. Thank them and say you'll confirm with ${f.employee_first} and send the calendar invite shortly. Use {{TIME}} exactly once.`,
  confirmed: (f) => `The meeting is booked for {{TIME}}. Say the calendar invite is coming from ${f.employee_first}'s calendar${f.location_type === 'teams' ? ' with the Teams link' : ''}. Use {{TIME}} exactly once.`,
  handoff: (f) => `The client asked something only ${f.employee_first} can answer${f.question ? ` (${f.question})` : ''}. Say you'll pass it to ${f.employee_first}, who will follow up. Do not answer the question. No placeholders.`,
};

function draftPrompt(facts, { feedback = null, previous = null } = {}) {
  const examples = STYLE_EXAMPLES.filter((e) => e.purpose === facts.purpose)
    .map((e) => `Example (${e.purpose}):\n${JSON.stringify({ body: e.body.replace(/\{EMPLOYEE\}/g, facts.employee_first) })}`).join('\n\n');
  return {
    system: [
      `You write short emails as Sarah, the AI scheduling assistant to ${facts.employee_full} at ${facts.company}.`,
      'Voice: an experienced, friendly executive assistant dashing off a quick email. Natural and conversational, with contractions.',
      'First respond to what they just said, if anything ("No worries" when none of the times worked, "Thanks for suggesting that" when their time is taken), then get to the point.',
      'Match their tone: if they write briefly and casually, do the same. Vary your wording from email to email.',
      'Avoid stock phrases ("I hope this email finds you well", "please do not hesitate", "kindly", "at your earliest convenience", "I wanted to reach out"), avoid exclamation marks, and never sound like a form letter.',
      'Plain text, 2–4 short sentences plus the options. Greet them by first name.',
      'HARD RULES — the email is rejected if you break any of them:',
      `1. Never write a date, a day of the week, a month, an ordinal like "8th", a clock time, a timezone, or a relative date (today, tomorrow, next week), not even to repeat what the client wrote. Code inserts every time: use {{SLOTS}} where the numbered options go and {{TIME}} where the agreed time goes, exactly as instructed.${facts.asked ? ' To refer to the day or time the client asked about, write {{ASKED}} (at most once); code fills it in.' : ' Do not use any other placeholder.'}`,
      '2. No sign-off and no signature ("Best, Sarah" is added automatically).',
      '3. No links, email addresses, or phone numbers.',
      '4. Never claim to be a person. Do not promise anything that is not in the facts.',
      OUTPUT_RULE + ' Schema: {"body": string}.',
      examples ? `\n${examples}` : '',
    ].join('\n'),
    user: `Task: ${PURPOSE_GUIDE[facts.purpose](facts)}\n\nFacts:\n${JSON.stringify({
      recipients_first_names: facts.recipient_first_names,
      employee_first_name: facts.employee_first,
      meeting: `${facts.duration_min}-minute ${facts.location}`,
      client_last_message: facts.client_last_message ? String(facts.client_last_message).slice(0, 1200) : null,
    }, null, 2)}${feedback ? `\n\nYour previous draft was rejected because it broke a hard rule: ${feedback}.\n`
      + `Previous draft: ${JSON.stringify(previous || '')}\nWrite it again, keeping the tone, but with no day names, dates, ordinals or clock times of your own${facts.asked ? ' (write {{ASKED}} instead)' : ''}.` : ''}`,
    schema: 'draft',
  };
}

module.exports = {
  STYLE_EXAMPLES, SCHEMAS, PURPOSE_GUIDE,
  classifyTriggerPrompt, classifyClientPrompt, classifyConfirmationPrompt, classifyEmployeeInThreadPrompt, draftPrompt,
};
