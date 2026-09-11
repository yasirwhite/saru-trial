// WHICH scan feed owns a package — and what happens when that feed stops
// answering.
//
// This is a CHAIN, not a switch. Ordered by the credentials that exist:
//
//   aftership  (AFTERSHIP_API_KEY)  → easypost  (EASYPOST_API_KEY)  → simulated
//
// Every driver in it presents the identical surface — createTracker(code,
// carrier) and fetchTracking(ref), both returning the normalized tracker
// applyTracker() consumes — so adding a 17TRACK driver next sprint is a new
// file and one line in DRIVERS, and nothing downstream learns a new shape.
//
// FAILOVER RULE: only an auth/quota refusal (401/402/403/429, or AfterShip's
// in-body meta.code equivalent) takes a feed out of the rotation. Those mean
// "this key is finished" — every package on it is affected, so we say so loudly
// and move the whole feed. A 500 or a malformed tracking number is that ONE
// shipment's problem and is thrown back to the caller, because parking a
// healthy feed over one bad package would be the worse outage.
import { config } from '../config.js';
import * as aftership from './aftership.js';
import * as easypost from './easypost.js';
import { simulatedTracker } from './easypost.js';
import { trace } from '../sim/trace.js';

// How long a dead feed stays out before it gets another chance. A revoked key
// gets restored, a quota window rolls over — ops should not have to bounce the
// process to pick that up.
const RETRY_MS = 30 * 60 * 1000;

// The statuses that mean the CREDENTIAL is the problem, not the package.
const FATAL = new Set([401, 402, 403, 429]);

// The capability console's sim child seeds invented orders and tracking
// numbers. Those must never be filed against a real carrier account — a fake
// number registered on the live AfterShip account is litter someone has to go
// delete, and a fictional package is not what a production feed is for. The
// child already blanks EASYPOST_API_KEY by name; this holds the same line for
// every driver in the chain, including the ones added after it.
const liveFeedsAllowed = () => !config.consoleChild;

const DRIVERS = {
  aftership: {
    name: 'aftership',
    configured: () => liveFeedsAllowed() && !!config.aftershipApiKey,
    createTracker: (code, carrier) => aftership.createTracker(code, carrier),
    fetchTracking: (ref) => aftership.fetchTracking(ref),
  },
  easypost: {
    name: 'easypost',
    configured: () => liveFeedsAllowed() && !!config.easypostApiKey,
    createTracker: (code, carrier) => easypost.createTracker(code, carrier),
    fetchTracking: (ref) => easypost.fetchTracker(typeof ref === 'string' ? ref : ref?.id),
  },
  // The terminal link, always present and incapable of failing: a deterministic
  // local tracker so the pipeline (and scripts/simulate-shipment.mjs) still runs
  // end to end with no credentials at all. It has nothing to re-read against,
  // so fetchTracking is null by design — a caller that gets null must fall back
  // to what it already stored rather than trusting an event body.
  simulated: {
    name: 'simulated',
    configured: () => true,
    createTracker: async (code, carrier, reason) => simulatedTracker(code, carrier, reason),
    fetchTracking: async () => null,
  },
};

// name → { healthy, lastError, status, since }. In-process on purpose: this is
// a liveness observation, not a fact about the world, and a restart should
// re-probe rather than inherit a stale verdict.
const health = new Map();

export function isFatal(err) {
  const status = Number(err?.status);
  const code = Number(err?.code);
  if (FATAL.has(status)) return true;
  if (FATAL.has(code)) return true;
  // AfterShip also namespaces in-body codes (4xx1, 4xx3, …) off the http class.
  if (Number.isFinite(code) && code >= 4000 && FATAL.has(Math.floor(code / 10))) return true;
  return false;
}

function usable(name) {
  const h = health.get(name);
  if (!h || h.healthy) return true;
  if (Date.now() - h.since >= RETRY_MS) {
    // Back into rotation on probation: the next call IS the re-probe, and a
    // second refusal simply marks it down again with a fresh clock.
    health.set(name, { ...h, healthy: true, since: 0 });
    trace('shipping', `provider ${name} has been down ${Math.round(RETRY_MS / 60000)}m — re-probing it on this call`);
    return true;
  }
  return false;
}

function markHealthy(name) {
  const h = health.get(name);
  if (h && !h.healthy) trace('shipping', `provider ${name} answered again — back in the rotation`);
  // A success clears the error too: ops should not be reading last week's 403.
  if (h) health.set(name, { healthy: true, lastError: null, status: null, since: 0 });
}

