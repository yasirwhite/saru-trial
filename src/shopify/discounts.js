// Discount codes are minted by CODE, not by the model. The percent, the expiry,
// and the one-code-per-customer rule are enforced here; the model can only ask
// "does this customer have a code?" and relay the answer.
import { config } from '../config.js';
import { getDiscount, saveDiscount } from '../store/db.js';
import { trace } from '../sim/trace.js';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rand4 = () => Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
const slug = (s) => (s || '').replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 8) || 'FRIEND';

async function adminCreateCode(code, percent, endsAt) {
  const mutation = `
    mutation($input: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $input) {
        userErrors { field message }
      }
    }`;
  const input = {
    title: `concierge ${code}`,
    code,
    startsAt: new Date().toISOString(),
    endsAt: new Date(endsAt).toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection: { all: true },
    customerGets: { value: { percentage: percent / 100 }, items: { all: true } },
  };
  const res = await fetch(`https://${config.shopifyAdminStore}/admin/api/2025-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.shopifyAdminToken,
    },
    body: JSON.stringify({ query: mutation, variables: { input } }),
  });
  const json = await res.json();
  const errs = json.data?.discountCodeBasicCreate?.userErrors || json.errors;
  if (errs?.length) throw new Error(JSON.stringify(errs).slice(0, 300));
}

export async function ensureDiscount(igsid, username) {
  const existing = getDiscount(igsid);
  if (existing && existing.expires_at > Date.now()) {
    return { code: existing.code, percent: existing.percent, expiresAt: existing.expires_at, simulated: !!existing.simulated, reused: true };
  }

  const code = `${slug(username)}-${rand4()}`;
  const percent = config.discountPercent;
  const expiresAt = Date.now() + 7 * 24 * 3600 * 1000;
  let simulated = true;

  if (config.shopifyAdminStore && config.shopifyAdminToken) {
    try {
      await adminCreateCode(code, percent, expiresAt);
      simulated = false;
    } catch (err) {
      // A minting failure must never eat the one private reply we get — fall
      // back to a simulated code and surface the error in the trace.
      trace('error', `admin discount create failed, using simulated code: ${err.message}`);
    }
  }

  saveDiscount(igsid, { code, percent, expiresAt, simulated });
  trace('discount', `${simulated ? 'simulated' : 'real'} code ${code} (${percent}%) minted for ${username || igsid}`);
  return { code, percent, expiresAt, simulated, reused: false };
}

// Shopify checkouts accept a discount code as a query param — appending it to
// the cart's checkout URL means the link arrives pre-discounted.
export function applyDiscountToUrl(checkoutUrl, code) {
  try {
    const u = new URL(checkoutUrl);
    u.searchParams.set('discount', code);
    return u.toString();
  } catch {
    return checkoutUrl;
  }
}
