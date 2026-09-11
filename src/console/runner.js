// Runs a suite against the sim child and turns what happened into verdicts.
//
// One run at a time: the child impersonates ONE customer, so two suites racing
// would interleave in the same thread and every verdict would be a lie.
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { listTools, callTool } from '../shopify/mcp-client.js';
import { trace } from '../sim/trace.js';
import { SUITES, suiteById, CAPABILITIES } from './scenarios.js';
import {
  ensureChild, childState, injectDm, resetThread, seedOrder, operatorSend,
  childInfo, childSetting, childDiscount, childCollected, CONSOLE_IGSID,
} from './child.js';

const runs = new Map(); // suiteId → the last run
let running = null;
let queue = Promise.resolve();

// --- grounding: what the store actually says right now --------------------
// The checks compare the agent's numbers against the store's own, so the
// console fetches the catalog itself rather than taking the agent's word for
// what it saw. Cached: a suite is judged against one snapshot of the truth.
let snapshot = null;
const SNAPSHOT_TTL = 10 * 60 * 1000;

async function storeSnapshot() {
  if (snapshot && Date.now() - snapshot.at < SNAPSHOT_TTL) return snapshot;
  const out = { at: Date.now(), text: '', products: [], featured: null, ingredients: [] };
  try {
    const names = (await listTools()).map((t) => t.name);
    const search = names.find((n) => /search.*(catalog|products?)/.test(n)) || 'search_catalog';
    const raw = await callTool(search, { query: 'best sellers', context: 'capability console grounding' });
    out.text += raw;
    out.products = [...raw.matchAll(/"title":"([^"]+)"/g)].map((m) => m[1]).slice(0, 20);
  } catch (err) {
    trace('console', `store snapshot: catalog search failed (${err.message}) — price checks fall back to tool results`);
  }
  // The featured product is pinned by variant id (the storefront search index
  // lags new products), so resolve it the way the promo link does — through a
  // cart — and then read its real details, ingredients included.
  if (config.featuredVariantId) {
    try {
      const cart = await callTool('update_cart', {
        add_items: [{ product_variant_id: `gid://shopify/ProductVariant/${config.featuredVariantId}`, quantity: 1 }],
      });
      const productId = (cart.match(/"product":\{"id":"(gid:\/\/shopify\/Product\/\d+)"/) || [])[1];
      if (productId) {
        const details = await callTool('get_product_details', { product_id: productId });
        out.text += `\n${details}`;
        out.featured = {
          id: productId,
          title: (details.match(/"title":"([^"]+)"/) || [])[1] || null,
          description: (details.match(/"description":"((?:[^"\\]|\\.)*)"/) || [])[1] || '',
        };
        // Prefer a real INCI list. A product description can also carry the
        // sentence "ingredient information is not specified", and reading that
        // as the list would make every check downstream meaningless.
        const desc = out.featured.description;
        const inci = /ingredients?\s*\(inci\)\s*:?\s*([^.]{10,800})/i.exec(desc)
          || [...desc.matchAll(/ingredients?\s*:?\s*([^.]{10,800})/gi)].find((m) => (m[1].match(/,/g) || []).length >= 3);
        if (inci) {
          out.ingredients = inci[1].split(/[,;]/).map((s) => s.replace(/[^a-z0-9 -]/gi, '').trim().toLowerCase())
            .filter((s) => s.length > 2 && s.length < 40);
        }
      }
    } catch (err) {
      trace('console', `store snapshot: featured product lookup failed (${err.message})`);
    }
  }
  snapshot = out;
  trace('console', `store snapshot — ${out.products.length} catalog titles, featured "${out.featured?.title || 'none'}", ${out.ingredients.length} ingredient(s) on file`);
  return snapshot;
}

// --- watching the child ---------------------------------------------------

const dmsSince = (state, since) => state.outbound.filter((o) => o.kind === 'dm' && o.at >= since);
const tracesSince = (state, since) => state.traces.filter((t) => t.at >= since);

// Wait for the agent to finish talking: something must arrive, and then the
// thread has to go quiet (multi-bubble replies land one at a time).
async function settle(since, { timeout = 45000, quiet = 1600, need = 1 } = {}) {
  const t0 = Date.now();
  let state = await childState();
  let count = dmsSince(state, since).length;
  let lastChange = Date.now();
  while (Date.now() - t0 < timeout) {
    await sleep(250);
    state = await childState();
    const n = dmsSince(state, since).length;
    if (n !== count) { count = n; lastChange = Date.now(); }
    if (count >= need && Date.now() - lastChange > quiet) return state;
  }
  return state;
}

// Pair each tool call with the result it returned (src/shopify/tools.js traces
// both) so a check can ask "was this number in the answer the tool gave?".
function toolCallsFrom(traces) {
  const calls = [];
  for (const t of traces) {
    const sp = t.text.indexOf(' ');
    const name = sp > 0 ? t.text.slice(0, sp) : t.text;
    const rest = sp > 0 ? t.text.slice(sp + 1) : '';
    if (t.kind === 'tool') calls.push({ name, args: rest, result: '' });
    else if (t.kind === 'tool-result') {
      const open = [...calls].reverse().find((c) => c.name === name && !c.result);
      if (open) open.result = rest;
      else calls.push({ name, args: '', result: rest });
    }
  }
  return calls;
}

function escalationFields() {
  const raw = childCollected(CONSOLE_IGSID);
  const status = raw['escalation.status'] || null;
  return {
    raw,
    escalation: status ? {
      status,
      question: raw['escalation.question'] || '',
      reason: raw['escalation.reason'] || '',
      at: parseInt(raw['escalation.at'], 10) || null,
      followupSent: !!raw['escalation.followup_sent'],
    } : null,
  };
}

