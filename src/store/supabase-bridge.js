// Live data bridge: mirrors the concierge's local SQLite state into the Kosha
// Postgres (Supabase) schema so the dashboard sees real customers, conversations
// and messages as they happen.
//
// Three rules govern everything here:
//   1. It is OPTIONAL. No DATABASE_URL, or transport 'sim' (the smoke suite), and
//      every entry point is a no-op — the concierge runs exactly as before.
//   2. It is FIRE-AND-FORGET. Mirroring is bookkeeping, never part of a customer
//      reply's critical path; a Postgres failure traces and is swallowed.
//   3. It is IDEMPOTENT. Every write lands on a natural key (brand+phone,
//      external_space_id, integration+provider_message_id, brand+customer+key)
//      so the boot backfill can run on every restart without duplicating a row.
//
// Schema notes (private.* in Kosha) that shape the mapping below:
//   - customers is SMS-first: (brand_id, phone_e164) is the natural key and
//     phone_e164 is CHECK-constrained to real E.164. An IG customer has no phone
//     until the gate captures one, so they get a deterministic +999 placeholder
//     (999 is ITU-reserved and assigned to no country, so it can never collide
//     with a real number) that is promoted in place the moment a real one lands.
//   - customers has no username/name/email columns, so those facts go to
//     private.memories, the schema's own per-customer fact store.
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { config } from '../config.js';
import { trace } from '../sim/trace.js';

const GOAL_POLL_MS = 30_000;
// Takeover is a live decision a person makes mid-conversation, so it polls
// twice as often as the goal: the worst case a customer feels is one automated
// reply already in flight when the operator flips the switch.
const MODE_POLL_MS = 15_000;
const CHANNEL = 'instagram';

// The local settings key that carries a conversation's response_mode. Read on
// the hot path by flows/workflow-settings.js — keep the two in step.
export const modeKey = (igsid) => `mode:${igsid}`;

// The bridge is off unless it is explicitly configured AND we are on real Meta
// traffic. The smoke suite runs transport 'sim' and must stay untouched.
export const bridgeEnabled = () => !!config.databaseUrl && config.transport !== 'sim';

let sql = null;        // lazy postgres client
let scope = null;      // { brandId, inboxId, integrationId } resolved once at boot
let started = false;
let goalTimer = null;
let modeTimer = null;

// All bridge writes run on one chain: it keeps the pool at a trickle and
// guarantees a customer exists before its conversation, and a conversation
// before its messages, without any per-call ordering ceremony at the call site.
let tail = Promise.resolve();
function enqueue(label, fn) {
  if (!bridgeEnabled()) return;
  tail = tail.then(fn).catch((err) => trace('bridge', `${label} failed (ignored): ${err.message}`));
}

function client() {
  if (!sql) sql = postgres(config.databaseUrl, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 15 });
  return sql;
}

// Deterministic stand-in phone for an IG customer who has not given one yet.
// +999 is ITU-reserved (no country), so a placeholder can never shadow a real
// number, and the same igsid always maps to the same row across restarts.
export function placeholderPhone(igsid) {
  const h = createHash('sha256').update(`ig:${igsid}`).digest('hex').slice(0, 16);
  return `+999${(BigInt(`0x${h}`) % 100000000000n).toString().padStart(11, '0')}`;
}

// Stable provider id per local message row — the dedupe key that lets the boot
// backfill and the live mirror write the same message without duplicating it.
const providerMessageId = (igsid, localId) => `ig-concierge:${igsid}:${localId}`;
const memoryKey = (field) =>
  String(field).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80);

// ---------------------------------------------------------------- boot scope

