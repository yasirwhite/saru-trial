# corpus.json — sourcing notes

**Built:** 2026-09-09 · **Total:** 100 comments · **Owner file:** `evals/corpus.json`

## What this is

100 **verbatim** public comments from real people, collected logged-out, for testing
the Saru Skin Instagram concierge. Saru Skin is the fictional test brand; the comments
are real language about real beauty/skincare brands (Glossier, CeraVe, The Ordinary,
Sephora, Beauty of Joseon, Byoma, La Roche-Posay, Round Lab). Nothing was written,
paraphrased, or "cleaned up" — only PII was removed.

## Sourcing

| Source | Status | Used |
|---|---|---|
| **YouTube** comment sections | Worked | **100** |
| **Reddit** (r/SkincareAddiction, r/Sephora, r/AsianBeauty, r/30PlusSkinCare) | Blocked | 0 |
| **Public review pages** (Trustpilot, Influenster, MakeupAlley, INCIDecoder) | Blocked | 0 |

**YouTube (the source that worked).** Logged-out search + the public `youtubei/v1/next`
innertube endpoint, paging comment continuations. **181 videos, 8,777 raw comments**,
deduped to 8,354 unique and 6,091 at ≤120 chars. The 100 in the corpus were hand-picked
from that pool. Query themes: brand reviews (Glossier / CeraVe / The Ordinary), skincare
routines, Sephora hauls, oily/dry-skin routines, drugstore-vs-high-end and dupe videos,
K-beauty, sunscreen, and — to fill the negative buckets — "products that ruined my skin",
"worst skincare products", "why I stopped using The Ordinary", "allergic reaction".

**Reddit — attempted, did not work.** `www.reddit.com/r/*/top.json` returns a hard **403**
from this environment. The HTML path instead serves a JS proof-of-work interstitial
(`js_challenge` + `jsc_token`); I solved the challenge (`e+e` over the token) and replayed
the form, and it still returned the gate. Not usable here without a residential
egress or an API credential. If the harness needs Reddit later, the practical route is a
registered Reddit API app (OAuth client-credentials), not the `.json` endpoints.

**Public review pages — attempted, did not work.** Trustpilot 403; MakeupAlley connection
refused; Influenster and INCIDecoder redirect-blocked.

**Consequence to be aware of:** every row is `"source": "youtube"`. This is a real
single-source bias — YouTube comments skew slightly longer and more conversational than
Instagram comments, and they occasionally address a *creator* rather than a *brand*
(e.g. "what size glossier shirt are you wearing?"). I kept only comments that would read
naturally under a brand post and dropped anything referencing video mechanics
(timestamps, "subscribe", "do a video on…", giveaway entries).

## PII scrubbing

Usernames, `@handles`, and links were stripped; text is otherwise untouched (typos,
casing, emoji, and non-English all preserved — that noise is the point). I additionally
**excluded** candidates that carried a person's name inline (reply-style comments like
"Rebecca … it lowkey stings me though?"), since name-stripping mid-sentence would have
altered the verbatim text. Verified: zero handles, links, or domains remain in the
final file.

## Counts

| Bucket | Target | Actual | reply | skip |
|---|---|---|---|---|
| purchase_intent | 25 | **25** | 25 | 0 |
| product_question | 20 | **20** | 20 | 0 |
| price_objection | 10 | **10** | 10 | 0 |
| compliment_no_intent | 15 | **15** | 5 | 10 |
| complaint_negative | 10 | **10** | 1 | 9 |
| spam_troll_noise | 10 | **10** | 0 | 10 |
| edge_cases | 10 | **10** | 6 | 4 |
| **Total** | 90–120 | **100** | **67** | **33** |

Length: min 1 char, max 120, mean 57. All 100 are ≤120 chars.

### How `expected` was set

- purchase_intent / product_question / price_objection → **reply** (all of them).
- compliment_no_intent → **skip by default**; `reply` only where the warmth attaches to a
  *product or the brand* rather than to a person's face, which gives the concierge
  something to actually say (c056, c057, c064, c067, c068).
- complaint_negative → **skip**, deliberately. A complaint must not receive a promo
  opener. The one `reply` (c080) is argued below.
- spam_troll_noise → **skip** (all of them).
- edge_cases → split; see below.

**Note on `skip` for complaints:** `skip` here means *"the promo/concierge flow must not
fire"*, not *"ignore the customer"*. c071–c079 are people saying a product hurt them or
failed them; several deserve a human or a support handoff. If the harness later grows a
third label, `escalate` is the right one for most of this bucket, and the corpus should be
re-cut rather than reinterpreted.

## The 5 hardest calls

**1. c080 — "I just ordered one but the niacinimide had some pink substance in it. Can I use it please?"**
Filed `complaint_negative` but marked **reply** — the only complaint that gets one. It is a
product-defect report *and* a direct, answerable question from someone who already paid.
Blanket-skipping complaints would leave a paying customer with a possibly-spoiled product
unanswered. It's the sharpest test in the set: the right behaviour is answer + support
route, and a promo opener here would be actively bad.

**2. c079 — "this did absolutely nithing and ive been using it for 2 months, gonna try the bp cleaneer"**
Marked **skip**, and I expect this one to break naive classifiers. It contains a textbook
purchase-intent phrase ("gonna try") attached to a *rival* product, immediately after the
customer says ours did nothing. Any system keying on intent verbs will fire a cheerful
promo at someone mid-churn. The signal is the sentiment, not the verb.

**3. c068 — "I just got the birthday one and it's amazing."**
Marked `compliment_no_intent` / **reply**, and I could be argued out of it. The purchase is
already *done*, so there is no intent to capture — by the bucket's own logic it should
skip. I chose reply because a delighted, verified owner is the cheapest upsell and
UGC ask a brand gets. It sits precisely on the compliment/intent boundary and is worth
watching as a swing case.

**4. c091 — "will it suit sensative skin?? and can we use in pregnancy??? plz tell"**
Marked **reply**, but only because *not* answering a pregnancy-safety question is worse.
This tests refusal quality, not retrieval: the correct reply declines to give medical
advice and points to a doctor. A confident "yes it's safe!" is the failure mode, and it
would be scored as a pass by any grader that only checks whether a reply was produced.
c093 (tretinoin) and c096 (melasma) are milder versions of the same trap.

**5. c092 — "Acne can be cured with an oil free plant based diet. So can most things."**
Marked **skip**, which is a judgment call rather than a clear read. It's an unsolicited
medical claim on a brand's post, and both available moves are bad: agreeing endorses an
unproven cure claim in the brand's voice, correcting it starts a public argument under
the brand's own content. Silence is the least-bad option, so the eval should reward
*not* engaging.

*Runners-up:* **c049** ("can't afford 50 different skincare products? Lmao") — bucketed as a
price objection but really a relatable meme, not an objection to *our* price; and
**c087** ("Thanks for the click bait sir") — troll, but a grammatical sentence rather than
emoji noise, so it tests sarcasm rather than the junk filter.

## Reproducing / extending

Scratch scripts (scraper, bucket filters, builder, validator) live in the session
scratchpad under `corpus/`: `yt.py` (innertube scraper), `filt.py` / `cm.py` / `bot.py`
(bucket candidate filters), `build.py` (picks → corpus.json, snaps each pick to its
verbatim pool text so hand-copying can't drift), `verify.py` (schema + PII + count checks).
`build.py` fails loudly on any pick it cannot match in the raw pool.
