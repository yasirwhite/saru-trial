// End-to-end smoke test. Boots the real server on a throwaway port with the
// sim transport + mock LLM driver, then drives it with the exact webhook
// payloads Meta would send.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';

const PORT = 3999;
const SECRET = 'smoke-secret';
const BASE = `http://127.0.0.1:${PORT}`;
const DB = 'data/smoke.db';

let passed = 0, failed = 0;
const ok = (cond, name) => { console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`); cond ? passed++ : failed++; };
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

async function postWebhook(body, { badSig = false } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const res = await fetch(`${BASE}/webhooks/instagram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': badSig ? 'sha256=' + '0'.repeat(64) : sign(raw) },
    body: raw,
  });
  return res.status;
}

const state = async () => (await fetch(`${BASE}/sim/state`)).json();

// Wait until the outbound count grows past `n` (the agent works async after the 200 ack).
async function outboundAfter(n, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const s = await state();
    if (s.outbound.length > n) return s;
    await sleep(300);
  }
  return state();
}

const comment = (id, text) => ({
  object: 'instagram',
  entry: [{ id: 'sim-brand-account', time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id, from: { id: 'sim-user-maya.runs', username: 'maya.runs' }, media: { id: 'sim-post-1' }, text } }] }],
});
const dm = (mid, text) => ({
  object: 'instagram',
  entry: [{ id: 'sim-brand-account', time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: 'sim-user-maya.runs' }, recipient: { id: 'sim-brand-account' }, timestamp: Date.now(), message: { mid, text } }] }],
});

for (const f of [DB, DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: DB, TRANSPORT: 'sim', LLM_DRIVER: 'mock',
    META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'smoke-verify', IG_ACCESS_TOKEN: '', OPENAI_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write('    | ' + d));
server.stderr.on('data', (d) => process.stdout.write('    ! ' + d));

try {
  // wait for boot
  let up = false;
  // generous: a cold Windows Defender pass over fresh node_modules can slow the first boot
  for (let i = 0; i < 120 && !up; i++) { try { up = (await fetch(`${BASE}/health`)).ok; } catch { await sleep(250); } }
  if (!up) throw new Error('server did not boot');
  console.log('server up — running checks\n');

  console.log('webhook trust boundary');
  const ch = await fetch(`${BASE}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=smoke-verify&hub.challenge=12345`);
  ok((await ch.text()) === '12345', 'GET handshake echoes hub.challenge');
  const chBad = await fetch(`${BASE}/webhooks/instagram?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x`);
  ok(chBad.status === 403, 'GET handshake rejects a wrong verify token');
  ok((await postWebhook(dm('mid-sig', 'hi'), { badSig: true })) === 401, 'forged signature → 401, payload untrusted');

  console.log('\nflagship: comment → personalized private reply');
  await postWebhook(comment('c-1', 'obsessed with this roast 😍'));
  let s = await outboundAfter(0);
  const openers = s.outbound.filter((o) => o.kind === 'private_reply');
  ok(openers.length === 1, 'exactly one private reply sent');
  ok(/maya/i.test(openers[0]?.text || ''), 'opener is grounded in the fetched profile (mentions maya)');
  ok(/[A-Z]+-[A-Z0-9]{4}/.test(openers[0]?.text || ''), 'opener carries the minted discount code');

  console.log('\nidempotency: Meta redelivers, we don\'t double-send');
  const before = (await state()).outbound.length;
  await postWebhook(comment('c-1', 'obsessed with this roast 😍'));
  await sleep(1500);
  ok((await state()).outbound.length === before, 'redelivered comment produced no second reply');
  await postWebhook(comment('c-2', 'need this in my life'));
  await sleep(2500);
  s = await state();
  ok(s.outbound.filter((o) => o.kind === 'private_reply').length === 2, 'a NEW comment still gets its opener');
  const codes = s.outbound.filter((o) => o.kind === 'private_reply').map((o) => (o.text.match(/[A-Z]+-[A-Z0-9]{4}/) || [])[0]);
  ok(codes[0] && codes[0] === codes[1], 'same customer keeps the same code (one per customer)');

  console.log('\npublic nudge: only non-followers need one');
  s = await state();
  ok(s.outbound.filter((o) => o.kind === 'comment_reply').length === 0, 'follower comments got NO public nudge (they get notified anyway)');
  await fetch(`${BASE}/sim/persona`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_user_follow_business: false }) });
  await postWebhook(comment('c-3', 'ok i need this'));
  await sleep(2500);
  s = await state();
  ok(s.outbound.filter((o) => o.kind === 'comment_reply').length === 1, 'non-follower comment got the public "check your dms" nudge');
  ok(s.outbound.filter((o) => o.kind === 'private_reply').length === 3, 'nudge rode along with a normal opener');
  await fetch(`${BASE}/sim/persona`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_user_follow_business: true }) });

  console.log('\nagent loop over live Shopify MCP');
  let n = (await state()).outbound.length;
  await postWebhook(dm('mid-1', 'what hoodie do you recommend?'));
  s = await outboundAfter(n);
  ok(s.outbound.length > n, 'recommendation DM got a reply');
  ok(s.traces.some((t) => t.kind === 'tool' && /catalog/.test(t.text)), 'the model called the catalog tool (live MCP)');

  n = s.outbound.length;
  await postWebhook(dm('mid-2', 'ok add it to my cart'));
  s = await outboundAfter(n);
  ok(s.traces.some((t) => t.kind === 'tool' && /update_cart/.test(t.text)), 'the model called update_cart (live MCP)');
  const cartReply = s.outbound[s.outbound.length - 1]?.text || '';
  if (/\/cart\/c\//.test(cartReply)) ok(true, 'reply carries a real cart checkout link');
  else console.log('  WARN  no checkout link in reply (store may not have returned one) — inspect trace');

  n = s.outbound.length;
  await postWebhook(dm('mid-2', 'ok add it to my cart')); // exact same mid
  await sleep(1500);
  ok((await state()).outbound.length === n, 'redelivered DM (same mid) produced no duplicate reply');

  n = (await state()).outbound.length;
  await postWebhook(dm('mid-3', 'what is your return policy?'));
  s = await outboundAfter(n);
  ok(s.traces.some((t) => t.kind === 'tool' && /polic/.test(t.text)), 'the model called the policies tool (live MCP)');
  ok(s.outbound.length > n, 'policy question got a reply');

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\nsmoke run aborted:', err.message);
  process.exitCode = 1;
} finally {
  server.kill();
}
