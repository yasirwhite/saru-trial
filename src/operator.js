// The human-takeover door. When an operator types a reply by hand in the Kosha
// portal, the portal POSTs it here rather than talking to Meta itself: the
// concierge already owns the access token, the 24-hour window rule and the
// transcript the model reads, so the send belongs on this side of the line.
//
// This is one half of the contract with the portal. The other half is
// response_mode, which the portal writes per conversation and the Supabase
// bridge mirrors into local settings (see store/supabase-bridge.js) so
// dm-reply.js knows to stay quiet while a human is holding the thread.
import { config } from './config.js';
import { appendMessage } from './store/db.js';
import { withinMessagingWindow } from './flows/dm-reply.js';
import { markAnswered } from './flows/escalation.js';
import { ensureDiscount } from './shopify/discounts.js';
import { sendDm } from './instagram/send.js';
import { trace } from './sim/trace.js';

// Told to the model right after a human's words land in the transcript. Without
// it the next agent turn reads the operator's message as its OWN last reply and
// happily contradicts it or re-offers what a person just gave away.
const HUMAN_NOTE =
  'context: the previous message was sent by a HUMAN operator, not by you. ' +
  'treat it as the brand speaking — do not repeat it, do not contradict it, and do not ' +
  're-offer anything it already promised.';

export function mountOperator(app) {
  app.post('/operator/send', async (req, res) => {
    const { igsid, text, key } = req.body || {};

    // Strict, and never open by default: an unset ADMIN_KEY closes this door
    // instead of unlocking it. Unlike /admin (a read-mostly dashboard) this
    // endpoint sends real DMs from the brand account to real people.
    if (!config.adminKey || key !== config.adminKey) {
      trace('operator', 'send rejected — bad or missing admin key');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const id = String(igsid ?? '').trim();
    const body = String(text ?? '').trim();
    if (!id || !body) return res.status(400).json({ ok: false, error: 'igsid and text are required' });

    // Meta's 24-hour rule is enforced here, not in the portal: a human operator
    // gets the same guarantee the agent does, and a clear reason when it fails.
    if (!withinMessagingWindow(id)) {
      trace('operator', `send blocked for ${id} — 24h messaging window closed`);
      return res.status(409).json({
        ok: false,
        error: '24h messaging window closed — this customer must message again before we can reply',
      });
    }

    try {
      await sendDm(id, body);
    } catch (err) {
      trace('error', `operator send failed for ${id}: ${err.message}`);
      return res.status(502).json({ ok: false, error: `instagram send failed: ${err.message}` });
    }

    // Only after the send actually landed: a failed send must not leave a
    // message in the transcript (or the portal mirror) that nobody received.
    appendMessage(id, 'assistant', body);
    appendMessage(id, 'system', HUMAN_NOTE); // 'system' rows are ours; the mirror skips them
    // A human has now spoken in this thread, which is exactly what an open
    // escalation flag was waiting for: it stops being work, and the courtesy
    // dm that would have fired is cancelled.
    markAnswered(id);
    trace('operator', `human operator → ${id}: ${body}`);
    res.json({ ok: true });
  });

  // Operator-minted discount. The portal's "Generate discount" button lands
  // here so the mint follows the same rails the agent's does: real Shopify
  // code, fixed percent and expiry, one code per subject — ensureDiscount
  // returns the existing code on a repeat click instead of minting a second.
  //
  // `subject` is whatever id the caller tracks the customer by: an igsid for
  // Instagram threads, or any stable key (e.g. "portal:<customerId>") for
  // channels the concierge doesn't run. Minting only — nothing is sent to the
  // customer; delivering the code is the operator's (or the agent's) job.
  app.post('/operator/discount', async (req, res) => {
    const { subject, label, key } = req.body || {};

    if (!config.adminKey || key !== config.adminKey) {
      trace('operator', 'discount rejected — bad or missing admin key');
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const id = String(subject ?? '').trim();
    if (!id) return res.status(400).json({ ok: false, error: 'subject is required' });

    try {
      const discount = await ensureDiscount(id, String(label ?? '').trim() || undefined);
      trace('operator', `discount for ${id}: ${discount.code}`);
      res.json({ ok: true, code: discount.code, percent: discount.percent, expires_at: discount.expiresAt ?? null, reused: !!discount.reused });
    } catch (err) {
      trace('error', `operator discount failed for ${id}: ${err.message}`);
      res.status(502).json({ ok: false, error: `discount mint failed: ${err.message}` });
    }
  });
}
