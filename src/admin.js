// The client dashboard: pick the active workflow (phone / email / off), set the
// outreach goal ("contact N people"), and watch captured contacts arrive.
// Server-rendered on purpose — one file, zero build step, reads SQLite live.
import { config } from './config.js';
import { getSetting, setSetting, listContacts, countOpeners, countCaptured } from './store/db.js';
import { activeWorkflow, goalTarget } from './flows/workflow-settings.js';
import { trace } from './sim/trace.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function page() {
  const wf = activeWorkflow();
  const goal = goalTarget();
  const sent = countOpeners();
  const captured = countCaptured();
  const contacts = listContacts();
  const pct = goal > 0 ? Math.min(100, Math.round((sent / goal) * 100)) : 0;
  const radio = (v, label) =>
    `<label class="wf${wf === v ? ' on' : ''}"><input type="radio" name="workflow" value="${v}"${wf === v ? ' checked' : ''}/> ${label}</label>`;
  const rows = contacts.map((c) => `
    <tr>
      <td>@${esc(c.username || c.igsid)}</td>
      <td>${esc(c.name || '')}</td>
      <td>${esc(c.phone || '')}</td>
      <td>${esc(c.email || '')}</td>
      <td class="code">${esc(c.discount_code || '')}</td>
      <td class="dim">${c.captured_at ? new Date(c.captured_at).toLocaleString() : ''}</td>
    </tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>saru — workflows</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#f7f4ed;color:#554a42;font:14px/1.5 -apple-system,'Segoe UI',sans-serif}
  .bar{background:#fff;border-bottom:1px solid #e8e2d8;padding:14px 22px;font-weight:700;color:#b65243;font-size:17px}
  .bar span{color:#8d8179;font-weight:400;font-size:13px;margin-left:10px}
  main{max-width:860px;margin:22px auto;padding:0 16px;display:grid;gap:16px}
  .card{background:#fff;border:1px solid #e8e2d8;border-radius:10px;padding:16px 18px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8d8179;margin:0 0 12px}
  .wf{display:inline-block;border:1px solid #e8e2d8;border-radius:8px;padding:8px 14px;margin-right:8px;cursor:pointer}
  .wf.on{border-color:#b65243;background:#faf1ee;color:#7c3128;font-weight:600}
  .goalrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  input[type=number]{width:90px;padding:7px 9px;border:1px solid #e8e2d8;border-radius:7px;font:inherit}
  button{background:#b65243;color:#fff;border:0;border-radius:7px;padding:8px 16px;font:inherit;font-weight:600;cursor:pointer}
  .meter{height:8px;background:#efe9df;border-radius:4px;overflow:hidden;margin-top:10px}
  .meter i{display:block;height:100%;width:${pct}%;background:${sent >= goal && goal > 0 ? '#496d53' : '#b65243'}}
  .stats{display:flex;gap:26px;margin-top:8px}.stats b{font-size:20px}.stats div{color:#8d8179;font-size:12px}
  table{width:100%;border-collapse:collapse}th{,text-align:left}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f0ebe2;font-size:13px}
  th{color:#8d8179;font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.05em}
  .code{font-family:Consolas,monospace;color:#7c3128}.dim{color:#9b9089}
</style>
<div class="bar">saru <span>Saru Skin — workflows &amp; contacts</span></div>
<main>
  <form class="card" method="post" action="/admin/settings">
    <input type="hidden" name="key" value="${esc(config.adminKey)}">
    <h2>Active workflow — what the agent asks for when a comment shows intent</h2>
    ${radio('phone', '📱 Phone number')} ${radio('email', '✉️ Email')} ${radio('off', 'Off — instant code, no capture')}
    <h2 style="margin-top:18px">Outreach goal</h2>
    <div class="goalrow">
      Contact <input type="number" name="goal_target" min="0" value="${goal || ''}" placeholder="∞"> people, then stop.
      <button type="submit">Save</button>
    </div>
    <div class="meter"><i></i></div>
    <div class="stats">
      <div><b>${sent}</b><br>openers sent${goal ? ` / ${goal}` : ''}</div>
      <div><b>${captured}</b><br>contacts captured</div>
      <div><b>${goal > 0 && sent >= goal ? 'reached — outreach paused' : 'active'}</b><br>status</div>
    </div>
  </form>
  <div class="card">
    <h2>Captured contacts</h2>
    <table>
      <tr><th>Instagram</th><th>Name</th><th>Phone</th><th>Email</th><th>Code</th><th>Captured</th></tr>
      ${rows || '<tr><td colspan="6" class="dim">none yet — first valid reply lands here</td></tr>'}
    </table>
  </div>
</main>`;
}

export function mountAdmin(app) {
  const authed = (req) => !config.adminKey || req.query.key === config.adminKey || req.body?.key === config.adminKey;
  app.get('/admin', (req, res) => {
    if (!authed(req)) return res.status(403).send('missing ?key=');
    res.type('html').send(page());
  });
  app.post('/admin/settings', (req, res) => {
    if (!authed(req)) return res.status(403).send('missing key');
    const wf = req.body?.workflow;
    if (wf === 'phone' || wf === 'email' || wf === 'off') setSetting('workflow', wf);
    const goal = parseInt(req.body?.goal_target, 10);
    setSetting('goal_target', Number.isFinite(goal) && goal > 0 ? goal : 0);
    trace('admin', `settings updated: workflow=${wf}, goal=${Number.isFinite(goal) ? goal : 0}`);
    res.redirect(`/admin${config.adminKey ? `?key=${encodeURIComponent(config.adminKey)}` : ''}`);
  });
}
