// Splits a VERIFIED webhook envelope into typed events and hands them to flows.
import { claimEvent } from '../store/db.js';
import { handleInboundDm } from '../flows/dm-reply.js';
import { handleNewComment } from '../flows/comment-to-dm.js';
import { trace } from '../sim/trace.js';

const toMs = (t) => (!t ? Date.now() : t < 1e12 ? t * 1000 : t); // Meta sends unix seconds

export async function routeWebhook(body) {
  for (const entry of body.entry || []) {
    for (const m of entry.messaging || []) {
      if (m.message?.is_echo) { trace('skip', 'echo of our own outbound message'); continue; }
      if (!m.message?.mid) { trace('skip', 'non-message event (read/delivery receipt)'); continue; }
      if (!claimEvent(m.message.mid)) { trace('dedupe', `duplicate delivery of ${m.message.mid} — ignored`); continue; }
      // Per-event isolation: one failing event must never eat the rest of the batch.
      try {
        await handleInboundDm({
          igsid: m.sender.id,
          text: m.message.text ?? '[the user sent an attachment]',
          at: toMs(m.timestamp),
        });
      } catch (err) {
        trace('error', `dm ${m.message.mid} failed (batch continues): ${err.message}`);
      }
    }
    for (const c of entry.changes || []) {
      if (c.field !== 'comments') { trace('skip', `unhandled change field: ${c.field}`); continue; }
      const v = c.value || {};
      if (!v.id || !v.from?.id) { trace('skip', 'comment payload missing id/author'); continue; }
      if (v.from.id === entry.id) { trace('skip', 'comment by the brand account itself — no self-loops'); continue; }
      if (!claimEvent(`comment:${v.id}`)) { trace('dedupe', `duplicate delivery of comment ${v.id} — ignored`); continue; }
      try {
        await handleNewComment({
          commentId: v.id,
          igsid: v.from.id,
          username: v.from.username || '',
          text: v.text || '',
          mediaId: v.media?.id || '',
          at: toMs(entry.time),
        });
      } catch (err) {
        trace('error', `comment ${v.id} failed (batch continues): ${err.message}`);
      }
    }
  }
}
