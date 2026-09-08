// All runtime configuration in one place. Everything has a dev-safe default so
// `npm start` works with an empty .env (simulator + mock LLM); secrets and the
// live-mode switches come from .env (see .env.example).

const int = (v, d) => (v && !Number.isNaN(parseInt(v, 10)) ? parseInt(v, 10) : d);
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
  mcpUrl: process.env.SHOPIFY_MCP_URL || 'https://gymshark.myshopify.com/api/mcp',
  brandName: process.env.BRAND_NAME || 'Gymshark (demo)',

  // Opener timing, seconds, as 'min-max'. '0' fires immediately (the brief's
  // "fires fast", and the demo default).
  openerDelayS: range(process.env.OPENER_DELAY_S, [0, 0]),
  // Free-text brand instructions folded into the opener prompt (voice, musts).
  openerBrandNotes: process.env.OPENER_BRAND_NOTES || '',

  // Public comment nudge.
  publicNudge: process.env.PUBLIC_NUDGE || 'non_followers',
  publicNudgeText: process.env.PUBLIC_NUDGE_TEXT || 'sent you a dm 💬',

  // Discounts. The percent and the one-code-per-customer rule live HERE, in
  // code — the model can request a code but can never set its terms.
  discountPercent: int(process.env.DISCOUNT_PERCENT, 20),
  openerIncludesDiscount: bool(process.env.OPENER_DISCOUNT, true),
  shopifyAdminStore: process.env.SHOPIFY_ADMIN_STORE || '',
  shopifyAdminToken: process.env.SHOPIFY_ADMIN_TOKEN || '',

  dbPath: process.env.DB_PATH || 'data/concierge.db',
};
