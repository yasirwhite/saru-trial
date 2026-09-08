// The flagship: comment webhook → profile fetch → (discount mint) → LLM-composed
// opener → the ONE private reply that comment entitles us to → and from there
// the thread flows into the same agent loop as any DM.
import { config } from '../config.js';
import { upsertThread, claimPrivateReply, recordPrivateReplyText, appendMessage } from '../store/db.js';
import { fetchProfile, fetchPostContext } from '../instagram/profile.js';
import { ensureDiscount } from '../shopify/discounts.js';
import { getDriver } from '../agent/llm.js';
import { toBubbles } from '../agent/shorten.js';
import { sendPrivateReply, replyToComment } from '../instagram/send.js';
import { trace } from '../sim/trace.js';

const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;

export async function handleNewComment(evt) {
  trace('webhook', `comment ${evt.commentId} by @${evt.username}: ${evt.text}`);
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
  const post = await fetchPostContext(mediaId);
  const discount = config.openerIncludesDiscount ? await ensureDiscount(igsid, username) : null;

  // The code is minted BEFORE the message is written, so everything the opener
  // says ("made you a code") is literally true by the time it sends.
  const opener = toBubbles(
    await getDriver().composeOpener({
      profile, commentText: text, postCaption: post.caption, postImageUrl: post.imageUrl, discount,
    }),
  )[0];
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
