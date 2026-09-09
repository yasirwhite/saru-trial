// The operator's levers, read at decision time so the /admin dashboard changes
// behavior instantly: which capture workflow runs, and the outreach goal that
// caps how many people we contact.
import { config } from '../config.js';
import { getSetting, countOpeners } from '../store/db.js';

// 'phone' | 'email' | 'off' — dashboard setting wins, env is the default.
export function activeWorkflow() {
  const s = getSetting('workflow');
  if (s === 'phone' || s === 'email' || s === 'off') return s;
  return config.phoneGate ? 'phone' : 'off';
}

// 0 = unlimited. Otherwise: total openers we may send (the "contact N people" goal).
export function goalTarget() {
  const s = parseInt(getSetting('goal_target'), 10);
  return Number.isFinite(s) && s > 0 ? s : 0;
}

export function goalReached() {
  const t = goalTarget();
  return t > 0 && countOpeners() >= t;
}

// The featured "sell it out" product. A dashboard-written setting wins over the
// env pin so the promotion can be re-aimed live, without a restart.
export function featuredVariantId() {
  const s = (getSetting('featured_variant_id') || '').replace(/\D/g, '');
  return s || config.featuredVariantId;
}

export function featuredTitle() {
  const s = (getSetting('featured_title') || '').trim();
  return s || config.featuredQuery;
}

// 'agent' | 'human' — the portal's per-conversation takeover switch. Kosha owns
// conversations.response_mode; the Supabase bridge mirrors it into the settings
// key 'mode:<igsid>' every 15s (see store/supabase-bridge.js). Absent or
// unrecognized means 'agent': the concierge fails OPEN, so a portal or Postgres
// outage can never leave every customer talking to nobody.
export function conversationMode(igsid) {
  return getSetting(`mode:${igsid}`) === 'human' ? 'human' : 'agent';
}
