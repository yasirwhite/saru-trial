# saru-ig-concierge

An AI concierge that lives in a brand's Instagram DMs. DMing the account feels
like texting a good store associate: an agent loop reasons over the thread,
calls the store's Shopify tools (over MCP) when it needs facts, and answers
short and casual. When someone comments on a brand post, the flagship workflow
fires: fetch who they are, mint them a discount code, and open the conversation
with one genuinely personalized DM — the single private reply Meta allows per
comment.

## Run it in 60 seconds (no keys needed)

```
npm install
npm start          # → http://127.0.0.1:3000/sim
```

With an empty `.env` the app boots in **simulator mode**: a local playground
plays Instagram (left: the phone; right: a live system trace). Comment on the
fake post and watch the webhook arrive, get verified, the profile fetch, the
discount mint, and the opener send. Then reply as the customer and talk to the
agent — Shopify calls are real MCP traffic against a live storefront.

Two demo buttons exercise the trust boundary on purpose:
- **redeliver last webhook** — Meta redelivers; the duplicate is a traced no-op
- **tamper signature** — a forged HMAC gets a 401 and the payload is never parsed

`npm run smoke` proves all of it headlessly (handshake, forged-signature
rejection, one-shot opener, idempotent redelivery, live MCP catalog/cart/policy
calls) using a deterministic mock LLM driver.

To talk to the real model: paste an `OPENAI_API_KEY` into `.env` (copy
`.env.example`). To go live against Instagram: follow `SETUP.md`, paste the
Meta credentials, restart — the transport flips automatically.

## Architecture

```
Instagram ──webhook──▶ verify HMAC ──▶ dedupe ──▶ router ─┬─▶ dm-reply ────▶ agent loop ─▶ send DM
   ▲                (raw bytes, 401)  (event id)          └─▶ comment-to-dm ─▶ opener ──▶ private reply
   │                                                            │
   └────────────── the sim playground stands in ◀───────────────┘
                   for all of this locally            profile fetch · discount mint
```

The agent loop (`src/agent/loop.js`) has no intent routing: the model sees the
thread plus every tool the store's MCP server advertises (discovered live via
`tools/list`, schemas passed through) and decides what to call. Tool errors are
returned to the model as text, so failures degrade in-conversation instead of
crashing the turn.

### File map

```
src/
  server.js            route map — read this first
  config.js            every knob, one file
  webhooks/verify.js   HMAC over raw bytes + the GET handshake (the trust boundary)
  webhooks/router.js   verified envelope → typed events; identity comes from HERE
  agent/loop.js        the agent loop (the heart)
  agent/llm.js         llm drivers: openai (real) | mock (deterministic, for tests)
  agent/prompts.js     every word the model is told — voice + honesty rails
  agent/shorten.js     DM-length contract: strip markdown, ≤2 bubbles
  shopify/mcp-client.js minimal MCP client (JSON-RPC over streamable HTTP)
  shopify/tools.js     discovered MCP tools + native issue_discount_code
  shopify/discounts.js code-gated minting: percent/limits fixed here, not by the model
  instagram/send.js    the only outbound path (DM + private reply), meta|sim
  instagram/profile.js personalization surface (profile + post caption), best-effort
  flows/dm-reply.js    inbound DM → loop → send, 24h window enforced
  flows/comment-to-dm.js  the flagship, one-shot ledger + 7-day window
  store/db.js          sqlite: threads, messages, dedupe, ledgers
  sim/                 the Instagram stand-in (playground UI + trace bus)
scripts/smoke.js       end-to-end proof, no keys required
```

## Design notes worth knowing

- **Identity comes from transport.** The IGSID/comment author flow from the
  verified webhook into the flows; the model never chooses a recipient, and a
  customer typing "act as the owner" changes nothing.
- **One-shot opener, enforced twice.** Meta allows exactly one private reply
  per comment (within 7 days). The ledger claims the comment *before* sending —
  a crash can lose an opener, never double-send one.
- **Discount terms are code, not prose.** The model can ask for the customer's
  code but the percent, single-use limit, expiry, and one-per-customer rule
  live in `discounts.js`. Prompt injection can't negotiate 90% off.
- **Tool names are discovered, not assumed.** Live stores currently expose
  `search_catalog` (the docs still say `search_shop_catalog` in places), and
  some stores expose only a subset — `tools/list` is the source of truth.
- **Non-followers get a public nudge.** A private reply to someone who doesn't
  follow the brand lands in their Requests folder, unnotified. The flagship
  flow posts "sent you a dm 💬" under a non-follower's comment so the opener
  (and its expiring discount) actually gets seen (`PUBLIC_NUDGE` in config).

## What I'd build next

- Real per-code redemption tracking (webhook from Shopify on order create) to
  measure comment→DM conversion, the number this exists to move.
- A review queue: low-confidence agent replies held for a human, with one-tap
  approve in Slack.
- Media handling (customers send screenshots constantly) and story-reply
  triggers as a second opener surface.
- Multi-brand tenancy: per-brand config rows (voice, store, discount policy)
  instead of env vars; the code is already shaped for it.
