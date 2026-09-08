# Going live against real Instagram (dev mode)

The whole app runs locally in simulator mode with zero setup. This is the
click-path to point it at real Instagram instead. Everything stays in Meta's
**development mode** — no app review needed. Budget ~30–45 minutes.

## What you need before starting

- An **Instagram professional account** (Business or Creator — flip it in the
  IG app under Settings → Account type) that will BE the concierge.
- A **second Instagram account** (any personal account) to play the customer.
- A Meta developer account: https://developers.facebook.com

## 1. Create the Meta app

1. developers.facebook.com → **My Apps → Create App** → use case **Other** →
   type **Business**.
2. In the app dashboard, **Add product → Instagram** and choose
   **Instagram API with Instagram Login** (this avoids needing a Facebook Page).
3. Under **Instagram → API setup with Instagram login**: connect the
   professional account (log in as it when prompted).
4. Generate an access token for it with these scopes:
   `instagram_business_basic`, `instagram_business_manage_messages`,
   `instagram_business_manage_comments`.
5. Copy from the dashboard into `.env`:
   - `IG_ACCESS_TOKEN` — the token you just generated
   - `IG_ID` — the account's ID shown next to it
   - `META_APP_SECRET` — ⚠️ the **Instagram app secret** from the Instagram
     product's API-setup page (it has its own Instagram app ID), NOT the Meta
     app secret under App settings → Basic. Webhook signatures for this app
     type are signed with the Instagram one — the wrong secret means every
     delivery is rejected as unverified (learned live).

## 2. Add the customer account as a tester

Development mode only delivers webhooks for accounts that hold a role on the
app: **App roles → Roles → Add People → Instagram Tester** → enter the second
account's handle. Then log into that account → Settings → Website permissions
→ Apps and websites → **Tester invites → Accept**.

## 3. Expose the webhook endpoint

Any HTTPS tunnel works. With no account at all:

```
winget install Cloudflare.cloudflared
cloudflared tunnel --url http://127.0.0.1:3000
```

Copy the `https://….trycloudflare.com` URL it prints. (It changes every run —
an ngrok account with a static domain saves re-pasting.)

## 4. Subscribe the webhooks

1. Pick any string as `META_VERIFY_TOKEN` in `.env`, then `npm start`.
2. ⚠️ Configure webhooks **inside the Instagram product page** ("API setup with
   Instagram business login" → step 3, Configure webhooks) — the generic
   Webhooks product page and the app-level `/subscriptions` API are parallel
   configs this app type IGNORES for delivery (the dashboard even warns:
   "supported only within the product itself"). Callback URL is
   `https://<your-tunnel>/webhooks/instagram`, verify token is your string.
   Meta performs the GET handshake against the running server on save.
3. In that same section's fields table, subscribe **`messages`** and
   **`comments`**. If the tunnel URL ever changes, this product-level form
   must be updated BY HAND — re-registering via API does not count.
4. **Enable delivery for the connected account** — the dashboard config alone
   doesn't deliver for this app type. With the token in `.env`, run:
   `npm run meta:subscribe` (calls `POST /me/subscribed_apps`).
5. **Flip the app to Live.** Meta's docs for Instagram-Login apps state webhooks
   only deliver with the app set to Live. Going Live needs a Privacy Policy URL
   in App settings → Basic (any reachable page you control works for a demo) —
   no app review needed; API access stays scoped to your own accounts.

## 5. Try it

- DM the professional account from the tester account → the agent replies.
- Post something on the professional account, comment on it from the tester
  account → the opener DM lands in the tester's inbox.
- Watch it all in the trace pane at `http://127.0.0.1:3000/sim`.

If comment webhooks are quiet, the dashboard's **Webhooks → Test** button sends
a canned payload — useful for isolating tunnel vs. subscription issues.

## Optional: real discount codes (your own dev store)

Simulated codes demo the flow. For real ones on a real checkout:

1. https://partners.shopify.com → **Stores → Add store → Development store**
   (free), add a few products and shipping/return policies.
2. Store admin → **Settings → Apps and sales channels → Develop apps →
   Create app** → Admin API scope `write_discounts` → install → copy the token.
3. `.env`:
   ```
   SHOPIFY_MCP_URL=https://<your-store>.myshopify.com/api/mcp
   BRAND_NAME=<your brand>
   SHOPIFY_ADMIN_STORE=<your-store>.myshopify.com
   SHOPIFY_ADMIN_TOKEN=shpat_…
   ```
   (If the dev store's MCP catalog tools 404 or return nothing, check the store
   has a published sales channel and products; the policies tool needs policies
   filled in.)
