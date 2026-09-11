// The shipment half of the pipeline: a Shopify fulfillment becomes an EasyPost
// tracker, and every tracker update becomes a row the agent can quote and —
// on the three moments that matter — one unprompted DM.
import {
  upsertShipment, getShipment, getShipmentByTracker, getShipmentByTrackingCode, getOrder,
} from '../store/db.js';
import { createTracker, carrierTrackingUrl } from './easypost.js';
import { sendMilestoneDm } from '../flows/shipment-dm.js';
import { trace } from '../sim/trace.js';

// The only statuses worth interrupting someone for. Everything else EasyPost
// reports (pre_transit, available_for_pickup, return_to_sender, failure,
// unknown) updates the row silently and waits to be asked about.
const MILESTONES = {
  in_transit: 'in_transit',
  out_for_delivery: 'out_for_delivery',
  delivered: 'delivered',
};

// fulfillments/create and fulfillments/update land here. Both are idempotent:
// the same fulfillment arriving twice updates the row and does NOT mint a
// second tracker for a tracking code we're already watching.
export async function ingestFulfillment(payload = {}, { simulated = false } = {}) {
  const id = String(payload.id ?? '');
  const orderId = String(payload.order_id ?? '');
  if (!id || !orderId) {
    trace('shipment', 'fulfillment payload had no id/order_id — ignored');
    return null;
  }
  const code = payload.tracking_number || (payload.tracking_numbers || [])[0] || null;
  const carrier = payload.tracking_company || null;
  const shopUrl = payload.tracking_url || (payload.tracking_urls || [])[0] || null;
  const known = getShipment(id);

  upsertShipment(id, {
    order_id: orderId,
    tracking_code: code,
    carrier,
    tracking_url: shopUrl || carrierTrackingUrl(carrier, code),
    status: known?.status || 'pre_transit',
  });
  trace('shipment', `fulfillment ${id} on order ${orderId} — ${carrier || 'carrier unknown'} ${code || 'no tracking number yet'}${simulated ? ' (simulated)' : ''}`);

  // A fulfillment can be created before the warehouse has a label; the
  // tracking number then arrives on a later fulfillments/update.
  if (!code) return getShipment(id);
  if (known?.tracker_id && known.tracking_code === code) {
    trace('shipment', `tracker ${known.tracker_id} already watching ${code} — no second tracker`);
    return getShipment(id);
  }

  try {
    const tracker = await createTracker(code, carrier);
    if (tracker) {
      upsertShipment(id, {
        tracker_id: tracker.id,
        carrier: tracker.carrier || carrier,
        status: tracker.status || known?.status || 'pre_transit',
        est_delivery_date: tracker.est_delivery_date,
        tracking_url: tracker.public_url || shopUrl || carrierTrackingUrl(tracker.carrier || carrier, code),
      });
      trace('shipment', `easypost tracker ${tracker.id} watching ${code}${tracker.simulated ? ' (simulated)' : ''}`);
    }
  } catch (err) {
    // A tracker we failed to create is a shipment we can't narrate — but the
    // order and the tracking number are already stored, so the agent can still
    // answer with what Shopify told us. Never throw back at the webhook.
    trace('error', `easypost tracker create failed for ${code}: ${err.message}`);
  }
  return getShipment(id);
}

// The single write path for tracker truth. `t` is ALWAYS a normalized tracker
// that came from the EasyPost API (or, credential-free, from a loopback
// simulation) — never an unverified webhook body.
export async function applyTracker(t = {}) {
  const row = (t.id && getShipmentByTracker(t.id))
    || (t.tracking_code && getShipmentByTrackingCode(t.tracking_code))
    || null;
  if (!row) {
    trace('shipment', `tracker ${t.id || t.tracking_code || '(unidentified)'} belongs to no shipment we created — ignored`);
    return null;
  }
  // First event for a tracker we only knew by tracking code (or a tracker id
  // that changed because the label was re-cut).
  if (t.id && row.tracker_id !== t.id) upsertShipment(row.id, { tracker_id: t.id });

  const prev = row.status || null;
  upsertShipment(row.id, {
    status: t.status,
    est_delivery_date: t.est_delivery_date,
    carrier: t.carrier || row.carrier,
    tracking_url: t.public_url || row.tracking_url || carrierTrackingUrl(t.carrier || row.carrier, row.tracking_code),
    last_message: t.latest?.message ?? null,
    last_city: t.latest?.city ?? null,
    last_state: t.latest?.state ?? null,
    last_time: t.latest?.time ?? null,
    checkpoints: JSON.stringify(t.checkpoints || []),
  });

  const where = t.latest?.city ? ` @ ${t.latest.city}${t.latest.state ? `, ${t.latest.state}` : ''}` : '';
  trace('shipment', `${row.tracking_code || row.id} ${prev || '—'} → ${t.status}${where}${t.latest?.message ? ` (${t.latest.message})` : ''}`);

  // TRANSITIONS only. A package sitting in_transit for four days produces
  // dozens of scans and exactly one "it's on its way" DM.
  if (t.status && t.status !== prev && MILESTONES[t.status]) {
    await sendMilestoneDm({
      shipment: getShipment(row.id),
      order: getOrder(row.order_id),
      milestone: MILESTONES[t.status],
    }).catch((err) => trace('error', `milestone dm failed: ${err.message}`));
  }
  return getShipment(row.id);
}
