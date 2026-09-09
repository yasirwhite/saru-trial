// The "sell it out" promotion's hydrated checkout link: a Shopify cart
// permalink that opens checkout with the featured product already in the cart
// and the discount code already applied — the customer never types anything.
import { config } from '../config.js';
import { listTools, callTool } from './mcp-client.js';
import { applyDiscountToUrl } from './discounts.js';
import { featuredVariantId, featuredTitle } from '../flows/workflow-settings.js';
import { trace } from '../sim/trace.js';

let cachedVariant = null; // numeric variant id, resolved once per process
let cachedFor = null;     // the title that cachedVariant was resolved from

// Resolve the featured product's first in-stock variant via the storefront MCP.
export async function resolveFeaturedVariant() {
  // Explicit pin wins: immune to storefront search-index lag on new products.
  // A dashboard-written setting outranks the env pin (re-aimable without a restart).
  const pinned = featuredVariantId();
  if (pinned) return pinned;
  const query = featuredTitle();
  if (!query) return null;
  // Re-resolve when the operator retitles the promotion mid-run.
  if (cachedVariant && cachedFor === query) return cachedVariant;
  try {
    const names = (await listTools()).map((t) => t.name);
    // Prefer a discovered CATALOG search (never the policies/FAQ search), and
    // fall back to the standard name — some stores serve search_catalog
    // without advertising it in tools/list.
    const search = names.find((n) => /search.*(catalog|products?)/.test(n))
      || names.find((n) => /search/.test(n) && !/polic|faq/.test(n))
      || 'search_catalog';
    const raw = await callTool(search, { query, context: 'featured promotion product' });
    // First AVAILABLE variant of the first product wins; fall back to any id.
    const gids = [...raw.matchAll(/gid:\/\/shopify\/ProductVariant\/(\d+)/g)].map((m) => m[1]);
    if (!gids.length) throw new Error(`no variants found for "${query}"`);
    // Tolerant parse: these payloads can arrive truncated mid-stream — recover
    // the valid prefix instead of losing the ranking (same trick as tools.js).
    const data = (() => {
      try { return JSON.parse(raw); } catch (e) {
        const at = /position (\d+)/.exec(e.message || '');
        if (at) { try { return JSON.parse(raw.slice(0, +at[1])); } catch { return null; } }
        return null;
      }
    })();
    // Search relevance can put a sibling product first — prefer the product
    // whose TITLE actually matches the featured query's words.
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const ranked = (data?.products || [])
      .map((p) => ({ p, score: words.filter((w) => (p.title || '').toLowerCase().includes(w)).length }))
      .sort((a, b) => b.score - a.score);
    let picked = gids[0];
    for (const { p } of ranked) {
      const v = (p.variants || []).find((x) => x.availability?.available && /(\d+)$/.test(x.id || ''))
        || (p.variants || []).find((x) => /(\d+)$/.test(x.id || ''));
      if (v) { picked = v.id.match(/(\d+)$/)[1]; break; }
    }
    cachedVariant = picked;
    cachedFor = query;
    trace('promo', `featured "${query}" resolved to variant ${picked}`);
    return picked;
  } catch (err) {
    trace('error', `featured variant resolve failed (link degrades to code-only): ${err.message}`);
    return null;
  }
}

export async function buildFeaturedLink(code) {
  const variant = await resolveFeaturedVariant();
  if (!variant || !config.storeDomain) return null;
  // Prefer a real MCP cart: its checkout_url goes straight into checkout,
  // which stays reachable even when a dev store's pages sit behind a password.
  try {
    const raw = await callTool('update_cart', {
      add_items: [{ product_variant_id: `gid://shopify/ProductVariant/${variant}`, quantity: 1 }],
    });
    const m = raw.match(/https?:[^"\s\\]*\/cart\/c\/[^"\s\\]*/);
    if (m) return applyDiscountToUrl(m[0].replace(/\\u0026/g, '&'), code);
  } catch (err) {
    trace('error', `cart checkout link failed, falling back to permalink: ${err.message}`);
  }
  return `https://${config.storeDomain}/cart/${variant}:1${code ? `?discount=${encodeURIComponent(code)}` : ''}`;
}
