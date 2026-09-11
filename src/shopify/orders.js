// Orders enter here — from the orders/create webhook — and the interesting work
// is the JOIN nobody gives us: Shopify knows an email and a phone, Instagram
// knows an igsid, and nothing connects them except the contact detail the
// capture gate already collected in the DM thread. That one match is what turns
// a checkout into a conversation the concierge can speak to.
import { extractPhone } from '../flows/phone-gate.js';
import { upsertOrder, getOrder, linkOrderToThread, findThreadByContact, setCollected } from '../store/db.js';
import { trace } from '../sim/trace.js';

// Shopify scatters contact info across the order, the customer and both
// addresses. Normalize to EXACTLY the shapes the gate stores (E.164 phone,
// lowercase email) — matching is equality, so the normalizers must be the same
// ones, which is why the phone parser is imported rather than re-written.
export function normalizeOrder(o = {}) {
  const email = String(o.email || o.contact_email || o.customer?.email || '').trim().toLowerCase() || null;
  const rawPhone = o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || '';
  return {
    id: String(o.id ?? ''),
    name: o.name || (o.order_number != null ? `#${o.order_number}` : null),
    email,
    phone: extractPhone(rawPhone),
    total: o.total_price != null ? String(o.total_price) : null,
    currency: o.currency || null,
    financial_status: o.financial_status || null,
    placed_at: o.created_at || null,
  };
}

export function ingestOrder(payload, { simulated = false, igsidHint = null } = {}) {
  const order = normalizeOrder(payload);
  if (!order.id) {
    trace('order', 'orders/create arrived without an id — ignored');
    return null;
  }
  upsertOrder(order.id, { ...order, simulated: simulated ? 1 : 0 });
  trace('order', `order ${order.name || order.id} stored — ${order.email || 'no email'} / ${order.phone || 'no phone'}${order.total ? ` / ${order.total}` : ''}${simulated ? ' (simulated)' : ''}`);
  matchOrderToThread(order, { igsidHint: simulated ? igsidHint : null });
  return getOrder(order.id);
}

// Link an order to the DM thread that belongs to the same human.
//
// `igsidHint` is a DEMO-ONLY shortcut, honored only for simulated (loopback)
// orders: scripts/simulate-shipment.mjs --igsid names the thread directly so a
// walkthrough works against a thread whose contact detail we don't want to
// retype. Real Shopify traffic can never set it.
export function matchOrderToThread(order, { igsidHint = null } = {}) {
  const existing = getOrder(order.id);
  if (existing?.igsid) return existing.igsid; // linked once, never re-pointed

  const hit = igsidHint
    ? { igsid: igsidHint, field: 'simulation', value: igsidHint }
    : findThreadByContact({ email: order.email, phone: order.phone });

  if (!hit) {
    trace('order', `order ${order.name || order.id} matches no instagram thread — ${order.email || '—'} / ${order.phone || '—'} is not in captured contacts`);
    return null;
  }

  linkOrderToThread(order.id, hit.igsid);
  // Deliberately setCollected, not remember(): the Kosha bridge already mirrors
  // every collected field into the portal, so the operator sees the order number
  // on the customer card without this file knowing the portal exists.
  setCollected(hit.igsid, 'order.name', order.name || `#${order.id}`);
  setCollected(hit.igsid, 'order.id', order.id);
  trace('order', `MATCH — order ${order.name || order.id} linked to thread ${hit.igsid} on ${hit.field} ${hit.value}`);
  return hit.igsid;
}
