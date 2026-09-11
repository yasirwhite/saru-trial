// Drives the ENTIRE shipment pipeline — order → fulfillment → carrier scans →
// milestone DMs — against a running server, with zero credentials. This is the
// demo driver and the manual test.
//
//   node scripts/simulate-shipment.mjs --email maya@example.com
//   node scripts/simulate-shipment.mjs --igsid sim-user-maya.runs --fast
//
//   --base   <url>    target server        (default http://localhost:3000)
//   --email  <addr>   the order's email    (matches a thread that captured it)
//   --phone  <num>    the order's phone    (normalized to E.164 before matching)
//   --igsid  <id>     link the order to this thread directly — a simulation-only
//                     shortcut for when you don't want to retype a contact
//   --carrier <name>  default USPS
//   --code   <track>  tracking number      (default a generated one)
//   --discount <code> the code used at checkout (default QRWELCOME10)
//   --no-code         checkout used NO discount code — the honest "no, you
//                     didn't use one" answer, which is a real answer too
//   --fast            no delays between steps
//
// Every POST goes out with X-Saru-Simulated: 1 from loopback, which is the ONLY
// way past the Shopify HMAC check (see src/webhooks/local.js) — the same script
// aimed at a remote host is refused, as it should be.
import { simTrackerId } from '../src/shipping/easypost.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
};

const base = (arg('base') || process.env.SIM_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const fast = flag('fast');
const igsid = arg('igsid');
const email = arg('email') || (igsid ? null : 'shipment.demo@example.com');
const phone = arg('phone');
const carrier = arg('carrier') || 'USPS';
const stamp = Date.now();
const code = arg('code') || `9400${String(stamp).slice(-12)}`;
const orderId = String(stamp);
const orderName = `#${1000 + (stamp % 9000)}`;
const fulfillmentId = `${stamp}1`;
const trackerId = simTrackerId(code);
// The order detail the customer asks about later ("did i use the qr code?",
// "what address do you have on file?") — the same keys a real orders/create
// carries, so the concierge answers from stored facts, not from this script.
const discountCode = flag('no-code') ? null : (arg('discount') || 'QRWELCOME10');
const shippingAddress = {
  first_name: 'Maya', last_name: 'Ruiz',
  address1: '812 Ocean Park Blvd', address2: 'apt 4',
  city: 'Santa Monica', province: 'California', province_code: 'CA',
  zip: '90405', country: 'United States', country_code: 'US', phone,
};
const lineItems = [{ title: 'Cloud Hoodie', variant_title: 'M / bone', quantity: 1, price: '68.00' }];

const sleep = (ms) => new Promise((r) => setTimeout(r, fast ? 0 : ms));

async function post(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Saru-Simulated': '1', ...headers },
    body: JSON.stringify(body),
  });
  const text = (await res.text()).slice(0, 200);
  return { status: res.status, text };
}

const show = (label, r) =>
  console.log(`  ${r.status === 200 ? 'ok  ' : 'FAIL'} ${label.padEnd(34)} ${r.status} ${r.text}`);

// The carrier's story, one scan at a time. Each event carries the cumulative
// tracking_details list, exactly as EasyPost's tracker object does.
const SCANS = [
  { status: 'pre_transit', message: 'shipping label created, usps awaiting item', city: 'Los Angeles', state: 'CA' },
  { status: 'in_transit', message: 'departed usps regional facility', city: 'Bell Gardens', state: 'CA' },
  { status: 'out_for_delivery', message: 'out for delivery, expected by 8:00pm', city: 'Austin', state: 'TX' },
  { status: 'delivered', message: 'delivered, front door/porch', city: 'Austin', state: 'TX' },
];

const eta = new Date(stamp + 3 * 86400000).toISOString().slice(0, 10);

console.log(`\nsimulating a shipment against ${base}`);
console.log(`  order ${orderName} (${orderId})  ${email || ''}${phone ? ` ${phone}` : ''}${igsid ? `  → thread ${igsid}` : ''}`);
console.log(`  ${carrier} ${code}  tracker ${trackerId}\n`);

if (!igsid) {
  console.log(`  matching by contact: this order only links to a dm thread if ${email || phone} is`);
  console.log('  already captured there. --igsid <thread> links one directly instead.\n');
}
if (process.env.EASYPOST_API_KEY) {
  console.log('  NOTE: EASYPOST_API_KEY is set, so the server re-fetches every tracker from the');
  console.log('        EasyPost API — these invented tracker events will be rejected. Unset it');
  console.log('        (or run the server without it) for a fully simulated run.\n');
}

// 1 — the order lands.
show('orders/create', await post('/webhooks/shopify', {
  id: Number(orderId),
  name: orderName,
  order_number: Number(orderName.slice(1)),
  email,
  phone,
  total_price: '68.00',
  currency: 'USD',
  financial_status: 'paid',
  created_at: new Date(stamp).toISOString(),
  customer: { email, phone },
  // An EMPTY array is deliberate under --no-code: it says "no code was used",
  // which the concierge answers plainly. Omitting the key would instead mean
  // "we never looked" and send it to the Admin API for the real answer.
  discount_codes: discountCode ? [{ code: discountCode, amount: '13.60', type: 'percentage' }] : [],
  shipping_address: shippingAddress,
  line_items: lineItems,
  // simulation-only: honored solely because this request is local + simulated
  _saru_igsid: igsid || undefined,
}, { 'X-Shopify-Topic': 'orders/create' }));
await sleep(1200);

// 2 — the warehouse ships it.
show('fulfillments/create', await post('/webhooks/shopify', {
  id: Number(fulfillmentId),
  order_id: Number(orderId),
  status: 'success',
  tracking_company: carrier,
  tracking_number: code,
  tracking_numbers: [code],
  created_at: new Date(stamp).toISOString(),
}, { 'X-Shopify-Topic': 'fulfillments/create' }));
await sleep(1500);

// 3 — the carrier scans it, one checkpoint at a time.
const details = [];
for (const [i, scan] of SCANS.entries()) {
  details.push({
    object: 'TrackingDetail',
    status: scan.status,
    message: scan.message,
    datetime: new Date(stamp + i * 3600000).toISOString(),
    tracking_location: { object: 'TrackingLocation', city: scan.city, state: scan.state, country: 'US', zip: null },
  });
  show(`easypost ${scan.status}`, await post('/webhooks/easypost', {
    description: 'tracker.updated',
    mode: 'test',
    result: {
      object: 'Tracker',
      id: trackerId,
      status: scan.status,
      tracking_code: code,
      carrier,
      est_delivery_date: eta,
      public_url: `https://track.easypost.com/djE6${trackerId.slice(-10)}`,
      tracking_details: details,
    },
  }));
  await sleep(2000);
}

console.log(`\ndone. the thread should now hold "on its way", "out for delivery" and a thank-you dm`);
console.log(`(subject to the 24h window and human-takeover rules), and asking "where's my order?"`);
console.log(`in the dms answers with the ${SCANS[SCANS.length - 1].city} scan.`);
console.log('the same order also answers "what address do you have on file?" ' +
  `(${shippingAddress.city}), "did i use the qr code?" ` +
  `(${discountCode ? discountCode : 'no — no code was used'}) and "what did i order?" ` +
  `(${lineItems[0].title.toLowerCase()}).\n`);
