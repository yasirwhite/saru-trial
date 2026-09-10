// Prompt-evaluation replay harness.
//
// Runs a corpus of real Instagram comments against the concierge, once per
// PROMPT VARIANT, and records exactly what the model did: whether the comment
// earned an opener, what that opener said, and how the conversation went for a
// few scripted follow-ups. Two variants side by side answer the question the
// whole thing exists for — "what changes when the instructions change?"
//
//   npm run evals -- --variants baseline,example-warmer --corpus evals/corpus.json --limit 30
//
// Safety, non-negotiable (mirrors scripts/smoke.js):
//   * every run boots its OWN server on a throwaway port with its OWN sqlite db
//     under data/ — the live server on :3000 is never touched.
//   * DATABASE_URL, IG_ACCESS_TOKEN and the Shopify ADMIN credentials are
//     blanked for the child, so a run cannot mirror to Kosha, cannot reach
//     Instagram, and cannot mint real store discount codes (pass
//     --real-discounts to opt in). The storefront MCP is read-only and stays on.
//
// Flags:
//   --variants a,b        variant files under evals/variants/<name>.md (default: baseline)
//   --corpus <path>       default evals/corpus.json, falling back to evals/corpus.sample.json
//   --limit <n>           comments per variant (default 30)
//   --stratify            spread that limit round-robin across categories
//                         (the corpus is grouped by category, so a plain
//                         --limit 12 would be twelve purchase_intent rows)
//   --out <dir>           jsonl destination (default evals/results)
//   --report <path>       report.html destination (default ../saru-demo-assets/evals/report.html)
//   --no-report           skip the report build
//   --port-base <n>       first throwaway port (default 4100)
//   --real-discounts      allow real Shopify admin code minting (off by default)
//   --keep-db             leave the throwaway sqlite files behind for inspection
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'evals-secret';
const BRAND_IGSID = 'sim-brand-account';
const POST_ID = 'sim-post-1';
// A single stable persona keeps the variable under test to ONE thing: the
// prompt. (The sim only serves a profile for its own persona igsid, so every
// eval thread comes back profile-less by design — identically, for every variant.)
const PERSONA_USERNAME = 'maya.runs';

// --- follow-up trajectories -------------------------------------------------
// What we say next, per category. The point is multi-turn behavior: does the
// gate still fire, does junk still get re-asked, does the code still land?
const TRAJECTORIES = {
  purchase_intent: ['how much is it?', '555 019', '(310) 555-0142'],
  product_question: ['how much is it?', '555 019', '(310) 555-0142'],
  price_objection: ["that's still a lot tbh", '(310) 555-0142'],
  compliment_no_intent: ['haha thanks', 'wait what do you sell'],
  complaint_negative: ['this is why i stopped ordering'],
  edge_cases: ['are you a bot?', '(310) 555-0142'],
  spam_troll_noise: [],
};
const trajectoryFor = (category, expected) =>
  (expected === 'skip' ? [] : TRAJECTORIES[category] || []);

// --- args -------------------------------------------------------------------
function parseArgs(argv) {
  const out = { variants: 'baseline', limit: 30, portBase: 4100, report: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--variants') out.variants = next();
    else if (a === '--corpus') out.corpus = next();
    else if (a === '--limit') out.limit = parseInt(next(), 10);
    else if (a === '--out') out.out = next();
    else if (a === '--report') out.reportPath = next();
    else if (a === '--no-report') out.report = false;
    else if (a === '--stratify') out.stratify = true;
    else if (a === '--port-base') out.portBase = parseInt(next(), 10);
    else if (a === '--real-discounts') out.realDiscounts = true;
    else if (a === '--keep-db') out.keepDb = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else console.warn(`  warn: ignoring unknown flag ${a}`);
  }
  return out;
}

