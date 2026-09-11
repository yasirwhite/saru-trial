// The carrier's door — and the one webhook in this system that arrives with NO
// signature to check. EasyPost events carry no HMAC we can verify, so the rule
// here is stricter than "verify then trust": we believe nothing in the body at
// all. We read ONE field out of it — the tracker id — and then re-fetch that
// tracker from the EasyPost API. The API's answer is the only thing written to
// a shipment row, so a forged event can at worst make us re-read a tracker we
// already own.
import { easypostEnabled, normalizeTracker } from '../shipping/easypost.js';
import { refetchTracker } from '../shipping/provider.js';
import { applyTracker } from '../shipping/shipments.js';
import { getShipmentByTracker } from '../store/db.js';
import { isLocalRequest } from './local.js';
import { trace } from '../sim/trace.js';

// EasyPost wraps the object in `result`; older/edge shapes put it at the top.
const trackerIdOf = (ev = {}) =>
  ev.result?.id || ev.result?.tracker?.id || ev.tracker?.id || (ev.object === 'Tracker' ? ev.id : null) || null;

export function mountEasypostWebhooks(app) {
  app.post('/webhooks/easypost', async (req, res) => {
    const ev = req.body || {};
    const id = trackerIdOf(ev);
    if (!id) {
      trace('rejected', 'easypost webhook carried no tracker id — ignored');
      return res.sendStatus(400);
    }

    try {
      if (easypostEnabled()) {
        // Routed through the provider chain rather than straight at EasyPost:
        // if this key has been revoked or throttled, the same tracking NUMBER
        // is re-registered on the next live feed instead of the package going
        // dark. The re-read (from whichever feed answers) IS the verification.
        const row = getShipmentByTracker(id);
        let tracker;
        try {
          tracker = await refetchTracker(row?.provider || 'easypost', id, {
            trackingCode: row?.tracking_code || null,
            carrier: row?.carrier || null,
          });
        } catch (err) {
          trace('error', `easypost re-fetch of ${id} failed — event dropped rather than trusted: ${err.message}`);
          return res.sendStatus(502);
        }
        if (!tracker) {
          trace('error', `easypost re-fetch of ${id} returned nothing — no live feed could confirm it, event dropped`);
          return res.sendStatus(502);
        }
        await applyTracker(tracker);
        return res.json({ ok: true, tracker: tracker.id || id, provider: tracker.provider, source: 'api' });
      }

      // No API key: there is nothing to re-read against, so the only payload we
      // can accept is one we generated ourselves — a loopback request carrying
      // no proxy headers, i.e. scripts/simulate-shipment.mjs. Anything arriving
      // through the public ingress is refused rather than believed.
      if (!isLocalRequest(req)) {
        trace('rejected', `easypost webhook for ${id} refused — EASYPOST_API_KEY unset, only local simulation is accepted`);
        return res.status(503).json({ ok: false, error: 'easypost not configured' });
      }
      await applyTracker(normalizeTracker({ ...(ev.result || ev.tracker || ev), simulated: true }));
      return res.json({ ok: true, tracker: id, source: 'simulation' });
    } catch (err) {
      trace('error', `easypost webhook for ${id} failed: ${err.message}`);
      return res.sendStatus(500);
    }
  });
}
