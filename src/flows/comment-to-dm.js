// The flagship: comment webhook → profile fetch → (discount mint) → LLM-composed
// opener → the ONE private reply that comment entitles us to → and from there
// the thread flows into the same agent loop as any DM.
import { config } from '../config.js';
import { upsertThread, getThread, history, claimPrivateReply, recordPrivateReplyText, appendMessage, setCollected, getCollected } from '../store/db.js';
import { fetchProfile, fetchPostContext } from '../instagram/profile.js';
import { ensureDiscount } from '../shopify/discounts.js';
import { getDiscount } from '../store/db.js';
import { getDriver } from '../agent/llm.js';
import { toBubbles } from '../agent/shorten.js';
import { sendPrivateReply, replyToComment } from '../instagram/send.js';
import { hasPurchaseIntent } from '../agent/intent.js';
import { resolveGreeting } from '../agent/greeting.js';
import { activeWorkflow, conversationMode, goalReached, goalTarget } from './workflow-settings.js';
import { trace } from '../sim/trace.js';

const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;

export async function handleNewComment(evt) {
  trace('webhook', `comment ${evt.commentId} by @${evt.username}: ${evt.text}`);
  // Goal guardrail: when the operator's outreach target is met, stop spending
  // openers entirely until they raise it.
  if (goalReached()) {
    trace('goal', `outreach goal reached (${goalTarget()} openers) — comment ${evt.commentId} not contacted`);
    return;
  }
  // One conversation per person. A new comment from someone we're already
  // talking to must not fire a second greeting — a re-introduction reads
  // exactly as botted as it is. The comment becomes context in the existing
  // thread instead, so the next agent (or human) turn can work it in.
  // Dormant threads (quiet past the 7-day reply window) count as over, and a
  // fresh comment there earns a fresh opener.
  const thread = getThread(evt.igsid);
  const lastSeen = thread ? (thread.last_user_msg_at ?? thread.created_at) : null;
  const activeThread = thread && history(evt.igsid, 1).length > 0
    && lastSeen != null && Date.now() - lastSeen < PRIVATE_REPLY_WINDOW_MS;
  const held = conversationMode(evt.igsid) === 'human';
  if (activeThread || held) {
    if (thread) {
      appendMessage(evt.igsid, 'system',
        `context: they just commented "${evt.text}" on another of the brand's posts. ` +
        'this conversation already exists — if they message again, work the comment in naturally; never re-introduce yourself or restart the pitch.');
    }
    // Human takeover means the operator owns ALL outbound — full silence.
    if (held) {
      trace('opener', `comment ${evt.commentId} folded into human-held thread with @${evt.username} — no send`);
      return;
    }
    // An engaged customer commenting again gets acknowledged in the ongoing
    // conversation's voice — never re-introduced, never re-pitched. Pure noise
    // still gets nothing.
    if (isNoiseComment(evt.text)) {
      trace('opener', `repeat comment ${evt.commentId} by @${evt.username} reads as noise — folded silently`);
      return;
    }
    await deliverAcknowledgment(evt).catch((err) => trace('error', `acknowledgment failed: ${err.message}`));
    return;
  }
  // Intent gate: the one private reply this comment entitles us to is spent
  // only on comments that read like a potential buyer.
  if (!(await hasPurchaseIntent(evt.text))) {
    trace('intent', `comment ${evt.commentId} skipped — no purchase intent ("${(evt.text || '').slice(0, 60)}")`);
    return;
  }
  // Optional humanizing delay: a DM seconds after a comment reads as a bot
  // trigger; minutes later it reads as a person who saw it.
  const [lo, hi] = config.openerDelayS;
  const delayMs = (lo + Math.random() * Math.max(0, hi - lo)) * 1000;
  if (delayMs > 0) {
    trace('opener', `opener for comment ${evt.commentId} scheduled in ${Math.round(delayMs / 1000)}s`);
    setTimeout(() => deliverOpener(evt).catch((err) => trace('error', `delayed opener failed: ${err.message}`)), delayMs);
    return;
  }
  await deliverOpener(evt);
}