// --- .env ------------------------------------------------------------------
// `npm run evals` deliberately does NOT use --env-file (the child gets a hand-
// built environment), so the key and the product pins are read here instead.
function readEnvFile() {
  const env = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

// --- http helpers ----------------------------------------------------------
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');

async function postWebhook(base, body) {
  const raw = Buffer.from(JSON.stringify(body));
  const res = await fetch(`${base}/webhooks/instagram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) },
    body: raw,
  });
  if (res.status !== 200) throw new Error(`webhook rejected with ${res.status}`);
}

const getState = async (base) => (await fetch(`${base}/sim/state`)).json();

const commentEnvelope = (commentId, igsid, text) => ({
  object: 'instagram',
  entry: [{
    id: BRAND_IGSID,
    time: Math.floor(Date.now() / 1000),
    changes: [{ field: 'comments', value: { id: commentId, from: { id: igsid, username: PERSONA_USERNAME }, media: { id: POST_ID }, text } }],
  }],
});

const dmEnvelope = (mid, igsid, text) => ({
  object: 'instagram',
  entry: [{
    id: BRAND_IGSID,
    time: Math.floor(Date.now() / 1000),
    messaging: [{ sender: { id: igsid }, recipient: { id: BRAND_IGSID }, timestamp: Date.now(), message: { mid, text } }],
  }],
});

// --- server lifecycle ------------------------------------------------------
async function bootServer({ port, dbPath, notesFile, envFile, realDiscounts, onStderr }) {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(path.join(ROOT, f), { force: true });
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      // sim transport + the real model: the whole point is real replies.
      TRANSPORT: 'sim',
      IG_ID: BRAND_IGSID,
      IG_ACCESS_TOKEN: '',
      LLM_DRIVER: 'openai',
      OPENAI_API_KEY: envFile.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
      OPENAI_MODEL: envFile.OPENAI_MODEL || process.env.OPENAI_MODEL || '',
      META_APP_SECRET: SECRET,
      META_VERIFY_TOKEN: 'evals-verify',
      // The walkthrough workflow under test: opener holds the code, the phone
      // gate releases it.
      PHONE_GATE: '1',
      FEATURED_PRODUCT: envFile.FEATURED_PRODUCT || '',
      FEATURED_VARIANT_ID: envFile.FEATURED_VARIANT_ID || '',
      STORE_DOMAIN: envFile.STORE_DOMAIN || '',
      SHOPIFY_MCP_URL: envFile.SHOPIFY_MCP_URL || '',
      BRAND_NAME: envFile.BRAND_NAME || '',
      // Instant pacing: reading-speed sleeps would triple a run's wall clock
      // without changing a single word the model writes.
      REPLY_PACING: 'instant',
      PROMPT_NOTES_FILE: notesFile,
      // Blast radius: no Kosha mirror, no admin dashboard key, no real codes.
      DATABASE_URL: '',
      ADMIN_KEY: '',
      PROMO_CODE: '',
      OPENER_BRAND_NOTES: '',
      SHOPIFY_ADMIN_STORE: realDiscounts ? (envFile.SHOPIFY_ADMIN_STORE || '') : '',
      SHOPIFY_ADMIN_TOKEN: realDiscounts ? (envFile.SHOPIFY_ADMIN_TOKEN || '') : '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.EVALS_VERBOSE && process.stdout.write('    | ' + d));
  child.stderr.on('data', (d) => onStderr?.(String(d)));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 160; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return { child, base }; } catch { /* not up yet */ }
    await sleep(250);
  }
  child.kill();
  throw new Error(`server for port ${port} did not boot`);
}

// --- waiting ---------------------------------------------------------------
// Everything downstream of the 200 ack is async, so we watch /sim/state. Both
// waiters key off `to` (the comment id or the igsid), never an array index —
// nothing else in the run can be mistaken for this comment's reply.
async function waitForOpener(base, { commentId, igsid, sinceTs, timeoutMs = 90000 }) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const s = await getState(base);
    const opener = s.outbound.find((o) => o.kind === 'private_reply' && o.to === commentId);
    if (opener) return { decision: 'reply', opener: opener.text, traces: since(s.traces, sinceTs, commentId, igsid) };
    const skip = s.traces.find((t) => t.at >= sinceTs && ['intent', 'goal', 'window', 'dedupe'].includes(t.kind) && t.text.includes(commentId));
    if (skip) return { decision: 'skip', opener: null, skipTrace: `[${skip.kind}] ${skip.text}`, traces: since(s.traces, sinceTs, commentId, igsid) };
    const err = s.traces.find((t) => t.at >= sinceTs && t.kind === 'error' && t.text.includes(commentId));
    if (err) return { decision: 'error', opener: null, skipTrace: `[error] ${err.text}`, traces: since(s.traces, sinceTs, commentId, igsid) };
    await sleep(400);
  }
  const s = await getState(base);
  return { decision: 'timeout', opener: null, traces: since(s.traces, sinceTs, commentId, igsid) };
}

// Replies arrive as separate bubbles: wait for the first, then for quiet.
async function waitForReplies(base, { igsid, seen, sinceTs, timeoutMs = 90000, quietMs = 2500 }) {
  const started = Date.now();
  let s = await getState(base);
  const mine = (st) => st.outbound.filter((o) => o.kind === 'dm' && o.to === igsid);
  while (Date.now() - started < timeoutMs && mine(s).length <= seen) {
    await sleep(400);
    s = await getState(base);
  }
  if (mine(s).length <= seen) return { replies: [], count: seen, timedOut: true, traces: since(s.traces, sinceTs, igsid) };
  let quietFor = 0;
  while (quietFor < quietMs) {
    await sleep(400);
    const next = await getState(base);
    if (mine(next).length === mine(s).length) quietFor += 400;
    else { quietFor = 0; s = next; }
  }
  return { replies: mine(s).slice(seen).map((o) => o.text), count: mine(s).length, timedOut: false, traces: since(s.traces, sinceTs, igsid) };
}

// The trace ring holds 500 events for the WHOLE server, so we harvest the ones
// belonging to this comment immediately after each step, before they roll off.
const since = (traces, ts, ...needles) =>
  traces
    .filter((t) => t.at >= ts && (needles.some((n) => n && t.text.includes(n)) || ['gate', 'tool', 'promo', 'error', 'intent'].includes(t.kind)))
    .map((t) => `[${t.kind}] ${t.text}`)
    .slice(-14);

// --- one variant -----------------------------------------------------------
async function runVariant({ variant, comments, port, envFile, opts, outFile }) {
  const notesFile = path.join(ROOT, 'evals', 'variants', `${variant}.md`);
  const notes = fs.readFileSync(notesFile, 'utf8').trim();
  const dbPath = `data/evals-${variant.replace(/[^a-z0-9_-]/gi, '')}.db`;
  const stderr = [];
  console.log(`\n=== variant "${variant}" — port ${port}, db ${dbPath}, notes ${notes ? `${notes.length} chars` : '(none — baseline)'}`);

  const { child, base } = await bootServer({
    port, dbPath, notesFile, envFile,
    realDiscounts: !!opts.realDiscounts,
    onStderr: (d) => { stderr.push(d.trim()); process.stdout.write('    ! ' + d); },
  });

  const rows = [];
  const stream = fs.createWriteStream(outFile, { flags: 'w' });
  try {
    for (const [i, c] of comments.entries()) {
      const t0 = Date.now();
      // A fresh synthetic igsid per comment: threads can never bleed into one
      // another, so every comment is judged on its own conversation.
      const igsid = `sim-eval-${String(i).padStart(3, '0')}-${c.id}`;
      const commentId = `eval-c-${c.id}`;
      process.stdout.write(`  [${String(i + 1).padStart(2)}/${comments.length}] ${c.id} (${c.category}) `);

      const openerSince = Date.now();
      let res;
      try {
        await postWebhook(base, commentEnvelope(commentId, igsid, c.text));
        res = await waitForOpener(base, { commentId, igsid, sinceTs: openerSince });
      } catch (err) {
        res = { decision: 'error', opener: null, skipTrace: `[harness] ${err.message}`, traces: [] };
      }
      const openerMs = Date.now() - t0;
      process.stdout.write(`→ ${res.decision}`);

      const trajectory = [];
      const steps = trajectoryFor(c.category, c.expected);
      let note = null;
      if (res.decision !== 'reply' && steps.length) {
        // No opener means no armed gate and no thread context — a DM here would
        // be a different experiment, not a comparable one.
        note = `follow-ups skipped: no opener was sent (decision=${res.decision})`;
      } else {
        let seen = 0;
        for (const [k, sent] of steps.entries()) {
          const stepSince = Date.now();
          const s0 = Date.now();
          try {
            await postWebhook(base, dmEnvelope(`eval-mid-${c.id}-${k}`, igsid, sent));
            const r = await waitForReplies(base, { igsid, seen, sinceTs: stepSince });
            seen = r.count;
            trajectory.push({ sent, replies: r.replies, traces: r.traces, ms: Date.now() - s0, timedOut: r.timedOut });
            process.stdout.write(r.timedOut ? ' ·!' : ` ·${r.replies.length}`);
          } catch (err) {
            trajectory.push({ sent, replies: [], traces: [`[harness] ${err.message}`], ms: Date.now() - s0, error: err.message });
            process.stdout.write(' ·x');
          }
          await sleep(500); // rate-limit kindly
        }
      }

      const row = {
        id: c.id,
        text: c.text,
        category: c.category,
        expected: c.expected,
        decision: res.decision,
        opener: res.opener,
        skipTrace: res.skipTrace || null,
        openerTraces: res.traces || [],
        note,
        trajectory,
        timings: { openerMs, totalMs: Date.now() - t0 },
      };
      rows.push(row);
      stream.write(JSON.stringify(row) + '\n');
      console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      await sleep(700); // and again between comments
    }
  } finally {
    stream.end();
    child.kill();
    await sleep(400);
    if (!opts.keepDb) for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(path.join(ROOT, f), { force: true });
  }
  return { rows, stderr: stderr.slice(-5), notes };
}

// Even coverage under a small --limit: one from each category, then round again.
function stratifiedSlice(all, limit) {
  const buckets = new Map();
  for (const c of all) {
    if (!buckets.has(c.category)) buckets.set(c.category, []);
    buckets.get(c.category).push(c);
  }
  const picked = [];
  for (let round = 0; picked.length < limit; round++) {
    let placed = false;
    for (const list of buckets.values()) {
      if (round >= list.length) continue;
      picked.push(list[round]);
      placed = true;
      if (picked.length === limit) break;
    }
    if (!placed) break; // every bucket exhausted
  }
  return picked;
}

// --- main ------------------------------------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).join('\n'));
    return;
  }

  const envFile = readEnvFile();
  if (!(envFile.OPENAI_API_KEY || process.env.OPENAI_API_KEY)) {
    throw new Error('no OPENAI_API_KEY in .env — the harness scores the real model, not the mock driver');
  }

  const corpusPath = path.resolve(ROOT, opts.corpus || (fs.existsSync(path.join(ROOT, 'evals/corpus.json')) ? 'evals/corpus.json' : 'evals/corpus.sample.json'));
  if (!fs.existsSync(corpusPath)) throw new Error(`corpus not found: ${corpusPath}`);
  const corpus = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const all = corpus.comments || [];
  if (!all.length) throw new Error(`corpus has no comments: ${corpusPath}`);
  for (const c of all) {
    if (!c.id || !c.text || !c.category || !c.expected) throw new Error(`corpus row missing a field: ${JSON.stringify(c).slice(0, 120)}`);
  }
  const limit = Number.isFinite(opts.limit) ? opts.limit : 30;
  // Plain limit = the corpus's own order. --stratify walks the categories
  // round-robin instead, so a cheap run still touches every behavior.
  const comments = opts.stratify ? stratifiedSlice(all, limit) : all.slice(0, limit);

  const variants = opts.variants.split(',').map((v) => v.trim()).filter(Boolean);
  for (const v of variants) {
    const f = path.join(ROOT, 'evals', 'variants', `${v}.md`);
    if (!fs.existsSync(f)) throw new Error(`variant file not found: ${f}`);
  }

  const outDir = path.resolve(ROOT, opts.out || 'evals/results');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`corpus: ${path.relative(ROOT, corpusPath)} — ${comments.length} of ${all.length} comments`);
  console.log(`variants: ${variants.join(', ')}`);
  console.log(`model: ${envFile.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini (config default)'}`);
  console.log(`discount minting: ${opts.realDiscounts ? 'REAL (shopify admin)' : 'simulated (throwaway db only)'}`);

  const startedAt = Date.now();
  const meta = {
    startedAt, corpus: path.relative(ROOT, corpusPath), corpusTotal: all.length, limit: comments.length,
    model: envFile.OPENAI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini', variants: [],
  };

  for (const [idx, variant] of variants.entries()) {
    const outFile = path.join(outDir, `${variant}.jsonl`);
    const { rows, stderr, notes } = await runVariant({
      variant, comments, port: opts.portBase + idx, envFile, opts, outFile,
    });
    meta.variants.push({ name: variant, file: path.basename(outFile), rows: rows.length, notes, stderr });
    console.log(`  → ${path.relative(ROOT, outFile)} (${rows.length} rows)`);
  }
  meta.finishedAt = Date.now();
  meta.durationMs = meta.finishedAt - startedAt;
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(meta, null, 2));

  console.log(`\nrun complete in ${(meta.durationMs / 60000).toFixed(1)} min`);

  if (opts.report) {
    const { buildReport } = await import(new URL('../evals/report.mjs', import.meta.url));
    const out = buildReport({ resultsDir: outDir, outPath: opts.reportPath });
    console.log(`report: ${out}`);
  }
}

main().catch((err) => {
  console.error('\nevals run aborted:', err.message);
  process.exitCode = 1;
});
