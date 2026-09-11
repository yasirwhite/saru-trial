// The console's dedicated sim child.
//
// The live server runs TRANSPORT=meta — every send goes to a real Instagram
// thread — so the capability console cannot drive the agent in-process the way
// the /sim playground does. Instead it boots a SECOND copy of this exact server
// on loopback with TRANSPORT=sim and its own throwaway database, and drives that
// one through the sim webhook + state endpoints (the same doors scripts/smoke.js
// uses). Same code, same prompts, same tools, same store — the only differences
// are where the messages land (a capture array instead of Meta) and which DB
// file they land in.
//
// The child boots on the FIRST console run, stays alive between runs, and is
// killed when the parent exits.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { simTrackerId } from '../shipping/easypost.js';
import { trace } from '../sim/trace.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SERVER = path.join(ROOT, 'src', 'server.js');

// The child's sim playground impersonates one person; this is the igsid it
// derives from that persona (see src/sim/playground.js igsidFor).
export const CONSOLE_IGSID = 'sim-user-maya.runs';

let child = null;
let info = null; // { port, pid, dbPath, driver, startedAt, up }
let booting = null;
let db = null;
let hooked = false;
const log = [];

const note = (line) => {
  log.push(`${new Date().toLocaleTimeString()} ${line}`);
  if (log.length > 60) log.shift();
};

// --- lifecycle -----------------------------------------------------------

async function portFree(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
    return !res.ok; // something answered /health — treat the port as taken
  } catch {
    return true; // nothing listening (or not our server) — usable
  }
}

async function pickPort(start) {
  for (let p = start; p < start + 8; p++) if (await portFree(p)) return p;
  throw new Error(`no free console port in ${start}-${start + 7}`);
}

// A fresh database per boot: the console's verdicts must never depend on what a
// previous session's run left behind. On Windows a stale child can still hold
// the file open — fall back to a uniquely named db rather than failing the run.
function wipeDb(dbPath) {
  closeDb();
  const abs = path.isAbsolute(dbPath) ? dbPath : path.join(ROOT, dbPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    for (const f of [abs, `${abs}-wal`, `${abs}-shm`]) fs.rmSync(f, { force: true });
    return abs;
  } catch (err) {
    const alt = abs.replace(/\.db$/, '') + `-${process.pid}.db`;
    note(`could not wipe ${path.basename(abs)} (${err.code || err.message}) — using ${path.basename(alt)}`);
    for (const f of [alt, `${alt}-wal`, `${alt}-shm`]) { try { fs.rmSync(f, { force: true }); } catch { /* ignore */ } }
    return alt;
  }
}

function childEnv(port, dbPath, adminKey) {
  return {
    ...process.env,
    PORT: String(port),
    DB_PATH: dbPath,
    // The whole point of the child: sim transport (nothing reaches Meta) with
    // the REAL model (the console exists to judge real behavior). Smoke flips
    // the driver to 'mock' through CONSOLE_LLM_DRIVER so it stays cheap.
    TRANSPORT: 'sim',
    LLM_DRIVER: config.consoleLlmDriver,
    IG_ACCESS_TOKEN: '',
    // Deterministic, fast: no reading-speed pacing, no capture gate in the way,
    // no portal mirror (console traffic must never reach a customer's record),
    // no EasyPost (the seeded shipment drives simulated trackers), no shopify
    // webhook secret (the seed uses the loopback simulated door), and the
    // child's own /admin + /operator doors stay closed.
    REPLY_PACING: 'instant',
    PHONE_GATE: '0',
    DATABASE_URL: '',
    // No carrier credentials of any kind: the seeded shipment's trackers are
    // simulated locally, and a real provider would (correctly) refuse to
    // recognise the console's invented tracking numbers.
    EASYPOST_API_KEY: '',
    AFTERSHIP_API_KEY: '',
    AFTERSHIP_WEBHOOK_SECRET: '',
    SHOPIFY_WEBHOOK_SECRET: '',
    PUBLIC_BASE_URL: '',
    // A per-boot key, known only to this process: the console plays the portal
    // operator (POST /operator/send) to prove a human reply resolves an
    // escalation flag. The port is loopback-only and the key never leaves here.
    ADMIN_KEY: adminKey,
    // The escalation courtesy DM is a 20-minute promise in production; the
    // console has to watch it happen, so the child's threshold is seconds.
    ESCALATION_FOLLOWUP_MIN: String(config.consoleFollowupMin),
    // The child runs the same server file, /console included. This marker keeps
    // it from ever spawning a console child of its own.
    SARU_CONSOLE_CHILD: '1',
    // Shopify MCP url, store domain, admin/discount creds, OPENAI_API_KEY and
    // the featured-product pin are inherited untouched — the catalog, policies
    // and minted codes the console judges are the live ones.
  };
}