async function deliverOpener({ commentId, igsid, username, text, mediaId, at }) {

  // Deliberate window handling: a comment older than 7 days can no longer be
  // private-replied — skip loudly rather than burn an API error.
  if (at && Date.now() - at > PRIVATE_REPLY_WINDOW_MS) {
    trace('window', `comment ${commentId} is outside the 7-day private-reply window — skipping`);
    return;
  }
  if (!claimPrivateReply(commentId, igsid)) {
    trace('dedupe', `opener already sent for comment ${commentId}`);
    return;
  }

  upsertThread(igsid, { username });

  // Best-effort context.
  const profile = (await fetchProfile(igsid)) || { username };
  upsertThread(igsid, {
    name: profile.name,
    follower_count: profile.follower_count,
    is_follower: profile.is_user_follow_business != null ? Number(profile.is_user_follow_business) : undefined,
  });
  // How to address them — decided ONCE, here, and persisted, so the opener and
  // every later agent turn say the same thing. An instagram name is as often a
  // title, a brand or a joke as it is a name; blindly taking its first token is
  // what produced "hey mr white".
  const greeting = await resolveGreeting({ name: profile.name, username: profile.username || username });
  setCollected(igsid, 'greeting.name', greeting.greetName || '');
  setCollected(igsid, '_greeting.basis', greeting.basis);
  trace('greeting', `@${username} name ${JSON.stringify(profile.name ?? null)} → ${greeting.greetName ? `"${greeting.greetName}" (${greeting.basis})` : 'no name (none)'}`);

  const post = await fetchPostContext(mediaId);
  // The portal's customer panel links "Commented on" straight to the post, so
  // the operator can see what they reacted to instead of hunting by caption.
  if (post.permalink) setCollected(igsid, 'instagram.comment.link', post.permalink);
  // Gated workflows hold the code back: the opener OFFERS the promo and asks
  // for the contact field; the code is minted only when a valid one arrives.
  const workflow = activeWorkflow();
  const discount = workflow === 'off' && config.openerIncludesDiscount ? await ensureDiscount(igsid, username) : null;

  // The code is minted BEFORE the message is written, so everything the opener
  // says ("made you a code") is literally true by the time it sends.
  // A comment's private reply is ONE message by API rule — if the model wrote
  // multiple bubbles anyway, JOIN them instead of silently dropping the rest.
  const opener = toBubbles(
    await getDriver().composeOpener({
      profile, greeting, commentText: text, postCaption: post.caption, postImageUrl: post.imageUrl, discount,
      gate: workflow === 'off' ? null : workflow, featured: config.featuredQuery, percent: config.discountPercent,
    }),
  ).join(' ').slice(0, 950);
  if (!opener) { trace('error', `opener came back empty for comment ${commentId}`); return; }

  // Seed the thread with the comment/post context so every LATER turn of the
  // agent loop also knows how this conversation started.
  appendMessage(igsid, 'system',
    `context: this thread started when they commented "${text}" on the brand's post` +
    `${post.caption ? ` (post caption: "${post.caption.slice(0, 140)}")` : ''}. the next message is our private-reply opener.`);

  try {
    await sendPrivateReply(commentId, opener);
  } catch (err) {
    trace('error', `private reply failed for comment ${commentId}: ${err.message}`);
    return; // ledger keeps the claim — retrying a one-shot API blind is worse than an operator look
  }
  recordPrivateReplyText(commentId, opener);
  appendMessage(igsid, 'assistant', opener); // the opener is part of the thread's memory
  if (workflow !== 'off') setCollected(igsid, '_awaiting', workflow); // arm workflow 2
  trace('opener', `sent to @${username}: ${opener}`);

  // The Requests-folder problem: a private reply to a non-follower arrives
  // unnotified, where the minted discount would quietly expire.
  const follows = profile.is_user_follow_business === true;
  const nudge = config.publicNudge === 'always' || (config.publicNudge === 'non_followers' && !follows);
  if (nudge) {
    try {
      await replyToComment(commentId, config.publicNudgeText);
      trace('nudge', `public nudge posted under comment ${commentId} (${follows ? 'follower' : 'non-follower'})`);
    } catch (err) {
      trace('error', `public nudge failed for ${commentId} (opener already sent, continuing): ${err.message}`);
    }
  }
}

// Noise that should never earn a reply, even from an engaged customer: test
// strings, link spam, bare emoji. Ambiguity fails toward acknowledging — a
// warm reply to weak noise is cheaper than ignoring a real person.
function isNoiseComment(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return true;
  const words = t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.includes('test') || words.includes('testing')) return true;
  if (t.toLowerCase().includes('http://') || t.toLowerCase().includes('https://')) return true;
  if (words.join(' ').includes('follow back') || words.join(' ').includes('dm me') || words.join(' ').includes('check my page')) return true;
  const letters = t.replace(/[^a-z0-9]/gi, '');
  return letters.length === 0;
}

// The repeat-comment private reply: acknowledgment only. Same one-shot window
// and per-comment ledger as an opener; no discount minting, no gate arming.
async function deliverAcknowledgment({ commentId, igsid, username, text, mediaId, at }) {
  if (at && Date.now() - at > PRIVATE_REPLY_WINDOW_MS) {
    trace('window', `repeat comment ${commentId} is outside the 7-day private-reply window — skipping`);
    return;
  }
  if (!claimPrivateReply(commentId, igsid)) {
    trace('dedupe', `reply already sent for comment ${commentId}`);
    return;
  }
  const post = await fetchPostContext(mediaId);
  if (post.permalink) setCollected(igsid, 'instagram.comment.link', post.permalink);

  const existingCode = getDiscount(igsid);
  const message = toBubbles(
    await getDriver().composeContinuation({
      greetName: (getCollected(igsid, 'greeting.name') || '').trim() || null,
      commentText: text,
      postCaption: post.caption,
      alreadyHasCode: !!(existingCode && existingCode.expires_at > Date.now()),
      captured: !!(getCollected(igsid, 'phone') || getCollected(igsid, 'email')),
      awaitingField: getCollected(igsid, '_awaiting') || null,
    }),
  ).join(' ').slice(0, 950);
  if (!message) { trace('error', `acknowledgment came back empty for comment ${commentId}`); return; }
  // Deterministic honesty rail: an acknowledgment may NEVER carry an offer.
  // The model once synthesized "use code DEW for 15% off" out of a caption's
  // CTA — if anything offer-shaped survives the prompt, replace the whole
  // message with a safe template instead of sending an invented promise.
  const offerWords = /(code|discount|promo|percent|% ?off|[0-9]{1,2} ?%|expire)/i;
  const finalText = offerWords.test(message)
    ? `saw your new comment — glad it's hitting.`
    : message;
  if (finalText !== message) trace('guard', `acknowledgment for ${commentId} carried an offer — replaced with safe template`);

  try {
    await sendPrivateReply(commentId, finalText);
  } catch (err) {
    trace('error', `acknowledgment reply failed for comment ${commentId}: ${err.message}`);
    return;
  }
  recordPrivateReplyText(commentId, finalText);
  appendMessage(igsid, 'assistant', finalText);
  trace('opener', `acknowledged repeat comment from @${username}: ${finalText}`);
}
