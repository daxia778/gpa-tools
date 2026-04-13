// ============================================================
// GPA Tools — Frontend Application (v2)
// 分账号配额展示 + CLI 工具箱 + 流量监控
// ============================================================

const API = '';  // Same origin

// ---- State ----
let currentPage = 'dashboard';
let trafficState = { filter: '', errorsOnly: false, offset: 0, limit: 50, total: 0 };
let trafficPollTimer = null;
let apiKey = '';

// ---- Page Navigation ----
document.querySelectorAll('.nav-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    switchPage(page);
  });
});

function switchPage(page) {
  currentPage = page;
  document.querySelectorAll('.nav-pill').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  document.querySelectorAll('.page-container').forEach(p => {
    p.classList.toggle('hidden', p.id !== `page-${page}`);
  });
  if (page === 'dashboard') loadDashboard();
  if (page === 'accounts') loadAccounts();
  if (page === 'toolbox') loadToolbox();
}

// ---- Dashboard ----
async function loadDashboard() {
  loadStats();
  loadAccountQuotas();
}

async function loadStats() {
  try {
    const data = await fetch(`${API}/api/stats?hours=24`).then(r => r.json());
    const t = data.total || {};
    document.getElementById('stat-total').textContent = (t.total_requests || 0).toLocaleString();
    const rate = t.total_requests > 0 ? ((t.success / t.total_requests) * 100).toFixed(1) + '%' : '—';
    document.getElementById('stat-success').textContent = rate;
    document.getElementById('stat-success-count').textContent = `${t.success || 0} 成功 / ${t.errors || 0} 失败`;
    document.getElementById('stat-credits').textContent = (t.credits_requests || 0).toLocaleString();
    document.getElementById('stat-latency').textContent = t.avg_latency_ms ? Math.round(t.avg_latency_ms) + 'ms' : '—';
    const totalTokens = (t.total_input_tokens || 0) + (t.total_output_tokens || 0);
    document.getElementById('stat-tokens').textContent = totalTokens > 0 ? formatNumber(totalTokens) + ' tokens' : '— tokens';

    // Model distribution
    renderModels(data.byModel || []);
    // Trend chart
    renderTrend(data.byHour || []);
  } catch (e) { console.error('Stats load failed:', e); }
}

async function loadAccountQuotas() {
  try {
    const data = await fetch(`${API}/api/quotas/grouped`).then(r => r.json());
    const container = document.getElementById('account-quotas-container');
    if (!data || data.length === 0) {
      container.innerHTML = '<div class="empty-state">导入账号后将显示配额和积分信息</div>';
      return;
    }
    container.innerHTML = data.map(acct => renderAccountCard(acct)).join('');
  } catch (e) { console.error('Grouped quotas failed:', e); }
}

function renderAccountCard(acct) {
  const tier = acct.subscription_tier || 'FREE';
  const tierClass = tier === 'ULTRA' ? 'tier-ULTRA' : tier === 'PRO' ? 'tier-PRO' : 'tier-FREE';
  const initial = (acct.email || '?')[0].toUpperCase();
  const credits = acct.credits;
  const creditsEnabled = credits && credits.credits_enabled;
  const creditsAmount = credits ? credits.credit_amount : 0;
  const creditsExhausted = credits && credits.credits_exhausted;

  let creditsHtml = '';
  if (credits) {
    const statusClass = creditsExhausted ? 'credits-exhausted' : creditsEnabled ? 'credits-active' : 'credits-disabled';
    const statusText = creditsExhausted ? '已耗尽' : creditsEnabled ? '已启用' : '未启用';
    creditsHtml = `
      <div class="acct-credits-info ${statusClass}">
        <span class="credits-badge">${statusText}</span>
        ${creditsAmount > 0 ? `<span class="credits-amount">¤ ${creditsAmount.toFixed(2)}</span>` : ''}
        <span class="credits-tier">${credits.credit_type || 'GOOGLE_ONE_AI'}</span>
      </div>`;
  }

  const quotasHtml = acct.quotas.length > 0
    ? `<div class="acct-quota-grid">${acct.quotas.map(q => {
        const pct = 100 - q.utilization;
        const color = pct > 60 ? '#22c55e' : pct > 20 ? '#f59e0b' : '#ef4444';
        return `<div class="acct-quota-item">
          <div class="acct-quota-name">${q.model}</div>
          <div class="acct-quota-bar"><div class="acct-quota-fill" style="width:${pct}%;background:${color}"></div></div>
          <div class="acct-quota-pct">${pct}%</div>
        </div>`;
      }).join('')}</div>`
    : '<div class="empty-state" style="padding:12px;font-size:12px;">暂无配额数据 — 点击顶部「刷新」按钮拉取</div>';

  return `
    <div class="account-quota-card">
      <div class="acct-card-header">
        <div class="acct-avatar">${initial}</div>
        <div class="acct-card-info">
          <div class="acct-card-email">${acct.email}</div>
          <div class="acct-card-meta">
            <span class="tier-badge ${tierClass}">${tier}</span>
            <span class="acct-project">${acct.project_id || '—'}</span>
          </div>
        </div>
        ${creditsHtml}
      </div>
      ${quotasHtml}
    </div>`;
}