async function boot() {
  const port = await pickPort(config.consolePort);
  const dbPath = wipeDb(config.consoleDbPath);
  const startedAt = Date.now();
  const adminKey = crypto.randomUUID();

  child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: childEnv(port, dbPath, adminKey),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pipe = (stream, prefix) => stream.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim()) note(`${prefix}${line.trim().slice(0, 220)}`);
  });
  pipe(child.stdout, '');
  pipe(child.stderr, '! ');
  child.on('exit', (code, signal) => {
    note(`child exited (code=${code} signal=${signal})`);
    if (info) info.up = false;
    child = null;
  });

  info = { port, pid: child.pid, dbPath, driver: config.consoleLlmDriver, startedAt, up: false, adminKey };
  registerExitHooks();

  // Generous: a cold boot pays for MCP tool discovery and, on Windows, a
  // Defender pass over node_modules.
  for (let i = 0; i < 160; i++) {
    if (!child) throw new Error(`console child died during boot — ${log.slice(-3).join(' | ')}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
      if (res.ok) {
        info.up = true;
        trace('console', `sim child up on 127.0.0.1:${port} (pid ${child.pid}, llm=${info.driver}, db=${path.basename(dbPath)})`);
        return info;
      }
    } catch { /* still booting */ }
    await sleep(250);
  }
  throw new Error('console child did not boot within 40s');
}

export async function ensureChild() {
  if (info?.up && child) return info;
  booting ||= boot().finally(() => { booting = null; });
  return booting;
}

export function killChild() {
  closeDb();
  if (child) { try { child.kill(); } catch { /* already gone */ } }
  child = null;
  if (info) info.up = false;
}

// Only armed once a child actually exists, so a server that never opens the
// console keeps its stock signal behavior.
function registerExitHooks() {
  if (hooked) return;
  hooked = true;
  process.on('exit', killChild);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { killChild(); process.exit(0); });
  }
}

export const childInfo = () => {
  if (!info) return { up: false, log: log.slice(-14) };
  const { adminKey, ...safe } = info; // the operator key stays in this process
  return { ...safe, followupMin: config.consoleFollowupMin, log: log.slice(-14) };
};

// --- talking to the child ------------------------------------------------

const base = () => {
  if (!info?.port) throw new Error('console child is not running');
  return `http://127.0.0.1:${info.port}`;
};

const post = async (pathname, body, headers = {}) => {
  const res = await fetch(`${base()}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: (await res.text()).slice(0, 300) };
};

export const childState = async () => (await fetch(`${base()}/sim/state`)).json();

export const injectDm = (text) => post('/sim/dm', { text });

// The console playing the portal: a human operator typing a reply into the
// thread, through the same door the Kosha portal uses.
export const operatorSend = (igsid, text) =>
  post('/operator/send', { igsid, text, key: info?.adminKey });

// --- the child's database ------------------------------------------------
// Read straight from the child's SQLite file (WAL makes cross-process reads
// safe — scripts/smoke.js does the same). It is the authority for the facts a
// reply cannot prove on its own: did the mode actually flip, was the code real,
// what did the escalation store.

function openDb() {
  if (!db && info?.dbPath && fs.existsSync(info.dbPath)) db = new Database(info.dbPath);
  return db;
}
function closeDb() {
  if (db) { try { db.close(); } catch { /* ignore */ } }
  db = null;
}

export function childSetting(key) {
  try { return openDb()?.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null; } catch { return null; }
}
export function childDiscount(igsid) {
  try { return openDb()?.prepare('SELECT * FROM discounts WHERE igsid = ?').get(igsid) ?? null; } catch { return null; }
}
export function childCollected(igsid) {
  try {
    const rows = openDb()?.prepare('SELECT field, value FROM collected WHERE igsid = ?').all(igsid) || [];
    return Object.fromEntries(rows.map((r) => [r.field, r.value]));
  } catch { return {}; }
}
// Feature detection for columns another workstream may (or may not) have added.
export function orderColumns() {
  try { return (openDb()?.prepare('PRAGMA table_info(orders)').all() || []).map((c) => c.name); } catch { return []; }
}
export function childOrder(igsid) {
  try { return openDb()?.prepare('SELECT * FROM orders WHERE igsid = ? ORDER BY created_at DESC LIMIT 1').get(igsid) ?? null; } catch { return null; }
}

// The one write the console makes into the child: clearing a takeover flag the
// escalation scenario set, so the next suite starts with the agent in charge.
export function clearHumanMode() {
  try { openDb()?.prepare("DELETE FROM settings WHERE key LIKE 'mode:%'").run(); } catch { /* ignore */ }
}

// Wipe the thread between scenarios: RESETNOW is the concierge's own kill
// switch (messages, discount, collected fields, order link), and the mode key
// is ours to clear.
export async function resetThread() {
  clearHumanMode();
  await injectDm('RESETNOW');
  await sleep(350);
}

// --- seeding an order ----------------------------------------------------
// Drives the child through the REAL pipeline (orders/create → fulfillments/create
// → tracker scans) the same way scripts/simulate-shipment.mjs drives a demo: a
// loopback request carrying X-Saru-Simulated. Nothing is written behind the
// system's back, so "where's my order?" is answered by the same code path a
// real Shopify order takes.
export async function seedOrder({ igsid = CONSOLE_IGSID, total = '48.00', carrier = 'USPS' } = {}) {
  const stamp = Date.now();
  const orderId = String(stamp);
  const orderNumber = 1000 + (stamp % 9000);
  const orderName = `#${orderNumber}`;
  const trackingCode = `9400${String(stamp).slice(-12)}`;
  const trackerId = simTrackerId(trackingCode);
  const eta = new Date(stamp + 2 * 86400000).toISOString().slice(0, 10);
  const sim = { 'X-Saru-Simulated': '1' };

  // The detail fields are sent the way Shopify sends them. A build whose orders
  // table predates those columns simply drops them (upsertOrder filters by
  // column), which is why the checks that read them feature-detect first.
  const address = {
    first_name: 'Maya', last_name: 'Ramirez',
    address1: '1847 Ashby Ave', address2: null,
    city: 'Austin', province: 'TX', zip: '78702', country: 'US',
  };
  const lineItems = [{ title: 'Daily Dew Serum', quantity: 1 }];
  const orderBody = {
    id: Number(orderId),
    name: orderName,
    order_number: orderNumber,
    email: 'console.demo@example.com',
    total_price: total,
    currency: 'USD',
    financial_status: 'paid',
    created_at: new Date(stamp).toISOString(),
    shipping_address: address,
    line_items: lineItems,
    discount_codes: [], // looked, and there were none — a real, quotable answer
    _saru_igsid: igsid, // simulation-only shortcut, honored on loopback only
  };
  await post('/webhooks/shopify', orderBody, { ...sim, 'X-Shopify-Topic': 'orders/create' });
  await post('/webhooks/shopify', {
    id: Number(`${stamp}1`),
    order_id: Number(orderId),
    status: 'success',
    tracking_company: carrier,
    tracking_number: trackingCode,
  }, { ...sim, 'X-Shopify-Topic': 'fulfillments/create' });

  const scans = [
    { status: 'pre_transit', message: 'shipping label created, usps awaiting item', city: 'Los Angeles', state: 'CA' },
    { status: 'in_transit', message: 'departed usps regional facility', city: 'Bell Gardens', state: 'CA' },
    { status: 'out_for_delivery', message: 'out for delivery, expected by 8:00pm', city: 'Austin', state: 'TX' },
  ];
  const details = [];
  for (const [i, scan] of scans.entries()) {
    details.push({
      object: 'TrackingDetail',
      status: scan.status,
      message: scan.message,
      datetime: new Date(stamp + i * 3600000).toISOString(),
      tracking_location: { city: scan.city, state: scan.state, country: 'US' },
    });
    await post('/webhooks/easypost', {
      description: 'tracker.updated',
      result: {
        object: 'Tracker', id: trackerId, status: scan.status, tracking_code: trackingCode, carrier,
        est_delivery_date: eta,
        public_url: `https://track.easypost.com/djE6${trackerId.slice(-10)}`,
        tracking_details: details,
      },
    }, sim);
  }
  await sleep(250);

  const latest = scans[scans.length - 1];
  const cols = orderColumns();
  return {
    orderId, orderName, orderNumber: String(orderNumber), total, currency: 'USD',
    carrier, trackingCode, trackerId, eta,
    status: latest.status, city: latest.city, state: latest.state, message: latest.message,
    trackingUrl: `https://track.easypost.com/djE6${trackerId.slice(-10)}`,
    address, lineItems, discountCodes: [],
    // What this build of the orders table can actually hold. The order-detail
    // checks assert only fields that really exist here (another workstream owns
    // those columns; the console never asserts a capability that isn't shipped).
    columns: cols,
    hasAddressColumn: cols.includes('shipping_address'),
    hasItemsColumn: cols.includes('line_items'),
    hasCodesColumn: cols.includes('discount_codes'),
  };
}
