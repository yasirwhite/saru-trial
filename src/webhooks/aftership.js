// AfterShip's door. Same rule as every other carrier feed in this system: the
// body is a NOTIFICATION, never a source of truth. We read one field out of it
// — the tracking id — and then re-fetch that tracking from the AfterShip API.
// Only the API's answer is written to a shipment row, so the worst a forged
// event can do is make us re-read a package we already own.
//
// AfterShip DOES sign its deliveries (unlike EasyPost), so when
// AFTERSHIP_WEBHOOK_SECRET is set we check the signature first and refuse an
// unsigned or mis-signed delivery outright. That check is a cheap early exit,
// not a licence to believe the body: the re-fetch still happens either way.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { aftershipEnabled, normalizeTracking } from '../shipping/aftership.js';
import { refetchTracker } from '../shipping/provider.js';
import { applyTracker } from '../shipping/shipments.js';
import { getShipmentByTracker, getShipmentByTrackingCode } from '../store/db.js';
import { isLocalRequest } from './local.js';
import { trace } from '../sim/trace.js';

// Base64 HMAC-SHA256 of the RAW body bytes, keyed with the account's webhook
// secret, in the `aftership-hmac-sha256` header. Same construction Shopify
// uses; the header name and the secret's home in the dashboard differ.
export function verifyAftershipHmac(req) {
  if (!config.aftershipWebhookSecret) return false;
  const header = req.get('aftership-hmac-sha256') || '';
  const expected = crypto.createHmac('sha256', config.aftershipWebhookSecret)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('base64');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signing helper for local tooling, so simulated traffic can prove out the real
// check instead of always taking the loopback bypass.
export const signAftershipBody = (rawBody, secret = config.aftershipWebhookSecret) =>
  crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

// 2025-07 nests the object under data.tracking; 2024-04 put it in `msg`. Both
// shapes are read, because an account's webhook version is set in the dashboard
// and nobody should have to redeploy to change it.
const trackingOf = (ev = {}) => ev.data?.tracking || ev.msg || ev.tracking || (ev.id && ev.tracking_number ? ev : null) || {};

export function mountAftershipWebhooks(app) {
  app.post('/webhooks/aftership', async (req, res) => {
    const ev = req.body || {};
    const t = trackingOf(ev);
    const id = t.id || null;
    const number = t.tracking_number || null;

    // A signed delivery is checked BEFORE anything else — a bad signature is a
    // forgery and gets nothing, not even a lookup.
    if (config.aftershipWebhookSecret && !verifyAftershipHmac(req)) {
      trace('rejected', `aftership webhook for ${id || number || '(unidentified)'} hmac invalid — payload not trusted`);
      return res.sendStatus(401);
    }

    if (!id && !number) {
      trace('rejected', 'aftership webhook carried no tracking id or number — ignored');
      return res.sendStatus(400);
    }

    try {
      if (aftershipEnabled()) {
        // Who owns this package? Normally aftership, but a shipment that
        // changed hands during an outage is re-read from its current feed.
        const row = (id && getShipmentByTracker(id)) || (number && getShipmentByTrackingCode(number)) || null;
        let tracker;
        try {
          tracker = await refetchTracker(row?.provider || 'aftership', id, {
            trackingCode: number || row?.tracking_code || null,
            carrier: row?.carrier || null,
          });
        } catch (err) {
          trace('error', `aftership re-fetch of ${id || number} failed — event dropped rather than trusted: ${err.message}`);
          return res.sendStatus(502);
        }
        if (!tracker) {
          trace('error', `aftership re-fetch of ${id || number} returned nothing — no live feed could confirm it, event dropped`);
          return res.sendStatus(502);
        }
        await applyTracker(tracker);
        return res.json({ ok: true, tracking: tracker.id || id, provider: tracker.provider, source: 'api' });
      }

      // No API key: there is nothing to re-read against, so the only payload we
      // can accept is one we generated ourselves — a loopback request carrying
      // no proxy headers. Anything arriving through the public ingress is
      // refused rather than believed, exactly as on the EasyPost door.
      if (!isLocalRequest(req)) {
        trace('rejected', `aftership webhook for ${id || number} refused — AFTERSHIP_API_KEY unset, only local simulation is accepted`);
        return res.status(503).json({ ok: false, error: 'aftership not configured' });
      }
      await applyTracker({ ...normalizeTracking(t), provider: 'aftership', simulated: true });
      return res.json({ ok: true, tracking: id || number, source: 'simulation' });
    } catch (err) {
      trace('error', `aftership webhook for ${id || number} failed: ${err.message}`);
      return res.sendStatus(500);
    }
  });
}
