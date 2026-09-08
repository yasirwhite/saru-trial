// A local stand-in for Instagram, sanctioned by the assignment's fallback
// clause.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from '../config.js';
import { signBody } from '../webhooks/verify.js';
import { trace, onTrace, recentTraces } from './trace.js';

const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

const persona = {
  username: 'maya.runs',
  name: 'Maya Ramirez',
  follower_count: 1432,
  is_user_follow_business: true,
  is_business_follow_user: false,
};
const post = { id: 'sim-post-1', caption: 'the sage colorway just dropped 🌿 limited run, once it\'s gone it\'s gone' };

const outbound = [];
const sseClients = new Set();
let lastDelivery = null;
let seq = 1;

const igsidFor = (username) => `sim-user-${(username || 'anon').replace(/[^a-z0-9.]/gi, '')}`;

function broadcast(payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(line);
}

// Deliver a payload to our own webhook endpoint exactly the way Meta would.
async function deliver(body, { tampered = false } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const sig = tampered ? 'sha256=' + '0'.repeat(64) : signBody(raw);
  lastDelivery = body;
  const res = await fetch(`http://127.0.0.1:${config.port}/webhooks/instagram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
    body: raw,
  });
  return res.status;
}

const commentEnvelope = (text) => ({
  object: 'instagram',
  entry: [{
    id: config.igId,
    time: Math.floor(Date.now() / 1000),
    changes: [{
      field: 'comments',
      value: {
        id: `sim-comment-${seq++}`,
        from: { id: igsidFor(persona.username), username: persona.username },
        media: { id: post.id, media_product_type: 'FEED' },
        text,
      },
    }],
  }],
});

const dmEnvelope = (text) => ({
  object: 'instagram',
  entry: [{
    id: config.igId,
    time: Math.floor(Date.now() / 1000),
    messaging: [{
      sender: { id: igsidFor(persona.username) },
      recipient: { id: config.igId },
      timestamp: Date.now(),
      message: { mid: `sim-mid-${seq++}`, text },
    }],
  }],
});

export function mountPlayground(app) {
  app.use('/sim', express.static(pub));

  app.get('/sim/events', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'init', traces: recentTraces(), outbound, persona, post, config: { brandName: config.brandName, transport: config.transport, llm: config.llmDriver, mcpHost: new URL(config.mcpUrl).host } })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.post('/sim/comment', async (req, res) => {
    const status = await deliver(commentEnvelope(String(req.body.text || '').slice(0, 500)));
    res.json({ status });
  });

  app.post('/sim/dm', async (req, res) => {
    const status = await deliver(dmEnvelope(String(req.body.text || '').slice(0, 900)));
    res.json({ status });
  });

  // Demo buttons for the two trust-boundary behaviors.
  app.post('/sim/redeliver', async (_req, res) => {
    if (!lastDelivery) return res.status(400).json({ error: 'nothing to redeliver yet' });
    trace('sim', 'redelivering the last webhook verbatim (Meta does this)');
    res.json({ status: await deliver(lastDelivery) });
  });
  app.post('/sim/tamper', async (_req, res) => {
    if (!lastDelivery) return res.status(400).json({ error: 'nothing to tamper with yet' });
    trace('sim', 'redelivering the last webhook with a forged signature');
    res.json({ status: await deliver(lastDelivery, { tampered: true }) });
  });

  // The sim half of the transport: outbound sends land here and hit the "phone".
  app.post('/sim/outbound', (req, res) => {
    if (req.body.kind === 'typing') {
      broadcast({ type: 'typing', to: req.body.to });
      return res.json({ ok: true });
    }
    const msg = { at: Date.now(), kind: req.body.kind, to: req.body.to, text: req.body.text };
    outbound.push(msg);
    broadcast({ type: 'outbound', msg });
    res.json({ ok: true });
  });

  app.get('/sim/profile/:igsid', (req, res) => {
    if (req.params.igsid !== igsidFor(persona.username)) return res.sendStatus(404);
    res.json(persona);
  });
  app.get('/sim/post/:id', (_req, res) => res.json(post));

  app.post('/sim/persona', (req, res) => {
    for (const k of ['username', 'name']) if (typeof req.body[k] === 'string') persona[k] = req.body[k];
    if (Number.isFinite(+req.body.follower_count)) persona.follower_count = +req.body.follower_count;
    for (const k of ['is_user_follow_business', 'is_business_follow_user']) if (k in req.body) persona[k] = !!req.body[k];
    if (typeof req.body.post_caption === 'string' && req.body.post_caption) post.caption = req.body.post_caption;
    broadcast({ type: 'persona', persona, post });
    res.json({ persona, post });
  });

  // Snapshot for scripts/smoke.js assertions.
  app.get('/sim/state', (_req, res) => res.json({ outbound, traces: recentTraces(), persona }));

  onTrace((ev) => broadcast({ type: 'trace', ev }));
}
