// All runtime configuration in one place. Everything has a dev-safe default so
// `npm start` works with an empty .env (simulator + mock LLM); secrets and the
// live-mode switches come from .env (see .env.example).

const int = (v, d) => (v && !Number.isNaN(parseInt(v, 10)) ? parseInt(v, 10) : d);
const mcpUrl = process.env.SHOPIFY_MCP_URL || 'https://gymshark.myshopify.com/api/mcp';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
const bool = (v, d) => (v === undefined || v === '' ? d : v === 'true' || v === '1');
const range = (v, d) => {
  if (!v) return d;
  const [a, b] = v.split('-').map((n) => parseInt(n, 10));
  return Number.isNaN(a) ? d : [a, Number.isNaN(b) ? a : b];
};

export const config = {
  port: int(process.env.PORT, 3000),

  // Trust boundary: webhook HMAC + the Meta dashboard verification handshake.
  appSecret: process.env.META_APP_SECRET || 'dev-app-secret',
  verifyToken: process.env.META_VERIFY_TOKEN || 'dev-verify-token',

  // Transport: 'meta' talks to graph.instagram.com, 'sim' talks to the local
  // playground. Auto-selects meta as soon as an access token is configured.
  transport: process.env.TRANSPORT || (process.env.IG_ACCESS_TOKEN ? 'meta' : 'sim'),
  igId: process.env.IG_ID || 'sim-brand-account',
  igAccessToken: process.env.IG_ACCESS_TOKEN || '',
  graphBase: process.env.GRAPH_BASE || 'https://graph.instagram.com/v23.0',

  // Reply pacing: 'natural' sends read receipts + typing indicators and paces
  // DM replies to reading speed; 'instant' fires as fast as the model returns.
  replyPacing: process.env.REPLY_PACING || 'natural',

  // LLM driver: 'openai' | 'mock'. Auto-selects openai when a key is present.
  llmDriver: process.env.LLM_DRIVER || (process.env.OPENAI_API_KEY ? 'openai' : 'mock'),
  openaiModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',

  // Shopify storefront MCP (public, unauthenticated). Point at any store —
  // picked for a deep in-stock catalog so demos don't dead-end on availability.
  mcpUrl,
  brandName: process.env.BRAND_NAME || 'Gymshark (demo)',

  // Live-walkthrough workflows. W1: the comment opener offers the promo but the
  // code unlocks only with a phone number. W2: a valid number back → confirm →
  // code + hydrated checkout link for the featured "sell it out" product.
  phoneGate: bool(process.env.PHONE_GATE, false),
  // Only comments with shopping intent trigger the opener ("another test" doesn't).
  commentIntentFilter: bool(process.env.COMMENT_INTENT_FILTER, true),
  featuredQuery: process.env.FEATURED_PRODUCT || '',
  // Numeric variant id pin — skips MCP search (new products can lag the index).
  featuredVariantId: (process.env.FEATURED_VARIANT_ID || '').replace(/\D/g, '') || '',
  // A pre-created store code shared by everyone; when empty, per-customer codes
  // are minted (real ones once the admin token is set, simulated otherwise).
  promoCode: process.env.PROMO_CODE || '',
  storeDomain: process.env.STORE_DOMAIN || hostOf(mcpUrl),

  // Opener timing, seconds, as 'min-max'. '0' fires immediately (the brief's
  // "fires fast", and the demo default).
  openerDelayS: range(process.env.OPENER_DELAY_S, [0, 0]),
  // Free-text brand instructions folded into the opener prompt (voice, musts).
  openerBrandNotes: process.env.OPENER_BRAND_NOTES || '',
  // Prompt-variant hook for the eval harness: a path to a markdown file whose
  // text is appended to BOTH the system prompt and the opener prompt, under a
  // marked "brand experiment notes" block. Empty (the default) changes nothing.
  promptNotesFile: process.env.PROMPT_NOTES_FILE || '',

  // Public comment nudge.
  publicNudge: process.env.PUBLIC_NUDGE || 'non_followers',
  publicNudgeText: process.env.PUBLIC_NUDGE_TEXT || 'sent you a dm 💬',

  // Discounts. The percent and the one-code-per-customer rule live HERE, in
  // code — the model can request a code but can never set its terms.
  discountPercent: int(process.env.DISCOUNT_PERCENT, 20),
  openerIncludesDiscount: bool(process.env.OPENER_DISCOUNT, true),
  shopifyAdminStore: process.env.SHOPIFY_ADMIN_STORE || '',
  shopifyAdminToken: process.env.SHOPIFY_ADMIN_TOKEN || '',

  // --- shipment tracking -------------------------------------------------
  // Orders are a SEPARATE grant from discounts: the admin token above is denied
  // protected customer data (ACCESS_DENIED on any order read), so order reads
  // and webhook registration use a custom app's token with read_orders /
  // read_fulfillments. Unset → every order path is a traced no-op.
  shopifyOrdersToken: process.env.SHOPIFY_ORDERS_TOKEN || '',
  // The secret Shopify signs webhook bodies with (base64 HMAC-SHA256 over the
  // raw bytes). Unset → /webhooks/shopify refuses every non-simulated call with
  // 503 rather than ingesting data nobody verified.
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET || '',
  // EasyPost tracker API — checkpoint-level carrier telemetry. Unset → trackers
  // are simulated locally and only loopback tracker events are accepted.
  easypostApiKey: process.env.EASYPOST_API_KEY || '',
  // Where Shopify and EasyPost reach us (the ngrok ingress), for registration.
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',

  // Protects the /admin dashboard on the public tunnel. Empty = local dev only.
  adminKey: process.env.ADMIN_KEY || '',

  dbPath: process.env.DB_PATH || 'data/concierge.db',

  // Kosha (Supabase) mirror. Empty = off: SQLite stays the only store and the
  // concierge behaves exactly as it does today. The brand is resolved by SELECT
  // at boot; this only says WHICH brand's instagram inbox to bind to.
  databaseUrl: process.env.DATABASE_URL || '',
  supabaseBrandId: process.env.SUPABASE_BRAND_ID || 'saru-dev-lab',
};
