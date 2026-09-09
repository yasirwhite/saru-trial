// SQLite persistence. Four small tables carry the whole system:
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
`);

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

export const saveDiscount = (igsid, d) =>
  db.prepare('INSERT OR REPLACE INTO discounts (igsid, code, percent, simulated, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(igsid, d.code, d.percent, d.simulated ? 1 : 0, d.expiresAt, Date.now());
