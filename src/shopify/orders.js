// Orders enter here — from the orders/create webhook — and the interesting work
// is the JOIN nobody gives us: Shopify knows an email and a phone, Instagram
// knows an igsid, and nothing connects them except the contact detail the
// capture gate already collected in the DM thread. That one match is what turns
// a checkout into a conversation the concierge can speak to.
import { extractPhone } from '../flows/phone-gate.js';
import { upsertOrder, getOrder, linkOrderToThread, findThreadByContact, setCollected } from '../store/db.js';
import { normalizeAddress } from './order-details.js';
import { trace } from '../sim/trace.js';

// Shopify scatters contact info across the order, the customer and both
// addresses. Normalize to EXACTLY the shapes the gate stores (E.164 phone,
// lowercase email) — matching is equality, so the normalizers must be the same
// ones, which is why the phone parser is imported rather than re-written.
export function normalizeOrder(o = {}) {
  const email = String(o.email || o.contact_email || o.customer?.email || '').trim().toLowerCase() || null;
  const rawPhone = o.phone || o.customer?.phone || o.shipping_address?.phone || o.billing_address?.phone || '';
  // The three detail fields are stored as JSON text, and ABSENT (undefined) is
  // not the same as EMPTY: a payload that carries `discount_codes: []` is
  // telling us no code was used, while a payload without the key at all leaves
  // the column NULL for the lazy Admin-API backfill to fill in later.
  // upsertOrder skips nulls, so a thin payload can never blank a fat one.
  const codes = Array.isArray(o.discount_codes)
    ? o.discount_codes.map((d) => (typeof d === 'string' ? d : d?.code)).filter(Boolean)
    : null;
  // Shipping only — a billing address is not "the address on file" for a
  // package, and answering with one would be a confident wrong answer.
  const address = normalizeAddress(o.shipping_address);
  const items = Array.isArray(o.line_items)
    ? o.line_items.slice(0, 10)
      .map((li) => ({ title: li.title || li.name || null, quantity: li.quantity ?? 1 }))
      .filter((li) => li.title)
    : null;
  return {
    id: String(o.id ?? ''),
    name: o.name || (o.order_number != null ? `#${o.order_number}` : null),
    email,
    phone: extractPhone(rawPhone),
    total: o.total_price != null ? String(o.total_price) : null,
    currency: o.currency || null,
    financial_status: o.financial_status || null,
    placed_at: o.created_at || null,
    discount_codes: codes ? JSON.stringify(codes) : null,
    shipping_address: address ? JSON.stringify(address) : null,
    line_items: items ? JSON.stringify(items) : null,
  };
}

export function ingestOrder(payload, { simulated = false, igsidHint = null } = {}) {
  const order = normalizeOrder(payload);
  if (!order.id) {
    trace('order', 'orders/create arrived without an id — ignored');
    return null;
  }
  upsertOrder(order.id, { ...order, simulated: simulated ? 1 : 0 });
  const detail = [
    order.discount_codes && `codes ${JSON.parse(order.discount_codes).join(',') || 'none'}`,
    order.shipping_address && `ships to ${JSON.parse(order.shipping_address).city || 'address on file'}`,
  ].filter(Boolean).join(' / ');
  trace('order', `order ${order.name || order.id} stored — ${order.email || 'no email'} / ${order.phone || 'no phone'}${order.total ? ` / ${order.total}` : ''}${detail ? ` / ${detail}` : ''}${simulated ? ' (simulated)' : ''}`);
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
