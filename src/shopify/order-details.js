// The order facts a customer actually asks about — "did i use the qr code?",
// "what address do you have on file?", "what did i even order?" — live on the
// order, not on the shipment. Two ways they get here:
//
//   1. the orders/create webhook carries them (discount_codes, shipping_address,
//      line_items) and src/shopify/orders.js normalizes them into the row;
//   2. for every order that predates that webhook — the store's whole existing
//      history, since the subscriptions were only registered today — they are
//      fetched LAZILY from the Admin GraphQL API the first time someone asks.
//
// Kept separate from orders.js on purpose: this module imports config, the
// store and the trace log and nothing else, so the agent's tool surface can
// pull it in without dragging the gate/DM machinery into the agent loop.
import { config } from '../config.js';
import {
  getOrder, upsertOrder, getCollected, setCollected,
  findUnlinkedOrdersByContact, linkOrderToThread,
} from '../store/db.js';
import { trace } from '../sim/trace.js';

const API_VERSION = '2025-07';
const FETCH_TIMEOUT_MS = 6000; // a customer is waiting on this reply

// One address shape, whatever the source spells it: webhook payloads are
// snake_case with first_name/last_name, GraphQL is camelCase with `name`.
export function normalizeAddress(a) {
  if (!a || typeof a !== 'object') return null;
  const full = [a.first_name ?? a.firstName, a.last_name ?? a.lastName].filter(Boolean).join(' ');
  const out = {
    name: a.name || full || null,
    address1: a.address1 || null,
    address2: a.address2 || null,
    city: a.city || null,
    province: a.province || a.provinceCode || a.province_code || null,
    zip: a.zip || null,
    country: a.country || a.countryCode || a.country_code || null,
  };
  return Object.values(out).some(Boolean) ? out : null;
}

// Tolerant JSON reads: a column is NULL (never looked), '[]'/'{}' (looked, and
// the answer is "none"), or a real payload. Callers get [] / null and never a
// thrown parse error.
const parseArray = (raw) => {
  if (raw == null) return null;
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch { return null; }
};
const parseObject = (raw) => {
  if (raw == null) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length ? v : null;
  } catch { return null; }
};

// What the tool reads. Separates "we know there were no codes" (an array) from
// "we have never looked" (null) so the agent can answer the first honestly.
export function orderDetails(row = {}) {
  return {
    discount_codes: parseArray(row.discount_codes),
    shipping_address: parseObject(row.shipping_address),
    line_items: parseArray(row.line_items),
  };
}

const needsDetails = (row) =>
  !!row && (row.discount_codes == null || row.shipping_address == null || row.line_items == null);

const ORDER_QUERY = `query($id: ID!) {
  order(id: $id) {
    name
    displayFinancialStatus
    discountCodes
    shippingAddress { name address1 address2 city province zip country }
    lineItems(first: 10) { nodes { title quantity } }
  }
}`;

const gid = (id) => (String(id).startsWith('gid://') ? String(id) : `gid://shopify/Order/${String(id).replace(/\D/g, '')}`);

// Lazy backfill for ONE order. Returns the row — hydrated if it could be,
// untouched if it could not. Never throws: an order we can't enrich still
// answers with everything the webhook gave us, and the gap is traced rather
// than guessed at.
export async function hydrateOrderDetails(id) {
  const row = getOrder(id);
  if (!row) return null;
  if (!needsDetails(row)) return row;

  const label = row.name || `#${row.id}`;
  const store = config.shopifyAdminStore || config.storeDomain;
  if (!config.shopifyOrdersToken || !store) {
    trace('order', `order ${label} details unavailable — SHOPIFY_ORDERS_TOKEN unset, answering only from what is already stored`);
    return row;
  }
  // A simulated (loopback) order exists in this database and nowhere else —
  // asking the real store about it would 404 on every single question.
  if (row.simulated) {
    trace('order', `order ${label} details unavailable — simulated order, there is nothing to fetch from ${store}`);
    return row;
  }

  try {
    const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.shopifyOrdersToken },
      body: JSON.stringify({ query: ORDER_QUERY, variables: { id: gid(row.id) } }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    if (json.errors?.length) throw new Error(JSON.stringify(json.errors).slice(0, 200));
    const o = json.data?.order;
    if (!o) {
      trace('order', `order ${label} details unavailable — ${store} returned no such order`);
      return row;
    }

    const codes = (o.discountCodes || []).filter(Boolean);
    const addr = normalizeAddress(o.shippingAddress);
    const items = (o.lineItems?.nodes || []).map((n) => ({ title: n.title, quantity: n.quantity }));
    upsertOrder(row.id, {
      name: row.name || o.name || null,
      financial_status: row.financial_status || (o.displayFinancialStatus || '').toLowerCase() || null,
      // '[]' and '{}' are deliberate: they record that we DID look and the
      // answer was "none", so the next question doesn't re-hit the API.
      discount_codes: JSON.stringify(codes),
      shipping_address: JSON.stringify(addr || {}),
      line_items: JSON.stringify(items),
    });
    trace('order', `order ${label} hydrated from the admin api — ${codes.length} code(s), ${items.length} item(s)${addr?.city ? `, ships to ${addr.city}` : ', no shipping address'}`);
    return getOrder(row.id);
  } catch (err) {
    trace('error', `order ${label} details fetch failed: ${err.message}`);
    return row;
  }
}

// The gate just captured an email or a phone. Any order already sitting in the
// table with that exact contact belongs to this conversation — link it NOW
// instead of waiting for the customer to place another order just so a webhook
// can do the same join. Matching is equality on the gate's own shapes (E.164
// phone, lowercased email), exactly as matchOrderToThread does it.
export function rematchStoredOrders(igsid) {
  const email = getCollected(igsid, 'email');
  const phone = getCollected(igsid, 'phone');
  if (!email && !phone) return null;

  const rows = findUnlinkedOrdersByContact({ email, phone });
  if (!rows.length) return null;

  for (const row of rows) {
    linkOrderToThread(row.id, igsid);
    trace('order', `REMATCH — stored order ${row.name || row.id} linked to thread ${igsid} on the ${email && row.email === email ? `email ${email}` : `phone ${phone}`} just captured`);
  }
  const newest = rows[0]; // same "most recent order" the tool answers about
  setCollected(igsid, 'order.name', newest.name || `#${newest.id}`);
  setCollected(igsid, 'order.id', newest.id);
  return newest;
}
