// The eval lens: one self-contained report.html, no build step and no network.
//
// Reads evals/results/run.json + <variant>.jsonl and lays every comment out as
// ONE row with ONE COLUMN PER VARIANT, so the same comment's two answers sit
// beside each other and the difference is the thing you actually see.
//
//   node evals/report.mjs [--results evals/results] [--out <path>]
//
// scripts/evals.mjs calls buildReport() directly at the end of a run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.resolve(ROOT, '..', 'saru-demo-assets', 'evals', 'report.html');

// A minted code looks like MAYARUNS-K7QP — the marker that a trajectory ran all
// the way to a delivered discount.
const CODE_RE = /\b[A-Z]{3,10}-[A-Z0-9]{4}\b/;

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

const reachedCode = (row) =>
  row.trajectory?.some((s) =>
    s.replies?.some((r) => CODE_RE.test(r)) || s.traces?.some((t) => /\bcaptured\b/.test(t)));

function summarize(rows) {
  const replies = rows.filter((r) => r.decision === 'reply');
  const skips = rows.filter((r) => r.decision === 'skip');
  const other = rows.filter((r) => r.decision !== 'reply' && r.decision !== 'skip');
  const agreed = rows.filter((r) => r.decision === r.expected).length;
  const withTrajectory = rows.filter((r) => (r.trajectory?.length || 0) > 0);
  const captured = withTrajectory.filter(reachedCode);
  const openerLens = replies.map((r) => (r.opener || '').length);
  return {
    total: rows.length,
    reply: replies.length,
    skip: skips.length,
    other: other.length,
    agreementPct: rows.length ? Math.round((agreed / rows.length) * 100) : 0,
    agreed,
    avgOpener: openerLens.length ? Math.round(openerLens.reduce((a, b) => a + b, 0) / openerLens.length) : 0,
    captureRate: withTrajectory.length ? Math.round((captured.length / withTrajectory.length) * 100) : 0,
    captured: captured.length,
    trajectories: withTrajectory.length,
    avgSecs: rows.length ? (rows.reduce((a, r) => a + (r.timings?.totalMs || 0), 0) / rows.length / 1000).toFixed(1) : '0',
  };
}

const badge = (decision, expected) => {
  const cls = decision === 'reply' ? 'b-reply' : decision === 'skip' ? 'b-skip' : 'b-bad';
  const miss = decision !== expected ? '<span class="miss" title="differs from expected">≠</span>' : '';
  return `<span class="badge ${cls}">${esc(decision)}</span>${miss}`;
};

function cell(row, variant) {
  if (!row) return '<td class="v-cell empty">—</td>';
  const bubbles = (row.trajectory || []).map((step) => `
        <div class="turn">
          <div class="bub out">${esc(step.sent)}</div>
          ${(step.replies || []).map((r) => `<div class="bub in">${esc(r)}</div>`).join('')
    || `<div class="bub none">${step.timedOut ? 'no reply before timeout' : 'no reply'}</div>`}
        </div>`).join('');
  const traceLines = [...(row.openerTraces || []), ...(row.trajectory || []).flatMap((s) => s.traces || [])];
  const detail = (row.trajectory?.length || row.skipTrace || traceLines.length) ? `
      <details>
        <summary>${row.trajectory?.length ? `transcript · ${row.trajectory.length} turn${row.trajectory.length > 1 ? 's' : ''}` : 'trace'}${reachedCode(row) ? ' <span class="tag ok">code delivered</span>' : ''}</summary>
        <div class="thread">${bubbles || ''}
          ${row.note ? `<p class="note">${esc(row.note)}</p>` : ''}
          ${row.skipTrace ? `<p class="note">${esc(row.skipTrace)}</p>` : ''}
          ${traceLines.length ? `<pre class="trace">${esc([...new Set(traceLines)].join('\n'))}</pre>` : ''}
        </div>
      </details>` : '';
  return `<td class="v-cell" data-variant="${esc(variant)}">
      <div class="dline">${badge(row.decision, row.expected)}<span class="ms">${((row.timings?.totalMs || 0) / 1000).toFixed(1)}s</span></div>
      ${row.opener ? `<p class="opener">${esc(row.opener)}</p>` : '<p class="opener muted">(no opener)</p>'}
      ${detail}
    </td>`;
}

