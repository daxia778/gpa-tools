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
  if (page === 'proxy') loadProxyPage();
  if (page === 'logs') loadLogsPage();
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

let groupedAccountData = [];
let activeAccountIdx = 0;

async function loadAccountQuotas() {
  try {
    const data = await fetch(`${API}/api/quotas/grouped`).then(r => r.json());
    groupedAccountData = data || [];
    const container = document.getElementById('account-quotas-container');
    if (!groupedAccountData.length) {
      container.innerHTML = '<div class="empty-state">导入账号后将显示配额和积分信息</div>';
      return;
    }
    if (activeAccountIdx >= groupedAccountData.length) activeAccountIdx = 0;
    renderAccountTabs();
  } catch (e) { console.error('Grouped quotas failed:', e); }
}

function renderAccountTabs() {
  const container = document.getElementById('account-quotas-container');
  const tabsHtml = groupedAccountData.map((acct, i) => {
    const tier = acct.subscription_tier || 'FREE';
    const tierClass = tier === 'ULTRA' ? 'tier-ULTRA' : tier === 'PRO' ? 'tier-PRO' : 'tier-FREE';
    const initial = (acct.email || '?')[0].toUpperCase();
    const active = i === activeAccountIdx;
    return `<button class="acct-tab ${active ? 'active' : ''}" onclick="switchAccountTab(${i})">
      <span class="acct-tab-avatar">${initial}</span>
      <span class="acct-tab-email">${acct.email.split('@')[0]}</span>
      <span class="tier-badge ${tierClass}" style="font-size:9px;padding:1px 5px;">${tier}</span>
    </button>`;
  }).join('');

  const acct = groupedAccountData[activeAccountIdx];
  container.innerHTML = `
    <div class="acct-tabs-bar">${tabsHtml}</div>
    ${renderAccountDetail(acct)}`;
}

function switchAccountTab(idx) {
  activeAccountIdx = idx;
  renderAccountTabs();
}

function renderAccountDetail(acct) {
  const tier = acct.subscription_tier || 'FREE';
  const tierClass = tier === 'ULTRA' ? 'tier-ULTRA' : tier === 'PRO' ? 'tier-PRO' : 'tier-FREE';
  const credits = acct.credits;

  // ---- Credits Section ----
  let creditsHtml = '';
  if (credits) {
    const enabled = credits.credits_enabled;
    const exhausted = credits.credits_exhausted;
    const amount = credits.credit_amount || 0;
    const minUsage = credits.minimum_for_usage || 0;
    const statusClass = exhausted ? 'exhausted' : enabled ? 'active' : 'disabled';
    const statusIcon = exhausted ? '🔴' : enabled ? '🟢' : '⚪';
    const statusLabel = exhausted ? '已耗尽' : enabled ? '可用' : '未启用';
    const exhaustedUntil = credits.credits_exhausted_until
      ? `<span class="credits-reset">恢复时间: ${new Date(credits.credits_exhausted_until).toLocaleString()}</span>` : '';

    creditsHtml = `
      <div class="credits-panel">
        <div class="credits-panel-header">
          <span class="credits-panel-title">💳 AI Credits</span>
          <span class="credits-status-pill ${statusClass}">${statusIcon} ${statusLabel}</span>
        </div>
        <div class="credits-detail-grid">
          <div class="credits-detail-item">
            <div class="credits-detail-label">类型</div>
            <div class="credits-detail-value">${credits.credit_type || 'GOOGLE_ONE_AI'}</div>
          </div>
          <div class="credits-detail-item">
            <div class="credits-detail-label">订阅等级</div>
            <div class="credits-detail-value"><span class="tier-badge ${tierClass}">${tier}</span></div>
          </div>
          <div class="credits-detail-item">
            <div class="credits-detail-label">余额</div>
            <div class="credits-detail-value credits-amount-lg">${amount > 0 ? '¤ ' + amount.toFixed(2) : '—'}</div>
          </div>
          <div class="credits-detail-item">
            <div class="credits-detail-label">最低使用额</div>
            <div class="credits-detail-value">${minUsage > 0 ? '¤ ' + minUsage.toFixed(2) : '—'}</div>
          </div>
        </div>
        ${exhaustedUntil}
      </div>`;
  }

  // ---- Group models by category ----
  const categories = categorizeModels(acct.quotas);
  let quotasHtml = '';
  if (acct.quotas.length > 0) {
    quotasHtml = categories.map(cat => {
      if (!cat.models.length) return '';
      return `
        <div class="model-category">
          <div class="model-category-header">
            <span class="model-category-icon">${cat.icon}</span>
            <span class="model-category-name">${cat.name}</span>
            <span class="model-category-count">${cat.models.length} 个模型</span>
          </div>
          <div class="model-category-grid">
            ${cat.models.map(q => {
              const pct = 100 - q.utilization;
              const barColor = pct > 60 ? 'var(--quota-green)' : pct > 20 ? 'var(--quota-amber)' : 'var(--quota-red)';
              const pctColor = pct > 60 ? '#16a34a' : pct > 20 ? '#d97706' : '#dc2626';
              return `<div class="model-quota-row">
                <div class="model-quota-name" title="${q.model}">${q.model}</div>
                <div class="model-quota-bar-wrap">
                  <div class="model-quota-bar-bg">
                    <div class="model-quota-bar-fill" style="width:${pct}%;background:${barColor}"></div>
                  </div>
                </div>
                <div class="model-quota-pct" style="color:${pctColor}">${pct}%</div>
              </div>`;
            }).join('')}
          </div>
        </div>`;
    }).filter(Boolean).join('');
  } else {
    quotasHtml = '<div class="empty-state" style="padding:16px;font-size:12px;">暂无配额数据 — 点击「刷新」拉取</div>';
  }

  return `
    <div class="acct-detail-panel">
      <div class="acct-detail-header">
        <div class="acct-detail-email">${acct.email}</div>
        <div class="acct-detail-meta">Project: <code>${acct.project_id || '—'}</code></div>
      </div>
      ${creditsHtml}
      <div class="acct-models-section">
        <div class="acct-models-title">📊 模型配额 <span class="acct-models-total">${acct.quotas.length} 个模型</span></div>
        ${quotasHtml}
      </div>
    </div>`;
}

