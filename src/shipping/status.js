// What the agent is allowed to know about a customer's order, shaped for a tool
// result. Kept in its own file (and importing nothing but the store) so the
// tool surface never pulls the DM/milestone machinery into the agent loop.
import { getOrderForThread, getShipmentForOrder } from '../store/db.js';
import { carrierTrackingUrl } from './easypost.js';

export function orderStatusFor(igsid) {
  const order = getOrderForThread(igsid);
  if (!order) {
    return {
      linked: false,
      note: 'no order is tied to this instagram conversation. say that plainly — do not guess, '
        + 'do not invent an order number or a delivery date. you can ask for the email or phone '
        + 'they used at checkout so it can be matched.',
    };
  }

  const base = {
    linked: true,
    order: {
      name: order.name,
      placed_at: order.placed_at,
      payment_status: order.financial_status,
      total: order.total,
      currency: order.currency,
    },
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
