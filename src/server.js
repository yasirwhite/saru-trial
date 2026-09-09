// Route map — the whole system from 30,000 feet:
import express from 'express';
import { config } from './config.js';
import { verifySignature, handleChallenge } from './webhooks/verify.js';
import { routeWebhook } from './webhooks/router.js';
import { mountPlayground } from './sim/playground.js';
import { mountShopifyOAuth } from './shopify/oauth.js';
import { mountAdmin } from './admin.js';
import { mountOperator } from './operator.js';
import { listTools } from './shopify/mcp-client.js';
import { startBridge } from './store/supabase-bridge.js';
import { purgeSimulatedDiscounts } from './store/db.js';
import { trace } from './sim/trace.js';

const app = express();
// Keep the raw bytes: signatures are HMACs over what Meta sent, not our re-parse.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: false })); // the /admin settings form

// Access line for every non-playground request — when debugging delivery, the
// question "did anything reach us at all?" must be answerable from the trace.
app.use((req, _res, next) => {
  if (!req.path.startsWith('/sim') && req.path !== '/health') trace('http', `${req.method} ${req.path}`);
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true, transport: config.transport, llm: config.llmDriver }));
app.get('/webhooks/instagram', handleChallenge);

app.post('/webhooks/instagram', (req, res) => {
  if (!verifySignature(req)) {
    trace('rejected', 'webhook signature invalid — payload not trusted');
    return res.sendStatus(401);
  }
  // Ack fast (Meta retries slow endpoints), process async.
  res.sendStatus(200);
  setImmediate(() =>
    routeWebhook(req.body).catch((err) => trace('error', `webhook processing failed: ${err.message}`)),
  );
});

mountPlayground(app);
mountShopifyOAuth(app);
mountAdmin(app);
mountOperator(app); // POST /operator/send — the Kosha portal's human-takeover door

app.listen(config.port, () => {
  trace('info', `listening on http://127.0.0.1:${config.port} — transport=${config.transport} llm=${config.llmDriver}`);
  trace('info', `playground: http://127.0.0.1:${config.port}/sim`);
  // Stale simulated codes are cleared at boot, but only once we can actually
  // replace them: without admin creds a purge would just re-mint another fake
  // code under a different name, which is worse than the one already promised.
  if (config.shopifyAdminStore && config.shopifyAdminToken) {
    const purged = purgeSimulatedDiscounts();
    trace('discount', `purged ${purged} simulated code(s) minted before the admin token — the next ask re-mints a real store code`);
  } else {
    trace('discount', 'simulated-code purge skipped — no shopify admin credentials to mint real replacements with');
  }
  startBridge(); // Kosha mirror + goal/mode polling; no-op without DATABASE_URL
  listTools()
    .then((tools) => trace('info', `shopify mcp connected (${new URL(config.mcpUrl).host}): ${tools.map((t) => t.name).join(', ')}`))
    .catch((err) => trace('error', `shopify mcp unreachable: ${err.message}`));
});