function categorizeModels(quotas) {
  const cats = [
    { name: 'Gemini', icon: '◆', prefix: 'gemini', models: [] },
    { name: 'Claude', icon: '⌘', prefix: 'claude', models: [] },
    { name: 'GPT / OpenAI', icon: '▶', prefix: 'gpt', models: [] },
    { name: '其他', icon: '⚙', prefix: '', models: [] },
  ];
  quotas.forEach(q => {
    const m = q.model.toLowerCase();
    if (m.startsWith('gemini')) cats[0].models.push(q);
    else if (m.startsWith('claude')) cats[1].models.push(q);
    else if (m.startsWith('gpt')) cats[2].models.push(q);
    else cats[3].models.push(q);
  });
  return cats;
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
    { id: 'claude', name: 'Claude Code', icon: '⌘', color: '#a855f7', protocol: 'ANTHROPIC' },
    { id: 'codex', name: 'Codex CLI', icon: '▶', color: '#3b82f6', protocol: 'OPENAI' },
    { id: 'gemini', name: 'Gemini CLI', icon: '◆', color: '#22c55e', protocol: 'GEMINI' },
    { id: 'cursor', name: 'Cursor / Windsurf', icon: '✦', color: '#f59e0b', protocol: 'OPENAI' },
  ];

  document.getElementById('cli-cards').innerHTML = clis.map(cli => {
    return `<div class="cli-card" id="cli-card-${cli.id}">
      <div class="cli-card-header">
        <div class="cli-icon" style="background:${cli.color}">${cli.icon}</div>
        <div class="cli-name">${cli.name}</div>
        <span class="cli-protocol">${cli.protocol}</span>
      </div>
      <div class="cli-sync-status" id="cli-status-${cli.id}">
        <span class="cli-status-loading">检测中...</span>
      </div>
      <div class="cli-actions" id="cli-actions-${cli.id}"></div>
    </div>`;
  }).join('');

  // Load status for each CLI
  ['claude', 'codex'].forEach(loadCliStatus);
  // Gemini and Cursor are env-based, render manual instructions
  renderEnvOnlyCard('gemini');
  renderEnvOnlyCard('cursor');
}