export function buildReport({ resultsDir, outPath } = {}) {
  const dir = path.resolve(ROOT, resultsDir || 'evals/results');
  const metaFile = path.join(dir, 'run.json');
  if (!fs.existsSync(metaFile)) throw new Error(`no run.json in ${dir} — run the harness first`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));

  const variants = meta.variants.map((v) => {
    const file = path.join(dir, v.file || `${v.name}.jsonl`);
    const rows = fs.existsSync(file) ? readJsonl(file) : [];
    return { ...v, rows, byId: new Map(rows.map((r) => [r.id, r])), summary: summarize(rows) };
  });

  // Row order follows the first variant that produced anything.
  const order = [];
  const seen = new Set();
  for (const v of variants) for (const r of v.rows) if (!seen.has(r.id)) { seen.add(r.id); order.push(r); }

  const categories = [...new Set(order.map((r) => r.category))].sort();

  const rowsHtml = order.map((base) => {
    const cells = variants.map((v) => v.byId.get(base.id));
    const decisions = cells.filter(Boolean).map((c) => c.decision);
    const disagree = new Set(decisions).size > 1;
    const missed = cells.some((c) => c && c.decision !== c.expected);
    const flag = disagree ? 'split' : missed ? 'missed' : '';
    const search = [base.id, base.text, base.category, ...cells.map((c) => c?.opener || '')].join(' ').toLowerCase();
    return `<tr class="${flag}" data-cat="${esc(base.category)}" data-flag="${flag}" data-search="${esc(search)}">
      <td class="c-cell">
        <div class="cid">${esc(base.id)}${disagree ? '<span class="tag split">variants split</span>' : ''}${!disagree && missed ? '<span class="tag missed">≠ expected</span>' : ''}</div>
        <p class="ctext">${esc(base.text)}</p>
        <div class="cmeta"><span class="cat">${esc(base.category)}</span><span class="exp">expects <b>${esc(base.expected)}</b></span></div>
      </td>
      ${cells.map((c, i) => cell(c, variants[i].name)).join('')}
    </tr>`;
  }).join('\n');

  const cards = variants.map((v) => {
    const s = v.summary;
    return `<article class="card">
      <h3>${esc(v.name)}</h3>
      <p class="notes">${v.notes
      // paragraphs of the variant file, one per line — the instructions ARE the experiment
      ? esc(v.notes.split(/\n\s*\n/).map((p) => `— ${p.replace(/\s+/g, ' ').trim()}`).join('\n'))
      : 'no extra instructions — current production behavior'}</p>
      <dl>
        <div><dt>agreement</dt><dd class="big">${s.agreementPct}<span>%</span></dd><dd class="sub">${s.agreed}/${s.total} match expected</dd></div>
        <div><dt>replied / skipped</dt><dd class="big">${s.reply}<span> / ${s.skip}</span></dd><dd class="sub">${s.other ? `${s.other} error or timeout` : 'no errors'}</dd></div>
        <div><dt>avg opener</dt><dd class="big">${s.avgOpener}<span> chars</span></dd><dd class="sub">across ${s.reply} openers</dd></div>
        <div><dt>capture completion</dt><dd class="big">${s.captureRate}<span>%</span></dd><dd class="sub">${s.captured}/${s.trajectories} trajectories reached a code</dd></div>
      </dl>
    </article>`;
  }).join('');

  const splits = order.filter((base) => {
    const d = variants.map((v) => v.byId.get(base.id)?.decision).filter(Boolean);
    return new Set(d).size > 1;
  }).length;
  const missedRows = order.filter((base) => variants.some((v) => {
    const c = v.byId.get(base.id);
    return c && c.decision !== c.expected;
  })).length;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>concierge prompt evals — ${esc(variants.map((v) => v.name).join(' vs '))}</title>
