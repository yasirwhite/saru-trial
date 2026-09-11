// The unprompted half of shipment tracking: three moments in a package's life
// that earn a DM nobody asked for. Everything about this file is a rail — the
// gates below decide whether we're ALLOWED to send, and the offer guard decides
// whether what the model wrote is safe to send.
import { getCollected, appendMessage, claimMilestone } from '../store/db.js';
import { getDriver } from '../agent/llm.js';
import { conversationMode } from './workflow-settings.js';
import { withinMessagingWindow } from './dm-reply.js';
import { sendDm } from '../instagram/send.js';
import { trace } from '../sim/trace.js';

// The fallback message per milestone: true, plain, and structurally incapable
// of promising anything. Same pattern as deliverAcknowledgment's safe template.
const SAFE = {
  in_transit: (o) => `${o} is on its way`,
  out_for_delivery: (o) => `${o} is out for delivery today`,
  delivered: (o) => `${o} just got delivered — hope it's everything you wanted`,
};

// An unprompted DM must never carry an offer: the model has been caught
// synthesizing "use code X for 15% off" out of surrounding context, and a
// promise nobody minted is worse than a boring message.
const OFFER_WORDS = /(code|discount|promo|percent|% ?off|[0-9]{1,2} ?%|expire)/i;

export async function sendMilestoneDm({ shipment, order, milestone }) {
  const name = order?.name || (order?.id ? `#${order.id}` : 'your order');
  const igsid = order?.igsid;

  // Gate 1 — is there anyone to tell? An order nobody matched to a thread is a
  // perfectly good order; it just isn't a conversation.
  if (!igsid) {
    trace('shipment', `${milestone} for ${shipment?.tracking_code || shipment?.id} — order ${name} is linked to no instagram thread, no dm`);
    return false;
  }
  // Gate 2 — a human operator holding the thread owns ALL outbound. A bot
  // interrupting mid-takeover is exactly the failure the portal exists to stop.
  if (conversationMode(igsid) === 'human') {
    trace('mode', `human mode for ${igsid} — ${milestone} dm skipped, the operator owns this thread`);
    return false;
  }
  // Gate 3 — Meta's 24-hour rule. Outside the window this send is simply
  // illegal, and a window check that throws must not take the pipeline with it.
  let open = false;
  try {
    open = withinMessagingWindow(igsid);
  } catch (err) {
    trace('error', `messaging window check failed for ${igsid}: ${err.message}`);
  }
  if (!open) {
    trace('window', `24h messaging window closed for ${igsid} — ${milestone} dm skipped for ${name}`);
    return false;
  }
  // Gate 4 — once per shipment per milestone, forever. Claimed BEFORE the send
  // (like the private-reply ledger): a blind retry of an unprompted DM is worse
  // than a missed one, and the trace says exactly what happened either way.
  if (!claimMilestone(shipment.id, milestone)) {
    trace('dedupe', `${milestone} dm already sent for shipment ${shipment.id}`);
    return false;
  }

  let text = '';
  try {
    text = String(await getDriver().composeShipmentDm({
      milestone,
      orderName: name,
      carrier: shipment.carrier,
      trackingCode: shipment.tracking_code,
      latest: { message: shipment.last_message, city: shipment.last_city, state: shipment.last_state, time: shipment.last_time },
      eta: shipment.est_delivery_date,
      greetName: (getCollected(igsid, 'greeting.name') || '').trim() || null,
    }) || '').trim();
  } catch (err) {
    trace('error', `shipment dm compose failed for ${igsid}: ${err.message}`);
  }
  // One message, one line — a proactive DM is a notification, not a thread.
  text = text.replace(/\s*\n+\s*/g, ' ').slice(0, 280).trim();

  if (!text || OFFER_WORDS.test(text)) {
    if (text) trace('guard', `${milestone} dm carried an offer — replaced with the safe template`);
    text = SAFE[milestone] ? SAFE[milestone](name) : `${name} — there's an update on your shipment`;
  }

  try {
    await sendDm(igsid, text);
  } catch (err) {
    trace('error', `${milestone} dm send failed for ${igsid}: ${err.message}`);
    return false;
  }
  // Part of the thread's memory, so the next agent turn knows we already told
  // them — and so the portal transcript shows the customer's whole story.
  appendMessage(igsid, 'assistant', text);
  trace('shipment', `${milestone} dm → ${igsid}: ${text}`);
  return true;
}
