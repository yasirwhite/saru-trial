// One-time OAuth handshake for the Dev Dashboard app: Dev Dashboard apps don't
// expose a static admin token — you install the app on the store via the
// authorize URL and exchange the returned code for an offline access token.
// Visit /oauth/install once (logged into the store admin), copy the token it
// prints, put it in .env as SHOPIFY_ADMIN_TOKEN, restart. Then these routes go
// unused; they hold no state and mint nothing on their own.
import crypto from 'node:crypto';
import { trace } from '../sim/trace.js';

const SCOPES = 'read_products,write_products,read_discounts,write_discounts,read_orders,write_orders,read_draft_orders,write_draft_orders,read_customers,write_customers,read_publications,write_publications,read_themes,write_themes,read_files,write_files,read_content,write_content';
let pendingState = null; // single-use CSRF state for the one handshake we do

export function mountShopifyOAuth(app) {
  const clientId = process.env.SHOPIFY_APP_CLIENT_ID || '';
  const clientSecret = process.env.SHOPIFY_APP_CLIENT_SECRET || '';
  const shop = process.env.SHOPIFY_ADMIN_STORE || 'saru-dev-lab.myshopify.com';
  const publicBase = process.env.PUBLIC_BASE_URL || '';

  app.get('/oauth/install', (_req, res) => {
    if (!clientId || !publicBase) {
      return res.status(500).send('set SHOPIFY_APP_CLIENT_ID and PUBLIC_BASE_URL in .env first');
    }
    pendingState = crypto.randomBytes(16).toString('hex');
    const url = `https://${shop}/admin/oauth/authorize` +
      `?client_id=${encodeURIComponent(clientId)}` +
      `&scope=${encodeURIComponent(SCOPES)}` +
      `&redirect_uri=${encodeURIComponent(`${publicBase}/oauth/callback`)}` +
      `&state=${pendingState}`;
    trace('oauth', `install started for ${shop}`);
    res.redirect(url);
  });

  app.get('/oauth/callback', async (req, res) => {
    const { code, state, shop: shopParam } = req.query;
    if (!code || !state || state !== pendingState) return res.status(403).send('bad or expired oauth state — hit /oauth/install again');
    pendingState = null;
    try {
      const r = await fetch(`https://${shopParam || shop}/admin/oauth/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
      const json = await r.json();
      if (!json.access_token) throw new Error(JSON.stringify(json).slice(0, 300));
      trace('oauth', `access token issued (scopes: ${json.scope})`);
      res.send(`<pre>app installed on ${shopParam || shop} ✔

SHOPIFY_ADMIN_TOKEN=${json.access_token}
granted scopes: ${json.scope}

copy the token line into .env, then restart the server.</pre>`);
    } catch (err) {
      trace('error', `oauth token exchange failed: ${err.message}`);
      res.status(500).send(`token exchange failed: ${err.message}`);
    }
  });
}