<style>
  :root{
    --cream:#faf5ec; --card:#fffdf8; --ink:#211f1a; --ink-2:#4b463c; --ink-3:#8a8272;
    --rule:#e3dbc9; --rule-2:#efe7d6;
    --reply:#2f6b4f; --reply-bg:#e7f1e9; --skip:#7a6a3f; --skip-bg:#f3ecd9;
    --bad:#9c3b2e; --bad-bg:#f8e5e0; --split:#8a5a12; --split-bg:#fdf3e0;
    --bub-in:#f0eadc; --bub-out:#e6ecf2;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--cream);color:var(--ink);
    font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  .wrap{max-width:1500px;margin:0 auto;padding:36px 28px 80px}
  header h1{font-size:26px;letter-spacing:-.02em;margin:0 0 6px}
  header .sub{color:var(--ink-3);margin:0 0 26px;font-size:13.5px}
  header .sub b{color:var(--ink-2);font-weight:600}

  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-bottom:26px}
  .card{background:var(--card);border:1px solid var(--rule);border-radius:12px;padding:18px 20px}
  .card h3{margin:0 0 4px;font-size:16px;letter-spacing:-.01em}
  .card .notes{margin:0 0 14px;color:var(--ink-3);font-size:12.5px;line-height:1.45;
    min-height:3.4em;white-space:pre-line}
  .card dl{display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;margin:0}
  .card dt{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink-3);margin-bottom:2px}
  .card dd{margin:0}
  .card .big{font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
  .card .big span{font-size:13px;font-weight:500;color:var(--ink-3)}
  .card .sub{font-size:11.5px;color:var(--ink-3);margin-top:2px}

  .bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:14px;
    background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:10px 12px;
    position:sticky;top:0;z-index:5}
  .bar input[type=search],.bar select{font:inherit;font-size:13.5px;color:var(--ink);
    background:var(--cream);border:1px solid var(--rule);border-radius:7px;padding:6px 9px}
  .bar input[type=search]{min-width:250px;flex:1}
  .bar label.chk{display:flex;align-items:center;gap:6px;font-size:13px;color:var(--ink-2)}
  .bar .count{margin-left:auto;font-size:12.5px;color:var(--ink-3)}

  /* No overflow/clip on the table: it would make the table its own scroll
     container and the sticky head would offset INSIDE it, covering row one. */
  table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);
    border:1px solid var(--rule);border-radius:12px;table-layout:fixed}
  thead th{position:sticky;top:58px;background:#f4eddf;text-align:left;font-size:11px;
    text-transform:uppercase;letter-spacing:.08em;color:var(--ink-2);padding:9px 14px;
    border-bottom:1px solid var(--rule);z-index:4}
  thead th:first-child{border-top-left-radius:11px}
  thead th:last-child{border-top-right-radius:11px}
  tbody tr:last-child td:first-child{border-bottom-left-radius:11px}
  tbody tr:last-child td:last-child{border-bottom-right-radius:11px}
  thead th .vnote{display:block;text-transform:none;letter-spacing:0;font-weight:400;
    font-size:11.5px;color:var(--ink-3);margin-top:2px}
  td{padding:14px;border-bottom:1px solid var(--rule-2);vertical-align:top}
  tr:last-child td{border-bottom:0}
  tr.split{background:#fefaf0}
  tr.split td:first-child{box-shadow:inset 3px 0 0 var(--split)}
  tr.missed td:first-child{box-shadow:inset 3px 0 0 var(--bad)}

  .c-cell{width:24%}
  .cid{font-size:11.5px;color:var(--ink-3);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin-bottom:5px}
  .ctext{margin:0 0 8px;font-size:14px;line-height:1.45}
  .cmeta{display:flex;flex-wrap:wrap;gap:6px;font-size:11.5px;color:var(--ink-3)}
  .cat{background:var(--rule-2);border-radius:20px;padding:2px 9px;color:var(--ink-2)}
  .exp b{color:var(--ink-2)}

  .badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:.04em;
    text-transform:uppercase;border-radius:20px;padding:2px 9px}
  .b-reply{background:var(--reply-bg);color:var(--reply)}
  .b-skip{background:var(--skip-bg);color:var(--skip)}
  .b-bad{background:var(--bad-bg);color:var(--bad)}
  .miss{color:var(--bad);font-weight:700;margin-left:5px}
  .tag{display:inline-block;font-size:10px;text-transform:uppercase;letter-spacing:.06em;
    border-radius:4px;padding:1px 6px;margin-left:6px;vertical-align:middle}
  .tag.split{background:var(--split-bg);color:var(--split)}
  .tag.missed{background:var(--bad-bg);color:var(--bad)}
  .tag.ok{background:var(--reply-bg);color:var(--reply)}

  .dline{display:flex;align-items:center;gap:8px;margin-bottom:7px}
  .ms{font-size:11px;color:var(--ink-3);margin-left:auto;font-variant-numeric:tabular-nums}
  .opener{margin:0;font-size:13.5px;line-height:1.5;color:var(--ink)}
  .opener.muted{color:var(--ink-3);font-style:italic}
  .v-cell.empty{color:var(--ink-3)}

  details{margin-top:9px}
  summary{cursor:pointer;font-size:12px;color:var(--ink-3);
    border-top:1px dashed var(--rule);padding-top:7px;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"▸ ";color:var(--ink-3)}
  details[open] summary::before{content:"▾ "}
  summary:hover{color:var(--ink-2)}
  .thread{margin-top:9px;display:flex;flex-direction:column;gap:9px}
  .turn{display:flex;flex-direction:column;gap:4px}
  .bub{max-width:88%;padding:7px 11px;border-radius:14px;font-size:12.5px;line-height:1.45;
    word-break:break-word}
  .bub.out{align-self:flex-end;background:var(--bub-out);border-bottom-right-radius:4px}
  .bub.in{align-self:flex-start;background:var(--bub-in);border-bottom-left-radius:4px}
  .bub.none{align-self:flex-start;background:transparent;color:var(--bad);font-style:italic;padding-left:0}
  .note{margin:2px 0 0;font-size:12px;color:var(--ink-3);font-style:italic}
  .trace{margin:6px 0 0;padding:8px 10px;background:#f5f0e4;border-radius:8px;
    font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink-2);
    white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}
  .empty-state{padding:36px;text-align:center;color:var(--ink-3)}
  footer{margin-top:22px;font-size:12px;color:var(--ink-3)}
