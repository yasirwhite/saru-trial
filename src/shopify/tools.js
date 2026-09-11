// The agent's tool surface = every tool the store's MCP server advertises
// (discovered live, schemas passed through untouched) + one native tool for
// discounts.
import { listTools, callTool } from './mcp-client.js';
import { ensureDiscount, applyDiscountToUrl } from './discounts.js';
import { getDiscount } from '../store/db.js';
import { orderStatusFor } from '../shipping/status.js';
import { trace } from '../sim/trace.js';

const RESULT_CAP = 6000; // keep giant tool payloads from flooding the context

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
        "Look up THIS customer's order and where their package physically is right now: order number, "
        + 'shipment status, the carrier\'s latest scan (message, city, time), the estimated delivery date '
        + 'and a tracking link. Call it for any "where\'s my order", "did it ship", "when does it arrive" '
        + 'question. If no order is linked to this conversation it says so — say that plainly rather than guessing.',
      // no arguments: the order is whichever one is linked to this thread, so
      // the model cannot look up a stranger's order by typing a number.
      parameters: { type: 'object', properties: {}, additionalProperties: false },
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

  // Runs one tool call.
  async function run(name, argsJson) {
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
      if (name === 'order_status') return JSON.stringify(orderStatusFor(ctx.igsid));
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
