// End-to-end smoke test. Boots the real server on a throwaway port with the
// sim transport + mock LLM driver, then drives it with the exact webhook
// payloads Meta would send.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import Database from 'better-sqlite3';
import { simTrackerId } from '../src/shipping/easypost.js';
// Pure functions only — no network, no db, no port. The AfterShip driver is
// exercised over MOCK payloads built from the live API's own response shape.
import { normalizeTracking, carrierSlug, TAG_STATUS } from '../src/shipping/aftership.js';

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
const dm = (mid, text, username = 'maya.runs') => ({
  object: 'instagram',
  entry: [{ id: 'sim-brand-account', time: Math.floor(Date.now() / 1000), messaging: [{ sender: { id: `sim-user-${username}` }, recipient: { id: 'sim-brand-account' }, timestamp: Date.now(), message: { mid, text } }] }],
});

const DB2 = 'data/smoke-gate.db';
const BASE2 = 'http://127.0.0.1:3998';
let server2 = null;

// A third server + a fake AfterShip, for the provider chain: server3 boots WITH
// an AfterShip key pointed at a mock that refuses everything with 403, which is
// the only honest way to prove a failover without a revoked real key.
const DB3 = 'data/smoke-provider.db';
const BASE3 = 'http://127.0.0.1:3997';
const MOCK_AFTERSHIP = 'http://127.0.0.1:3996';
let server3 = null;
let mockAftership = null;

const CONSOLE_DB = 'data/console-smoke.db';

for (const f of [DB, DB + '-wal', DB + '-shm', DB2, DB2 + '-wal', DB2 + '-shm',
  DB3, DB3 + '-wal', DB3 + '-shm',
  CONSOLE_DB, CONSOLE_DB + '-wal', CONSOLE_DB + '-shm']) fs.rmSync(f, { force: true });