// One SELECT resolves brand + instagram inbox + meta integration together:
// the inbox row already carries the FK triple the writes below need, so there
// is nothing to guess and nothing to create.
async function resolveScope() {
  const db = client();
  const want = config.supabaseBrandId;
  const [row] = await db`
    SELECT i.brand_id, i.id AS inbox_id, i.integration_id
    FROM private.inboxes i
    JOIN private.integrations g ON g.id = i.integration_id
    JOIN private.brands b ON b.id = i.brand_id
    WHERE i.platform = ${CHANNEL} AND i.enabled AND g.enabled AND b.enabled
      AND g.provider = 'meta'
      AND (${want} = '' OR i.brand_id = ${want})
    ORDER BY i.id
    LIMIT 1`;
  if (!row) throw new Error(`no enabled instagram inbox found${want ? ` for brand ${want}` : ''}`);
  return { brandId: row.brand_id, inboxId: row.inbox_id, integrationId: row.integration_id };
}

// ------------------------------------------------------------ upsert helpers

// Memoized per igsid: the customer/conversation pair is resolved once and every
// later message write reuses the ids.
const spaces = new Map(); // igsid -> Promise<{ customerId, conversationId }>

async function upsertSpace(igsid, at) {
  const db = client();
  const { brandId, inboxId, integrationId } = scope;
  const when = new Date(at || Date.now());

  const [customer] = await db`
    INSERT INTO private.customers (brand_id, phone_e164)
    VALUES (${brandId}, ${placeholderPhone(igsid)})
    ON CONFLICT (brand_id, phone_e164) DO UPDATE SET updated_at = now()
    RETURNING id`;

  const [conversation] = await db`
    INSERT INTO private.conversations
      (brand_id, customer_id, integration_id, inbox_id, channel, external_space_id,
       response_mode, started_at, last_message_at)
    VALUES (${brandId}, ${customer.id}, ${integrationId}, ${inboxId}, ${CHANNEL}, ${String(igsid)},
       'agent', ${when}, ${when})
    ON CONFLICT (brand_id, channel, integration_id, inbox_id, external_space_id)
    DO UPDATE SET last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
                  updated_at = now()
    RETURNING id`;

  return { customerId: customer.id, conversationId: conversation.id };
}

function space(igsid, at) {
  const key = String(igsid);
  if (!spaces.has(key)) {
    // A failed resolve must not be cached, or the thread stays broken for the
    // life of the process.
    spaces.set(key, upsertSpace(key, at).catch((err) => { spaces.delete(key); throw err; }));
  }
  return spaces.get(key);
}

// private.memories is the schema's per-customer fact store — the only clean home
// for the facts customers itself has no column for (username, name, email).
async function remember(customerId, key, value, kind = 'fact') {
  const v = value == null ? '' : String(value).trim().slice(0, 1000);
  const k = memoryKey(key);
  if (!v || !k) return;
  await client()`
    INSERT INTO private.memories (brand_id, customer_id, key, kind, value)
    VALUES (${scope.brandId}, ${customerId}, ${k}, ${kind}, ${v})
    ON CONFLICT (brand_id, customer_id, key)
    DO UPDATE SET value = EXCLUDED.value, kind = EXCLUDED.kind, updated_at = now()`;
}

async function writeThread(igsid, fields = {}, at) {
  const { customerId } = await space(igsid, at);
  await remember(customerId, 'instagram.igsid', igsid);
  await remember(customerId, 'instagram.username', fields.username);
  await remember(customerId, 'instagram.name', fields.name);
}

// The comment that opened a thread is written into a system context message by
// comment-to-dm.js. The portal wants that fact ("commented X on the Y post"),
// so it gets promoted into memories instead of being dropped with the rest of
// the scaffolding. The pattern must stay in step with the writer's wording.
const COMMENT_CONTEXT =
  /^context: this thread started when they commented "([\s\S]+?)" on the brand's post(?: \(post caption: "([\s\S]+?)"\))?/;

