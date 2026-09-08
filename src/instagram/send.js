// The only outbound path to a customer, for both message kinds Instagram
// allows us: a DM into an open thread, and the single private reply a comment
// entitles us to.
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

async function metaSend(recipient, text) {
  const res = await fetch(`${config.graphBase}/${config.igId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.igAccessToken}`,
    },
    body: JSON.stringify({ recipient, message: { text } }),
  });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(`send failed ${res.status}: ${bodyText.slice(0, 300)}`);
  return bodyText;
}

async function simSend(kind, to, text) {
  await fetch(`http://127.0.0.1:${config.port}/sim/outbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, to, text }),
  });
}

export async function sendDm(igsid, text) {
  trace('send', `dm → ${igsid}: ${text}`);
  if (config.transport === 'meta') return metaSend({ id: igsid }, text);
  return simSend('dm', igsid, text);
}

export async function sendPrivateReply(commentId, text) {
  trace('send', `private reply → comment ${commentId}: ${text}`);
  if (config.transport === 'meta') return metaSend({ comment_id: commentId }, text);
  return simSend('private_reply', commentId, text);
}

// Conversational body language: read receipts and typing indicators. Failures
// here are cosmetic and never block a reply.
export async function sendSenderAction(igsid, action) {
  if (config.transport === 'meta') {
    try {
      const res = await fetch(`${config.graphBase}/${config.igId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.igAccessToken}` },
        body: JSON.stringify({ recipient: { id: igsid }, sender_action: action }),
      });
      if (!res.ok) trace('error', `sender_action ${action} failed: ${(await res.text()).slice(0, 120)}`);
    } catch (err) {
      trace('error', `sender_action ${action} failed: ${err.message}`);
    }
    return;
  }
  if (action === 'typing_on') return simSend('typing', igsid, '');
}

// A PUBLIC reply under the comment — the visible half of the flagship flow.
export async function replyToComment(commentId, text) {
  trace('send', `public comment reply → ${commentId}: ${text}`);
  if (config.transport === 'meta') {
    const res = await fetch(`${config.graphBase}/${commentId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.igAccessToken}` },
      body: JSON.stringify({ message: text }),
    });
    if (!res.ok) throw new Error(`comment reply failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  return simSend('comment_reply', commentId, text);
}