// ---- Models ----
function renderModels(models) {
  const el = document.getElementById('model-list');
  if (!models.length) { el.innerHTML = '<div class="empty-state">暂无模型使用数据</div>'; return; }
  const maxReq = Math.max(...models.map(m => m.requests));
  el.innerHTML = models.map(m => {
    const pct = maxReq > 0 ? (m.requests / maxReq * 100) : 0;
    return `<div class="model-item">
      <div class="model-name">${m.model}</div>
      <div class="model-bar"><div class="model-fill" style="width:${pct}%"></div></div>
      <div class="model-count">${m.requests}</div>
    </div>`;
  }).join('');
}

// ---- Trend ----
function renderTrend(hours) {
  const el = document.getElementById('trend-chart');
  if (!hours.length) { el.innerHTML = '<div class="empty-state">暂无趋势数据</div>'; return; }
  const maxReq = Math.max(...hours.map(h => h.requests), 1);
  el.innerHTML = `<div class="trend-bars">${hours.map(h => {
    const pct = (h.requests / maxReq * 100);
    const label = h.hour.split(' ')[1] || h.hour;
    return `<div class="trend-col">
      <div class="trend-bar-wrap"><div class="trend-bar" style="height:${pct}%"></div></div>
      <div class="trend-label">${label}</div>
    </div>`;
  }).join('')}</div>`;
}

// ---- Accounts Page ----
async function loadAccounts() {
  try {
    const [accounts, credits] = await Promise.all([
      fetch(`${API}/api/accounts`).then(r => r.json()),
      fetch(`${API}/api/credits`).then(r => r.json()),
    ]);
    const creditsMap = {};
    (credits || []).forEach(c => { creditsMap[c.account_id] = c; });

    const active = accounts.filter(a => a.status === 'active').length;
    const expired = accounts.length - active;
    document.getElementById('acct-total').textContent = accounts.length;
    document.getElementById('acct-active').textContent = active;
    document.getElementById('acct-active-pct').textContent = accounts.length > 0 ? `${(active / accounts.length * 100).toFixed(0)}% 可用` : '—';
    document.getElementById('acct-expired').textContent = expired;

    const totalCredits = (credits || []).reduce((sum, c) => sum + (c.credit_amount || 0), 0);
    document.getElementById('acct-credits-total').textContent = totalCredits > 0 ? `¤ ${totalCredits.toFixed(2)}` : '—';

    const badge = document.getElementById('acct-count-badge');
    badge.textContent = `${accounts.length} 个账号`;

    const list = document.getElementById('accounts-list');
    if (!accounts.length) {
      list.innerHTML = '<div class="empty-state">暂无账号 — 点击"导入 RT"添加 Google 账号</div>';
      return;
    }
    list.innerHTML = accounts.map(a => {
      const tier = a.subscription_tier || 'FREE';
      const tierClass = tier === 'ULTRA' ? 'tier-ULTRA' : tier === 'PRO' ? 'tier-PRO' : 'tier-FREE';
      const initial = (a.email || '?')[0].toUpperCase();
      const statusClass = a.status === 'active' ? 'status-active' : 'status-error';
      const statusText = a.status === 'active' ? '正常' : '异常';
      return `<div class="account-item">
        <div class="account-avatar">${initial}</div>
        <div class="account-info">
          <div class="account-email">${a.email}</div>
          <div class="account-meta">
            <span class="tier-badge ${tierClass}">${tier}</span>
            <span class="account-rt">RT: ${a.refresh_token.substring(0, 15)}...</span>
            <span class="account-pid">Proj: ${a.project_id || '—'}</span>
          </div>
        </div>
        <span class="account-status ${statusClass}">${statusText}</span>
        <button class="tool-btn" onclick="refreshAccount('${a.account_id}')" title="刷新token">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        </button>
        <button class="tool-btn danger" onclick="deleteAccount('${a.account_id}')" title="删除账号">
          <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </div>`;
    }).join('');
  } catch (e) { console.error('Accounts load failed:', e); }
}

