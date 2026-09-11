// The capture gate — workflow 2 of the live walkthrough, kept DETERMINISTIC on
// purpose: once the opener asks for a phone number (or email, per the active
// workflow), the reply is handled by code — the model never validates contact
// info and never decides whether the promo unlocks.
import { config } from '../config.js';
import { getThread, appendMessage, setCollected, getCollected } from '../store/db.js';
import { ensureDiscount } from '../shopify/discounts.js';
import { rematchStoredOrders } from '../shopify/order-details.js';
import { buildFeaturedLink } from '../shopify/permalink.js';
import { activeWorkflow } from './workflow-settings.js';
import { trace } from '../sim/trace.js';

// E.164-ish extraction with a US default: "310-555-0142", "(310) 555 0142",
// "+44 20 7946 0958" all normalize; junk returns null.
export function extractPhone(text) {
  const cleaned = (text || '').replace(/[\s().\-]/g, '');
  const m = cleaned.match(/\+?\d{7,15}/);
  if (!m) return null;
  const n = m[0];
  const digits = n.replace(/\D/g, '');
  if (n.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null; // 7-9 bare digits: not enough to be a reachable number
}

export function extractEmail(text) {
  const m = (text || '').match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

const looksLikePhoneAttempt = (text) => ((text || '').match(/\d/g) || []).length >= 6;
const looksLikeEmailAttempt = (text) => /@/.test(text || '');

// Returns reply bubbles when this message is the gate's business, else null
// (null = the normal agent turn handles it).
export async function handleGateReply(igsid, text) {
  if (activeWorkflow() === 'off') return null;
  const awaiting = getCollected(igsid, '_awaiting');
  if (awaiting !== 'phone' && awaiting !== 'email') return null;
  if (getCollected(igsid, awaiting)) return null;

  const value = awaiting === 'phone' ? extractPhone(text) : extractEmail(text);
  if (!value) {
    const attempted = awaiting === 'phone' ? looksLikePhoneAttempt(text) : looksLikeEmailAttempt(text);
    if (!attempted) return null; // a question, not an attempt — let the agent answer
    const attempts = (parseInt(getCollected(igsid, '_gate_attempts'), 10) || 0) + 1;
    setCollected(igsid, '_gate_attempts', attempts);
    if (attempts >= 3) { setCollected(igsid, '_awaiting', ''); return null; }
    trace('gate', `invalid ${awaiting} attempt ${attempts} from ${igsid}`);
    return [awaiting === 'phone'
      ? 'hmm that one looks off — mind sending it again with area code?'
      : 'hmm that email looks off — mind typing it once more?'];
  }

  setCollected(igsid, awaiting, value);
  setCollected(igsid, '_awaiting', '');
  trace('gate', `${awaiting} ${value} captured for ${igsid}`);

  // The contact detail we just captured is the whole join between a checkout
  // and this conversation — so run it BACKWARDS immediately. Orders already in
  // the table (placed before we ever had their number, or before the store's
  // webhooks existed) link right now instead of waiting for the customer to
  // order again just so a webhook can do it. Never fatal to the gate.
  try { rematchStoredOrders(igsid); } catch (err) { trace('error', `order re-match after ${awaiting} capture failed: ${err.message}`); }

  const d = config.promoCode
    ? { code: config.promoCode, percent: config.discountPercent }
    : await ensureDiscount(igsid, getThread(igsid)?.username);
  const link = await buildFeaturedLink(d.code);

  const bubbles = ['got it 🙌', `${d.code} — ${d.percent}% off, made for you`];
  if (link) bubbles.push(link);

  appendMessage(igsid, 'system',
    `context: customer's ${awaiting} ${value} was captured and validated; code ${d.code} was delivered` +
    `${link ? ` with the checkout link ${link}` : ''}. never re-ask for contact info; remind them the link checks out with the code already applied.`);
  return bubbles;
}

export const handlePhoneReply = handleGateReply; // back-compat alias