// --- running a suite ------------------------------------------------------

async function execute(suite) {
  const run = {
    suiteId: suite.id,
    capability: suite.capability,
    title: suite.title,
    why: suite.why,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    steps: [],
    passed: 0,
    failed: 0,
    error: null,
    driver: null,
  };
  runs.set(suite.id, run);

  const child = await ensureChild();
  run.driver = child.driver;
  const store = await storeSnapshot();

  await resetThread();
  const seed = suite.seed ? await seedOrder({ igsid: CONSOLE_IGSID }) : null;
  run.seed = seed && { order: seed.orderName, tracking: `${seed.carrier} ${seed.trackingCode}`, scan: `${seed.message} — ${seed.city}, ${seed.state}`, eta: seed.eta, details: seed.hasAddressColumn ? 'address + items + codes' : 'basic order only' };

  let allToolText = '';
  // Every agent message of the run so far. Some behavior is on a timer, not on
  // a turn — the escalation courtesy dm can land during whichever step happens
  // to be open — so a check has to be able to look at the whole conversation.
  const allBubbles = [];

  for (const step of suite.steps) {
    const since = Date.now() - 1;
    const rec = {
      kind: step.wait ? 'wait' : step.operator ? 'operator' : 'customer',
      customer: step.customer || null,
      operator: step.operator || null,
      label: step.wait || null,
      why: step.why || null,
      bubbles: [],
      tools: [],
      checks: [],
      ms: 0,
    };
    run.steps.push(rec);

    let state;
    if (step.wait) {
      // An unprompted message: nobody asks, the agent decides. Wait out the
      // courtesy threshold plus slack, and take whatever (if anything) arrives.
      const waitMs = Math.round(config.consoleFollowupMin * 60 * 1000) + 7000;
      state = await settle(since, { timeout: waitMs, quiet: 1200 });
    } else if (step.operator) {
      const res = await operatorSend(CONSOLE_IGSID, step.operator);
      rec.operatorStatus = res.status;
      // Poll rather than sleep: the send is captured a beat after the endpoint
      // answers, and a fixed nap drops the operator's own message from the
      // transcript often enough to be confusing.
      state = await settle(since, { timeout: 8000, quiet: 500 });
    } else {
      await injectDm(step.customer);
      state = await settle(since);
    }

    rec.ms = Date.now() - since;
    rec.bubbles = dmsSince(state, since).map((o) => o.text);
    // The operator's own dm is shown as the operator, not as the agent — and
    // the checks on that step are about what the AGENT did, which is nothing.
    if (step.operator) rec.bubbles = rec.bubbles.filter((b) => b.trim() !== step.operator.trim());
    const traces = tracesSince(state, since);
    const tools = toolCallsFrom(traces);
    rec.tools = tools.map((t) => ({ name: t.name, args: t.args.slice(0, 160), result: t.result.slice(0, 240) }));
    rec.traceKinds = [...new Set(traces.map((t) => t.kind))];
    allToolText += `\n${tools.map((t) => t.result).join('\n')}`;

    allBubbles.push(...rec.bubbles);

    const { escalation, raw } = escalationFields();
    const ctx = {
      customer: step.customer || '',
      bubbles: rec.bubbles,
      allBubbles,
      reply: rec.bubbles.join('\n'),
      tools,
      toolText: tools.map((t) => t.result).join('\n'),
      allToolText,
      traces,
      store,
      seed,
      escalation,
      escalationRaw: raw,
      mode: childSetting(`mode:${CONSOLE_IGSID}`) === 'human' ? 'human' : 'agent',
      discount: childDiscount(CONSOLE_IGSID),
    };

    for (const c of step.checks) {
      let verdict;
      try {
        const r = c.run(ctx);
        verdict = typeof r === 'boolean' ? { pass: r, observed: '' } : r;
      } catch (err) {
        verdict = { pass: false, observed: `check threw: ${err.message}` };
      }
      rec.checks.push({ id: c.id, label: c.label, expect: c.expect, pass: !!verdict.pass, observed: verdict.observed || '' });
      if (verdict.pass) run.passed++; else run.failed++;
    }
  }

  run.status = 'done';
  run.finishedAt = Date.now();
  trace('console', `suite ${suite.id}: ${run.passed}/${run.passed + run.failed} controlled`);
  return run;
}

export function runSuite(id) {
  const suite = suiteById(id);
  if (!suite) throw new Error(`unknown suite ${id}`);
  // Serialized, not refused: the founder clicking three Run buttons should get
  // three runs, in order, not two errors.
  queue = queue.then(async () => {
    running = suite.id;
    try {
      await execute(suite);
    } catch (err) {
      const run = runs.get(suite.id) || { suiteId: suite.id, capability: suite.capability, title: suite.title, steps: [], passed: 0, failed: 0 };
      run.status = 'error';
      run.error = err.message;
      run.finishedAt = Date.now();
      runs.set(suite.id, run);
      trace('console', `suite ${suite.id} failed to run: ${err.message}`);
    } finally {
      running = null;
    }
  });
  return queue;
}

export function runAll() {
  for (const s of SUITES) runSuite(s.id);
  return queue;
}

export function consoleState() {
  return {
    child: childInfo(),
    running,
    queued: SUITES.filter((s) => runs.get(s.id)?.status === 'running').map((s) => s.id),
    capabilities: CAPABILITIES.map((c) => ({
      ...c,
      suites: SUITES.filter((s) => s.capability === c.id).map((s) => ({
        id: s.id, title: s.title, why: s.why, steps: s.steps.length, seeded: !!s.seed,
      })),
    })),
    runs: Object.fromEntries([...runs.entries()]),
  };
}
