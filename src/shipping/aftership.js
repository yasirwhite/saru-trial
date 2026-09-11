// The second scan feed, behind the same interface as src/shipping/easypost.js.
//
// AfterShip watches a tracking number across ~2,000 couriers and reports the
// carrier's own checkpoints — "arrived at usps facility, bell gardens, ca" —
// which is the whole point: the concierge answers "where's my package?" with a
// real city instead of a shrug.
//
// SHAPE NOTE (verified against the live 2025-07 API, not the 2024-04 docs):
// POST /trackings takes a FLAT body — {tracking_number, slug} — and returns
// {meta:{code:201}, data:{...tracking}}. The older {tracking:{...}} envelope is
// rejected with meta.code 4007 "`tracking_number` is required".
import { config } from '../config.js';
import { carrierTrackingUrl } from './easypost.js';
import { trace } from '../sim/trace.js';

export const aftershipEnabled = () => !!config.aftershipApiKey;

// AfterShip's tag vocabulary → the status vocabulary the shipment row, the
// milestone detector (src/shipping/shipments.js) and the agent already speak.
// Pending/InfoReceived collapse to pre_transit because "label made" and "we've
// heard about it" are the same fact to a customer. The three failure tags keep
// their own names: "exception" and "attempt_fail" are answers worth quoting,
// and flattening them into a milestone word would fire a DM that lies.
export const TAG_STATUS = {
  Pending: 'pre_transit',
  InfoReceived: 'pre_transit',
  InTransit: 'in_transit',
  OutForDelivery: 'out_for_delivery',
  Delivered: 'delivered',
  AvailableForPickup: 'available_for_pickup',
  AttemptFail: 'attempt_fail',
  Exception: 'exception',
  Expired: 'expired',
};
export const statusOf = (tag) => TAG_STATUS[tag] || 'unknown';

// Carrier name (what Shopify's tracking_company says) → AfterShip courier slug,
// for the four that cover almost all US DTC volume. Anything else gets NO slug
// and AfterShip detects the courier from the number's own shape — which is the
// better answer for a long tail of 2,000 couriers we'd otherwise guess wrong.
export function carrierSlug(carrier) {
  const c = String(carrier || '').toLowerCase();
  if (!c) return null;
  if (c.includes('usps') || c.includes('united states postal')) return 'usps';
  if (c.includes('fedex') || c.includes('federal express')) return 'fedex';
  if (c.includes('dhl')) return 'dhl';
  if (/\bups\b/.test(c) || c === 'ups') return 'ups';
  return null;
}

// The reverse trip, for display. A row that says "usps" reads like a database;
// the DM should say USPS. Unknown slugs pass through untouched — an honest
// "yanwen" beats a prettified guess.
const COURIER_NAMES = { usps: 'USPS', ups: 'UPS', fedex: 'FedEx', dhl: 'DHL' };
export const courierName = (slug) => COURIER_NAMES[String(slug || '').toLowerCase()] || slug || null;

// AfterShip reports an ETA in up to six places, from six different sources.
// Most specific / most current first; `latest_estimated_delivery` is the
// courier's own revision and outranks the one it promised on day one.
function estDelivery(t = {}) {
  const pick = (v) => (typeof v === 'string' ? v : v?.datetime || v?.estimated_delivery_date || null);
  return pick(t.latest_estimated_delivery)
    || pick(t.courier_estimated_delivery_date)
    || pick(t.first_estimated_delivery)
    || pick(t.aftership_estimated_delivery_date)
    || pick(t.custom_estimated_delivery_date)
    || pick(t.order_promised_delivery_date)
    || null;
}

// A link the customer can actually open. AfterShip only fills its hosted
// tracking urls when the account has a branded tracking page configured, and
// `courier_tracking_link` degrades to the generic courier directory for
// couriers with no deep link — which is a dead end, not a tracking page. Both
// of those fall through to the carrier url we already build ourselves.
const DEAD_ENDS = /^https:\/\/(www\.)?aftership\.com\/couriers\/?$/i;
function publicUrl(t = {}) {
  for (const u of [t.aftership_tracking_url, t.aftership_tracking_order_url, t.courier_redirect_link, t.courier_tracking_link]) {
    if (u && !DEAD_ENDS.test(String(u).trim())) return u;
  }
  return carrierTrackingUrl(courierName(t.slug) || t.slug, t.tracking_number);
}

