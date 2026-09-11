// The capability test console: one page where the founder watches the agent
// handle each deliverable capability live and judges whether it stays in
// control.
//
// It is served by the LIVE server but nothing it does touches live traffic —
// every message is injected into a dedicated sim child (see child.js), and the
// verdicts on this page come from machine checks, not from reading the vibes.
// A failed check renders loudly. That is the entire point of the page.
import { config } from './../config.js';
import { isLocalRequest } from '../webhooks/local.js';
import { trace } from '../sim/trace.js';
import { runSuite, runAll, consoleState } from './runner.js';
import { SUITES } from './scenarios.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Same door as /admin, one notch stricter: with no ADMIN_KEY set this is a
// local-dev page, never an open one on the public tunnel — it spawns processes
// and mints real discount codes.
const authed = (req) => (config.adminKey
  ? req.query?.key === config.adminKey || req.body?.key === config.adminKey
  : isLocalRequest(req));

function page(key) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>saru — capability console</title>
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#f7f4ed;color:#554a42;font:14px/1.5 -apple-system,'Segoe UI',sans-serif}
  .bar{background:#fff;border-bottom:1px solid #e8e2d8;padding:12px 20px;display:flex;align-items:center;gap:14px;position:sticky;top:0;z-index:5}
  .bar b{color:#b65243;font-size:17px}
  .bar span.sub{color:#8d8179;font-size:13px}
  .bar .right{margin-left:auto;display:flex;align-items:center;gap:10px}
  .chip{font:12px/1.4 Consolas,monospace;background:#f3efe6;border:1px solid #e8e2d8;border-radius:999px;padding:4px 10px;color:#8d8179}
  .chip.up{background:#eef4ef;border-color:#cfe0d4;color:#3f6a4c}
  .chip.down{background:#fbeeec;border-color:#f0cdc6;color:#a8382a}
  button{background:#b65243;color:#fff;border:0;border-radius:7px;padding:7px 14px;font:inherit;font-weight:600;cursor:pointer}
  button.ghost{background:#fff;color:#8d6b62;border:1px solid #e8e2d8}
  button:disabled{opacity:.5;cursor:default}
  main{display:grid;grid-template-columns:320px minmax(0,1fr);gap:18px;max-width:1280px;margin:18px auto;padding:0 16px;align-items:start}
  .card{background:#fff;border:1px solid #e8e2d8;border-radius:10px;padding:14px 16px}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8d8179;margin:0 0 4px}
  .cap{margin-bottom:14px}
  .cap .blurb{color:#9b9089;font-size:12px;margin:0 0 8px}
  .suite{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;cursor:pointer;border:1px solid transparent}
  .suite:hover{background:#faf7f1}
  .suite.on{background:#faf1ee;border-color:#e7c9c2}
  .suite .t{flex:1;font-size:13px;min-width:0}
  .suite .t small{display:block;color:#a89e96;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .badge{font:11px/1.6 Consolas,monospace;border-radius:999px;padding:1px 8px;white-space:nowrap}
  .badge.ok{background:#eef4ef;color:#3f6a4c}
  .badge.bad{background:#fbeeec;color:#a8382a;font-weight:700}
  .badge.idle{background:#f3efe6;color:#a89e96}
  .badge.run{background:#fdf3e2;color:#9a7327}
  .run{display:flex;flex-direction:column;gap:12px}
  .why{color:#8d8179;font-size:13px;margin:2px 0 0}
  .alarm{background:#fbeeec;border:1px solid #f0cdc6;color:#a8382a;border-radius:10px;padding:10px 14px;font-weight:600}
  .step{border-top:1px solid #f0ebe2;padding-top:12px;margin-top:4px}
  .step:first-of-type{border-top:0}
  .who{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#a89e96;margin-bottom:6px}
  .b{max-width:74%;padding:8px 12px;border-radius:14px;margin:0 0 6px;white-space:pre-wrap;word-break:break-word}
  .b.cust{background:#f0ece3;border-bottom-left-radius:4px}
  .b.agent{background:#b65243;color:#fff;margin-left:auto;border-bottom-right-radius:4px}
  .b.agent a{color:#ffe9e4}
  .b.op{background:#40566b;color:#fff;margin-left:auto;border-bottom-right-radius:4px}
  .tool{font:11.5px/1.5 Consolas,monospace;background:#fbf7ef;border:1px solid #efe4d0;border-left:3px solid #d8b26a;border-radius:6px;padding:5px 9px;margin:0 0 6px;color:#7a6a4e;overflow-x:auto;white-space:pre}
  .tool b{color:#9a7327}
  .checks{margin-top:8px;display:grid;gap:5px}
  .ck{display:flex;gap:8px;font-size:12.5px;padding:5px 8px;border-radius:7px;background:#fafaf7}
  .ck .m{font-weight:700;width:14px;text-align:center}
  .ck.pass .m{color:#3f6a4c}
  .ck.fail{background:#fbeeec;border:1px solid #f0cdc6}
  .ck.fail .m{color:#a8382a}
  .ck .body{min-width:0}
  .ck .lbl{font-weight:600}
  .ck.fail .lbl{color:#a8382a}
  .ck .det{color:#8d8179;font-size:11.5px;word-break:break-word}
  .ck.fail .det{color:#a8382a}
  .dim{color:#a89e96}
  .waitline{font-size:12px;color:#8d8179;font-style:italic}
  .log{font:11px/1.5 Consolas,monospace;color:#a89e96;white-space:pre-wrap;max-height:120px;overflow:auto}
  .rollup{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}
</style>
<div class="bar">
  <b>saru</b><span class="sub">capability console — watch it work, judge whether it stays in control</span>
  <span class="right">
    <span class="chip" id="child">child: booting…</span>
    <button class="ghost" id="refresh">Refresh</button>
    <button id="runall">Run all</button>
  </span>
</div>
<main>
  <div class="card" id="side"></div>
  <div id="stage"></div>
</main>
<script>
const KEY = ${JSON.stringify(key)};
let state = null, selected = null, pinned = false;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const linkify = (s) => esc(s).replace(/(https?:\\/\\/[^\\s]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>');

const api = (path, body) => fetch('/console/api/' + path + '?key=' + encodeURIComponent(KEY), body
  ? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ...body, key: KEY }) }
  : {}).then(r => r.json());

function tally(run) {
  if (!run) return null;
  return { passed: run.passed, failed: run.failed, total: run.passed + run.failed, status: run.status };
}

function badge(run) {
  if (!run) return '<span class="badge idle">not run</span>';
  if (run.status === 'running') return '<span class="badge run">running…</span>';
  if (run.status === 'error') return '<span class="badge bad">error</span>';
  const t = tally(run);
  const cls = run.failed ? 'bad' : 'ok';
  return '<span class="badge ' + cls + '">' + t.passed + '/' + t.total + (run.failed ? ' — ' + run.failed + ' failed' : '') + '</span>';
}

function renderSide() {
  const parts = [];
  for (const cap of state.capabilities) {
    let p = 0, f = 0, any = false;
    for (const s of cap.suites) { const r = state.runs[s.id]; if (r) { any = true; p += r.passed; f += r.failed; } }
    const roll = any ? '<span class="badge ' + (f ? 'bad' : 'ok') + '">' + p + '/' + (p + f) + ' controlled</span>' : '';
    parts.push('<div class="cap"><h2>' + esc(cap.label) + ' ' + roll + '</h2><p class="blurb">' + esc(cap.blurb) + '</p>' +
      cap.suites.map(s => {
        const r = state.runs[s.id];
        return '<div class="suite' + (selected === s.id ? ' on' : '') + '" data-suite="' + s.id + '">' +
          '<span class="t">' + esc(s.title) + '<small>' + s.steps + ' step' + (s.steps > 1 ? 's' : '') + (s.seeded ? ' · seeded order' : '') + '</small></span>' +
          badge(r) +
          '<button class="ghost run-btn" data-run="' + s.id + '">Run</button></div>';
      }).join('') + '</div>');
  }
  document.getElementById('side').innerHTML = parts.join('');
}

function renderTool(t) {
  const res = t.result ? ' → ' + t.result : '';
  return '<div class="tool"><b>▸ ' + esc(t.name) + '</b> ' + esc(t.args || '{}') + esc(res.length > 260 ? res.slice(0, 260) + '…' : res) + '</div>';
}

function renderStep(st) {
  const out = [];
  if (st.kind === 'customer') out.push('<div class="who">customer</div><div class="b cust">' + esc(st.customer) + '</div>');
  if (st.kind === 'operator') out.push('<div class="who">human operator (portal)</div><div class="b op">' + esc(st.operator) + '</div>' +
    (st.why ? '<div class="waitline">' + esc(st.why) + '</div>' : ''));
  if (st.kind === 'wait') out.push('<div class="who">no message sent — waiting</div><div class="waitline">' + esc(st.label || 'waiting') + (st.why ? ' · ' + esc(st.why) : '') + '</div>');
  for (const t of st.tools) out.push(renderTool(t));
  for (const b of st.bubbles) out.push('<div class="b agent">' + linkify(b) + '</div>');
  if (!st.bubbles.length && st.kind !== 'operator') out.push('<div class="waitline">— no reply —</div>');
  const checks = st.checks.map(c => '<div class="ck ' + (c.pass ? 'pass' : 'fail') + '"><span class="m">' + (c.pass ? '✓' : '✗') + '</span>' +
    '<span class="body"><span class="lbl">' + esc(c.label) + '</span>' +
    '<div class="det">expected: ' + esc(c.expect) + (c.observed ? '<br>observed: ' + esc(c.observed) : '') + '</div></span></div>').join('');
  return '<div class="step">' + out.join('') + '<div class="checks">' + checks + '</div>' +
    '<div class="dim" style="font-size:11px;margin-top:6px">' + Math.round((st.ms || 0) / 100) / 10 + 's</div></div>';
}

function renderStage() {
  const suite = state.capabilities.flatMap(c => c.suites).find(s => s.id === selected);
  const run = state.runs[selected];
  const head = suite
    ? '<div class="card"><h2>' + esc((state.capabilities.find(c => c.suites.some(s => s.id === selected)) || {}).label || '') + '</h2>' +
      '<div style="font-size:16px;font-weight:600">' + esc(suite.title) + '</div><p class="why">' + esc(suite.why || '') + '</p>' +
      (run && run.seed ? '<div class="rollup"><span class="chip">seeded ' + esc(run.seed.order) + '</span><span class="chip">' + esc(run.seed.tracking) + '</span><span class="chip">' + esc(run.seed.scan) + '</span><span class="chip">' + esc(run.seed.details) + '</span></div>' : '') +
      '<div class="rollup">' + badge(run) + (run && run.driver ? '<span class="chip">llm: ' + esc(run.driver) + '</span>' : '') + '</div></div>'
    : '';
  if (!run) {
    document.getElementById('stage').innerHTML = head + '<div class="card dim">press Run to watch this one.</div>';
    return;
  }
  const alarm = run.failed ? '<div class="alarm">' + run.failed + ' control check' + (run.failed > 1 ? 's' : '') + ' FAILED — read the red rows below.</div>' : '';
  const err = run.error ? '<div class="alarm">run error: ' + esc(run.error) + '</div>' : '';
  document.getElementById('stage').innerHTML = '<div class="run">' + head + err + alarm +
    '<div class="card">' + run.steps.map(renderStep).join('') + (run.status === 'running' ? '<div class="waitline">running…</div>' : '') + '</div></div>';
}

function render() {
  const c = state.child || {};
  const chip = document.getElementById('child');
  chip.className = 'chip ' + (c.up ? 'up' : 'down');
  chip.textContent = c.up ? 'sim child :' + c.port + ' · llm=' + c.driver + ' · pid ' + c.pid : (c.pid ? 'child down' : 'child: not started');
  document.getElementById('runall').disabled = !!state.running;
  if (!pinned && state.running) selected = state.running;
  if (!selected) {
    const withRun = Object.keys(state.runs)[0];
    selected = withRun || state.capabilities[0].suites[0].id;
  }
  renderSide();
  renderStage();
}

// Re-render only when something actually changed: a 1s repaint of an idle page
// throws away the reader's scroll position halfway down a transcript.
let lastSig = '';
async function poll() {
  try {
    const next = await api('state');
    const sig = JSON.stringify(next);
    if (sig === lastSig) return;
    lastSig = sig;
    state = next;
    render();
  } catch (e) { /* transient */ }
}

document.addEventListener('click', async (e) => {
  const runBtn = e.target.closest('[data-run]');
  if (runBtn) {
    e.stopPropagation();
    selected = runBtn.dataset.run; pinned = true;
    await api('run', { suite: runBtn.dataset.run });
    poll();
    return;
  }
  const row = e.target.closest('[data-suite]');
  if (row) { selected = row.dataset.suite; pinned = true; render(); return; }
  if (e.target.id === 'runall') { pinned = false; await api('run-all', {}); poll(); }
  if (e.target.id === 'refresh') poll();
});

poll();
setInterval(poll, 1000);
</script>`;
}

export function mountConsole(app) {
  // The console's own sim child runs this same file. It must never be able to
  // open a console of its own (and spawn a grandchild).
  if (process.env.SARU_CONSOLE_CHILD === '1') return;

  app.get('/console', (req, res) => {
    if (!authed(req)) {
      trace('console', 'page request refused — missing or wrong admin key');
      return res.status(401).type('text/plain').send('unauthorized — /console?key=ADMIN_KEY');
    }
    res.type('html').send(page(config.adminKey || ''));
  });

  app.get('/console/api/state', (req, res) => {
    if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    res.json(consoleState());
  });

  app.post('/console/api/run', (req, res) => {
    if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const id = String(req.body?.suite || '');
    if (!SUITES.some((s) => s.id === id)) return res.status(400).json({ ok: false, error: `unknown suite ${id}` });
    trace('console', `run requested: ${id}`);
    runSuite(id).catch(() => { /* the run record carries the error */ });
    res.json({ ok: true, suite: id });
  });

  app.post('/console/api/run-all', (req, res) => {
    if (!authed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    trace('console', `run-all requested (${SUITES.length} suites)`);
    runAll().catch(() => { /* per-suite errors are recorded on each run */ });
    res.json({ ok: true, suites: SUITES.map((s) => s.id) });
  });
}
