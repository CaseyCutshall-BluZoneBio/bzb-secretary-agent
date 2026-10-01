'use strict';
// MSAL setup. One ConfidentialClientApplication per use:
//   * sign-in / connect: a fresh client with an in-memory cache
//   * the broker: one client per employee whose cache plugin reads and writes
//     that employee's encrypted row (tokens.js)
// PII logging is off, and MSAL messages flagged as containing PII are dropped.
// No client capabilities are declared: "cp1" (continuous access evaluation)
// would get 24-hour access tokens, which nothing here could revoke early.
const { ConfidentialClientApplication, LogLevel } = require('@azure/msal-node');

// Sign-in only needs who you are. Connecting adds the calendar (and
// mailboxSettings for the one-time prefill). MSAL adds openid, profile and
// offline_access to every request itself.
const SIGNIN_SCOPES = ['User.Read'];
const CONNECT_SCOPES = ['User.Read', 'MailboxSettings.Read', 'Calendars.ReadWrite'];
const CALENDAR_SCOPES = ['Calendars.ReadWrite'];

function createMsalFactory(config, logger) {
  return function msalFactory(cachePlugin) {
    return new ConfidentialClientApplication({
      auth: { clientId: config.clientId, authority: config.authority, clientSecret: config.clientSecret },
      cache: cachePlugin ? { cachePlugin } : undefined,
      system: {
        loggerOptions: {
          piiLoggingEnabled: false,
          logLevel: LogLevel.Warning,
          loggerCallback: (level, message, containsPii) => {
            if (containsPii || level > LogLevel.Warning) return;
            logger.warn('msal', { message: String(message).slice(0, 300) });
          },
        },
      },
    });
  };
}

module.exports = { createMsalFactory, SIGNIN_SCOPES, CONNECT_SCOPES, CALENDAR_SCOPES };
