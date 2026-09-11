// The store's door. Shopify signs every webhook body the same way Meta does,
// with one difference worth knowing: base64, not hex, in X-Shopify-Hmac-Sha256.
// Same rule applies — nothing in the body is believed until the HMAC over the
// RAW bytes checks out.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { ingestOrder } from '../shopify/orders.js';
import { ingestFulfillment } from '../shipping/shipments.js';
import { isSimulatedRequest } from './local.js';
import { trace } from '../sim/trace.js';

export function verifyShopifyHmac(req) {
  if (!config.shopifyWebhookSecret) return false;
  const header = req.get('x-shopify-hmac-sha256') || '';
  const expected = crypto.createHmac('sha256', config.shopifyWebhookSecret)
    .update(req.rawBody || Buffer.alloc(0))
    .digest('base64');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signing helper for local tooling, so simulated traffic can prove out the real
// check instead of always taking the bypass.
export const signShopifyBody = (rawBody, secret = config.shopifyWebhookSecret) =>
  crypto.createHmac('sha256', secret).update(rawBody).digest('base64');

async function handleTopic(topic, body, opts) {
  if (topic === 'orders/create' || topic === 'orders/updated') {
    ingestOrder(body, opts);
    return;
  }
  if (topic === 'fulfillments/create' || topic === 'fulfillments/update') {
    await ingestFulfillment(body, opts);
    return;
  }
  trace('webhook', `shopify topic ${topic || '(none)'} ignored — not one we subscribe to`);
}

export function mountShopifyWebhooks(app) {
  app.post('/webhooks/shopify', async (req, res) => {
    const topic = (req.get('x-shopify-topic') || '').toLowerCase();
    const simulated = isSimulatedRequest(req);

    if (!simulated) {
      // An unset secret is a CLOSED door, not an open one. Without it there is
      // no way to tell a real order from a forged one, and silently ingesting
      // unverified customer data is the worst of the three options.
      if (!config.shopifyWebhookSecret) {
        trace('rejected', `shopify webhook ${topic || '(no topic)'} refused — SHOPIFY_WEBHOOK_SECRET unset, nothing unverified is ingested`);
        return res.status(503).json({ ok: false, error: 'shopify webhook secret not configured' });
      }
      if (!verifyShopifyHmac(req)) {
        trace('rejected', `shopify webhook ${topic || '(no topic)'} hmac invalid — payload not trusted`);
        return res.sendStatus(401);
      }
    }

    // Handled inline rather than after a fast ack (the Meta route's pattern):
    // orders/create must land before the fulfillment that references it, the
    // work is a few sqlite writes plus at most one EasyPost call, and Shopify's
    // timeout is 5s. A thrown error returns 500 so Shopify retries.
    try {
      await handleTopic(topic, req.body, { simulated, igsidHint: req.body?._saru_igsid || null });
    } catch (err) {
      trace('error', `shopify webhook ${topic} failed: ${err.message}`);
      return res.sendStatus(500);
    }
    res.json({ ok: true, topic, simulated });
  });
}
