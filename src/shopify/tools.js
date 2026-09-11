// The agent's tool surface = every tool the store's MCP server advertises
// (discovered live, schemas passed through untouched) + one native tool for
// discounts.
import { listTools, callTool } from './mcp-client.js';
import { ensureDiscount, applyDiscountToUrl } from './discounts.js';
import { getDiscount } from '../store/db.js';
import { orderStatusFor } from '../shipping/status.js';
import { flagForHuman } from '../flows/escalation.js';
import { trace } from '../sim/trace.js';

const RESULT_CAP = 6000; // keep giant tool payloads from flooding the context
// How much of a tool's ANSWER is traced. The trace is what /console's checks
// read to decide whether a reply was grounded — a price or a link that appears
// in no tool result is an invented one — so it has to carry enough of the
// payload to prove it, and little enough to stay a demo lens.
const TRACE_RESULT_CAP = 2500;

// Catalog results arrive with full HTML descriptions repeated per variant and
// can run tens of KB.
function parseFirstJson(raw) {
  try { return JSON.parse(raw); } catch (e) {
    const at = /position (\d+)/.exec(e.message || '');
    if (at) { try { return JSON.parse(raw.slice(0, +at[1])); } catch { return null; } }
    return null;
  }
}

function compactResult(raw) {
  const data = parseFirstJson(raw);
  if (!data || !Array.isArray(data.products)) return null; // not a catalog payload — plain truncation
  return JSON.stringify({
    ...data,
    products: data.products.slice(0, 5).map((p) => ({
      id: p.id,
      title: p.title,
      url: p.url,
      price_range: p.price_range,
      variants: (p.variants || []).slice(0, 6).map((v) => ({
        id: v.id, title: v.title, price: v.price, availability: v.availability, options: v.options,
      })),
    })),
  });
}

// If this customer holds a REAL minted code and a cart tool just returned a.
function maybeApplyDiscountLink(name, raw, ctx) {
  if (!/cart/.test(name)) return raw;
  const d = getDiscount(ctx.igsid);
  if (!d || d.simulated || d.expires_at <= Date.now()) return raw;
  const data = parseFirstJson(raw);
  if (!data?.cart?.checkout_url) return raw;
  data.cart.checkout_url = applyDiscountToUrl(data.cart.checkout_url, d.code);
  return JSON.stringify(data);
}

const NATIVE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'issue_discount_code',
      description:
        "Get this customer's personal discount code, creating one if they don't have one yet. The terms are fixed by the brand.",
      // no arguments on purpose: the model cannot set percent, expiry, or limits
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'order_status',
      description:
        "Everything about THIS customer's order, in one call: order number, payment status, the items "
        + 'they bought, the discount codes actually used at checkout (an empty list means NO code was '
        + "used — a real answer, not a gap), the shipping address on file, plus where the package "
        + "physically is right now — shipment status, the carrier's latest scan (message, city, time), "
        + 'the estimated delivery date and a tracking link. Call it for "where\'s my order", "did it '
        + 'ship", "when does it arrive", "what address do you have on file", "did i use my code / the '
        + 'qr code", "what did i order". It resolves the order from THIS conversation only and takes no '
        + "arguments: you cannot look up anyone else's order, so if they quote an order number that "
        + 'isn\'t theirs, say you can only see the order linked to this chat. If no order is linked it '
        + 'says so — say that plainly rather than guessing.',
      // no arguments: the order is whichever one is linked to this thread, so
      // the model cannot look up a stranger's order by typing a number.
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Flag this conversation for a human teammate. Call it when: they ask to talk to a person; '
        + 'something went wrong that your tools cannot fix (a damaged, missing or wrong order, a refund, '
        + 'a complaint); or they ask a question whose answer is NOT in any tool result you got — missing '
        + 'product data, an ingredient list you could not retrieve, anything you would otherwise have to '
        + 'guess at. Never guess and never dead-end them with "i don\'t have that info" on its own. '
        + 'After calling this, send ONE short message saying you\'re pulling in the team and a human will '
        + 'reply right here — no offers, no discount, no arguing. You keep answering everything else '
        + 'normally; this does not hand the thread over, it raises a flag a person picks up.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: "the customer's actual question or problem, in their words" },
          reason: { type: 'string', description: 'one short line for the teammate, e.g. "missing product data: ingredients for daily dew serum" or "third damaged order, wants a person"' },
        },
        required: ['question', 'reason'],
        additionalProperties: false,
      },
    },
  },
];