async function loadCliStatus(appId) {
  const statusEl = document.getElementById(`cli-status-${appId}`);
  const actionsEl = document.getElementById(`cli-actions-${appId}`);
  try {
    const data = await fetch(`${API}/api/cli/status?app=${appId}`).then(r => r.json());
    const viewData = await fetch(`${API}/api/cli/view?app=${appId}`).then(r => r.json());

    let statusHtml = '';
    let actionsHtml = '';

    if (data.is_synced) {
      statusHtml = `
        <div class="cli-sync-badge synced">🟢 已同步到 GPA Tools</div>
        <div class="cli-config-path">📄 ${data.config_path}</div>
        <pre class="cli-code">${escapeHtml(viewData.content || '').substring(0, 500)}</pre>`;
      actionsHtml = `
        <button class="btn btn-sm btn-outline" onclick="viewCliConfig('${appId}')">查看配置</button>
        ${viewData.has_backup ? `<button class="btn btn-sm btn-outline btn-danger" onclick="restoreCli('${appId}')">恢复原始</button>` : ''}`;
    } else if (data.exists) {
      statusHtml = `
        <div class="cli-sync-badge not-synced">🔶 未同步 — 当前指向: <code>${data.current_base_url || '默认'}</code></div>
        <div class="cli-config-path">📄 ${data.config_path}</div>`;
      actionsHtml = `
        <button class="btn btn-sm btn-primary" onclick="syncCli('${appId}')">⚡ 一键同步</button>
        <button class="btn btn-sm btn-outline" onclick="viewCliConfig('${appId}')">查看当前</button>`;
    } else {
      statusHtml = `
        <div class="cli-sync-badge no-config">⚪ 未安装 / 无配置文件</div>`;
      actionsHtml = `
        <button class="btn btn-sm btn-primary" onclick="syncCli('${appId}')">⚡ 创建配置</button>`;
    }

    statusEl.innerHTML = statusHtml;
    actionsEl.innerHTML = actionsHtml;
  } catch (e) {
    statusEl.innerHTML = `<div class="cli-sync-badge error">❌ 状态检测失败</div>`;
  }
}

function renderEnvOnlyCard(appId) {
  const statusEl = document.getElementById(`cli-status-${appId}`);
  const actionsEl = document.getElementById(`cli-actions-${appId}`);
  const key = apiKey || 'gpa-xxx';

  if (appId === 'gemini') {
    statusEl.innerHTML = `
      <div class="cli-sync-badge info">ℹ️ 需设置环境变量</div>
      <pre class="cli-code">export GEMINI_API_KEY=${key}</pre>`;
    actionsEl.innerHTML = `<button class="btn btn-sm btn-outline" onclick="copyText('export GEMINI_API_KEY=${key}')">复制命令</button>`;
  } else {
    statusEl.innerHTML = `
      <div class="cli-sync-badge info">ℹ️ 在 IDE 设置中手动配置</div>
      <pre class="cli-code"># Base URL: http://localhost:8600/v1\n# API Key: ${key}\n# 在 IDE Settings → AI 配置中填写</pre>`;
    actionsEl.innerHTML = `<button class="btn btn-sm btn-outline" onclick="copyText('http://localhost:8600/v1')">复制 URL</button>
      <button class="btn btn-sm btn-outline" onclick="copyText('${key}')">复制 Key</button>`;
  }
}

async function syncCli(appId) {
  if (!apiKey) {
    alert('请先在上方生成 API Key');
    return;
  }
  const statusEl = document.getElementById(`cli-status-${appId}`);
  statusEl.innerHTML = '<div class="cli-sync-badge syncing">⏳ 正在写入配置...</div>';

  try {
    const res = await fetch(`${API}/api/cli/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appId }),
    }).then(r => r.json());

    if (res.ok) {
      showToast(`✅ ${appId} 配置已同步`);
      if (res.env_hint) {
        showToast(`📋 还需设置: ${res.env_hint}`, 'info', 5000);
      }
      loadCliStatus(appId);
    } else {
      showToast(`❌ 同步失败: ${res.error}`, 'error');
      loadCliStatus(appId);
    }
  } catch (e) {
    showToast(`❌ 同步失败: ${e.message}`, 'error');
    loadCliStatus(appId);
  }
}

async function restoreCli(appId) {
  if (!confirm(`确定要恢复 ${appId} 的原始配置？`)) return;
  try {
    const res = await fetch(`${API}/api/cli/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appId }),
    }).then(r => r.json());

    if (res.restored) {
      showToast(`✅ ${appId} 配置已恢复`);
    } else {
      showToast(`ℹ️ ${res.message || '无备份可恢复'}`, 'info');
    }
    loadCliStatus(appId);
  } catch (e) {
    showToast(`❌ 恢复失败: ${e.message}`, 'error');
  }
}