// ---- Toolbox Page ----
async function loadToolbox() {
  loadApiKey();
  renderCliCards();
  loadTrafficLogs();
  startTrafficPoll();
  initTrafficFilters();
}

async function loadApiKey() {
  try {
    const data = await fetch(`${API}/api/api-key`).then(r => r.json());
    apiKey = data.api_key || '';
    document.getElementById('api-key-display').textContent = apiKey || '未生成 — 点击「生成」创建';
    renderCliCards();
  } catch (e) { console.error('ApiKey load failed:', e); }
}

function renderCliCards() {
  const clis = [
    { name: 'Claude Code', icon: '⌘', color: '#a855f7', protocol: 'anthropic',
      envLines: [`export ANTHROPIC_BASE_URL=http://localhost:8600`, `export ANTHROPIC_API_KEY=${apiKey || 'gpa-xxx'}`] },
    { name: 'Codex CLI', icon: '▶', color: '#3b82f6', protocol: 'openai',
      envLines: [`export OPENAI_BASE_URL=http://localhost:8600/v1`, `export OPENAI_API_KEY=${apiKey || 'gpa-xxx'}`] },
    { name: 'Gemini CLI', icon: '◆', color: '#22c55e', protocol: 'gemini',
      envLines: [`export GEMINI_API_KEY=${apiKey || 'gpa-xxx'}`, `# Gemini CLI 通过 API Key 模式连接`] },
    { name: 'Cursor / Windsurf', icon: '✦', color: '#f59e0b', protocol: 'openai',
      envLines: [`# Base URL: http://localhost:8600/v1`, `# API Key: ${apiKey || 'gpa-xxx'}`, `# 在 IDE Settings → AI 配置中填写以上信息`] },
  ];

  document.getElementById('cli-cards').innerHTML = clis.map(cli => {
    const cmdText = cli.envLines.join('\n');
    return `<div class="cli-card">
      <div class="cli-card-header">
        <div class="cli-icon" style="background:${cli.color}">${cli.icon}</div>
        <div class="cli-name">${cli.name}</div>
        <span class="cli-protocol">${cli.protocol}</span>
      </div>
      <pre class="cli-code">${escapeHtml(cmdText)}</pre>
      <button class="btn btn-sm btn-outline cli-copy-btn" onclick="copyText(\`${cmdText.replace(/`/g, '\\`')}\`)">
        复制命令
      </button>
    </div>`;
  }).join('');
}

// ---- Traffic Monitor ----
function initTrafficFilters() {
  const container = document.getElementById('traffic-filters');
  if (container.children.length > 0) return; // already init
  const filters = [
    { label: '全部', value: '', errors: false },
    { label: '错误', value: '', errors: true },
    { label: 'Claude', value: 'claude', errors: false },
    { label: 'Gemini', value: 'gemini', errors: false },
    { label: 'Credits', value: 'credits', errors: false },
  ];
  container.innerHTML = filters.map(f => {
    const active = trafficState.filter === f.value && trafficState.errorsOnly === f.errors;
    return `<button class="filter-pill ${active ? 'active' : ''}" data-filter="${f.value}" data-errors="${f.errors}">${f.label}</button>`;
  }).join('');
  container.querySelectorAll('.filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      trafficState.filter = btn.dataset.filter;
      trafficState.errorsOnly = btn.dataset.errors === 'true';
      trafficState.offset = 0;
      container.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadTrafficLogs();
    });
  });
}

