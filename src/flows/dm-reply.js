// Inbound DM → agent loop → outbound DM(s), with the 24-hour messaging window
// enforced on the way out.
import { config } from '../config.js';
import { upsertThread, getThread, touchUserMessage, appendMessage, resetThread, getCollected, setCollected } from '../store/db.js';
import { fetchProfile } from '../instagram/profile.js';
import { resolveGreeting } from '../agent/greeting.js';
import { runAgentTurn } from '../agent/loop.js';
import { handlePhoneReply } from './phone-gate.js';
import { conversationMode } from './workflow-settings.js';
import { sendDm, sendSenderAction } from '../instagram/send.js';
import { trace } from '../sim/trace.js';

const WINDOW_MS = 24 * 3600 * 1000;

// Reading-speed pacing.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const typeTime = (text) =>
  Math.min(6000, Math.max(1500, text.length * 45)) * (0.8 + Math.random() * 0.4);

export function withinMessagingWindow(igsid) {
  const t = getThread(igsid);
  return !!t?.last_user_msg_at && Date.now() - t.last_user_msg_at < WINDOW_MS;
}

export async function handleInboundDm({ igsid, text, at }) {
  trace('webhook', `dm from ${igsid}: ${text}`);

  // Kill switch for demo takes: the exact message RESETNOW wipes this thread's.
  if (text.trim() === 'RESETNOW') {
    resetThread(igsid);
    trace('reset', `thread ${igsid} wiped on request — next message starts fresh`);
    return;
  }

  upsertThread(igsid);
  touchUserMessage(igsid, at || Date.now());
  appendMessage(igsid, 'user', text);

  // Lazily enrich the thread once we're in a messaging context; never fatal.
  const thread = getThread(igsid);
  if (!thread?.username || thread?.is_follower == null) {
    const p = await fetchProfile(igsid);
    if (p) {
      upsertThread(igsid, {
        username: p.username,
        name: p.name,
        follower_count: p.follower_count,
        is_follower: p.is_user_follow_business != null ? Number(p.is_user_follow_business) : undefined,
      });
    }
  }

  // How to address them. Threads opened by our own opener already decided this
  // (comment-to-dm.js) and the stored value stands — re-deciding mid-thread is
  // how an agent starts calling someone a different name on turn four. Only a
  // thread that never had an opener (they DM'd us first) resolves it here.
  if (getCollected(igsid, 'greeting.name') === null) {
    const t = getThread(igsid);
    const greeting = await resolveGreeting({ name: t?.name, username: t?.username });
    setCollected(igsid, 'greeting.name', greeting.greetName || '');
    setCollected(igsid, '_greeting.basis', greeting.basis);
    trace('greeting', `${igsid} name ${JSON.stringify(t?.name ?? null)} → ${greeting.greetName ? `"${greeting.greetName}" (${greeting.basis})` : 'no name (none)'}`);
  }

  // Human takeover. An operator holding this thread in the Kosha portal means
  // the concierge answers nothing at all — no gate reply, no agent turn, not
  // even a typing indicator, which would otherwise promise a bot reply that
  // never comes. The inbound message is already stored AND mirrored above, so
  // the portal transcript the operator is reading stays complete; their reply
  // comes back through POST /operator/send.
  if (conversationMode(igsid) === 'human') {
    trace('mode', `human mode for ${igsid} — inbound stored, no auto-reply`);
    return;
  }

  const pacing = config.replyPacing === 'natural';
  if (pacing) {
    await sendSenderAction(igsid, 'mark_seen');
    await sendSenderAction(igsid, 'typing_on'); // typing shows while the model composes
  }

  // Workflow 2 first: if we're waiting on a phone number, the gate handles the
  // message deterministically (validate → confirm → code + hydrated link).
  let bubbles = await handlePhoneReply(igsid, text);
  if (bubbles) appendMessage(igsid, 'assistant', bubbles.join('\n'));
  else bubbles = await runAgentTurn(igsid);
  for (const b of bubbles) {
    if (!withinMessagingWindow(igsid)) {
      trace('window', `24h messaging window closed for ${igsid} — send suppressed`);
      return;
    }
    if (pacing) {
      await sendSenderAction(igsid, 'typing_on');
      await sleep(typeTime(b));
    }
    try {
      await sendDm(igsid, b);
    } catch (err) {
      trace('error', `dm send failed for ${igsid}: ${err.message}`);
      return;
    }
  }
}
