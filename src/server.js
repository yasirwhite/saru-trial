// Route map — the whole system from 30,000 feet:
import express from 'express';
import { config } from './config.js';
import { verifySignature, handleChallenge } from './webhooks/verify.js';
import { routeWebhook } from './webhooks/router.js';
import { mountPlayground } from './sim/playground.js';
import { listTools } from './shopify/mcp-client.js';
import { trace } from './sim/trace.js';

const app = express();
// Keep the raw bytes: signatures are HMACs over what Meta sent, not our re-parse.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

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

app.listen(config.port, () => {
  trace('info', `listening on http://127.0.0.1:${config.port} — transport=${config.transport} llm=${config.llmDriver}`);
  trace('info', `playground: http://127.0.0.1:${config.port}/sim`);
  listTools()
    .then((tools) => trace('info', `shopify mcp connected (${new URL(config.mcpUrl).host}): ${tools.map((t) => t.name).join(', ')}`))
    .catch((err) => trace('error', `shopify mcp unreachable: ${err.message}`));
});