async function writeMessage(igsid, role, content, localId, at) {
  if (role === 'system') {
    const match = COMMENT_CONTEXT.exec(String(content ?? ''));
    if (match) {
      const { customerId } = await space(igsid, at);
      await remember(customerId, 'instagram.comment', match[1]);
      if (match[2]) await remember(customerId, 'instagram.comment.post', match[2]);
    }
    return;
  }
  if (role !== 'user' && role !== 'assistant') return; // other scaffolding stays local
  if (!content || !String(content).trim()) return;
  const { customerId, conversationId } = await space(igsid, at);
  const when = new Date(at || Date.now());
  await client()`
    INSERT INTO private.messages
      (brand_id, conversation_id, customer_id, integration_id, provider_message_id,
       direction, content, metadata, sent_at)
    VALUES (${scope.brandId}, ${conversationId}, ${customerId}, ${scope.integrationId},
       ${providerMessageId(igsid, localId)},
       ${role === 'user' ? 'inbound' : 'outbound'}, ${String(content)},
       ${client().json({ source: 'ig-concierge', channel: CHANNEL, igsid: String(igsid), role })},
       ${when})
    ON CONFLICT (integration_id, provider_message_id) DO NOTHING`;
  await client()`
    UPDATE private.conversations
    SET last_message_at = GREATEST(last_message_at, ${when}), updated_at = now()
    WHERE id = ${conversationId}`;
}

async function writeCollected(igsid, field, value) {
  if (!field || String(field).startsWith('_')) return; // '_awaiting' etc. is gate bookkeeping
  if (value == null || !String(value).trim()) return;
  const { customerId } = await space(igsid);
  // A captured phone belongs in the column the schema actually has for it:
  // promote the placeholder in place so the customer row becomes a real one.
  if (field === 'phone' && /^\+[1-9][0-9]{6,14}$/.test(String(value).trim())) {
    try {
      await client()`
        UPDATE private.customers SET phone_e164 = ${String(value).trim()}, updated_at = now()
        WHERE id = ${customerId} AND phone_e164 <> ${String(value).trim()}`;
    } catch (err) {
      // Another customer already owns that number — keep the placeholder and
      // let the memory below carry the fact.
      trace('bridge', `phone promote skipped for ${igsid}: ${err.message}`);
    }
  }
  await remember(customerId, field, value);
}

// -------------------------------------------------------------------- hooks
// Everything below is what src/store/db.js calls. Each is one line at the call
// site, returns immediately, and cannot throw into the caller.

export const mirrorThread = (igsid, fields, at) =>
  enqueue('thread mirror', () => writeThread(igsid, fields, at));

export const mirrorMessage = (igsid, role, content, localId, at) =>
  enqueue('message mirror', () => writeMessage(igsid, role, content, localId, at));

export const mirrorCollected = (igsid, field, value) =>
  enqueue('capture mirror', () => writeCollected(igsid, field, value));

// ------------------------------------------------------------------ backfill

// Replays everything already in SQLite. Safe on every boot: each statement
// lands on a natural key, so a restart re-runs this and changes nothing.
async function backfill() {
  const store = await import('./db.js'); // dynamic: db.js imports this module
  const threads = store.allThreads();
  const messages = store.allMessages();
  const collected = store.allCollected();

  for (const t of threads) await writeThread(t.igsid, { username: t.username, name: t.name }, t.created_at);
  let mirrored = 0;
  for (const m of messages) {
    // System rows route through writeMessage too: it drops them from the
    // mirror but promotes comment-context facts into memories.
    await writeMessage(m.igsid, m.role, m.content, m.id, m.created_at);
    if (m.role === 'user' || m.role === 'assistant') mirrored++;
  }
  for (const c of collected) await writeCollected(c.igsid, c.field, c.value);

  trace('bridge', `backfill complete — ${threads.length} threads, ${mirrored} messages, ${collected.length} captured fields reconciled`);
}

// -------------------------------------------------------------- goal polling

let lastGoalSignature = '';

