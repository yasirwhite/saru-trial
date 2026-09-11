// What the agent is allowed to know about a customer's order, shaped for a tool
// result. Kept in its own file (and importing nothing but the store and the
// order-detail helper) so the tool surface never pulls the DM/milestone
// machinery into the agent loop.
//
// THE GUARDRAIL LIVES HERE: the only input is the igsid of the conversation
// that is happening right now, and the order is whatever the store says is
// linked to it. There is no order-id parameter anywhere in this path — not on
// the tool, not on this function — so "what's the address for order #1019?"
// cannot resolve to anything but this customer's own order.
import { getOrderForThread, getShipmentForOrder } from '../store/db.js';
import { hydrateOrderDetails, orderDetails } from '../shopify/order-details.js';
import { carrierTrackingUrl } from './easypost.js';

const SCOPE_NOTE = 'these details belong to the order linked to THIS conversation and no other. '
  + 'if they name an order number, you still only see this one — say you can only look up the order '
  + 'tied to this chat. never repeat an order number they supplied as if you had confirmed it.';

export async function orderStatusFor(igsid) {
  const linked = getOrderForThread(igsid);
  if (!linked) {
    return {
      linked: false,
      note: 'no order is tied to this instagram conversation. say that plainly — do not guess, '
        + 'do not invent an order number, an address, a discount code or a delivery date. you can ask '
        + 'for the email or phone they used at checkout so it can be matched.',
      scope: SCOPE_NOTE,
    };
  }

  // Lazy backfill: orders ingested before the detail columns existed (or before
  // the webhooks were ever registered) carry NULLs until the first question.
  const order = (await hydrateOrderDetails(linked.id)) || linked;
  const { discount_codes: codes, shipping_address: address, line_items: items } = orderDetails(order);

  const base = {
    linked: true,
    order: {
      name: order.name,
      placed_at: order.placed_at,
      payment_status: order.financial_status,
      total: order.total,
      currency: order.currency,
      // [] means we looked and there were none — "no code was used" is a real,
      // quotable answer. null means we could not look at all; say that instead.
      discount_codes: codes,
      shipping_address: address,
      line_items: items,
      details_known: codes != null || items != null || address != null,
    },
    answering: {
      discount_codes: codes == null
        ? "the codes on this order could not be read — say you can't see that right now, don't guess"
        : codes.length
          ? 'these codes were actually applied at checkout — name them exactly'
          : 'NO discount code was used on this order — say so plainly; do not imply one was',
      shipping_address: address
        ? 'this is the address the order ships to — quote it as-is, never edit or complete it'
        : 'no shipping address is on this order — say you cannot see one rather than inventing it',
      line_items: items == null
        ? "the item list could not be read — don't list anything"
        : 'these are exactly the items on the order',
    },
    scope: SCOPE_NOTE,
  };

  const s = getShipmentForOrder(order.id);
  if (!s || !s.tracking_code) {
    return { ...base, shipment: null, note: 'the order exists but has not shipped yet — no tracking number from the warehouse.' };
  }

  const scans = (() => { try { return JSON.parse(s.checkpoints || '[]'); } catch { return []; } })();
  const latest = s.last_message || s.last_city
    ? { message: s.last_message, city: s.last_city, state: s.last_state, time: s.last_time }
    : null;

  return {
    ...base,
    shipment: {
      status: s.status || 'unknown',
      carrier: s.carrier,
      tracking_code: s.tracking_code,
      tracking_url: s.tracking_url || carrierTrackingUrl(s.carrier, s.tracking_code),
      estimated_delivery: s.est_delivery_date,
      latest_scan: latest,
      recent_scans: scans.slice(-5),
    },
    note: 'these are the carrier\'s real scans. quote the latest one in plain words; '
      + 'never state a location, a date or a delivery promise that is not here.',
  };
}