async function viewCliConfig(appId) {
  try {
    const data = await fetch(`${API}/api/cli/view?app=${appId}`).then(r => r.json());
    alert(`📄 ${data.path}\n${'─'.repeat(40)}\n${data.content}`);
  } catch (e) { alert('读取失败'); }
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

// ============================================================
// PAGE: API 反代
// ============================================================

async function loadProxyPage() {
  // Load API key for proxy page
  try {
    const data = await fetch(`${API}/api/api-key`).then(r => r.json());
    apiKey = data.api_key || '';
    const el = document.getElementById('proxy-api-key-input');
    if (el) el.value = apiKey || '未生成 — 点击 🔄 创建';
  } catch (e) {}

  // Update service badge (AT style: dot + text + separator)
  try {
    const h = await fetch(`${API}/api/health`).then(r => r.json());
    const badge = document.getElementById('proxy-svc-badge');
    if (badge && h.bridge === 'online') {
      badge.classList.add('running');
      badge.innerHTML = '<span class="at-status-dot online"></span><span class="at-status-text">服务运行中 (' + h.port + ')</span>';
    }
  } catch (e) {}

  // Render CLI cards in proxy page
  renderProxyCliCards();
}

function renderProxyCliCards() {
  const container = document.getElementById('proxy-cli-cards');
  if (!container) return;
  // Reuse the toolbox cli rendering but target proxy-cli-cards
  const origContainer = document.getElementById('cli-cards');
  // Build cards inline
  const clis = [
    { id: 'claude', name: 'Claude Code', icon: '⌘', color: '#a855f7', protocol: 'ANTHROPIC' },
    { id: 'codex', name: 'Codex CLI', icon: '▶', color: '#3b82f6', protocol: 'OPENAI' },
    { id: 'gemini', name: 'Gemini CLI', icon: '◆', color: '#22c55e', protocol: 'GEMINI' },
    { id: 'cursor', name: 'Cursor / Windsurf', icon: '✦', color: '#f59e0b', protocol: 'OPENAI' },
  ];
  container.innerHTML = clis.map(cli => `<div class="cli-card" id="pcli-card-${cli.id}">
    <div class="cli-card-header">
      <div class="cli-icon" style="background:${cli.color}">${cli.icon}</div>
      <div class="cli-name">${cli.name}</div>
      <span class="cli-protocol">${cli.protocol}</span>
    </div>
    <div class="cli-sync-status" id="pcli-status-${cli.id}"><span class="cli-status-loading">检测中...</span></div>
    <div class="cli-actions" id="pcli-actions-${cli.id}"></div>
  </div>`).join('');

  // Load status
  ['claude', 'codex'].forEach(async (appId) => {
    const statusEl = document.getElementById(`pcli-status-${appId}`);
    const actionsEl = document.getElementById(`pcli-actions-${appId}`);
    try {
      const data = await fetch(`${API}/api/cli/status?app=${appId}`).then(r => r.json());
      if (data.is_synced) {
        statusEl.innerHTML = '<div class="cli-sync-badge synced">🟢 已同步到 GPA Tools</div>';
        actionsEl.innerHTML = '<button class="btn btn-sm btn-outline" onclick="viewCliConfig(\'' + appId + '\')">查看</button>';
      } else if (data.exists) {
        statusEl.innerHTML = `<div class="cli-sync-badge not-synced">🟡 未同步 — 当前: <code>${data.current_base_url || '默认'}</code></div>`;
        actionsEl.innerHTML = '<button class="btn btn-sm btn-primary" onclick="syncCli(\'' + appId + '\')">⚡ 一键同步</button>';
      } else {
        statusEl.innerHTML = '<div class="cli-sync-badge no-config">⚪ 未安装</div>';
        actionsEl.innerHTML = '<button class="btn btn-sm btn-primary" onclick="syncCli(\'' + appId + '\')">⚡ 创建配置</button>';
      }
    } catch (e) { statusEl.innerHTML = '<div class="cli-sync-badge error">❌ 检测失败</div>'; }
  });

  // Env-only cards
  const key = apiKey || 'gpa-xxx';
  const gemSt = document.getElementById('pcli-status-gemini');
  const gemAc = document.getElementById('pcli-actions-gemini');
  if (gemSt) { gemSt.innerHTML = '<div class="cli-sync-badge info">ℹ️ 需设置环境变量</div><pre class="cli-code">export GEMINI_API_KEY=' + key + '</pre>'; }
  if (gemAc) { gemAc.innerHTML = '<button class="btn btn-sm btn-outline" onclick="copyText(\'export GEMINI_API_KEY=' + key + '\')">复制</button>'; }
  const curSt = document.getElementById('pcli-status-cursor');
  const curAc = document.getElementById('pcli-actions-cursor');
  if (curSt) { curSt.innerHTML = '<div class="cli-sync-badge info">ℹ️ IDE 手动配置</div>'; }
  if (curAc) { curAc.innerHTML = '<button class="btn btn-sm btn-outline" onclick="copyText(\'http://localhost:8600/v1\')">复制 URL</button> <button class="btn btn-sm btn-outline" onclick="copyText(\'' + key + '\')">复制 Key</button>'; }
}

function copyProxyApiKey() { copyText(apiKey); }
async function generateProxyApiKey() {
  try {
    const data = await fetch(`${API}/api/api-key/generate`, { method: 'POST' }).then(r => r.json());
    if (data.ok) {
      apiKey = data.api_key;
      const proxyInput = document.getElementById('proxy-api-key-input');
      if (proxyInput) proxyInput.value = apiKey;
      const dashDisplay = document.getElementById('api-key-display');
      if (dashDisplay) dashDisplay.textContent = apiKey;
      showToast('✅ API Key 已生成');
    }
  } catch (e) { showToast('❌ 生成失败', 'error'); }
}
function toggleProxyService() {
  showToast('ℹ️ GPA Tools 服务始终运行，无需手动启停', 'info');
}

// ============================================================
// PAGE: 流量日志 (AT Manager 风格)
// ============================================================

let logsState = {
  page: 1,
  perPage: 100,
  total: 0,
  filter: 'all',
  search: '',
  account: '',
  data: [],
};
let logsAutoRefresh = null;

async function loadLogsPage() {
  // Bind filter pills
  document.querySelectorAll('.logs-filter-pill').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.logs-filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      logsState.filter = btn.dataset.filter;
      logsState.page = 1;
      fetchLogs();
    };
  });
  // Search debounce
  const searchEl = document.getElementById('logs-search');
  let searchTimer = null;
  searchEl.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { logsState.search = searchEl.value; logsState.page = 1; fetchLogs(); }, 400);
  };
  // Account filter
  const acctFilter = document.getElementById('logs-account-filter');
  acctFilter.onchange = () => { logsState.account = acctFilter.value; logsState.page = 1; fetchLogs(); };
  // Per-page
  document.getElementById('logs-per-page').onchange = function() { logsState.perPage = parseInt(this.value); logsState.page = 1; fetchLogs(); };
  // Populate account dropdown
  try {
    const accts = await fetch(`${API}/api/accounts`).then(r => r.json());
    acctFilter.innerHTML = '<option value="">全部账号</option>' +
      accts.map(a => `<option value="${a.email}">${a.email.split('@')[0]}</option>`).join('');
  } catch (e) {}

  fetchLogs();
  // Auto-refresh every 10s
  if (logsAutoRefresh) clearInterval(logsAutoRefresh);
  logsAutoRefresh = setInterval(() => { if (currentPage === 'logs') fetchLogs(); }, 10000);
}

