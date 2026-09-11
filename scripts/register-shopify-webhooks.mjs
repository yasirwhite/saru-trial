// Point the store's order + fulfillment webhooks at this app. Idempotent: it
// lists what already exists and creates only what's missing, so running it
// twice is a no-op and running it after a tunnel change re-points nothing —
// delete the stale subscription in Shopify (or change the URL) first.
//
//   npm run shopify:webhooks
import { config } from '../src/config.js';

const TOPICS = ['ORDERS_CREATE', 'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE'];
const API_VERSION = '2025-07';

const store = config.shopifyAdminStore || config.storeDomain;
const base = (config.publicBaseUrl || '').replace(/\/+$/, '');
const callbackUrl = `${base}/webhooks/shopify`;

if (!config.shopifyOrdersToken) {
  console.error('SHOPIFY_ORDERS_TOKEN is empty.');
  console.error('Orders are protected customer data: the existing SHOPIFY_ADMIN_TOKEN cannot read them');
  console.error('(verified — ACCESS_DENIED). Create a custom app on the store with read_orders +');
  console.error('read_fulfillments, install it, and paste its Admin API access token as');
  console.error('SHOPIFY_ORDERS_TOKEN in .env. Until then the concierge runs the simulated path:');
  console.error('  node scripts/simulate-shipment.mjs --fast');
  process.exit(1);
}
if (!store) {
  console.error('No store domain — set SHOPIFY_ADMIN_STORE (e.g. your-shop.myshopify.com) in .env.');
  process.exit(1);
}
if (!base) {
  console.error('No PUBLIC_BASE_URL — set it to the public ingress (e.g. https://<subdomain>.ngrok-free.dev) in .env.');
  process.exit(1);
}

async function gql(query, variables = {}) {
  const res = await fetch(`https://${store}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': config.shopifyOrdersToken },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors).slice(0, 400));
  return json.data;
}

const LIST = `{
  webhookSubscriptions(first: 100) {
    edges { node {
      id topic
      endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
    } }
  }
}`;

const CREATE = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
    webhookSubscription { id topic }
    userErrors { field message }
  }
}`;

try {
  console.log(`store    ${store}`);
  console.log(`callback ${callbackUrl}\n`);

  const data = await gql(LIST);
  const existing = data.webhookSubscriptions.edges.map((e) => e.node);
  const here = new Set(
    existing.filter((n) => n.endpoint?.callbackUrl === callbackUrl).map((n) => n.topic),
  );
  for (const n of existing) {
    console.log(`  existing  ${n.topic.padEnd(22)} → ${n.endpoint?.callbackUrl || n.endpoint?.__typename || '?'}`);
  }
  if (existing.length) console.log('');

  let created = 0;
  for (const topic of TOPICS) {
    if (here.has(topic)) { console.log(`  ok        ${topic} already points here`); continue; }
    const res = await gql(CREATE, { topic, sub: { callbackUrl, format: 'JSON' } });
    const errs = res.webhookSubscriptionCreate.userErrors;
    if (errs?.length) { console.log(`  FAILED    ${topic}: ${errs.map((e) => e.message).join('; ')}`); continue; }
    console.log(`  created   ${topic} → ${callbackUrl}`);
    created++;
  }
  console.log(`\ndone — ${created} created, ${TOPICS.length - created} already in place.`);
  if (!config.shopifyWebhookSecret) {
    console.log('\nNOTE: SHOPIFY_WEBHOOK_SECRET is empty, so /webhooks/shopify will refuse every');
    console.log('delivery with 503 until you paste the app\'s webhook signing secret into .env.');
  }
} catch (err) {
  console.error(`\nregistration failed: ${err.message}`);
  console.error('(a 401/403 here means SHOPIFY_ORDERS_TOKEN lacks write_webhooks or read_orders)');
  process.exit(1);
}
