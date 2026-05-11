import http from 'http';
import { db } from '../db/connection.js';
import { WEB_PORT } from '../config.js';

// ── API handlers ─────────────────────────────────────────────────────────────

function apiPositions() {
  const rows = db.prepare(`
    SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT 100
  `).all();
  return rows.map(r => {
    if (r.status === 'open' && r.entry_mcap && r.high_water_mcap) {
      r.current_pnl_percent = (Number(r.high_water_mcap) / Number(r.entry_mcap) - 1) * 100;
      r.current_pnl_sol = Number(r.size_sol) * r.current_pnl_percent / 100;
    }
    return r;
  });
}

function apiTrades() {
  return db.prepare(`
    SELECT t.*, p.symbol, p.execution_mode
    FROM dry_run_trades t
    LEFT JOIN dry_run_positions p ON p.id = t.position_id
    ORDER BY t.id DESC LIMIT 200
  `).all();
}

function apiDecisions() {
  return db.prepare(`
    SELECT d.*, c.candidate_json
    FROM llm_decisions d
    LEFT JOIN candidates c ON c.id = d.candidate_id
    ORDER BY d.id DESC LIMIT 100
  `).all();
}

function apiCandidates() {
  return db.prepare(`
    SELECT id, mint, status, created_at_ms, signal_key, filter_result_json, candidate_json
    FROM candidates ORDER BY id DESC LIMIT 100
  `).all();
}

function apiStats() {
  const open = db.prepare(`SELECT COUNT(*) AS c FROM dry_run_positions WHERE status='open'`).get().c;
  const closed = db.prepare(`SELECT COUNT(*) AS c FROM dry_run_positions WHERE status='closed'`).get().c;
  const wins = db.prepare(`SELECT COUNT(*) AS c FROM dry_run_positions WHERE status='closed' AND pnl_percent > 0`).get().c;
  const totalPnlSol = db.prepare(`SELECT COALESCE(SUM(pnl_sol),0) AS s FROM dry_run_positions WHERE status='closed'`).get().s;
  const openPnl = db.prepare(`SELECT * FROM dry_run_positions WHERE status='open'`).all();
  const candidates24h = db.prepare(`SELECT COUNT(*) AS c FROM candidates WHERE created_at_ms > ?`).get(Date.now() - 86400000).c;
  const decisions24h = db.prepare(`SELECT COUNT(*) AS c FROM llm_decisions WHERE created_at_ms > ?`).get(Date.now() - 86400000).c;
  const buyDecisions24h = db.prepare(`SELECT COUNT(*) AS c FROM llm_decisions WHERE created_at_ms > ? AND verdict='buy'`).get(Date.now() - 86400000).c;
  return {
    open, closed, wins,
    winRate: closed > 0 ? ((wins / closed) * 100).toFixed(1) : null,
    totalPnlSol: Number(totalPnlSol).toFixed(4),
    openPositions: openPnl.length,
    candidates24h,
    decisions24h,
    buyDecisions24h,
    updatedAt: Date.now(),
  };
}

// ── HTML UI ───────────────────────────────────────────────────────────────────

function serveHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Charon Monitor</title>
<style>
  :root{--bg:#0d0d0f;--surface:#17171b;--border:#2a2a32;--accent:#6c63ff;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--text:#e2e2e8;--muted:#6b6b7b;--font:'Inter',system-ui,sans-serif}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:13px;min-height:100vh}
  header{background:var(--surface);border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:16px}
  header h1{font-size:16px;font-weight:700;color:#fff;letter-spacing:.5px}
  header h1 span{color:var(--accent)}
  .badge{padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
  .badge.live{background:#22c55e22;color:var(--green)}
  .badge.dry{background:#eab30822;color:var(--yellow)}
  .refresh-info{margin-left:auto;color:var(--muted);font-size:11px}
  .stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;padding:16px 24px}
  .stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
  .stat .label{color:var(--muted);font-size:11px;margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
  .stat .value{font-size:22px;font-weight:700;color:#fff}
  .stat .value.green{color:var(--green)}
  .stat .value.red{color:var(--red)}
  .stat .value.yellow{color:var(--yellow)}
  nav{display:flex;gap:2px;padding:0 24px;border-bottom:1px solid var(--border);background:var(--surface)}
  nav button{background:none;border:none;color:var(--muted);padding:10px 16px;cursor:pointer;font-size:13px;border-bottom:2px solid transparent;transition:.15s}
  nav button.active{color:#fff;border-bottom-color:var(--accent)}
  nav button:hover:not(.active){color:var(--text)}
  .tab-content{padding:16px 24px;display:none}
  .tab-content.active{display:block}
  table{width:100%;border-collapse:collapse;font-size:12px}
  thead th{text-align:left;padding:8px 10px;color:var(--muted);font-weight:500;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg);text-transform:uppercase;font-size:10px;letter-spacing:.5px}
  tbody tr{border-bottom:1px solid var(--border)11;transition:.1s}
  tbody tr:hover{background:#ffffff06}
  td{padding:8px 10px;vertical-align:middle}
  .pill{display:inline-block;padding:2px 7px;border-radius:5px;font-size:10px;font-weight:600}
  .pill.open{background:#6c63ff22;color:#a89fff}
  .pill.closed{background:#ffffff11;color:var(--muted)}
  .pill.buy,.pill.BUY{background:#22c55e22;color:var(--green)}
  .pill.sell,.pill.SELL{background:#ef444422;color:var(--red)}
  .pill.live{background:#22c55e22;color:var(--green)}
  .pill.dry_run{background:#eab30822;color:var(--yellow)}
  .pill.passed{background:#22c55e22;color:var(--green)}
  .pill.filtered,.pill.rejected{background:#ef444422;color:var(--red)}
  .pill.candidate{background:#6c63ff22;color:#a89fff}
  .pnl.pos{color:var(--green);font-weight:600}
  .pnl.neg{color:var(--red);font-weight:600}
  .pnl.zero{color:var(--muted)}
  .mint{font-family:monospace;font-size:11px;color:var(--muted)}
  .reason{color:var(--muted);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .table-wrap{overflow-x:auto;border-radius:10px;border:1px solid var(--border)}
  .empty{color:var(--muted);text-align:center;padding:32px;font-size:13px}
  .ts{color:var(--muted);font-size:10px;font-family:monospace}
  .verdict.buy{color:var(--green);font-weight:600}
  .verdict.skip,.verdict.reject{color:var(--muted)}
  .verdict.hold{color:var(--yellow)}
  @keyframes wallStreetFlash{0%{background-color:#22c55e44;box-shadow:inset 0 0 20px #22c55e66}100%{background-color:transparent;box-shadow:none}}
  tbody tr.flash{animation:wallStreetFlash .5s cubic-bezier(.4,0,.2,1)}
</style>
</head>
<body>
<header>
  <h1>☽ <span>Charon</span> Monitor</h1>
  <span class="badge dry" id="mode-badge">dry_run</span>
  <span class="refresh-info" id="refresh-info">refreshing…</span>
</header>
<div class="stats" id="stats-grid"></div>
<nav>
  <button class="active" onclick="switchTab('positions',this)">Positions</button>
  <button onclick="switchTab('trades',this)">Trades</button>
  <button onclick="switchTab('decisions',this)">LLM Decisions</button>
  <button onclick="switchTab('candidates',this)">Candidates</button>
</nav>
<div id="positions" class="tab-content active"></div>
<div id="trades" class="tab-content"></div>
<div id="decisions" class="tab-content"></div>
<div id="candidates" class="tab-content"></div>

<script>
const fmt = {
  ts: ms => ms ? new Date(ms).toLocaleString() : '—',
  pct: v => v == null ? '—' : (v >= 0 ? '+' : '') + Number(v).toFixed(2) + '%',
  sol: v => v == null ? '—' : Number(v).toFixed(4) + ' SOL',
  usd: v => v == null ? '—' : '$' + (Number(v) >= 1e6 ? (Number(v)/1e6).toFixed(2)+'M' : Number(v) >= 1e3 ? (Number(v)/1e3).toFixed(1)+'K' : Number(v).toFixed(0)),
  short: s => s ? s.slice(0,6)+'…'+s.slice(-4) : '—',
  age: ms => { if(!ms) return '—'; const d=Date.now()-ms; if(d<60000) return Math.floor(d/1000)+'s ago'; if(d<3600000) return Math.floor(d/60000)+'m ago'; if(d<86400000) return Math.floor(d/3600000)+'h ago'; return Math.floor(d/86400000)+'d ago'; }
};

function pnlClass(v) { return v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero'; }
function pill(text, cls) { return '<span class="pill ' + (cls||text) + '">' + (text||'') + '</span>'; }

function renderStats(d) {
  const grid = document.getElementById('stats-grid');
  const wr = d.winRate != null ? d.winRate + '%' : '—';
  const pnlCls = Number(d.totalPnlSol) >= 0 ? 'green' : 'red';
  grid.innerHTML = [
    ['Open', d.open, ''],
    ['Closed', d.closed, ''],
    ['Win Rate', wr, ''],
    ['Total PnL', d.totalPnlSol + ' SOL', pnlCls],
    ['Candidates 24h', d.candidates24h, ''],
    ['LLM Decisions 24h', d.decisions24h, ''],
    ['LLM Buys 24h', d.buyDecisions24h, 'green'],
  ].map(([label, value, cls]) =>
    '<div class="stat"><div class="label">'+label+'</div><div class="value '+cls+'">'+value+'</div></div>'
  ).join('');
}

function renderPositions(rows) {
  if (!rows.length) return '<div class="empty">No positions</div>';
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>ID</th><th>Symbol</th><th>Mode</th><th>Status</th><th>Entry Mcap</th><th>High Water</th><th>Unrealized %</th><th>Unrealized SOL</th><th>Realized %</th><th>Realized SOL</th><th>Exit Reason</th><th>Opened</th><th>Closed</th>' +
    '</tr></thead><tbody>' +
    rows.map(r => '<tr data-id="' + r.id + '">' +
      '<td>#'+r.id+'</td>' +
      '<td><b>'+(r.symbol||fmt.short(r.mint))+'</b></td>' +
      '<td>'+pill(r.execution_mode)+'</td>' +
      '<td>'+pill(r.status)+'</td>' +
      '<td>'+fmt.usd(r.entry_mcap)+'</td>' +
      '<td>'+fmt.usd(r.high_water_mcap)+'</td>' +
      '<td class="pnl '+pnlClass(r.current_pnl_percent)+'">'+fmt.pct(r.current_pnl_percent)+'</td>' +
      '<td class="pnl '+pnlClass(r.current_pnl_sol)+'">'+fmt.sol(r.current_pnl_sol)+'</td>' +
      '<td class="pnl '+pnlClass(r.pnl_percent)+'">'+fmt.pct(r.pnl_percent)+'</td>' +
      '<td class="pnl '+pnlClass(r.pnl_sol)+'">'+fmt.sol(r.pnl_sol)+'</td>' +
      '<td>'+(r.exit_reason||'—')+'</td>' +
      '<td class="ts">'+fmt.age(r.opened_at_ms)+'</td>' +
      '<td class="ts">'+(r.closed_at_ms ? fmt.age(r.closed_at_ms) : '—')+'</td>' +
    '</tr>').join('') +
    '</tbody></table></div>';
}

function renderTrades(rows) {
  if (!rows.length) return '<div class="empty">No trades</div>';
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>ID</th><th>Position</th><th>Symbol</th><th>Side</th><th>Mode</th><th>Mcap</th><th>Size SOL</th><th>PnL</th><th>Reason</th><th>Time</th>' +
    '</tr></thead><tbody>' +
    rows.map(r => {
      let pnl = '—';
      try { const p = JSON.parse(r.payload_json||'{}'); pnl = p.pnlPercent != null ? '<span class="pnl '+pnlClass(p.pnlPercent)+'">'+fmt.pct(p.pnlPercent)+'</span>' : '—'; } catch(e){}
      return '<tr data-id="' + r.id + '">' +
        '<td>#'+r.id+'</td>' +
        '<td>#'+r.position_id+'</td>' +
        '<td><b>'+(r.symbol||fmt.short(r.mint))+'</b></td>' +
        '<td>'+pill(r.side)+'</td>' +
        '<td>'+pill(r.execution_mode||'dry_run')+'</td>' +
        '<td>'+fmt.usd(r.mcap)+'</td>' +
        '<td>'+fmt.sol(r.size_sol)+'</td>' +
        '<td>'+pnl+'</td>' +
        '<td class="reason">'+(r.reason||'—')+'</td>' +
        '<td class="ts">'+fmt.age(r.at_ms)+'</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

function renderDecisions(rows) {
  if (!rows.length) return '<div class="empty">No decisions</div>';
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>ID</th><th>Symbol</th><th>Verdict</th><th>Confidence</th><th>Reason</th><th>Risks</th><th>Time</th>' +
    '</tr></thead><tbody>' +
    rows.map(r => {
      let symbol = fmt.short(r.mint);
      try { const c = JSON.parse(r.candidate_json||'{}'); symbol = c.token?.symbol || symbol; } catch(e) {}
      let risks = '—';
      try { const a = JSON.parse(r.risks_json||'[]'); risks = a.slice(0,3).join(', ') || '—'; } catch(e) {}
      return '<tr data-id="' + r.id + '">' +
        '<td>#'+r.id+'</td>' +
        '<td><b>'+symbol+'</b></td>' +
        '<td><span class="verdict '+r.verdict+'">'+r.verdict+'</span></td>' +
        '<td>'+(r.confidence != null ? Number(r.confidence).toFixed(0)+'%' : '—')+'</td>' +
        '<td class="reason">'+(r.reason||'—')+'</td>' +
        '<td class="reason">'+risks+'</td>' +
        '<td class="ts">'+fmt.age(r.created_at_ms)+'</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

function renderCandidates(rows) {
  if (!rows.length) return '<div class="empty">No candidates</div>';
  return '<div class="table-wrap"><table><thead><tr>' +
    '<th>ID</th><th>Symbol</th><th>Signal</th><th>Status</th><th>Filter</th><th>Failures</th><th>Time</th>' +
    '</tr></thead><tbody>' +
    rows.map(r => {
      let symbol = fmt.short(r.mint);
      let failures = '—';
      try { const c = JSON.parse(r.candidate_json||'{}'); symbol = c.token?.symbol || symbol; } catch(e) {}
      try { const f = JSON.parse(r.filter_result_json||'{}'); failures = (f.failures||[]).slice(0,3).join(', ') || '—'; } catch(e) {}
      let filterStatus = 'passed';
      try { const f = JSON.parse(r.filter_result_json||'{}'); filterStatus = f.passed ? 'passed' : 'filtered'; } catch(e) {}
      return '<tr data-id="' + r.id + '">' +
        '<td>#'+r.id+'</td>' +
        '<td><b>'+symbol+'</b></td>' +
        '<td class="mint">'+(r.signal_key||'—')+'</td>' +
        '<td>'+pill(r.status)+'</td>' +
        '<td>'+pill(filterStatus)+'</td>' +
        '<td class="reason">'+failures+'</td>' +
        '<td class="ts">'+fmt.age(r.created_at_ms)+'</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

let activeTab = 'positions';
function switchTab(id, btn) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(el => el.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
  activeTab = id;
}

async function fetchJson(url) {
  const r = await fetch(url);
  return r.json();
}

let lastData = {};
function applyFlash(type, newRows) {
  const old = lastData[type] || [];
  setTimeout(() => {
    const tbody = document.querySelector('#' + type + ' tbody');
    if (!tbody) return;
    const rows = tbody.querySelectorAll('tr');
    rows.forEach((el, i) => {
      const newId = newRows[i]?.id;
      const oldId = old[i]?.id;
      if (!newId) return;
      if (newId !== oldId) {
        el.classList.add('flash');
        setTimeout(() => el.classList.remove('flash'), 600);
      } else {
        const oldStr = JSON.stringify(old[i]);
        const newStr = JSON.stringify(newRows[i]);
        if (oldStr !== newStr) {
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 600);
        }
      }
    });
  }, 10);
}

let countdown = 5;
async function refresh() {
  try {
    const [stats, positions, trades, decisions, candidates] = await Promise.all([
      fetchJson('/api/stats'),
      fetchJson('/api/positions'),
      fetchJson('/api/trades'),
      fetchJson('/api/decisions'),
      fetchJson('/api/candidates'),
    ]);
    renderStats(stats);
    document.getElementById('positions').innerHTML = renderPositions(positions);
    document.getElementById('trades').innerHTML = renderTrades(trades);
    document.getElementById('decisions').innerHTML = renderDecisions(decisions);
    document.getElementById('candidates').innerHTML = renderCandidates(candidates);
    applyFlash('positions', positions);
    applyFlash('trades', trades);
    applyFlash('decisions', decisions);
    applyFlash('candidates', candidates);
    lastData = {positions, trades, decisions, candidates};
    countdown = 5;
  } catch(e) {
    document.getElementById('refresh-info').textContent = 'Error: ' + e.message;
  }
}

setInterval(() => {
  countdown--;
  if (countdown <= 0) { refresh(); countdown = 5; }
  document.getElementById('refresh-info').textContent = 'next refresh in ' + countdown + 's';
}, 1000);

refresh();
</script>
</body>
</html>`;
}

// ── Router ────────────────────────────────────────────────────────────────────

function respond(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function respondHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

export function startWebServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost`);
    try {
      if (url.pathname === '/') return respondHtml(res, serveHtml());
      if (url.pathname === '/api/stats') return respond(res, apiStats());
      if (url.pathname === '/api/positions') return respond(res, apiPositions());
      if (url.pathname === '/api/trades') return respond(res, apiTrades());
      if (url.pathname === '/api/decisions') return respond(res, apiDecisions());
      if (url.pathname === '/api/candidates') return respond(res, apiCandidates());
      res.writeHead(404); res.end('Not found');
    } catch (err) {
      console.error('[web] request error:', err.message);
      res.writeHead(500); res.end('Internal error');
    }
  });

  server.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`[web] Monitor UI: http://localhost:${WEB_PORT}`);
  });

  return server;
}
