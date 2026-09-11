// Agent-initiated escalation: a FLAG, not a transfer.
//
// The portal already owns human takeover (conversations.response_mode →
// 'mode:<igsid>'), and that stays a person's deliberate choice. What the agent
// lacked was a way to say "a human needs to look at this" — when someone asks
// for a person, when something went wrong that no tool can fix, or when a
// question's answer is simply not in any tool result and the only alternatives
// were inventing one or shrugging.
//
// So escalating writes four collected fields and nothing else: the thread keeps
// running, the agent keeps answering everything ELSE normally, and the flag
// (mirrored to the portal by the Kosha bridge, like every collected field)
// shows up on the customer's card as work waiting for a human.
//
// Two safety valves hang off the flag:
//   - a courtesy DM if no human has answered within the threshold, so the
//     customer is never left on a promise nobody kept;
//   - /operator/send marking the flag answered the moment a human replies.
import { config } from '../config.js';
import { getCollected, setCollected, appendMessage, allCollected } from '../store/db.js';
import { conversationMode } from './workflow-settings.js';
import { withinMessagingWindow } from './dm-reply.js';
import { sendDm } from '../instagram/send.js';
import { trace } from '../sim/trace.js';

const F = {
  question: 'escalation.question',
  reason: 'escalation.reason',
  at: 'escalation.at',
  status: 'escalation.status',
  followup: 'escalation.followup_sent',
};

const followupMs = () => Math.max(1000, Math.round(config.escalationFollowupMin * 60 * 1000));
const timers = new Map();

// What the agent is working with, or null. 'open' means no human has replied
// since the flag was raised.
export function openEscalation(igsid) {
  if (getCollected(igsid, F.status) !== 'open') return null;
  return {
    question: getCollected(igsid, F.question) || '',
    reason: getCollected(igsid, F.reason) || '',
    at: parseInt(getCollected(igsid, F.at), 10) || null,
    followupSent: !!getCollected(igsid, F.followup),
  };
}

// Raise the flag. Idempotent per question: the model is told never to escalate
// the same thing twice, and this makes that true even when it tries.
export function flagForHuman(igsid, { reason = '', question = '' } = {}) {
  const existing = openEscalation(igsid);
  if (existing) {
    trace('escalation', `${igsid} already has an open flag ("${existing.question.slice(0, 60)}") — not raising a second`);
    return { ...existing, duplicate: true };
  }
  const record = {
    question: String(question || '').slice(0, 400).trim(),
    reason: String(reason || '').slice(0, 300).trim() || 'customer needs a human',
    at: Date.now(),
  };
  setCollected(igsid, F.question, record.question);
  setCollected(igsid, F.reason, record.reason);
  setCollected(igsid, F.at, record.at);
  setCollected(igsid, F.status, 'open');
  trace('escalation', `flagged for a human — ${igsid}: ${record.reason}${record.question ? ` ("${record.question.slice(0, 80)}")` : ''}`);
  scheduleFollowup(igsid);
  return { ...record, followupSent: false, duplicate: false };
}

// A human replied (src/operator.js calls this). The record stays — the portal
// wants the history — it just stops being work.
export function markAnswered(igsid) {
  if (getCollected(igsid, F.status) !== 'open') return false;
  setCollected(igsid, F.status, 'answered');
  const t = timers.get(igsid);
  if (t) { clearTimeout(t); timers.delete(igsid); }
  trace('escalation', `${igsid} flag answered by a human — no courtesy dm will fire`);
  return true;
}

// The one-line fact the system prompt carries while a flag is open.
export function escalationFact(igsid) {
  const e = openEscalation(igsid);
  if (!e) return null;
  return `a teammate has ALREADY been flagged about: "${e.question || e.reason}". if they ask about `
    + 'that again, say it\'s still being checked with the team — never answer that question yourself, '
    + 'never escalate it a second time. everything else they ask, answer normally.';
}