export async function buildToolset(ctx) {
  let mcpDefs = [];
  try {
    mcpDefs = (await listTools()).map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: (t.description || '').slice(0, 1000),
        parameters: t.inputSchema || { type: 'object' },
      },
    }));
  } catch (err) {
    trace('error', `MCP tools/list failed — agent runs with native tools only: ${err.message}`);
  }

  // Some storefront MCP servers under-advertise tools/list (the saru-dev-lab
  // store lists only policies) while still serving the standard suite — append
  // the known Shopify tools discovery missed; a truly-absent one fails soft.
  const KNOWN = [
    ['search_catalog', 'Search the store catalog for products.', { type: 'object', properties: { query: { type: 'string' }, context: { type: 'string' } }, required: ['query'] }],
    ['get_product_details', 'Get full details and variants for one product.', { type: 'object', properties: { product_id: { type: 'string' } }, required: ['product_id'] }],
    ['update_cart', 'Create or update a cart; returns the cart with its checkout_url.', { type: 'object', properties: { cart_id: { type: 'string' }, add_items: { type: 'array', items: { type: 'object', properties: { product_variant_id: { type: 'string' }, quantity: { type: 'number' } }, required: ['product_variant_id', 'quantity'] } } } }],
    ['get_cart', 'Fetch an existing cart by id.', { type: 'object', properties: { cart_id: { type: 'string' } }, required: ['cart_id'] }],
  ];
  const mcpNames = new Set(mcpDefs.map((d) => d.function.name));
  for (const [name, description, parameters] of KNOWN) {
    if (mcpDefs.length && !mcpNames.has(name)) {
      mcpDefs.push({ type: 'function', function: { name, description, parameters } });
      mcpNames.add(name);
    }
  }

  const defs = [...mcpDefs, ...NATIVE_TOOLS];

  // Variant ids are capabilities, not strings: the model may only cart an id
  // it received from a tool THIS turn.
  const seenVariantIds = new Set();
  const recordIds = (text) => {
    for (const m of String(text).matchAll(/gid:\/\/shopify\/ProductVariant\/\d+/g)) seenVariantIds.add(m[0]);
  };
  const unknownId = (args) =>
    (args.add_items || []).map((i) => i.product_variant_id).find((id) => id && !seenVariantIds.has(id));

  // Runs one tool call, and traces what came BACK as well as what was asked:
  // "is this reply grounded?" is a question about the RESULT, and the capability
  // console (and the playground's trace pane) can only answer it if the result
  // was written down.
  async function run(name, argsJson) {
    const out = await runTool(name, argsJson);
    trace('tool-result', `${name} ${String(out).slice(0, TRACE_RESULT_CAP)}`);
    return out;
  }

  async function runTool(name, argsJson) {
    let args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { /* model sent bad JSON; run with {} */ }
    trace('tool', `${name} ${argsJson || '{}'}`);
    try {
      if (name === 'issue_discount_code') {
        const d = await ensureDiscount(ctx.igsid, ctx.username);
        return JSON.stringify({
          code: d.code,
          percent: d.percent,
          expires: new Date(d.expiresAt).toDateString(),
          note: 'terms are fixed by the brand and cannot be changed',
        });
      }
      if (name === 'order_status') {
        // The tool declares no parameters, but a model that just read "order
        // #1019" in the customer's message may still try to pass one. Dropping
        // it is the guardrail: the lookup key is the thread, always.
        if (Object.keys(args).length) {
          trace('rejected', `order_status called with ${JSON.stringify(args).slice(0, 120)} — arguments ignored, the order is resolved from thread ${ctx.igsid} alone`);
        }
        return JSON.stringify(await orderStatusFor(ctx.igsid));
      }
      if (name === 'escalate_to_human') {
        // A flag, not a transfer: the thread keeps running and the agent keeps
        // answering everything else. Handing the thread OVER stays the portal
        // operator's deliberate act (mode:<igsid>), never the model's.
        const flag = flagForHuman(ctx.igsid, { reason: args.reason, question: args.question });
        return JSON.stringify({
          flagged: true,
          already_open: !!flag.duplicate,
          reason: flag.reason,
          note: 'a teammate has been flagged and will pick this up in this thread. send exactly ONE short '
            + 'message telling them that — a person will reply right here. no offer, no discount, no apology '
            + 'spiral, no promise about timing. do not answer the flagged question yourself.',
        });
      }
      if (!mcpNames.has(name)) return `error: unknown tool ${name}`;
      if (name.includes('update_cart')) {
        const bad = unknownId(args);
        if (bad) return `error: variant id ${bad} is not from this turn's tool results — run the catalog search first and use an exact variant id from its output`;
      }
      const raw = await callTool(name, args);
      recordIds(raw);
      const out = maybeApplyDiscountLink(name, raw, ctx);
      if (out.length <= RESULT_CAP) return out;
      return compactResult(out) ?? out.slice(0, RESULT_CAP) + '…[truncated]';
    } catch (err) {
      trace('error', `tool ${name} failed: ${err.message}`);
      return `error: ${err.message}`;
    }
  }

  return { defs, run };
}