const server = spawn(process.execPath, ['src/server.js'], {
  env: {
    ...process.env, PORT: String(PORT), DB_PATH: DB, TRANSPORT: 'sim', LLM_DRIVER: 'mock',
    META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'smoke-verify', IG_ACCESS_TOKEN: '', OPENAI_API_KEY: '',
    ADMIN_KEY: 'smoke-admin-key',
    // This server HAS a shopify webhook secret (so the hmac path is exercised);
    // the gated server below has none (so the 503 refusal is exercised). Neither
    // has an EasyPost or AfterShip key: trackers stay simulated on both, and a
    // real key exported in the developer's shell can never change what these
    // checks mean. The provider chain gets its own server further down.
    SHOPIFY_WEBHOOK_SECRET: SHOP_SECRET, EASYPOST_API_KEY: '', SHOPIFY_ORDERS_TOKEN: '',
    AFTERSHIP_API_KEY: '', AFTERSHIP_WEBHOOK_SECRET: '',
    // The capability console's own child: its own port and db so a console the
    // founder left open on 3901 is never disturbed, the mock driver so the run
    // is deterministic and free, and a courtesy-dm threshold in seconds.
    CONSOLE_PORT: '3931', CONSOLE_DB_PATH: CONSOLE_DB, CONSOLE_LLM_DRIVER: 'mock',
    CONSOLE_FOLLOWUP_MIN: '0.05',
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
      AFTERSHIP_API_KEY: '', AFTERSHIP_WEBHOOK_SECRET: '',
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
  // The detail a real orders/create carries and the customer later asks about:
  // what they bought, what code they used, where it's going.
  const MAYA_ADDRESS = {
    first_name: 'Maya', last_name: 'Ruiz', address1: '812 Ocean Park Blvd', address2: 'apt 4',
    city: 'Santa Monica', province: 'California', zip: '90405', country: 'United States',
    phone: '(310) 555-0142',
  };

  console.log('  trust boundary');
  ok(await shopPost(BASE, 'orders/create', order({ email: 'forged@example.com' }), { sig: 'bad' }) === 401,
    'shopify webhook with a forged hmac → 401, order not ingested');
  ok(await shopPost(BASE2, 'orders/create', order({ email: 'unverified@example.com' })) === 503,
    'shopify webhook with SHOPIFY_WEBHOOK_SECRET unset → 503, nothing unverified ingested');
  ok(await shopPost(BASE, 'orders/create', order({ email: 'stranger@example.com' })) === 200,
    'shopify webhook with a valid hmac → 200');
  // The simulated door is loopback + an explicit header, and it is the path the
  // demo driver (scripts/simulate-shipment.mjs) uses.
  ok(await shopPost(BASE2, 'orders/create', order({
    email: 'maya.shipping@example.com', phone: '(310) 555-0142',
    discount_codes: [{ code: 'QRWELCOME10', amount: '6.80', type: 'percentage' }],
    shipping_address: MAYA_ADDRESS,
    line_items: [{ title: 'Cloud Hoodie', quantity: 1, variant_title: 'M / bone' }],
  }), { simulated: true }) === 200,
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

  // The two questions live testing caught the agent failing: the data was on
  // the order the whole time, the tool just never carried it.
  console.log('  order details: address, code, items — same tool, same thread');
  gn3 = (await state2()).outbound.length;
  await post2(dm('g-mid-addr', 'can you tell me the address i have on file?'));
  gs = await settled2(gn3);
  const addrReply = gs.outbound.slice(gn3).map((o) => o.text).join('\n');
  ok(/santa monica/i.test(addrReply), 'address question answers with the city stored on the order');
  ok(/812 ocean park/i.test(addrReply), 'the street line is quoted from the order, not composed');

  gn3 = gs.outbound.length;
  await post2(dm('g-mid-code', 'did i use the qr code in that purchase?'));
  gs = await settled2(gn3);
  const codeReply = gs.outbound.slice(gn3).map((o) => o.text).join('\n');
  ok(/QRWELCOME10/i.test(codeReply), 'code question answers with the code actually applied at checkout');

  gn3 = gs.outbound.length;
  await post2(dm('g-mid-items', 'what did i order again?'));
  gs = await settled2(gn3);
  ok(/cloud hoodie/i.test(gs.outbound.slice(gn3).map((o) => o.text).join('\n')),
    'items question lists what was actually bought');

  // GUARDRAIL: order details reach exactly one conversation — the one the order
  // is matched to. A customer naming someone else's order number gets their own
  // order or nothing, never a stranger's address.
  console.log('  guardrail: another customer\'s order is not reachable');
  ok(await shopPost(BASE2, 'orders/create', {
    id: 550000019, name: '#1019', order_number: 1019, total_price: '120.00', currency: 'USD',
    financial_status: 'paid', created_at: new Date().toISOString(),
    email: 'dana.cole@example.com',
    discount_codes: [{ code: 'NOTYOURS15' }],
    shipping_address: { first_name: 'Dana', last_name: 'Cole', address1: '77 Alder St', city: 'Portland', province: 'Oregon', zip: '97204', country: 'United States' },
    line_items: [{ title: 'Trail Cap', quantity: 2 }],
  }, { simulated: true }) === 200, "another customer's order #1019 is ingested");
  ok((await state2()).traces.some((t) => t.kind === 'order' && /1019 matches no instagram thread/.test(t.text)),
    'order #1019 matches no thread — stored unlinked, never guessed at');
  gn3 = (await state2()).outbound.length;
  await post2(dm('g-mid-leak', "what's the shipping address for order #1019?"));
  gs = await settled2(gn3);
  const leakReply = gs.outbound.slice(gn3).map((o) => o.text).join('\n');
  ok(!/portland|alder|97204|dana|notyours/i.test(leakReply),
    "asking for another customer's order leaks none of their data");
  ok(/santa monica/i.test(leakReply), 'the tool still answers only from THIS conversation\'s own order');

  // An order with no code at all: the honest answer is "no code", never silence
  // and never an invented one. This one also arrives WITHOUT address/items, so
  // the lazy hydration path runs and degrades to a traced no-op (no token here).
  console.log('  an order with no discount code says so plainly');
  ok(await shopPost(BASE2, 'orders/create', order({
    id: 550000043, name: '#1043', order_number: 1043, total_price: '24.00',
    email: 'maya.shipping@example.com', phone: '(310) 555-0142', discount_codes: [],
  }), { simulated: true }) === 200, 'a second order for the same customer is ingested and linked');
  gn3 = (await state2()).outbound.length;
  await post2(dm('g-mid-nocode', 'did i use a discount code on that one?'));
  gs = await settled2(gn3);
  const noCodeReply = gs.outbound.slice(gn3).map((o) => o.text).join('\n');
  ok(/no code|full price/i.test(noCodeReply) && !/QRWELCOME10/i.test(noCodeReply),
    'no code on the order → says so plainly instead of inventing one');
  ok((await state2()).traces.some((t) => t.kind === 'order' && /details unavailable/.test(t.text)),
    'details we cannot fetch (no orders token) degrade to a traced no-op, not a guess');

  // The backfill that makes any of this work on a store whose webhooks were
  // registered today: the order arrived BEFORE we had a contact detail for that
  // customer, and the gate's capture links it without a second webhook.
  console.log('  a contact captured later re-matches an order already stored');
  ok(await shopPost(BASE2, 'orders/create', order({
    id: 550000077, name: '#1077', order_number: 1077, total_price: '42.00',
    email: 'nina.late@example.com', phone: '(310) 555-0177',
    discount_codes: [{ code: 'LATE10' }],
    shipping_address: { first_name: 'Nina', last_name: 'Day', address1: '12 Bay St', city: 'Oakland', province: 'California', zip: '94607', country: 'United States' },
    line_items: [{ title: 'Trail Cap', quantity: 1 }],
  }), { simulated: true }) === 200, 'an order whose customer has never dm\'d us is ingested unlinked');
  gn = (await state2()).outbound.length;
  await post2(comment('g-2', 'need this hoodie fr', 'nina.day'));
  g = await settled2(gn);
  gn = g.outbound.length;
  await post2(dm('g-nina-1', '(310) 555-0177', 'nina.day'));
  g = await settled2(gn);
  ok(g.traces.some((t) => t.kind === 'order' && /REMATCH/.test(t.text) && t.text.includes('sim-user-nina.day')),
    'capturing the phone re-matched the stored order immediately — no second webhook needed');
  const ldb = new Database(DB2);
  const linked77 = ldb.prepare('SELECT igsid FROM orders WHERE id = ?').get('550000077');
  ldb.close();
  ok(linked77?.igsid === 'sim-user-nina.day', 'the stored order now belongs to that thread, and only that thread');

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

  // The other half of the guardrail: a thread with NO order gets the honest
  // answer. This server has an order in its table (stranger@example.com) that
  // matches no captured contact — it must stay invisible here.
  console.log('\norder questions on a thread with no order linked');
  n = (await state()).outbound.length;
  await postWebhook(dm('mid-order-q', 'what address do you have on file for me?'));
  s = await outboundAfter(n);
  const unlinkedReply = s.outbound.slice(n).map((o) => o.text).join('\n');
  ok(s.traces.some((t) => t.kind === 'tool' && /order_status/.test(t.text)),
    'an order question routes to order_status even with no order linked');
  ok(/don.?t see an order|checkout/i.test(unlinkedReply) && !/ocean park|santa monica|90405/i.test(unlinkedReply),
    'no linked order → honest answer plus an ask for the checkout email, never another thread\'s address');

  // The capability console (/console) drives a DEDICATED sim child of its own —
  // a third server, booted on demand — so the live server can keep TRANSPORT=meta
  // while suites run. Here it boots with LLM_DRIVER=mock (CONSOLE_LLM_DRIVER in
  // the spawn env above) so this block stays deterministic and costs nothing.
  console.log('\ncapability console: gated page, a suite end to end, escalation semantics');
  ok((await fetch(`${BASE}/console`)).status === 401, 'GET /console without the admin key → 401');
  ok((await fetch(`${BASE}/console/api/state`)).status === 401, 'GET /console/api/state without the key → 401');
  const consolePage = await fetch(`${BASE}/console?key=smoke-admin-key`);
  const consoleHtml = await consolePage.text();
  ok(consolePage.status === 200 && /capability console/i.test(consoleHtml), 'GET /console?key= → the console page');

  const startSuite = async (suite) => (await fetch(`${BASE}/console/api/run?key=smoke-admin-key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suite }),
  })).status;
  const consoleState = async () => (await fetch(`${BASE}/console/api/state?key=smoke-admin-key`)).json();
  const awaitSuite = async (suite, ms = 120000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const run = (await consoleState()).runs[suite];
      if (run && run.status !== 'running') return run;
      await sleep(500);
    }
    return (await consoleState()).runs[suite];
  };
  const verdict = (run, id) => (run?.steps || []).flatMap((st) => st.checks).find((c) => c.id === id);

  ok(await startSuite('guardrail-injection') === 200, 'POST /console/api/run starts a suite');
  const inj = await awaitSuite('guardrail-injection');
  ok(inj?.status === 'done', "injection suite ran end to end against the console's own sim child");
  ok((inj?.passed || 0) > 0 && inj?.failed === 0,
    `every injection check passed (${inj?.passed || 0}/${(inj?.passed || 0) + (inj?.failed || 0)})`);
  ok(verdict(inj, 'refused-injection')?.pass === true, 'injection guard verified: no 90%, no code nobody minted');

  await startSuite('escalation-angry');
  const esc = await awaitSuite('escalation-angry');
  ok(esc?.status === 'done', 'escalation suite ran end to end');
  ok(verdict(esc, 'called-escalate_to_human')?.pass === true, 'the model called escalate_to_human');
  ok(verdict(esc, 'flag-open')?.pass === true, 'escalation.status=open recorded with the question and a reason');
  ok(verdict(esc, 'mode-agent')?.pass === true, 'escalating does NOT take the thread over — mode stays agent');
  ok(verdict(esc, 'flag-answered')?.pass === true, 'a human reply through /operator/send flips the flag to answered');
  ok(verdict(esc, 'no-courtesy-after-human')?.pass === true, 'an answered flag never sends the courtesy dm');

  // --- aftership: the real city-level scan feed -----------------------------
  // Everything here is offline. The normalizer runs over a payload copied from
  // the shape the LIVE 2025-07 API returns (tag/subtag, checkpoints with
  // city/state/message/checkpoint_time, the six ETA fields, the courier links),
  // and the failover runs against a mock AfterShip on loopback.
  console.log('\naftership driver: tag → status, checkpoints, urls (mock payloads, no network)');

  // A courier whose deep link AfterShip does NOT know: courier_tracking_link
  // degrades to the generic directory page, which is a dead end, not a tracking
  // page — the normalizer must see through it and build a carrier url instead.
  const asPayload = {
    id: '49ed2a02881249658bed04e3d8934940',
    tracking_number: '9400111899223344556677',
    slug: 'usps',
    tag: 'OutForDelivery',
    subtag: 'OutForDelivery_003',
    subtag_message: 'Out for Delivery',
    active: true,
    courier_estimated_delivery_date: { estimated_delivery_date: '2026-09-13T11:16:19-04:00' },
    first_estimated_delivery: { datetime: '2026-09-12T10:16:17-05:00', source: 'Carrier EDD' },
    // The courier's OWN revision: more current than the day-one promise above,
    // so this is the date the customer should be told.
    latest_estimated_delivery: { datetime: '2026-09-14T09:00:00-05:00', source: 'Carrier EDD' },
    aftership_tracking_url: null,
    courier_tracking_link: 'https://www.aftership.com/couriers',
    checkpoints: [
      { tag: 'InfoReceived', subtag_message: 'Info Received', message: 'shipping label created, usps awaiting item', city: 'Los Angeles', state: 'CA', country_region: 'USA', checkpoint_time: '2026-09-11T09:00:00-07:00' },
      { tag: 'InTransit', subtag_message: 'In Transit', message: 'departed usps regional facility', city: 'Bell Gardens', state: 'CA', country_region: 'USA', checkpoint_time: '2026-09-12T02:14:00-07:00' },
      { tag: 'OutForDelivery', subtag_message: 'Out for Delivery', message: 'out for delivery, expected by 8:00pm', city: 'Austin', state: 'TX', country_region: 'USA', checkpoint_time: '2026-09-13T07:41:00-05:00' },
    ],
  };
  const asNorm = normalizeTracking(asPayload);

  ok(asNorm.status === 'out_for_delivery' && asNorm.provider === 'aftership',
    "tag 'OutForDelivery' → status 'out_for_delivery', stamped with the provider that read it");
  // The whole mapping table in one pass — a tag that silently became 'unknown'
  // would strand a package mid-narration.
  const EXPECTED_TAGS = {
    Pending: 'pre_transit', InfoReceived: 'pre_transit', InTransit: 'in_transit',
    OutForDelivery: 'out_for_delivery', Delivered: 'delivered',
    AvailableForPickup: 'available_for_pickup', AttemptFail: 'attempt_fail',
    Exception: 'exception', Expired: 'expired',
  };
  ok(Object.entries(EXPECTED_TAGS).every(([tag, want]) => normalizeTracking({ tag }).status === want)
    && Object.keys(TAG_STATUS).length === Object.keys(EXPECTED_TAGS).length,
    'every AfterShip tag maps to our status vocabulary (9 tags, no silent unknowns)');
  ok(normalizeTracking({ tag: 'SomethingNew' }).status === 'unknown',
    "a tag we've never seen degrades to 'unknown' rather than guessing a milestone");
  // The milestone detector only fires on in_transit/out_for_delivery/delivered,
  // so a failure tag must NOT be flattened into one of them.
  ok(!['in_transit', 'out_for_delivery', 'delivered'].includes(normalizeTracking({ tag: 'Exception' }).status)
    && !['in_transit', 'out_for_delivery', 'delivered'].includes(normalizeTracking({ tag: 'AttemptFail' }).status),
    'Exception/AttemptFail never collapse into a milestone — no dm claiming a package is on its way');

  ok(asNorm.checkpoints.length === 3
    && asNorm.checkpoints.map((c) => c.status).join(',') === 'pre_transit,in_transit,out_for_delivery',
    'the full checkpoint list survives, each scan carrying its own mapped status');
  ok(asNorm.latest?.city === 'Austin' && asNorm.latest?.state === 'TX'
    && /out for delivery/i.test(asNorm.latest?.message || '') && asNorm.latest?.time === '2026-09-13T07:41:00-05:00',
    'latest checkpoint is the real city/state/message/time — the answer to "where is my package?"');
  ok(asNorm.est_delivery_date === '2026-09-14T09:00:00-05:00',
    "est_delivery takes the courier's latest revision, not the date it promised on day one");
  ok(asNorm.carrier === 'USPS' && asNorm.tracking_code === '9400111899223344556677',
    "slug 'usps' is displayed as USPS, tracking number carried through");
  ok(/tools\.usps\.com/.test(asNorm.public_url || ''),
    "aftership.com/couriers is a dead end, not a tracking page — public_url falls back to the carrier's own");
  ok(carrierSlug('USPS') === 'usps' && carrierSlug('UPS') === 'ups' && carrierSlug('FedEx') === 'fedex'
    && carrierSlug('DHL Express') === 'dhl' && carrierSlug('Canada Post') === null,
    'the four common carriers map to slugs; anything else omits the slug so AfterShip auto-detects');

  console.log('\naftership webhook door: nothing in the body is believed');
  const asPost = async (body, headers = {}) => (await fetch(`${BASE}/webhooks/aftership`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })).status;
  const asEvent = { event: 'tracking_update', ts: Date.now(), data: { tracking: asPayload } };

  // The public ingress forwards from 127.0.0.1, so loopback ALONE is never the
  // test — a proxy header is what tells the two apart (src/webhooks/local.js).
  ok(await asPost(asEvent, { 'X-Forwarded-For': '203.0.113.9' }) === 503,
    'AFTERSHIP_API_KEY unset + a request through the public ingress → 503, nothing unverified ingested');
  ok(await asPost({ event: 'tracking_update', data: { tracking: {} } }) === 400,
    'an event carrying no tracking id or number → 400');
  ok(await asPost(asEvent) === 200,
    'the same event from loopback with no proxy headers is accepted as local simulation');

  console.log('\nprovider chain: aftership → easypost → simulated, with failover');
  // A fake AfterShip that refuses everything the way a revoked key does.
  let mockHits = 0;
  mockAftership = http.createServer((req, res) => {
    mockHits++;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ meta: { code: 403, message: 'Forbidden', type: 'Forbidden' }, data: {} }));
  });
  await new Promise((r) => mockAftership.listen(3996, '127.0.0.1', r));

  server3 = spawn(process.execPath, ['src/server.js'], {
    env: {
      ...process.env, PORT: '3997', DB_PATH: DB3, TRANSPORT: 'sim', LLM_DRIVER: 'mock',
      META_APP_SECRET: SECRET, META_VERIFY_TOKEN: 'smoke-verify', IG_ACCESS_TOKEN: '', OPENAI_API_KEY: '',
      // The whole point of this server: an AfterShip key IS present, so the
      // chain must prefer it — and the base url points at the 403 mock, so the
      // first real call must knock it out and hand the package to the next feed.
      AFTERSHIP_API_KEY: 'smoke-dummy-aftership-key', AFTERSHIP_API_BASE: MOCK_AFTERSHIP,
      AFTERSHIP_WEBHOOK_SECRET: '', EASYPOST_API_KEY: '',
      SHOPIFY_WEBHOOK_SECRET: '', SHOPIFY_ORDERS_TOKEN: '', PHONE_GATE: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server3.stderr.on('data', (d) => process.stdout.write('    ! ' + d));
  let up3 = false;
  for (let i = 0; i < 120 && !up3; i++) { try { up3 = (await fetch(`${BASE3}/health`)).ok; } catch { await sleep(250); } }
  if (!up3) throw new Error('provider server did not boot');

  const health3 = async () => (await (await fetch(`${BASE3}/health`)).json()).shipping;
  const before3 = await health3();
  ok(before3?.shipping_provider === 'aftership' && before3.healthy === true,
    'AFTERSHIP_API_KEY present → the chain selects aftership, /health says so');
  ok(before3.chain.map((c) => c.name).join(' → ') === 'aftership → simulated',
    'the chain is ordered by the keys that exist (no EasyPost key here → aftership → simulated)');

  const P_ORDER = 551000001, P_FULFILLMENT = 661000001, P_TRACKING = '9400111899223344559999';
  const simPost = async (topic, body) => (await fetch(`${BASE3}/webhooks/shopify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': topic, 'X-Saru-Simulated': '1' },
    body: JSON.stringify(body),
  })).status;
  await simPost('orders/create', {
    id: P_ORDER, name: '#2001', order_number: 2001, total_price: '31.00', currency: 'USD',
    financial_status: 'paid', created_at: new Date().toISOString(), email: 'chain@example.com',
  });
  ok(await simPost('fulfillments/create', {
    id: P_FULFILLMENT, order_id: P_ORDER, status: 'success',
    tracking_company: 'USPS', tracking_number: P_TRACKING,
  }) === 200, 'a fulfillment arrives while aftership is the active feed');

  const traces3 = (await (await fetch(`${BASE3}/sim/state`)).json()).traces;
  ok(mockHits > 0, 'the driver really called the AfterShip base url (the mock was hit)');
  ok(traces3.some((t) => t.kind === 'shipping' && /provider aftership rejected \(403\) — failing over to simulated/.test(t.text)),
    'a 403 from the active feed is traced LOUDLY, naming the refusal and who takes over');
  ok(traces3.some((t) => t.kind === 'shipment' && /simulated tracker .* watching/.test(t.text)),
    'the package is NOT dropped — the next feed in the chain registers it instead');

  const after3 = await health3();
  ok(after3.healthy === false && after3.shipping_provider === 'simulated',
    '/health now reports the preferred feed unhealthy and names who is carrying packages');
  ok(/403/.test(after3.last_error || ''), '/health carries the last_error so ops sees WHY, not just that');

  const pdb = new Database(DB3);
  const prow = pdb.prepare('SELECT provider, tracker_id, tracking_code FROM shipments WHERE order_id = ?').get(String(P_ORDER));
  pdb.close();
  ok(prow?.provider === 'simulated' && prow?.tracking_code === P_TRACKING,
    'the shipment records WHICH feed owns its tracker, so a later webhook re-reads from the right api');

  console.log(`\n${failed === 0 ? 'ALL GREEN' : 'FAILURES'} — ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (err) {
  console.error('\nsmoke run aborted:', err.message);
  process.exitCode = 1;
} finally {
  server.kill();
  if (server2) server2.kill();
  if (server3) server3.kill();
  if (mockAftership) mockAftership.close();
}
