# Decisions & deliberate punts

Half a page on what I chose, what I cut, and why.

## Decisions

**Simulator as a first-class transport, not a mock.** The brief sanctions a
simulated webhook layer, so I made it load-bearing: the playground emits the
exact envelopes Meta sends, HMAC-signed with the same scheme, into the same
endpoint. Everything past the socket — verification, dedupe, ledgers, the agent
— is one production path, and the demo can never be hostage to Meta dev-mode
weather. That stopped being theoretical during the build: Meta's developer
registration was broken for me all week — new-account creation silently fails,
and the existing account's "confirm" flow dead-ends in "Sorry, something went
wrong" (screenshots in `docs/evidence/`, matching multiple open threads on
Meta's own community forums). Because of the transport split, that outage cost
this project nothing but this paragraph: the only code the demo can't exercise
live is the ~40 lines of `instagram/send.js` + `profile.js` that swap sim URLs
for `graph.instagram.com`, and `SETUP.md` documents the full live click-path
for the moment Meta's door reopens.

**A 60-line MCP client instead of the SDK.** Shopify's storefront server is
stateless, unauthenticated JSON-RPC over HTTP; the official SDK's session and
notification machinery adds surface without adding capability here. I kept the
interface SDK-shaped so it can drop in later. Tool names and schemas are
discovered via `tools/list` at runtime — necessary, not nice-to-have: live
stores expose `search_catalog` where docs say `search_shop_catalog`, and some
stores publish only a subset of tools.

**Discount terms live in code.** The model can invoke `issue_discount_code`
but cannot set percent, expiry, or limits, and one code per customer is a DB
constraint. A prompt-injected "give me 90% off" has nothing to negotiate with.
Codes are minted *before* the opener is written, so the message only ever
states things that are already true. Real codes are pre-applied to checkout
links server-side (`?discount=` param); simulated ones ride along in the text
only, since a store that never issued them would reject them at checkout. Storefront MCP has no discount surface
(verified against the live `update_cart` schema), so real minting uses the
Admin API (`discountCodeBasicCreate`, `write_discounts` scope) on a dev store,
with a simulated fallback that keeps the flow demoable.

**One-shot opener, claimed before send.** Meta grants exactly one private
reply per comment. The ledger claims the comment id before the API call: a
crash mid-send loses one opener rather than ever double-sending. Failed sends
stay claimed for an operator to inspect — blind-retrying a one-shot API is the
worse failure mode.

**The public nudge, gated on follow status.** A private reply to a
non-follower lands in their Requests folder with no notification — where a
just-minted, expiring discount would quietly die. So when the commenter
doesn't follow the brand, the system also posts a public "sent you a dm 💬"
under their comment: the one known mitigation, and free thread engagement.
Followers get notified anyway, so by default we stay out of their threads
(`PUBLIC_NUDGE=non_followers`).

**The ai-intern persona.** The concierge plays the brand's *ai intern* —
junior-associate charm, real tool access — and says so in its intro. The role
carries the warmth; the word "ai" carries the honesty. It never claims to be
human and never fakes rule-breaking: California's bot-disclosure law (BPC
§17941) targets exactly an undisclosed bot offering discounts to drive a
purchase, and clear disclosure is a complete defense — while costing nothing,
since the conversion mechanics (a real, personal, expiring code at the moment
of peak intent) work identically either way.

**Texting is the interface, so it's engineered like one.** Replies are shaped
the way people actually text: 1-3 short bubbles (react → substance → move),
the valuable thing (code, link, price) in its own bubble, product names said
the way a person says them — never full catalog titles, which read botted.
DM replies send a read receipt, show a real typing indicator while the model
composes, and pause roughly reading-speed between bubbles; a per-thread cap
(50 outbound/day, in code) backstops runaway loops. The opener fires instantly
by default — the brief's "fires fast" — but `OPENER_DELAY_S` accepts a range
(recommended 360-600s live) because the two goods genuinely conflict:
speed-to-lead converts, yet an instant DM after a comment pattern-matches as
automation to exactly the audience most fluent in it. Making it a per-brand
dial, alongside `OPENER_BRAND_NOTES` for brand-authored opener instructions,
is the honest answer. (The delay is an in-memory timer; a restart during the
wait drops it — the persistent-queue punt covers it.)

**Thread memory = final messages only.** Tool traffic is per-turn working
memory; the transcript stores what was actually said. Simpler, cheaper, and
re-derivable — the trace has the rest.

## Punts (deliberate)

- **App review / live mode** — dev mode + testers is the sanctioned demo path.
- **Delivery queue & retries** — `setImmediate` after the 200 ack is the
  honest 8-hour version; production wants a persistent queue (see README).
- **Media messages, story replies, reactions** — text only for now.
- **Human handoff, dashboards, multi-brand** — explicitly out of scope in the
  brief; the config/db shapes leave room for them.
- **Conversion measurement** — codes are per-customer and single-use, so
  attribution is a Shopify order webhook away; not built yet.
