// "Did this request come from this machine, or from the internet?" — the
// question the credential-free paths hang on.
//
// Loopback alone is NOT the answer. The public ingress is
// https://stuck-fanatic-spew.ngrok-free.dev → localhost:3000, so the ngrok
// agent forwards every internet request from 127.0.0.1: trusting the socket
// address by itself would hand the whole world the simulation door. A proxied
// request always carries proxy headers, and nothing we send to ourselves does —
// so both halves must hold.
const LOOPBACK = /^(::1|::ffff:127\.|127\.)/;

export function isLocalRequest(req) {
  const addr = req.socket?.remoteAddress || '';
  if (!LOOPBACK.test(addr)) return false;
  return !req.get('x-forwarded-for') && !req.get('x-real-ip') && !req.get('x-forwarded-host');
}

// A simulated request is a local one that ALSO says so out loud — an explicit
// header, never an inference, so a real Shopify delivery can never be mistaken
// for one (and a simulated one can never be mistaken for real: the rows it
// writes are marked simulated).
export const isSimulatedRequest = (req) =>
  isLocalRequest(req) && req.get('x-saru-simulated') === '1';