function markDown(name, err, nextName) {
  health.set(name, {
    healthy: false,
    lastError: err?.message ? String(err.message).slice(0, 300) : String(err),
    status: Number(err?.status) || Number(err?.code) || null,
    since: Date.now(),
  });
  // LOUD, and in the operator's words: which feed died, what it said, who is
  // carrying the packages now.
  trace('shipping', `provider ${name} rejected (${err?.status || err?.code || 'error'}) — failing over to ${nextName}`);
  trace('error', `shipping provider ${name} is out of rotation for ${Math.round(RETRY_MS / 60000)}m: ${err?.message || err}`);
}

// The chain as it stands right now, credentials considered. Order is fixed:
// richest feed first, terminal simulation last.
export function chain() {
  const out = [];
  for (const name of ['aftership', 'easypost']) if (DRIVERS[name].configured()) out.push(DRIVERS[name]);
  out.push(DRIVERS.simulated);
  return out;
}

// The feed a new package would be registered with this second.
export const activeProvider = () => (chain().find((d) => d.name === 'simulated' || usable(d.name)) || DRIVERS.simulated).name;

// What /health reports. `healthy` is about the PREFERRED feed: when it reads
// false while shipping_provider says something else, the chain is doing its job
// and someone should still go look at the key.
export function providerHealth() {
  const ring = chain();
  const preferred = ring[0];
  const preferredHealth = health.get(preferred.name);
  const errors = ring.map((d) => health.get(d.name)).filter((h) => h && h.lastError);
  return {
    shipping_provider: activeProvider(),
    healthy: preferred.name === 'simulated' ? true : !!(preferredHealth?.healthy ?? true),
    last_error: errors.length ? errors[0].lastError : null,
    chain: ring.map((d) => {
      const h = health.get(d.name);
      return { name: d.name, healthy: h ? h.healthy : true, last_error: h?.lastError || null };
    }),
  };
}

// Test/staging seam and a safety valve: lets a smoke run (and an operator with
// a wedged in-process verdict) start from a known state.
export function resetProviderHealth() { health.clear(); }

// Start watching a tracking number on the best feed that will take it. Walks
// down the chain on an auth/quota refusal and ends, at worst, on a simulated
// tracker — a shipment we can still narrate from what Shopify told us is
// strictly better than a shipment that failed to register at all.
export async function registerTracker(trackingCode, carrier) {
  if (!trackingCode) return null;
  const ring = chain();
  for (let i = 0; i < ring.length; i++) {
    const d = ring[i];
    if (d.name !== 'simulated' && !usable(d.name)) continue;
    try {
      const t = await d.createTracker(trackingCode, carrier,
        i > 0 ? `${ring[0].name} unavailable` : 'no tracking provider configured');
      markHealthy(d.name);
      return t ? { ...t, provider: d.name } : null;
    } catch (err) {
      if (!isFatal(err)) throw err; // this package's problem, not the feed's
      const next = ring.slice(i + 1).find((x) => x.name === 'simulated' || usable(x.name));
      markDown(d.name, err, next?.name || 'nothing');
    }
  }
  return null;
}

// Re-read a tracker as TRUTH — the move that makes an unverified webhook safe.
// `owner` is the provider recorded on the shipment row (shipments.provider), so
// an event goes back to the feed that actually minted the tracker id.
//
// If that feed is dead, the package is NOT orphaned: any other configured feed
// is asked to register the same tracking NUMBER, which yields a fresh tracker
// on a live feed. applyTracker() re-binds the row by tracking code, so the
// shipment keeps its history and simply changes hands.
export async function refetchTracker(owner, id, { trackingCode = null, carrier = null } = {}) {
  const ring = chain().filter((d) => d.name !== 'simulated');
  const first = ring.findIndex((d) => d.name === owner);
  const order = first >= 0 ? [ring[first], ...ring.filter((_, i) => i !== first)] : ring;

  for (const d of order) {
    if (!usable(d.name)) continue;
    const isOwner = d.name === owner && !!id;
    try {
      const t = isOwner
        ? await d.fetchTracking(id)
        // A feed that never saw this tracker id cannot look it up — but it can
        // be handed the tracking number, which is the customer's fact anyway.
        : (trackingCode ? await d.createTracker(trackingCode, carrier, `${owner} unavailable`) : null);
      if (!t) continue;
      markHealthy(d.name);
      if (!isOwner) trace('shipping', `${trackingCode} re-registered with ${d.name} after ${owner} went down — same package, new feed`);
      return { ...t, provider: d.name };
    } catch (err) {
      if (!isFatal(err)) {
        if (isOwner) throw err; // a real re-read failure: drop the event, don't trust it
        continue;
      }
      const next = order.find((x) => x !== d && usable(x.name));
      markDown(d.name, err, next?.name || 'nothing (no live feed left)');
    }
  }
  return null;
}
