// Checkpoint-level shipment telemetry. Shopify tells us a package shipped and
// hands over a tracking number; EasyPost turns that number into a live tracker
// object — status, ETA, and the carrier's actual scans ("departed usps regional
// facility, bell gardens, ca") — which is what lets the concierge answer
// "where's my order?" with a real location instead of "it's on the way".
//
// Without EASYPOST_API_KEY every call here degrades to a traced local
// simulation: a deterministic tracker id derived from the tracking code, so the
// whole pipeline (and scripts/simulate-shipment.mjs) still runs end to end.
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

const API = 'https://api.easypost.com/v2';

export const easypostEnabled = () => !!config.easypostApiKey;

// EasyPost uses HTTP basic auth with the API key as the username, no password.
const authHeader = () => 'Basic ' + Buffer.from(`${config.easypostApiKey}:`).toString('base64');

// The credential-free id. Derived from the tracking code so the simulator can
// address a tracker it never saw created, and namespaced 'trk_sim_' so a
// simulated row is never mistaken for a real EasyPost tracker.
export const simTrackerId = (code) =>
  'trk_sim_' + String(code || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();

// EasyPost's tracker → the handful of fields the shipment row and the agent
// actually use. Tracking details arrive oldest-first; the last one is "now".
export function normalizeTracker(t = {}) {
  const details = Array.isArray(t.tracking_details) ? t.tracking_details : [];
  const checkpoints = details.map((d) => ({
    status: d.status || '',
    message: d.message || d.description || d.status || '',
    city: d.tracking_location?.city || null,
    state: d.tracking_location?.state || null,
    country: d.tracking_location?.country || null,
    time: d.datetime || null,
  }));
  return {
    id: t.id || null,
    status: t.status || 'unknown',
    carrier: t.carrier || null,
    tracking_code: t.tracking_code || null,
    est_delivery_date: t.est_delivery_date || null,
    // EasyPost hosts a public tracking page per tracker — a better link to send
    // a customer than a carrier site that wants the number typed in again.
    public_url: t.public_url || null,
    latest: checkpoints.length ? checkpoints[checkpoints.length - 1] : null,
    checkpoints,
    simulated: !!t.simulated,
  };
}

// The credential-free tracker, as a function: the provider chain
// (src/shipping/provider.js) uses this as its terminal driver, so a simulated
// tracker looks identical whether it came from "no keys configured at all" or
// "every live feed just refused us". `reason` is what the trace says happened.
export function simulatedTracker(trackingCode, carrier, reason = 'EASYPOST_API_KEY unset') {
  const id = simTrackerId(trackingCode);
  trace('easypost', `${reason} — tracker for ${trackingCode} simulated locally as ${id}, no api call made`);
  return normalizeTracker({ id, status: 'pre_transit', carrier: carrier || null, tracking_code: trackingCode, simulated: true });
}

async function easypost(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(), ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) {
    // The status rides on the error: the provider chain tells "this key is
    // finished" (401/403/429 → fail the whole feed over) apart from "this one
    // package is bad" (everything else → this shipment's problem alone).
    const err = new Error(`easypost ${path} ${res.status}: ${body.slice(0, 300)}`);
    err.status = res.status;
    err.provider = 'easypost';
    throw err;
  }
  return JSON.parse(body);
}

// Start watching a tracking number. EasyPost then POSTs us a tracker.updated
// event on every new scan (see src/webhooks/easypost.js).
export async function createTracker(trackingCode, carrier) {
  if (!trackingCode) return null;
  if (!easypostEnabled()) return simulatedTracker(trackingCode, carrier);
  const json = await easypost('/trackers', {
    method: 'POST',
    body: JSON.stringify({ tracker: { tracking_code: trackingCode, carrier: carrier || undefined } }),
  });
  return normalizeTracker(json);
}

// The re-read that makes an unsigned webhook safe: we never believe an event
// body, we believe this.
export async function fetchTracker(id) {
  if (!easypostEnabled()) return null;
  return normalizeTracker(await easypost(`/trackers/${encodeURIComponent(id)}`));
}

// A link the customer can actually open. EasyPost's public_url is preferred
// (see applyTracker); this is the fallback when we only know carrier + code.
export function carrierTrackingUrl(carrier, code) {
  if (!code) return null;
  const c = String(carrier || '').toLowerCase();
  const q = encodeURIComponent(code);
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${q}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${q}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${q}`;
  if (c.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${q}`;
  // Unknown carrier: an aggregator resolves it from the number's own shape.
  return `https://www.trackingmore.com/track/en/${q}`;
}
