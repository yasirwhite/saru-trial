// The trust boundary. Nothing in a webhook body is believed until the HMAC
// checks out: Meta signs every POST with SHA-256 over the RAW bytes using the
// app secret, in the `X-Hub-Signature-256: sha256=<hex>` header.
import crypto from 'node:crypto';
import { config } from '../config.js';

export function verifySignature(req) {
  const header = req.get('x-hub-signature-256') || '';
  const expected = 'sha256=' +
    crypto.createHmac('sha256', config.appSecret)
      .update(req.rawBody || Buffer.alloc(0))
      .digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Signing helper for the simulator, so sim traffic proves out the same check.
export function signBody(rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', config.appSecret).update(rawBody).digest('hex');
}

// The one-time GET handshake Meta performs when you save the callback URL.
export function handleChallenge(req, res) {
  const ok = req.query['hub.mode'] === 'subscribe' &&
    req.query['hub.verify_token'] === config.verifyToken;
  if (ok) return res.send(req.query['hub.challenge']);
  return res.sendStatus(403);
}