// --- the courtesy dm -----------------------------------------------------

// Deterministic on purpose: a message that exists because nobody has answered
// yet must not be able to invent, offer, or over-promise. Built from the
// reason the model gave, trimmed to something a person would text.
// A reason is written for the teammate ("missing product data: ingredients for
// the daily dew serum"), so it only becomes a subject once the bookkeeping
// words are stripped — and a reason that is ABOUT the customer rather than
// about a topic ("customer asked for a person") can't be one at all.
const ABOUT_THE_PERSON = /(customer|asked for|wants?\b|angry|upset|complain|refund|human|person|escalat|third time|promised|teammate|follow up|agent)/i;

function followupText(reason) {
  const topic = String(reason || '')
    .replace(/^(missing|no|unknown)\s+(product\s+)?(data|info(rmation)?)\s*[:\-—]?\s*/i, '')
    .replace(/^(couldn'?t|cannot|can'?t)\s+(find|retrieve|confirm)\s*/i, '')
    .replace(/[.?!]+$/, '')
    .trim()
    .split(/\s+/).slice(0, 7).join(' ')
    .toLowerCase();
  return topic && !ABOUT_THE_PERSON.test(topic)
    ? `still on your ${topic} question — checking with the team so i give you the exact answer, not a guess`
    : "still on your question — the team's on it, i'd rather get you the exact answer than a guess";
}

export async function sendFollowup(igsid) {
  const e = openEscalation(igsid);
  if (!e) return false; // answered, or the thread was reset out from under it
  if (e.followupSent) return false;
  if (Date.now() - (e.at || 0) < followupMs() - 500) return false; // not due yet
  // A human holding the thread owns all outbound, and Meta's 24h rule applies
  // to a courtesy dm exactly like any other unprompted send.
  if (conversationMode(igsid) === 'human') {
    trace('escalation', `courtesy dm skipped for ${igsid} — a human holds this thread`);
    return false;
  }
  if (!withinMessagingWindow(igsid)) {
    trace('window', `24h messaging window closed for ${igsid} — escalation courtesy dm skipped`);
    return false;
  }
  const text = followupText(e.reason);
  // Claim BEFORE the send, like every other one-shot in this system: a retry
  // that double-texts someone who is already waiting is the worse failure.
  setCollected(igsid, F.followup, Date.now());
  try {
    await sendDm(igsid, text);
  } catch (err) {
    trace('error', `escalation courtesy dm failed for ${igsid}: ${err.message}`);
    return false;
  }
  appendMessage(igsid, 'assistant', text);
  trace('escalation', `courtesy dm → ${igsid}: ${text}`);
  return true;
}

export function scheduleFollowup(igsid) {
  const e = openEscalation(igsid);
  if (!e || e.followupSent) return;
  const due = Math.max(0, (e.at || Date.now()) + followupMs() - Date.now());
  const prev = timers.get(igsid);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    timers.delete(igsid);
    sendFollowup(igsid).catch((err) => trace('error', `escalation followup failed: ${err.message}`));
  }, due);
  t.unref?.(); // never hold the process open for a courtesy message
  timers.set(igsid, t);
}

// Restarts must not eat the promise. At boot, every flag that is still open,
// still inside its messaging window and past its threshold sends now; the rest
// get their timer re-armed.
export function sweepEscalations() {
  const byThread = new Map();
  for (const row of allCollected()) {
    if (!row.field.startsWith('escalation.')) continue;
    const t = byThread.get(row.igsid) || {};
    t[row.field] = row.value;
    byThread.set(row.igsid, t);
  }
  let armed = 0;
  for (const [igsid, fields] of byThread) {
    if (fields[F.status] !== 'open' || fields[F.followup]) continue;
    armed++;
    scheduleFollowup(igsid);
  }
  if (armed) trace('escalation', `boot sweep — ${armed} open escalation(s) re-armed for a courtesy dm`);
  return armed;
}
