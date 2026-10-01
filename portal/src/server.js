'use strict';
// Entry point. Two separate HTTP servers on two ports:
//   public  (PORTAL_PORT, 3000)        UI. Compose publishes it on 127.0.0.1 only;
//                                      Tailscale Funnel serves it on :8443.
//   broker  (PORTAL_BROKER_PORT, 3001) internal token broker for n8n. Never
//                                      published; reachable on the compose network only.
const http = require('http');
const { Pool } = require('pg');
const { loadConfig } = require('./config');
const { createKeyRing } = require('./crypto');
const { createLogger } = require('./log');
const { createDb } = require('./db');
const { createGraph } = require('./graph');
const { createMsalFactory } = require('./msal');
const { createTokenService } = require('./tokens');
const { createPublicApp } = require('./web');
const { createBrokerApp } = require('./broker');
const { startKeepalive } = require('./keepalive');

function build(deps) {
  const { config } = deps;
  const publicServer = http.createServer(createPublicApp(deps));
  const brokerServer = http.createServer(createBrokerApp(deps));
  for (const s of [publicServer, brokerServer]) {
    s.headersTimeout = 15000;
    s.requestTimeout = 60000;
    s.keepAliveTimeout = 5000;
  }
  return {
    publicServer,
    brokerServer,
    listen: () => Promise.all([
      new Promise((resolve) => publicServer.listen(config.publicPort, config.publicHost, resolve)),
      new Promise((resolve) => brokerServer.listen(config.brokerPort, config.brokerHost, resolve)),
    ]),
    close: () => Promise.all([publicServer, brokerServer].map((s) => new Promise((resolve) => s.close(resolve)))),
  };
}

async function main() {
  const logger = createLogger();
  const config = loadConfig(process.env);
  const keyRing = createKeyRing(config.tokenKeys);
  const pool = new Pool(config.databaseUrl ? { connectionString: config.databaseUrl, max: 10 } : { max: 10 });
  const db = createDb(pool);
  const graph = createGraph({ baseUrl: config.graphBaseUrl });
  const msalFactory = createMsalFactory(config, logger);
  const tokens = createTokenService({ db, keyRing, msalFactory, logger });
  const app = build({ config, db, tokens, graph, msalFactory, keyRing, logger });
  await app.listen();
  startKeepalive({ db, tokens, logger, hours: config.keepaliveHours });
  logger.info('portal_started', { origin: config.origin, public_port: config.publicPort, broker_port: config.brokerPort });
  const stop = () => app.close().then(() => pool.end()).then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`portal failed to start: ${e && e.message}\n`);
    process.exit(1);
  });
}

module.exports = { build };