async function loadTrafficLogs() {
  try {
    const params = new URLSearchParams({
      limit: trafficState.limit, offset: trafficState.offset,
      filter: trafficState.filter, errors_only: trafficState.errorsOnly,
    });
    const data = await fetch(`${API}/api/usage-logs?${params}`).then(r => r.json());
    trafficState.total = data.total || 0;
    renderTrafficTable(data.logs || []);
    renderTrafficPagination();
  } catch (e) { console.error('Traffic logs failed:', e); }
}

function renderTrafficTable(logs) {
  const tbody = document.getElementById('traffic-body');
  if (!logs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">暂无请求记录</td></tr>';
    return;
  }
  tbody.innerHTML = logs.map(log => {
    const statusClass = log.status_code < 400 ? 'status-ok' : 'status-err';
    const creditsTag = log.credits_used ? '<span class="credits-tag">¤</span>' : '';
    const email = log.account_email ? log.account_email.replace(/(.{3}).*(@.*)/, '$1***$2') : '—';
    const tokens = (log.input_tokens || 0) + (log.output_tokens || 0);
    return `<tr>
      <td><span class="status-badge ${statusClass}">${log.status_code}</span></td>
      <td class="model-cell">${creditsTag}${log.model || '—'}</td>
      <td class="email-cell" title="${log.account_email || ''}">${email}</td>
      <td style="text-align:right">${log.latency_ms}ms</td>
      <td style="text-align:right">${tokens > 0 ? formatNumber(tokens) : '—'}</td>
      <td style="text-align:right;font-size:11px;">${log.trace_id ? log.trace_id.split('-')[1] || '' : ''}</td>
    </tr>`;
  }).join('');
}

function renderTrafficPagination() {
  const el = document.getElementById('traffic-pagination');
  const totalPages = Math.ceil(trafficState.total / trafficState.limit);
  const page = Math.floor(trafficState.offset / trafficState.limit) + 1;
  if (totalPages <= 1) { el.innerHTML = `<span class="pag-info">${trafficState.total} 条记录</span>`; return; }
  el.innerHTML = `
    <button class="btn btn-sm btn-outline" onclick="trafficPrev()" ${page <= 1 ? 'disabled' : ''}>‹</button>
    <span class="pag-info">${page} / ${totalPages} (${trafficState.total} 条)</span>
    <button class="btn btn-sm btn-outline" onclick="trafficNext()" ${page >= totalPages ? 'disabled' : ''}>›</button>`;
}

function trafficPrev() { trafficState.offset = Math.max(0, trafficState.offset - trafficState.limit); loadTrafficLogs(); }
function trafficNext() { trafficState.offset += trafficState.limit; loadTrafficLogs(); }

function startTrafficPoll() {
  if (trafficPollTimer) clearInterval(trafficPollTimer);
  trafficPollTimer = setInterval(() => {
    if (currentPage === 'toolbox') loadTrafficLogs();
  }, 10000);
}

// ---- Account Actions ----
async function refreshAccount(accountId) {
  try {
    await fetch(`${API}/api/accounts/${accountId}/refresh`, { method: 'POST' });
    loadAccounts();
  } catch (e) { console.error(e); }
}

async function deleteAccount(accountId) {
  if (!confirm('确定删除此账号？')) return;
  try {
    await fetch(`${API}/api/accounts/${accountId}`, { method: 'DELETE' });
    loadAccounts();
  } catch (e) { console.error(e); }
}

// ---- Import RT ----
function toggleImportModal(show) {
  document.getElementById('import-modal').classList.toggle('hidden', !show);
  if (show) {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-progress').classList.add('hidden');
    document.getElementById('import-results').classList.add('hidden');
  }
}

