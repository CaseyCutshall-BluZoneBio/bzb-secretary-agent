'use strict';
// LiteLLM request building and tolerant response parsing.
const { SCHEMAS } = require('./prompts');
const { setting } = require('./util');

// OpenAI-compatible chat request for LiteLLM.
function buildRequest(ctx, prompt, { temperature = 0, maxTokens = 1500 } = {}) {
  const body = {
    model: setting(ctx, 'llm_model', 'qwen'),
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.user },
    ],
  };
  if (setting(ctx, 'llm_json_schema', true)) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: prompt.schema, schema: SCHEMAS[prompt.schema], strict: true },
    };
  }
  return { url: setting(ctx, 'litellm_url', ''), body, schema: prompt.schema };
}

// Pull the assistant text out of an OpenAI-style response. Returns '' on error shapes.
function responseText(resp) {
  if (!resp || typeof resp !== 'object') return '';
  const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : p && p.text) || '').join('');
  return '';
}

// Every balanced {...} block in the text, respecting strings.
function jsonBlocks(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { out.push(text.slice(i, j + 1)); break; }
    }
  }
  return out;
}

/**
 * Parse model output into an object with all required keys of the schema.
 * Handles <think> blocks, code fences, narration before/after, and models
 * that echo the schema before answering (the LAST complete match wins).
 * Returns { ok, value, error, raw }.
 */
function parseModelJson(resp, schemaName) {
  const raw = responseText(resp);
  if (resp && resp.error) {
    return { ok: false, error: `llm_error: ${JSON.stringify(resp.error).slice(0, 300)}`, raw };
  }
  if (!raw) return { ok: false, error: 'empty model response', raw };
  const required = (SCHEMAS[schemaName] && SCHEMAS[schemaName].required) || [];
  const text = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*<\/think>/i, '')
    .replace(/```(?:json)?/gi, '');
  const blocks = jsonBlocks(text);
  let found = null;
  for (const b of blocks) {
    try {
      const v = JSON.parse(b);
      if (v && typeof v === 'object' && !Array.isArray(v) && required.every((k) => k in v) && !('properties' in v)) found = v;
    } catch (_) { /* not JSON */ }
  }
  if (!found) return { ok: false, error: `no ${schemaName} JSON object in model output`, raw };
  return { ok: true, value: found, raw };
}

module.exports = { buildRequest, responseText, jsonBlocks, parseModelJson };