// The operator sets the goal in Kosha; the concierge reads it here and writes it
// into the same settings keys the /admin dashboard uses, so the agent picks the
// change up on its very next decision — no restart, no second source of truth.
async function pollGoal() {
  const store = await import('./db.js');
  const [goal] = await client()`
    SELECT capture_field, target_count, featured_variant_id, featured_title
    FROM private.ig_goals
    WHERE brand_id = ${scope.brandId} AND status = 'active'
    ORDER BY created_at DESC, id DESC
    LIMIT 1`;
  if (!goal) {
    // A stopped promotion must actually stop the agent: clear every goal-
    // applied override so the workflow falls back to env defaults, featured
    // pin included — a pin left behind would keep pitching the old product.
    if (lastGoalSignature !== 'none') {
      lastGoalSignature = 'none';
      for (const key of ['workflow', 'goal_target', 'featured_variant_id', 'featured_title']) {
        store.clearSetting(key);
      }
      trace('bridge', 'goal poll: no active goal — cleared goal-applied settings, agent back to defaults');
    }
    return;
  }

  const signature = JSON.stringify(goal);
  if (signature === lastGoalSignature) return; // unchanged — stay quiet
  lastGoalSignature = signature;

  const applied = [];
  store.setSetting('workflow', goal.capture_field);
  applied.push(`workflow=${goal.capture_field}`);
  store.setSetting('goal_target', goal.target_count);
  applied.push(`goal_target=${goal.target_count}`);
  // Null halves of the featured pin are left alone rather than blanked, so an
  // env/dashboard pin survives a goal that simply doesn't name a product.
  if (goal.featured_variant_id) {
    store.setSetting('featured_variant_id', goal.featured_variant_id);
    applied.push(`featured_variant_id=${goal.featured_variant_id}`);
  }
  if (goal.featured_title) {
    store.setSetting('featured_title', goal.featured_title);
    applied.push(`featured_title=${goal.featured_title}`);
  }
  trace('bridge', `goal poll applied settings — ${applied.join(' ')}`);
}

// -------------------------------------------------------------- mode polling

// Kosha owns the takeover switch: an operator flips a conversation to 'human'
// in the portal and expects the bot to fall silent immediately. Mirroring it
// into the same settings table the workflows already read means dm-reply.js
// answers "is a human holding this thread?" with one local SQLite lookup —
// never a network call on a customer's critical path, and never a thread stuck
// on the bot because Postgres happened to be unreachable at that second.
async function pollModes() {
  const store = await import('./db.js');
  const rows = await client()`
    SELECT external_space_id, response_mode
    FROM private.conversations
    WHERE brand_id = ${scope.brandId} AND channel = ${CHANNEL}
      AND integration_id = ${scope.integrationId} AND inbox_id = ${scope.inboxId}`;

  const changed = [];
  for (const row of rows) {
    const igsid = String(row.external_space_id || '').trim();
    if (!igsid) continue;
    // Anything that is not an explicit 'human' means the agent answers. The
    // portal may grow other modes; none of them should silence the concierge
    // by accident.
    const mode = String(row.response_mode || '').toLowerCase() === 'human' ? 'human' : 'agent';
    if (store.getSetting(modeKey(igsid)) === mode) continue; // unchanged — stay quiet
    store.setSetting(modeKey(igsid), mode);
    changed.push(`${igsid}=${mode}`);
  }
  if (changed.length) trace('mode', `portal response_mode applied — ${changed.join(' ')}`);
}

// ----------------------------------------------------------------- lifecycle

export function startBridge() {
  if (started) return;
  if (!bridgeEnabled()) {
    trace('bridge', `mirror off (${config.databaseUrl ? `transport=${config.transport}` : 'no DATABASE_URL'}) — local sqlite only`);
    return;
  }
  started = true;
  enqueue('boot', async () => {
    scope = await resolveScope();
    trace('bridge', `connected — brand=${scope.brandId} inbox=${scope.inboxId} integration=${scope.integrationId}`);
    await backfill();
    await pollGoal();
    await pollModes(); // a thread left in human mode must stay silent across a restart
    goalTimer = setInterval(() => enqueue('goal poll', pollGoal), GOAL_POLL_MS);
    modeTimer = setInterval(() => enqueue('mode poll', pollModes), MODE_POLL_MS);
    // never hold the process open on the bridge's account
    goalTimer.unref();
    modeTimer.unref();
  });
}

export async function stopBridge() {
  if (goalTimer) clearInterval(goalTimer);
  if (modeTimer) clearInterval(modeTimer);
  goalTimer = null;
  modeTimer = null;
  started = false;
  if (sql) { const s = sql; sql = null; await s.end({ timeout: 5 }).catch(() => {}); }
}