async function doImportTokens() {
  const raw = document.getElementById('import-textarea').value.trim();
  if (!raw) return;
  let tokens = [];
  try { tokens = JSON.parse(raw); } catch {
    tokens = raw.split(/[\n,]+/).map(t => t.split('|').pop().trim()).filter(Boolean);
  }
  if (!tokens.length) return;

  document.getElementById('import-progress').classList.remove('hidden');
  document.getElementById('import-status').textContent = `正在导入 ${tokens.length} 个 token...`;
  document.getElementById('import-progress-bar').style.width = '50%';

  try {
    const resp = await fetch(`${API}/api/import-tokens`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens }),
    });
    const result = await resp.json();
    document.getElementById('import-progress-bar').style.width = '100%';
    document.getElementById('import-status').textContent = `完成: ${result.success} 成功, ${result.failed} 失败`;

    const resultsDiv = document.getElementById('import-results');
    resultsDiv.classList.remove('hidden');
    resultsDiv.innerHTML = (result.results || []).map(r => {
      const icon = r.status === 'success' ? '✓' : '✗';
      const cls = r.status === 'success' ? 'result-success' : 'result-error';
      return `<div class="import-result-row ${cls}"><span>${icon}</span> ${r.email || r.error || r.refresh_token}</div>`;
    }).join('');

    loadAccounts();
    loadAccountQuotas();
  } catch (e) {
    document.getElementById('import-status').textContent = `导入失败: ${e.message}`;
  }
}

// ---- Health Check ----
async function checkHealth() {
  try {
    const data = await fetch(`${API}/api/health`).then(r => r.json());
    const dot = document.getElementById('health-indicator');
    dot.className = 'health-dot ' + (data.at_proxy === 'online' ? 'online' : 'offline');
    dot.title = data.at_proxy === 'online' ? 'AT Manager 在线' : 'AT Manager 离线';
  } catch { document.getElementById('health-indicator').className = 'health-dot offline'; }
}

// ---- Settings ----
document.getElementById('btn-settings')?.addEventListener('click', async () => {
  try {
    const cfg = await fetch(`${API}/api/config`).then(r => r.json());
    document.getElementById('cfg-at-proxy').value = cfg.at_proxy_url || '';
    document.getElementById('cfg-sub2api').value = cfg.sub2api_url || '';
    document.getElementById('cfg-auto-inject').checked = cfg.credits_auto_inject === 'true';
  } catch {}
  document.getElementById('settings-modal').classList.remove('hidden');
});

document.getElementById('btn-save-config')?.addEventListener('click', async () => {
  try {
    await fetch(`${API}/api/config`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        at_proxy_url: document.getElementById('cfg-at-proxy').value,
        sub2api_url: document.getElementById('cfg-sub2api').value,
        credits_auto_inject: document.getElementById('cfg-auto-inject').checked ? 'true' : 'false',
      }),
    });
    document.getElementById('settings-modal').classList.add('hidden');
  } catch (e) { console.error(e); }
});

// ---- Event Bindings ----
document.getElementById('btn-refresh')?.addEventListener('click', () => {
  if (currentPage === 'dashboard') loadDashboard();
  if (currentPage === 'accounts') loadAccounts();
  if (currentPage === 'toolbox') loadToolbox();
});

document.getElementById('btn-import-rt')?.addEventListener('click', () => toggleImportModal(true));

document.getElementById('btn-refresh-quotas')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-quotas');
  btn.disabled = true;
  btn.textContent = '刷新中...';
  try {
    await fetch(`${API}/api/quotas/refresh`, { method: 'POST' });
    await loadAccountQuotas();
  } catch (e) { console.error(e); }
  btn.disabled = false;
  btn.innerHTML = '<svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>刷新';
});

document.getElementById('btn-gen-key')?.addEventListener('click', async () => {
  try {
    const data = await fetch(`${API}/api/api-key/generate`, { method: 'POST' }).then(r => r.json());
    apiKey = data.api_key;
    document.getElementById('api-key-display').textContent = apiKey;
    renderCliCards();
  } catch (e) { console.error(e); }
});

document.getElementById('btn-copy-key')?.addEventListener('click', () => copyText(apiKey));

document.getElementById('btn-clear-logs')?.addEventListener('click', async () => {
  if (!confirm('确定清空所有请求日志？')) return;
  try { await fetch(`${API}/api/usage-logs/clear`, { method: 'POST' }); loadTrafficLogs(); } catch (e) { console.error(e); }
});

// Copy buttons for proxy endpoints
document.querySelectorAll('.copy-btn[data-url]').forEach(btn => {
  btn.addEventListener('click', () => copyText(btn.dataset.url));
});

// ---- Utilities ----
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    // Brief visual feedback (could add toast later)
  }).catch(() => {
    const ta = document.createElement('textarea'); ta.value = text;
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatNumber(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

// ---- Init ----
checkHealth();
loadDashboard();
setInterval(checkHealth, 30000);
