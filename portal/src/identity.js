'use strict';
// Who may use the portal. Entra already enforces "Assignment required" (only
// members of the "Sarah users" group get a token at all). On top of that:
//   * the token was issued by BZB's tenant (tid), AND
//   * the account's HOME tenant is BZB (a B2B guest signs in to BZB's tenant
//     with BZB's tid, but their homeAccountId ends in their own tenant id), AND
//   * Graph says userType = Member, AND
//   * their mail/UPN is on one of BZB's internal domains.

const lower = (s) => String(s || '').trim().toLowerCase();
const domainOf = (a) => lower(a).split('@')[1] || '';

/**
 * result: MSAL AuthenticationResult; me: Graph /me with
 * id,userPrincipalName,mail,displayName,givenName,userType.
 * Returns { ok: true, profile } or { ok: false, reason } (reason is for logs only).
 */
function checkIdentity(result, me, { tenantId, internalDomains }) {
  const tenant = lower(tenantId);
  const account = (result && result.account) || {};
  const claims = (result && result.idTokenClaims) || account.idTokenClaims || {};
  if (lower(claims.tid) !== tenant || lower(account.tenantId) !== tenant) return { ok: false, reason: 'other_tenant' };
  const home = lower(account.homeAccountId);
  if (!home.endsWith(`.${tenant}`)) return { ok: false, reason: 'guest_home_tenant' };
  const oid = lower(claims.oid);
  if (!oid || home !== `${oid}.${tenant}`) return { ok: false, reason: 'oid_mismatch' };
  if (!me || lower(me.id) !== oid) return { ok: false, reason: 'graph_profile_mismatch' };
  if (me.userType !== 'Member') return { ok: false, reason: 'not_member' };
  if (lower(me.userPrincipalName).includes('#ext#')) return { ok: false, reason: 'guest_upn' };
  const domains = (internalDomains || []).map(lower);
  const upn = lower(me.userPrincipalName);
  const mail = lower(me.mail) || upn;
  if (!domains.includes(domainOf(upn)) || !domains.includes(domainOf(mail))) return { ok: false, reason: 'not_internal_domain' };
  const displayName = String(me.displayName || '').trim().slice(0, 120) || upn;
  return {
    ok: true,
    profile: {
      aad_object_id: oid,
      upn,
      mail,
      display_name: displayName,
      first_name: String(me.givenName || displayName.split(' ')[0] || '').trim().slice(0, 40),
    },
  };
}

module.exports = { checkIdentity };
