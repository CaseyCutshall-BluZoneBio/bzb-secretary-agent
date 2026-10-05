'use strict';
// Small, dependency-free helpers shared by every module.

const lower = (s) => (s == null ? '' : String(s).trim().toLowerCase());

const unique = (arr) => [...new Set((arr || []).filter(Boolean))];

function domainOf(address) {
  const a = lower(address);
  const at = a.lastIndexOf('@');
  return at === -1 ? '' : a.slice(at + 1);
}

function isInternal(address, internalDomains) {
  const d = domainOf(address);
  return (internalDomains || []).some((x) => lower(x) === d);
}

function setting(ctx, key, fallback) {
  const s = ctx && ctx.settings ? ctx.settings[key] : undefined;
  return s === undefined || s === null ? fallback : s;
}

function htmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Plain text → simple HTML paragraphs, preserving line breaks.
function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((p) => `<p>${htmlEscape(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

// "Dana Whitfield" → "Dana". Without a usable display name, the address is
// used only when it clearly holds a name ("dana.whitfield@" → "Dana");
// "cmcutshall5@" or "jsmith@" give "there" (as in "Hi there").
function firstName(name, address) {
  const n = String(name || '').trim();
  if (n && !n.includes('@')) {
    const clean = n.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '');
    const first = clean.split(/[\s,]+/)[0];
    if (first && /^[\p{L}'-]+$/u.test(first)) return first;
  }
  const local = lower(address).split('@')[0] || '';
  const parts = local.split(/[._-]/);
  if (parts.length >= 2 && /^[a-z]{2,}$/.test(parts[0]) && /^[a-z]{2,}$/.test(parts[1])) {
    return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  }
  return 'there';
}

function joinNames(names) {
  const n = (names || []).filter(Boolean);
  if (n.length <= 1) return n[0] || '';
  if (n.length === 2) return `${n[0]} and ${n[1]}`;
  return `${n.slice(0, -1).join(', ')}, and ${n[n.length - 1]}`;
}

// Display names come from email headers, i.e. from the client. Keep only what a
// name looks like (letters, spaces, . ' -), max 60 chars, so a crafted name
// can't smuggle instructions into prompts or emails.
function sanitizeName(name) {
  const s = String(name || '').normalize('NFC').replace(/[^\p{L}\p{M} .'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 60).trim();
}

// The address an employee sends from and receives at: the primary SMTP address
// when known (self-service rows), else the UPN (they're usually the same).
const employeeAddress = (emp) => lower((emp && (emp.mail || emp.upn)) || '');

// Is this employee's calendar reached through the portal's broker?
const delegated = (emp) => !!emp && emp.calendar_auth === 'delegated';

module.exports = { employeeAddress, delegated, lower, unique, domainOf, isInternal, setting, htmlEscape, textToHtml, firstName, joinNames, sanitizeName };