async function fetchLogs() {
  try {
    const params = new URLSearchParams({
      offset: (logsState.page - 1) * logsState.perPage,
      limit: logsState.perPage,
    });
    if (logsState.filter === 'errors') params.set('errors_only', 'true');
    if (logsState.search) params.set('search', logsState.search);
    if (logsState.account) params.set('account', logsState.account);
    if (['gemini', 'claude', 'chat', 'credits'].includes(logsState.filter)) params.set('search', logsState.filter);

    const data = await fetch(`${API}/api/usage-logs?${params}`).then(r => r.json());
    logsState.data = data.logs || [];
    logsState.total = data.total || 0;
    renderLogsTable();
    renderLogsStats();
    renderLogsPagination();
  } catch (e) { console.error('Logs fetch error:', e); }
}

function renderLogsTable() {
  const tbody = document.getElementById('logs-body');
  if (!logsState.data.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="empty-state">暂无请求记录</td></tr>';
    return;
  }
  tbody.innerHTML = logsState.data.map(log => {
    const status = log.status_code || log.status || 0;
    const isErr = status >= 400;
    const statusClass = isErr ? 'log-status-err' : 'log-status-ok';
    const method = log.method || 'GET';
    const model = log.model || '—';
    const protocol = (log.path || '').startsWith('/v1') ? 'OpenAI' :
                     (log.path || '').startsWith('/anthropic') ? 'Anthropic' :
                     (log.path || '').startsWith('/gemini') ? 'Gemini' : '—';
    const account = log.account_email || log.account || '—';
    const path = log.path || '—';
    const tokens = (log.input_tokens || 0) + (log.output_tokens || 0);
    const tokensStr = tokens > 0 ? formatNumber(tokens) : '—';
    const latency = log.latency_ms != null ? log.latency_ms + 'ms' : (log.duration ? log.duration + 'ms' : '—');
    const time = log.created_at ? new Date(log.created_at).toLocaleTimeString('zh-CN', {hour12: false}) : '—';

    return `<tr class="${isErr ? 'log-row-err' : ''}">
      <td><span class="${statusClass}">${status}</span></td>
      <td>${method}</td>
      <td class="log-model-cell" title="${model}">${model}</td>
      <td>${protocol}</td>
      <td class="log-account-cell" title="${account}">${account === '—' ? '—' : account.split('@')[0]}</td>
      <td class="log-path-cell" title="${path}">${path}</td>
      <td style="text-align:right">${tokensStr}</td>
      <td style="text-align:right">${latency}</td>
      <td style="text-align:right">${time}</td>
    </tr>`;
  }).join('');
}

