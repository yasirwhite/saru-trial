// End-to-end smoke test. Boots the real server on a throwaway port with the
// sim transport + mock LLM driver, then drives it with the exact webhook
// payloads Meta would send.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { simTrackerId } from '../src/shipping/easypost.js';

const PORT = 3999;
const SECRET = 'smoke-secret';
const SHOP_SECRET = 'smoke-shopify-secret';
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

const comment = (id, text, username = 'maya.runs') => ({
  object: 'instagram',
  entry: [{ id: 'sim-brand-account', time: Math.floor(Date.now() / 1000), changes: [{ field: 'comments', value: { id, from: { id: `sim-user-${username}`, username }, media: { id: 'sim-post-1' }, text } }] }],
});
const dm = (mid, text) => ({
  object: 'instagram',
  entry: [{ id: 'sim-brand-account', time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: 'sim-user-maya.runs' }, recipient: { id: 'sim-brand-account' }, timestamp: Date.now(), message: { mid, text } }] }],
});

const DB2 = 'data/smoke-gate.db';
const BASE2 = 'http://127.0.0.1:3998';
let server2 = null;

for (const f of [DB, DB + '-wal', DB + '-shm', DB2, DB2 + '-wal', DB2 + '-shm']) fs.rmSync(f, { force: true });
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: DB, TRANSPORT: 'sim', LLM_DRIVER: 'mock',
    META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'smoke-verify', IG_ACCESS_TOKEN: '', OPENAI_API_KEY: '',
    ADMIN_KEY: 'smoke-admin-key',
    // This server HAS a shopify webhook secret (so the hmac path is exercised);
    // the gated server below has none (so the 503 refusal is exercised). Neither
    // has an EasyPost key: trackers stay simulated on both.
    SHOPIFY_WEBHOOK_SECRET: SHOP_SECRET, EASYPOST_API_KEY: '', SHOPIFY_ORDERS_TOKEN: '',
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
  // The operator door sends real DMs from the brand account — a wrong key must
  // never get past it, whatever the portal on the other side believes.
  const opBadKey = await fetch(`${BASE}/operator/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ igsid: 'sim-user-maya.runs', text: 'hi from the portal', key: 'not-the-admin-key' }),
  });
  ok(opBadKey.status === 401, 'POST /operator/send with a wrong admin key → 401');

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
  // One conversation per person, acknowledged: a second comment from someone
  // with an active thread earns ONE continuation reply — never a re-greeting,
  // never an offer — and pure noise earns nothing.
  await postWebhook(comment('c-2', 'need this in my life'));
  await sleep(2500);
  s = await state();
  const ackReplies = s.outbound.filter((o) => o.kind === 'private_reply');
  ok(ackReplies.length === 2, 'second comment from an active thread gets exactly one acknowledgment reply');
  const ack = ackReplies[1]?.text || '';
  ok(!/intern|welcome|nice to meet/i.test(ack), 'acknowledgment never re-introduces');
  ok(!/(code|discount|promo|% ?off|expire)/i.test(ack), 'acknowledgment carries no offer');
  await postWebhook(comment('c-2b', 'another test'));
  await sleep(2000);
  ok((await state()).outbound.filter((o) => o.kind === 'private_reply').length === 2, 'noise repeat comment ("another test") still gets nothing');

  console.log('\npublic nudge: only non-followers need one');
  s = await state();
  ok(s.outbound.filter((o) => o.kind === 'comment_reply').length === 0, 'follower comments got NO public nudge (they get notified anyway)');
  // A fresh customer (the sim only impersonates maya, so nina's profile fetch
  // 404s → non-follower fallback) still earns an opener, and the nudge rides
  // along because she would never see it in Requests otherwise.
  await postWebhook(comment('c-3', 'ok i need this', 'nina.day'));
  await sleep(2500);
  s = await state();
  ok(s.outbound.filter((o) => o.kind === 'comment_reply').length === 1, 'non-follower comment got the public "check your dms" nudge');
  ok(s.outbound.filter((o) => o.kind === 'private_reply').length === 3, 'nudge rode along with a fresh customer\'s opener');
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

  console.log('\nlive-walkthrough workflows: phone gate + hydrated link');
  server2 = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: '3998', DB_PATH: DB2, TRANSPORT: 'sim', LLM_DRIVER: 'mock',
      META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'smoke-verify', IG_ACCESS_TOKEN: '', OPENAI_API_KEY: '',
      PHONE_GATE: '1', FEATURED_PRODUCT: 'hoodie',
      SHOPIFY_WEBHOOK_SECRET: '', EASYPOST_API_KEY: '', SHOPIFY_ORDERS_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server2.stderr.on('data', (d) => process.stdout.write('    ! ' + d));
  let up2 = false;
  for (let i = 0; i < 120 && !up2; i++) { try { up2 = (await fetch(`${BASE2}/health`)).ok; } catch { await sleep(250); } }
  if (!up2) throw new Error('gated server did not boot');
  const post2 = async (body) => {
    const raw = Buffer.from(JSON.stringify(body));
    return (await fetch(`${BASE2}/webhooks/instagram`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) }, body: raw,
    })).status;
  };
  const state2 = async () => (await fetch(`${BASE2}/sim/state`)).json();
  const outboundAfter2 = async (n, ms = 30000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const s = await state2();
      if (s.outbound.length > n) return s;
      await sleep(300);
    }
    return state2();
  };

  await post2(comment('g-0', 'another test'));
  await sleep(2000);
  ok((await state2()).outbound.length === 0, 'no-intent comment ("another test") triggers NO dm');

  await post2(comment('g-1', 'need this hoodie fr'));
  let g = await outboundAfter2(0);
  const gOpener = g.outbound.find((o) => o.kind === 'private_reply');
  ok(!!gOpener, 'gated opener sent');
  ok(!/number|email|code|% ?off|discount/i.test(gOpener?.text || ''), 'opener is pure engagement — no ask, no offer (anti-botted)');
  ok(!/[A-Z]+-[A-Z0-9]{4}/.test(gOpener?.text || ''), 'opener holds the code back (gate armed)');

  // Multi-bubble replies land one at a time under natural pacing — poll until
  // the outbound count stops growing before asserting on the tail.
  const settled2 = async (n) => {
    let s = await outboundAfter2(n);
    // natural pacing can hold a long link bubble ~7s — stay until 9s of quiet
    for (let quiet = 0; quiet < 23; ) {
      await sleep(400);
      const next = await state2();
      if (next.outbound.length === s.outbound.length) quiet++;
      else { quiet = 0; s = next; }
    }
    return s;
  };

  let gn = (await state2()).outbound.length;
  await post2(dm('g-mid-0', 'does it run big?'));
  g = await settled2(gn);
  ok(/number/i.test(g.outbound[g.outbound.length - 1]?.text || ''), 'first reply engages THEN makes the offer (ask arrives in message two)');

  gn = g.outbound.length;
  await post2(dm('g-mid-1', '555 019'));
  g = await settled2(gn);
  ok(/again|off/i.test(g.outbound[g.outbound.length - 1]?.text || ''), 'junk number → polite re-ask, no code');

  gn = g.outbound.length;
  await post2(dm('g-mid-2', '(310) 555-0142'));
  g = await settled2(gn);
  const gTail = g.outbound.slice(gn).map((o) => o.text).join('\n');
  ok(/[A-Z]+-[A-Z0-9]{4}/.test(gTail), 'valid number → code delivered');
  ok(/\/cart\/(c\/[\w-]+\?[^\s]*|(\d+:1\?))[^\s]*discount=/.test(gTail), 'hydrated checkout link: featured item + code attached');
  ok(g.traces.some((t) => t.kind === 'gate' && /\+1310555\d{4}/.test(t.text)), 'number validated and stored as E.164');

  gn = g.outbound.length;
  await post2(dm('g-mid-3', 'wait can i get another code?'));
  g = await outboundAfter2(gn);
  ok(g.outbound.length > gn, 'post-capture DMs still flow to the agent');

  // An instagram "name" is as often a title, a brand or a joke as it is a name.
  // maya (asserted above) proves the plain case; these two prove the other two.
  console.log('\ngreeting resolution: monikers stay whole, junk names get none');
  const persona = async (p) => fetch(`${BASE}/sim/persona`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
  });
  // discount codes are SLUG-XXXX built from the handle — not an address, so they
  // must not be read as one by the assertions below
  const stripCode = (t) => (t || '').replace(/[A-Z]{2,}-[A-Z0-9]{4}/g, '');

  await persona({ username: 'mr.white', name: 'Mr White' });
  let gn2 = (await state()).outbound.length;
  await postWebhook(comment('c-4', 'need this hoodie in my life', 'mr.white'));
  s = await outboundAfter(gn2);
  const mrOpener = stripCode(s.outbound.slice(gn2).find((o) => o.kind === 'private_reply')?.text);
  ok(/\bmr white\b/i.test(mrOpener), 'self-chosen moniker "Mr White" is greeted whole ("hey mr white")');
  ok(!/\bmr\b(?! white)/i.test(mrOpener) && !/(?<!mr )\bwhite\b/i.test(mrOpener),
    'moniker is never dissected — no bare "mr", no bare "white"');
  ok(!/Mr\.?\s*White/.test(mrOpener) && !/\bhello\b/i.test(mrOpener),
    'moniker is never formalized — no "Hello Mr. White", stays lowercase');

  await persona({ username: 'xx.dark.xx', name: 'cloud mask stan' });
  gn2 = (await state()).outbound.length;
  await postWebhook(comment('c-5', 'ok i need this fr', 'xx.dark.xx'));
  s = await outboundAfter(gn2);
  const junkOpener = stripCode(s.outbound.slice(gn2).find((o) => o.kind === 'private_reply')?.text);
  ok(!!junkOpener, 'a meme-named commenter still earns an opener');
  ok(!/cloud|mask|stan|dark|xx|@/i.test(junkOpener),
    'joke profile name is never echoed back and no handle greeting — nameless opener');

  // The gated server above captured a real phone number through the gate
  // (+13105550142) — that captured contact is the ONLY thing joining a Shopify
  // order to an Instagram thread, so the whole shipment flow runs there.
  console.log('\nshipment tracking: shopify → easypost → milestone dms');
  const GATED_IGSID = 'sim-user-maya.runs';
  const ORDER_ID = 550000001, FULFILLMENT_ID = 660000001;
  const TRACKING = '9400111899223344556677';
  const TRACKER = simTrackerId(TRACKING);
  const shopSign = (raw) => crypto.createHmac('sha256', SHOP_SECRET).update(raw).digest('base64');
  const shopPost = async (baseUrl, topic, body, { sig = 'good', simulated = false } = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const headers = { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic };
    if (simulated) headers['X-Saru-Simulated'] = '1';
    if (sig === 'good') headers['X-Shopify-Hmac-Sha256'] = shopSign(raw);
    // same length as a real base64 sha256, so timingSafeEqual is actually reached
    if (sig === 'bad') headers['X-Shopify-Hmac-Sha256'] = Buffer.from('nope'.repeat(8)).toString('base64');
    return (await fetch(`${baseUrl}/webhooks/shopify`, { method: 'POST', headers, body: raw })).status;
  };
  const order = (extra = {}) => ({
    id: ORDER_ID, name: '#1042', order_number: 1042, total_price: '68.00', currency: 'USD',
    financial_status: 'paid', created_at: new Date().toISOString(), ...extra,
  });

  console.log('  trust boundary');
  ok(await shopPost(BASE, 'orders/create', order({ email: 'forged@example.com' }), { sig: 'bad' }) === 401,
    'shopify webhook with a forged hmac → 401, order not ingested');
  ok(await shopPost(BASE2, 'orders/create', order({ email: 'unverified@example.com' })) === 503,
    'shopify webhook with SHOPIFY_WEBHOOK_SECRET unset → 503, nothing unverified ingested');
  ok(await shopPost(BASE, 'orders/create', order({ email: 'stranger@example.com' })) === 200,
    'shopify webhook with a valid hmac → 200');
  // The simulated door is loopback + an explicit header, and it is the path the
  // demo driver (scripts/simulate-shipment.mjs) uses.
  ok(await shopPost(BASE2, 'orders/create',
    order({ email: 'maya.shipping@example.com', phone: '(310) 555-0142' }), { simulated: true }) === 200,
    'simulated order from loopback bypasses hmac → 200');

  console.log('  customer matching');
  let t2 = (await state2()).traces;
  ok(t2.some((t) => t.kind === 'order' && /MATCH/.test(t.text) && t.text.includes(GATED_IGSID)),
    'order matched the thread that captured a phone through the gate (E.164 normalized)');

  ok(await shopPost(BASE2, 'fulfillments/create', {
    id: FULFILLMENT_ID, order_id: ORDER_ID, status: 'success',
    tracking_company: 'USPS', tracking_number: TRACKING,
  }, { simulated: true }) === 200, 'fulfillments/create accepted');
  t2 = (await state2()).traces;
  ok(t2.some((t) => t.kind === 'easypost' && t.text.includes(TRACKER)),
    'no EASYPOST_API_KEY → tracker simulated locally instead of failing');
  ok(t2.some((t) => t.kind === 'shipment' && /tracker .* watching/.test(t.text)),
    'tracker id stored on the shipment row');

  console.log('  carrier scans → milestone dms');
  const scans = [];
  const epPost = async (status, message, city, state) => {
    scans.push({
      object: 'TrackingDetail', status, message, datetime: new Date().toISOString(),
      tracking_location: { city, state, country: 'US' },
    });
    return (await fetch(`${BASE2}/webhooks/easypost`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'tracker.updated',
        result: {
          object: 'Tracker', id: TRACKER, status, tracking_code: TRACKING, carrier: 'USPS',
          est_delivery_date: '2026-09-14', public_url: `https://track.easypost.com/djE6${TRACKER.slice(-8)}`,
          tracking_details: scans,
        },
      }),
    })).status;
  };
  const dmCount = async () => (await state2()).outbound.filter((o) => o.kind === 'dm').length;
  const dmTail = async (n) => (await state2()).outbound.filter((o) => o.kind === 'dm').slice(n).map((o) => o.text).join('\n');

  let dn = await dmCount();
  await epPost('pre_transit', 'shipping label created', 'Los Angeles', 'CA');
  ok((await dmCount()) === dn, 'pre_transit is not a milestone — no dm on every scan');

  await epPost('in_transit', 'departed usps regional facility', 'Bell Gardens', 'CA');
  ok((await dmCount()) === dn + 1, 'first in_transit → exactly one "on its way" dm');
  const firstDm = await dmTail(dn);
  ok(/on its way/i.test(firstDm) && /bell gardens/i.test(firstDm), 'the dm quotes the real latest scan');
  ok(!/(code|discount|promo|% ?off|expire)/i.test(firstDm), 'a milestone dm never carries an offer');

  dn = await dmCount();
  await epPost('in_transit', 'arrived at usps facility', 'Phoenix', 'AZ');
  ok((await dmCount()) === dn, 'a second in_transit scan fires NO second dm (transitions, not scans)');

  await epPost('out_for_delivery', 'out for delivery, expected by 8:00pm', 'Austin', 'TX');
  ok((await dmCount()) === dn + 1, 'out_for_delivery → one dm');

  console.log('  order_status tool');
  let gn3 = (await state2()).outbound.length;
  await post2(dm('g-mid-ship', "hey where's my order?"));
  let gs = await settled2(gn3);
  ok(gs.traces.some((t) => t.kind === 'tool' && /order_status/.test(t.text)), 'the model called order_status');
  const shipReply = gs.outbound.slice(gn3).map((o) => o.text).join('\n');
  // ('#' is stripped by the markdown scrubber in toBubbles — 1042 is the order)
  ok(/\b1042\b/.test(shipReply) && /austin/i.test(shipReply), 'reply carries the order number and the latest checkpoint');
  ok(/track\.easypost\.com|usps\.com/.test(shipReply), 'reply carries a tracking link');

  console.log('  human takeover');
  // The portal owns response_mode; the bridge mirrors it into settings. With no
  // portal here, write the same key the bridge would (WAL makes this safe).
  const gdb = new Database(DB2);
  gdb.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(`mode:${GATED_IGSID}`, 'human', Date.now());
  gdb.close();
  dn = await dmCount();
  await epPost('delivered', 'delivered, front door/porch', 'Austin', 'TX');
  ok((await dmCount()) === dn, 'delivered milestone is SKIPPED while a human holds the thread');
  ok((await state2()).traces.some((t) => t.kind === 'mode' && /dm skipped/.test(t.text)),
    'the skip is traced, not silent');

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\nsmoke run aborted:', err.message);
  process.exitCode = 1;
} finally {
  server.kill();
  if (server2) server2.kill();
}