// AfterShip's tracking object → the EXACT normalized shape applyTracker
// consumes. Every field here has a counterpart in normalizeTracker(), because
// the single write path downstream must not know or care which feed it came
// from. Checkpoints arrive oldest-first; the last one is "now".
export function normalizeTracking(t = {}) {
  const raw = Array.isArray(t.checkpoints) ? t.checkpoints : [];
  let checkpoints = raw.map((c) => ({
    status: statusOf(c.tag),
    message: c.message || c.subtag_message || c.tag || '',
    city: c.city || null,
    state: c.state || null,
    country: c.country_region || c.country_region_name || null,
    time: c.checkpoint_time || c.created_at || null,
  }));
  // Defensive only: the API documents and delivers oldest-first, but `latest`
  // decides what the customer is told, so it must not hang on that. Sorting is
  // skipped unless every timestamp parses, and V8's sort is stable, so scans
  // sharing a timestamp keep the carrier's own order.
  const stamps = checkpoints.map((c) => Date.parse(c.time));
  if (stamps.length > 1 && stamps.every((n) => Number.isFinite(n))) {
    checkpoints = checkpoints
      .map((c, i) => ({ c, at: stamps[i] }))
      .sort((a, b) => a.at - b.at)
      .map((x) => x.c);
  }

  return {
    id: t.id || null,
    status: statusOf(t.tag),
    carrier: courierName(t.slug),
    tracking_code: t.tracking_number || null,
    est_delivery_date: estDelivery(t),
    public_url: publicUrl(t),
    latest: checkpoints.length ? checkpoints[checkpoints.length - 1] : null,
    checkpoints,
    provider: 'aftership',
    simulated: false,
  };
}

// Errors carry the HTTP status and AfterShip's own meta.code so the provider
// chain can tell "this key is dead" (401/403/429 → fail over to the next feed)
// apart from "this one number was bad" (4xx → this shipment's problem alone).
function apiError(path, status, code, body) {
  const err = new Error(`aftership ${path} ${status}${code ? `/${code}` : ''}: ${String(body).slice(0, 300)}`);
  err.status = status;
  err.code = code || null;
  err.provider = 'aftership';
  return err;
}

async function aftership(path, init = {}) {
  const res = await fetch(`${config.aftershipApiBase}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      // AfterShip's own header, not Authorization — a Bearer token here 401s.
      'as-api-key': config.aftershipApiKey,
      ...(init.headers || {}),
    },
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* non-json error page */ }
  // AfterShip mirrors the status into meta.code and sometimes answers 200 with
  // a failure code in the body, so both halves are checked.
  const metaCode = json?.meta?.code ?? null;
  if (!res.ok || (metaCode && metaCode >= 400)) throw apiError(path, res.status, metaCode, body);
  return json;
}

// Start watching a tracking number. AfterShip accepts a number the courier has
// not scanned yet and parks it on tag 'Pending', which is exactly what we want:
// the warehouse creates the label before the truck ever sees the box.
export async function createTracker(trackingCode, carrier) {
  if (!trackingCode) return null;
  const slug = carrierSlug(carrier);
  const json = await aftership('/trackings', {
    method: 'POST',
    // FLAT body — see the shape note at the top of this file.
    body: JSON.stringify({ tracking_number: trackingCode, ...(slug ? { slug } : {}) }),
  });
  const t = json?.data || {};
  trace('aftership', `tracking ${t.id} watching ${trackingCode}${slug ? ` (${slug})` : ' (courier auto-detected)'} — ${t.tag || 'no tag yet'}`);
  return normalizeTracking(t);
}

// The re-read that makes an unsigned (or unverifiable) webhook safe: we never
// believe an event body, we believe this. Addressable by AfterShip id, or by
// tracking number + slug for a tracker whose id we never stored.
export async function fetchTracking(ref) {
  if (!ref) return null;
  const path = typeof ref === 'string'
    ? `/trackings/${encodeURIComponent(ref)}`
    : `/trackings/${encodeURIComponent(ref.slug || '')}/${encodeURIComponent(ref.tracking_number || '')}`;
  const json = await aftership(path);
  return normalizeTracking(json?.data || {});
}

// Stop watching. Used when a shipment is done with (and by the live-proof
// script, so probing the API never leaves litter in the account).
export async function deleteTracking(id) {
  if (!id) return null;
  const json = await aftership(`/trackings/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return json?.meta?.code ?? 200;
}