</style></head>
<body><div class="wrap">
<header>
  <h1>concierge prompt evals</h1>
  <p class="sub">
    <b>${order.length}</b> comments from <b>${esc(String(meta.corpus).replace(/\\/g, '/'))}</b> ·
    <b>${variants.length}</b> variants · model <b>${esc(meta.model)}</b> ·
    <b>${splits}</b> ${splits === 1 ? 'row' : 'rows'} where the variants split ·
    <b>${missedRows}</b> ${missedRows === 1 ? 'row' : 'rows'} where a variant missed the expected call ·
    run ${esc(new Date(meta.startedAt).toLocaleString())} in ${(meta.durationMs / 60000).toFixed(1)} min
  </p>
</header>

<section class="cards">${cards}</section>

<div class="bar">
  <input type="search" id="q" placeholder="search comments and openers…" autocomplete="off">
  <select id="cat"><option value="">all categories</option>${categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
  <label class="chk"><input type="checkbox" id="only"> only disagreements</label>
  <button id="expand" type="button" style="font:inherit;font-size:13px;background:var(--cream);border:1px solid var(--rule);border-radius:7px;padding:6px 10px;cursor:pointer">expand all</button>
  <span class="count" id="count"></span>
</div>

<table>
  <thead><tr>
    <th style="width:24%">comment</th>
    ${variants.map((v) => `<th><span>${esc(v.name)}</span><span class="vnote">${v.notes ? 'variant notes applied' : 'baseline — no notes'}</span></th>`).join('')}
  </tr></thead>
  <tbody id="body">${rowsHtml}</tbody>
</table>
<p class="empty-state" id="none" hidden>nothing matches those filters.</p>

<footer>generated by evals/report.mjs — raw results in evals/results/*.jsonl</footer>
</div>
<script>
  var rows = Array.prototype.slice.call(document.querySelectorAll('#body tr'));
  var q = document.getElementById('q'), cat = document.getElementById('cat'),
      only = document.getElementById('only'), count = document.getElementById('count'),
      none = document.getElementById('none'), expand = document.getElementById('expand');
  function apply() {
    var term = q.value.trim().toLowerCase(), c = cat.value, d = only.checked, shown = 0;
    rows.forEach(function (r) {
      var hit = (!term || r.dataset.search.indexOf(term) !== -1)
        && (!c || r.dataset.cat === c)
        && (!d || r.dataset.flag);
      r.hidden = !hit;
      if (hit) shown++;
    });
    count.textContent = shown + ' of ' + rows.length + ' rows';
    none.hidden = shown !== 0;
  }
  var open = false;
  expand.addEventListener('click', function () {
    open = !open;
    document.querySelectorAll('#body details').forEach(function (d) { d.open = open; });
    expand.textContent = open ? 'collapse all' : 'expand all';
  });
  q.addEventListener('input', apply); cat.addEventListener('change', apply); only.addEventListener('change', apply);
  apply();
</script>
</body></html>`;

  const out = path.resolve(outPath || DEFAULT_OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html);
  return out;
}

// standalone: node evals/report.mjs [--results dir] [--out file]
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i === -1 ? undefined : args[i + 1]; };
  console.log(buildReport({ resultsDir: get('--results'), outPath: get('--out') }));
}
