// SQLite persistence. A handful of small tables carry the whole system:
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';
// The Kosha mirror. Every call below is fire-and-forget and a no-op unless the
// bridge is configured, so SQLite remains the source of truth either way.
import { mirrorThread, mirrorMessage, mirrorCollected } from './supabase-bridge.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS processed_events (
    id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS threads (
    igsid TEXT PRIMARY KEY, username TEXT, name TEXT,
    follower_count INTEGER, is_follower INTEGER,
    last_user_msg_at INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, igsid TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS private_replies (
    comment_id TEXT PRIMARY KEY, igsid TEXT NOT NULL,
    text TEXT, sent_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS discounts (
    igsid TEXT PRIMARY KEY, code TEXT NOT NULL, percent INTEGER NOT NULL,
    simulated INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS collected (
    igsid TEXT NOT NULL, field TEXT NOT NULL, value TEXT,
    created_at INTEGER NOT NULL, PRIMARY KEY (igsid, field));
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT,
    total TEXT, currency TEXT, financial_status TEXT, placed_at TEXT,
    discount_codes TEXT, shipping_address TEXT, line_items TEXT,
    igsid TEXT, simulated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS shipments (
    id TEXT PRIMARY KEY, order_id TEXT NOT NULL,
    tracking_code TEXT, carrier TEXT, tracking_url TEXT, tracker_id TEXT,
    status TEXT, est_delivery_date TEXT,
    last_message TEXT, last_city TEXT, last_state TEXT, last_time TEXT,
    checkpoints TEXT, updated_at INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS shipment_milestones (
    shipment_id TEXT NOT NULL, milestone TEXT NOT NULL, sent_at INTEGER NOT NULL,
    PRIMARY KEY (shipment_id, milestone));
  CREATE INDEX IF NOT EXISTS orders_igsid ON orders (igsid);
  CREATE INDEX IF NOT EXISTS shipments_order ON shipments (order_id);
  CREATE INDEX IF NOT EXISTS shipments_tracker ON shipments (tracker_id);
`);

// Migrations. CREATE TABLE above is what a FRESH install gets; a database that
// predates a column catches up here. Guarded by table_info, so this runs on
// every boot and does nothing on all but the first.
function addColumn(table, column, decl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
  if (!has) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    console.log(`[db] migrated: ${table}.${column} added`);
  }
}
// Order detail, stored as JSON text: the codes used at checkout (an EMPTY array
// is a real answer — "no code was used" — and must not be confused with NULL,
// which means we have never looked), the shipping address, and a line-item
// summary. Orders ingested before these columns existed have NULL and are
// hydrated from the Admin API on demand (src/shopify/order-details.js).
addColumn('orders', 'discount_codes', 'TEXT');
addColumn('orders', 'shipping_address', 'TEXT');
addColumn('orders', 'line_items', 'TEXT');
// WHICH scan feed minted this shipment's tracker id — 'aftership', 'easypost'
// or 'simulated'. A tracker id is only meaningful to the provider that issued
// it, so a webhook has to know who to re-read from; and when a feed goes down,
// this is what says which packages need re-registering elsewhere.
addColumn('shipments', 'provider', 'TEXT');

// Returns true the FIRST time an event id is seen, false on any redelivery.
// INSERT OR IGNORE makes this atomic — safe even if Meta delivers twice at once.
export function claimEvent(id) {
  const r = db.prepare('INSERT OR IGNORE INTO processed_events (id, seen_at) VALUES (?, ?)').run(id, Date.now());
  return r.changes === 1;
}

export function upsertThread(igsid, fields = {}) {
  db.prepare('INSERT OR IGNORE INTO threads (igsid, created_at) VALUES (?, ?)').run(igsid, Date.now());
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (!['username', 'name', 'follower_count', 'is_follower'].includes(k)) continue;
    db.prepare(`UPDATE threads SET ${k} = ? WHERE igsid = ?`).run(v, igsid);
  }
  mirrorThread(igsid, getThread(igsid));
}

export const getThread = (igsid) =>
  db.prepare('SELECT * FROM threads WHERE igsid = ?').get(igsid);

export const touchUserMessage = (igsid, at = Date.now()) =>
  db.prepare('UPDATE threads SET last_user_msg_at = ? WHERE igsid = ?').run(at, igsid);

export function appendMessage(igsid, role, content) {
  const at = Date.now();
  const r = db.prepare('INSERT INTO messages (igsid, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(igsid, role, content, at);
  // The local row id is the mirror's dedupe key — stable across restarts, so the
  // boot backfill and this live write can never produce the message twice.
  mirrorMessage(igsid, role, content, r.lastInsertRowid, at);
  return r;
}

export const history = (igsid, limit = 30) =>
  db.prepare('SELECT role, content FROM messages WHERE igsid = ? ORDER BY id DESC LIMIT ?')
    .all(igsid, limit).reverse();

// One-shot ledger.
export function claimPrivateReply(commentId, igsid) {
  const r = db.prepare('INSERT OR IGNORE INTO private_replies (comment_id, igsid, sent_at) VALUES (?, ?, ?)')
    .run(commentId, igsid, Date.now());
  return r.changes === 1;
}

export const recordPrivateReplyText = (commentId, text) =>
  db.prepare('UPDATE private_replies SET text = ? WHERE comment_id = ?').run(text, commentId);

// Demo/self-serve reset: wipe one thread's agent memory and its discount so
// the next message starts a fresh relationship (with a fresh code).
export function resetThread(igsid) {
  db.prepare('DELETE FROM messages WHERE igsid = ?').run(igsid);
  db.prepare('DELETE FROM discounts WHERE igsid = ?').run(igsid);
  db.prepare('DELETE FROM collected WHERE igsid = ?').run(igsid);
  // The order stays (it really happened) but stops being THIS thread's order —
  // a wiped thread has no captured contact, so it must not still answer
  // "where's my order?" from a link the customer's messages no longer support.
  db.prepare('UPDATE orders SET igsid = NULL WHERE igsid = ?').run(igsid);
  db.prepare('UPDATE threads SET last_user_msg_at = NULL WHERE igsid = ?').run(igsid);
}

// Structured facts the workflows collect from the conversation (phone, email,
// and the gate's own bookkeeping fields, prefixed with '_').
export function setCollected(igsid, field, value) {
  const r = db.prepare('INSERT OR REPLACE INTO collected (igsid, field, value, created_at) VALUES (?, ?, ?, ?)')
    .run(igsid, field, value == null ? null : String(value), Date.now());
  mirrorCollected(igsid, field, value);
  return r;
}

export const getCollected = (igsid, field) =>
  db.prepare('SELECT value FROM collected WHERE igsid = ? AND field = ?').get(igsid, field)?.value ?? null;

// Operator-tunable settings (the /admin dashboard writes these; they override env).
export const getSetting = (key) =>
  db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
export const setSetting = (key, value) =>
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, String(value), Date.now());
export const clearSetting = (key) =>
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);

// Dashboard reads.
export const listContacts = () =>
  db.prepare(`
    SELECT c.igsid, t.username, t.name,
      MAX(CASE WHEN c.field = 'phone' THEN c.value END) AS phone,
      MAX(CASE WHEN c.field = 'email' THEN c.value END) AS email,
      MAX(c.created_at) AS captured_at, d.code AS discount_code
    FROM collected c
    LEFT JOIN threads t ON t.igsid = c.igsid
    LEFT JOIN discounts d ON d.igsid = c.igsid
    WHERE c.field IN ('phone', 'email')
    GROUP BY c.igsid ORDER BY captured_at DESC`).all();
export const countOpeners = () =>
  db.prepare('SELECT COUNT(*) AS n FROM private_replies').get().n;
export const countCaptured = () =>
  db.prepare("SELECT COUNT(DISTINCT igsid) AS n FROM collected WHERE field IN ('phone','email')").get().n;

// Full-table reads, for the Kosha mirror's boot backfill only.
export const allThreads = () =>
  db.prepare('SELECT igsid, username, name, created_at FROM threads ORDER BY created_at').all();
export const allMessages = () =>
  db.prepare('SELECT id, igsid, role, content, created_at FROM messages ORDER BY id').all();
export const allCollected = () =>
  db.prepare("SELECT igsid, field, value FROM collected WHERE field NOT LIKE '\\_%' ESCAPE '\\'").all();

export const getDiscount = (igsid) =>
  db.prepare('SELECT * FROM discounts WHERE igsid = ?').get(igsid);

// Codes minted before the Shopify admin token was configured are SIMULATED:
// they read like real codes in a transcript but exist nowhere in the store, so
// a customer who tries one gets rejected at checkout. Deleting the row is the
// entire fix — getDiscount then misses, ensureDiscount runs again, and with the
// admin creds now in place it mints a REAL store code under the same rules.
// Returns how many were purged.
export const purgeSimulatedDiscounts = () =>
  db.prepare('DELETE FROM discounts WHERE simulated = 1').run().changes;

// --- orders & shipments -------------------------------------------------
// Shopify's order id is the natural key. Writes are field-by-field (the same
// shape as upsertThread) because two different sources touch a row: the
// orders/create webhook writes the customer facts, the matcher writes igsid,
// and neither may blank what the other stored.
const ORDER_COLS = ['name', 'email', 'phone', 'total', 'currency', 'financial_status', 'placed_at',
  'discount_codes', 'shipping_address', 'line_items', 'igsid', 'simulated'];
export function upsertOrder(id, fields = {}) {
  const key = String(id);
  db.prepare('INSERT OR IGNORE INTO orders (id, created_at) VALUES (?, ?)').run(key, Date.now());
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (!ORDER_COLS.includes(k)) continue;
    db.prepare(`UPDATE orders SET ${k} = ? WHERE id = ?`).run(v, key);
  }
  return getOrder(key);
}

export const getOrder = (id) => db.prepare('SELECT * FROM orders WHERE id = ?').get(String(id));
export const linkOrderToThread = (id, igsid) =>
  db.prepare('UPDATE orders SET igsid = ? WHERE id = ?').run(igsid, String(id));
// The customer's most recent linked order — what "where's my order?" means.
export const getOrderForThread = (igsid) =>
  db.prepare('SELECT * FROM orders WHERE igsid = ? ORDER BY created_at DESC LIMIT 1').get(igsid);

// Customer matching. The gate stores 'phone' as E.164 and 'email' lowercased,
// so the caller normalizes an incoming order to those exact shapes and this is
// a plain equality lookup. A NULL argument matches nothing (SQL, not a bug):
// an order with no email can never collide with a thread that has no email.
// Email wins over phone when both hit — it's the more unique of the two.
export function findThreadByContact({ email = null, phone = null } = {}) {
  const rows = db.prepare(`
    SELECT igsid, field, value FROM collected
    WHERE (field = 'email' AND value = ?) OR (field = 'phone' AND value = ?)
    ORDER BY created_at DESC`).all(email, phone);
  return rows.find((r) => r.field === 'email') || rows[0] || null;
}

// The same join as findThreadByContact, run from the other side: orders that
// arrived BEFORE this customer ever handed us a contact detail sit unlinked
// with nothing to match against. The moment the gate captures an email or a
// phone, this finds them. A NULL argument matches nothing (SQL, not a bug).
export const findUnlinkedOrdersByContact = ({ email = null, phone = null } = {}) =>
  db.prepare(`
    SELECT * FROM orders
    WHERE igsid IS NULL AND (email = ? OR phone = ?)
    ORDER BY created_at DESC`).all(email, phone);

const SHIPMENT_COLS = ['order_id', 'tracking_code', 'carrier', 'tracking_url', 'tracker_id', 'provider',
  'status', 'est_delivery_date', 'last_message', 'last_city', 'last_state', 'last_time', 'checkpoints'];
export function upsertShipment(id, fields = {}) {
  const key = String(id);
  db.prepare('INSERT OR IGNORE INTO shipments (id, order_id, created_at) VALUES (?, ?, ?)')
    .run(key, String(fields.order_id ?? ''), Date.now());
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (!SHIPMENT_COLS.includes(k)) continue;
    db.prepare(`UPDATE shipments SET ${k} = ? WHERE id = ?`).run(v, key);
  }
  db.prepare('UPDATE shipments SET updated_at = ? WHERE id = ?').run(Date.now(), key);
  return getShipment(key);
}

export const getShipment = (id) => db.prepare('SELECT * FROM shipments WHERE id = ?').get(String(id));
export const getShipmentByTracker = (trackerId) =>
  db.prepare('SELECT * FROM shipments WHERE tracker_id = ?').get(String(trackerId));
export const getShipmentByTrackingCode = (code) =>
  db.prepare('SELECT * FROM shipments WHERE tracking_code = ? ORDER BY created_at DESC LIMIT 1').get(String(code));
export const getShipmentForOrder = (orderId) =>
  db.prepare('SELECT * FROM shipments WHERE order_id = ? ORDER BY created_at DESC LIMIT 1').get(String(orderId));

// One-shot ledger, exactly like claimPrivateReply: true the FIRST time this
// shipment reaches this milestone, false forever after. A carrier that reports
// 'in_transit' on ten consecutive scans still buys the customer one DM.
export function claimMilestone(shipmentId, milestone) {
  const r = db.prepare('INSERT OR IGNORE INTO shipment_milestones (shipment_id, milestone, sent_at) VALUES (?, ?, ?)')
    .run(String(shipmentId), milestone, Date.now());
  return r.changes === 1;
}

export const saveDiscount = (igsid, d) =>
  db.prepare('INSERT OR REPLACE INTO discounts (igsid, code, percent, simulated, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(igsid, d.code, d.percent, d.simulated ? 1 : 0, d.expiresAt, Date.now());