function renderLogsStats() {
  const el = document.getElementById('logs-stats');
  const total = logsState.total;
  const errCount = logsState.data.filter(l => (l.status_code || l.status || 0) >= 400).length;
  const okCount = logsState.data.length - errCount;
  el.innerHTML = `
    <span class="logs-stat-item logs-stat-total"><strong>${formatNumber(total)}</strong> 总计</span>
    <span class="logs-stat-item logs-stat-ok"><strong>${formatNumber(okCount)}</strong> 正常</span>
    <span class="logs-stat-item logs-stat-err"><strong>${errCount}</strong> 错误</span>`;
}

function renderLogsPagination() {
  const totalPages = Math.ceil(logsState.total / logsState.perPage) || 1;
  document.getElementById('logs-page-info').textContent =
    `${logsState.page} / ${totalPages}`;
  document.getElementById('logs-prev').disabled = logsState.page <= 1;
  document.getElementById('logs-next').disabled = logsState.page >= totalPages;
  // AT style: 显示第 1 到 100 条，共 2128 条
  const start = (logsState.page - 1) * logsState.perPage + 1;
  const end = Math.min(logsState.page * logsState.perPage, logsState.total);
  const detail = document.getElementById('logs-page-detail');
  if (detail) detail.textContent = logsState.total > 0 ? `显示第 ${start} 到 ${end} 条，共 ${logsState.total} 条` : '';
}

function logsPagePrev() { if (logsState.page > 1) { logsState.page--; fetchLogs(); } }
function logsPageNext() {
  const totalPages = Math.ceil(logsState.total / logsState.perPage) || 1;
  if (logsState.page < totalPages) { logsState.page++; fetchLogs(); }
}

function refreshTrafficLogs() { fetchLogs(); showToast('✅ 日志已刷新'); }
async function clearTrafficLogs() {
  if (!confirm('确定清空所有流量日志？')) return;
  try {
    await fetch(`${API}/api/usage-logs/clear`, { method: 'POST' });
    showToast('✅ 日志已清空');
    fetchLogs();
  } catch (e) { showToast('❌ 清空失败', 'error'); }
}

// ---- Init ----
checkHealth();
loadDashboard();
setInterval(checkHealth, 30000);
