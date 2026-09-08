// SQLite persistence. Four small tables carry the whole system:
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

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
}

export const getThread = (igsid) =>
  db.prepare('SELECT * FROM threads WHERE igsid = ?').get(igsid);

export const touchUserMessage = (igsid, at = Date.now()) =>
  db.prepare('UPDATE threads SET last_user_msg_at = ? WHERE igsid = ?').run(at, igsid);

export const appendMessage = (igsid, role, content) =>
  db.prepare('INSERT INTO messages (igsid, role, content, created_at) VALUES (?, ?, ?, ?)')
    .run(igsid, role, content, Date.now());

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
  db.prepare('UPDATE threads SET last_user_msg_at = NULL WHERE igsid = ?').run(igsid);
}

export const getDiscount = (igsid) =>
  db.prepare('SELECT * FROM discounts WHERE igsid = ?').get(igsid);

export const saveDiscount = (igsid, d) =>
  db.prepare('INSERT OR REPLACE INTO discounts (igsid, code, percent, simulated, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(igsid, d.code, d.percent, d.simulated ? 1 : 0, d.expiresAt, Date.now());
