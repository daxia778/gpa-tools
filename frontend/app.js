// ============================================================
// GPA Tools — Google Partner API 代理管理工具
// ============================================================

const API = '';

// ---- State ----
let statsData = null;
let creditsData = [];
let quotasData = [];
let accountsData = [];
let config = {};
let currentPage = 'dashboard';

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  setupPageSwitching();
  await loadAll();
  setInterval(loadAll, 30000);
});

async function loadAll() {
  await Promise.all([
    loadStats(),
    loadCredits(),
    loadQuotas(),
    loadAccounts(),
    checkHealth(),
    loadConfig(),
  ]);
}

// ---- Page Switching ----
function setupPageSwitching() {
  const pills = document.querySelectorAll('.nav-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      const page = pill.dataset.page;
      switchPage(page);
    });
  });
}

function switchPage(page) {
  currentPage = page;
  // Update pills
  document.querySelectorAll('.nav-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.page === page);
  });
  // Update page containers
  document.querySelectorAll('.page-container').forEach(c => {
    c.classList.toggle('hidden', c.id !== `page-${page}`);
  });
}

// ---- Event Listeners ----
function setupEventListeners() {
  document.getElementById('btn-refresh').addEventListener('click', loadAll);
  document.getElementById('btn-settings').addEventListener('click', () => toggleModal(true));
  document.getElementById('btn-sync-accounts').addEventListener('click', syncAccounts);
  document.getElementById('btn-save-config').addEventListener('click', saveConfig);
  document.getElementById('btn-import-rt').addEventListener('click', () => toggleImportModal(true));

  // Modal close (settings)
  document.querySelector('#settings-modal .modal-close').addEventListener('click', () => toggleModal(false));
  document.querySelector('#settings-modal .modal-backdrop').addEventListener('click', () => toggleModal(false));
}

// ---- API Calls ----
async function loadStats() {
  try {
    const resp = await fetch(`${API}/api/stats?hours=24`);
    statsData = await resp.json();
    renderStats(statsData);
    renderModels(statsData.byModel);
    renderTrend(statsData.byHour);
    renderErrors(statsData.recentErrors);
  } catch (e) {
    console.error('Failed to load stats:', e);
  }
}

async function loadCredits() {
  try {
    const resp = await fetch(`${API}/api/credits`);
    creditsData = await resp.json();
    renderCredits(creditsData);
  } catch (e) {
    console.error('Failed to load credits:', e);
  }
}

async function loadQuotas() {
  try {
    const resp = await fetch(`${API}/api/quotas`);
    quotasData = await resp.json();
    renderQuotas(quotasData);
  } catch (e) {
    console.error('Failed to load quotas:', e);
  }
}

async function checkHealth() {
  const dot = document.getElementById('health-indicator');
  dot.className = 'health-dot checking';
  dot.title = '检查中...';
  try {
    const resp = await fetch(`${API}/api/health`);
    const data = await resp.json();
    dot.className = `health-dot ${data.at_proxy === 'online' ? 'online' : 'offline'}`;
    dot.title = `AT: ${data.at_proxy} | Bridge: ${data.bridge} | Uptime: ${formatDuration(data.uptime_seconds)}`;
  } catch {
    dot.className = 'health-dot offline';
    dot.title = 'Bridge 离线';
  }
}

async function loadConfig() {
  try {
    const resp = await fetch(`${API}/api/config`);
    config = await resp.json();
    document.getElementById('cfg-at-proxy').value = config.at_proxy_url || '';
    document.getElementById('cfg-sub2api').value = config.sub2api_url || '';
    document.getElementById('cfg-auto-inject').checked = config.credits_auto_inject === 'true';
  } catch { /* ignore */ }
}

async function saveConfig() {
  const payload = {
    at_proxy_url: document.getElementById('cfg-at-proxy').value.trim(),
    sub2api_url: document.getElementById('cfg-sub2api').value.trim(),
    credits_auto_inject: document.getElementById('cfg-auto-inject').checked ? 'true' : 'false',
  };
  await fetch(`${API}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  toggleModal(false);
  loadAll();
}

async function syncAccounts() {
  const btn = document.getElementById('btn-sync-accounts');
  btn.disabled = true;
  btn.innerHTML = '<svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="animation:spin 1s linear infinite"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> 同步中...';
  try {
    const resp = await fetch(`${API}/api/sync-accounts`, { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      btn.innerHTML = `<svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg> 已同步 ${data.synced} 个`;
      setTimeout(() => { resetSyncBtn(btn); btn.disabled = false; }, 2000);
      loadCredits();
    } else {
      btn.textContent = '失败';
      setTimeout(() => { resetSyncBtn(btn); btn.disabled = false; }, 2000);
    }
  } catch {
    btn.textContent = '网络错误';
    setTimeout(() => { resetSyncBtn(btn); btn.disabled = false; }, 2000);
  }
}

async function toggleAccountCredits(accountId, enabled) {
  await fetch(`${API}/api/credits/${accountId}/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  loadCredits();
}

// ---- Renderers ----

function renderStats(stats) {
  const t = stats.total;
  document.getElementById('stat-total').textContent = formatNum(t.total_requests || 0);
  
  const successRate = t.total_requests > 0 ? ((t.success / t.total_requests) * 100).toFixed(1) : '—';
  document.getElementById('stat-success').textContent = t.total_requests > 0 ? `${successRate}%` : '—';
  document.getElementById('stat-success-count').textContent = `${formatNum(t.success || 0)} / ${formatNum(t.total_requests || 0)}`;

  document.getElementById('stat-credits').textContent = formatNum(t.credits_requests || 0);
  document.getElementById('stat-credits-sub').textContent = t.total_requests > 0
    ? `占比 ${((t.credits_requests / t.total_requests) * 100).toFixed(1)}%`
    : '积分调用次数';

  document.getElementById('stat-latency').textContent = t.avg_latency_ms
    ? `${Math.round(t.avg_latency_ms)}ms`
    : '—';
  const totalTokens = (t.total_input_tokens || 0) + (t.total_output_tokens || 0);
  document.getElementById('stat-tokens').textContent = `${formatNum(totalTokens)} tokens`;
}

function renderModels(models) {
  const container = document.getElementById('model-list');
  if (!models || models.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无模型使用数据</div>';
    return;
  }

  const maxReq = Math.max(...models.map(m => m.requests));
  container.innerHTML = models.map(m => {
    const pct = maxReq > 0 ? (m.requests / maxReq * 100) : 0;
    const barClass = pct > 70 ? 'high' : pct > 40 ? 'mid' : 'low';
    const creditsBadge = m.credits_used > 0
      ? `<span class="model-credits-badge">${m.credits_used} credits</span>`
      : '';
    return `
      <div class="model-item">
        <span class="model-name">${escapeHtml(m.model)}</span>
        ${creditsBadge}
        <div class="model-bar-wrap">
          <div class="model-bar ${barClass}" style="width: ${pct}%"></div>
        </div>
        <span class="model-count">${formatNum(m.requests)}</span>
      </div>
    `;
  }).join('');
}

function renderCredits(credits) {
  const container = document.getElementById('credits-list');
  if (!credits || credits.length === 0) {
    container.innerHTML = '<div class="empty-state">点击"同步"从 AT Manager 导入账号</div>';
    return;
  }

  container.innerHTML = credits.map(c => {
    const isExhausted = c.credits_exhausted && isInCooldown(c.credits_exhausted_until);
    const balanceClass = isExhausted ? 'exhausted' : '';
    const tierClass = c.subscription_tier ? `tier-${c.subscription_tier}` : 'tier-FREE';
    const toggleClass = c.credits_enabled ? 'active' : '';
    const cooldownText = isExhausted
      ? `冷却至 ${formatTime(c.credits_exhausted_until)}`
      : c.credits_enabled ? '已启用' : '未启用';

    return `
      <div class="credit-item">
        <div class="credit-avatar">${c.email ? c.email[0].toUpperCase() : '?'}</div>
        <div class="credit-info">
          <div class="credit-email">${escapeHtml(c.email)}</div>
          <div class="credit-detail">
            <span class="tier-badge ${tierClass}">${c.subscription_tier || 'FREE'}</span>
            <span>${cooldownText}</span>
          </div>
        </div>
        <div class="credit-balance ${balanceClass}">
          ${c.credit_amount > 0 ? `$${c.credit_amount.toFixed(2)}` : '—'}
        </div>
        <button class="credit-toggle ${toggleClass}"
          onclick="toggleAccountCredits('${escapeHtml(c.account_id)}', ${!c.credits_enabled})"
          title="切换 Credits"></button>
      </div>
    `;
  }).join('');
}

function renderQuotas(quotas) {
  const container = document.getElementById('quota-grid');
  if (!quotas || quotas.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无配额数据 — 通过 API 拉取后显示</div>';
    return;
  }

  const grouped = {};
  for (const q of quotas) {
    const key = q.account_id;
    if (!grouped[key]) grouped[key] = { email: q.email, models: [] };
    grouped[key].models.push(q);
  }

  let html = '';
  for (const [accountId, info] of Object.entries(grouped)) {
    for (const m of info.models) {
      const remaining = 100 - m.utilization;
      const barClass = remaining > 50 ? 'ok' : remaining > 20 ? 'warn' : 'full';
      html += `
        <div class="quota-card">
          <div class="quota-model" title="${escapeHtml(m.model_name)}">${escapeHtml(m.model_name)}</div>
          <div class="quota-bar-outer">
            <div class="quota-bar-inner ${barClass}" style="width: ${remaining}%"></div>
          </div>
          <div class="quota-meta">
            <span class="quota-pct ${barClass}">${remaining}% 剩余</span>
            <span>${escapeHtml(info.email.split('@')[0])}</span>
          </div>
        </div>
      `;
    }
  }
  container.innerHTML = html || '<div class="empty-state">暂无配额数据</div>';
}

function renderTrend(byHour) {
  const container = document.getElementById('trend-chart');
  if (!byHour || byHour.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无趋势数据</div>';
    return;
  }

  const maxReq = Math.max(...byHour.map(h => h.requests), 1);
  const maxHeight = 140;

  container.innerHTML = byHour.map(h => {
    const barH = Math.max(2, (h.requests / maxReq) * maxHeight);
    const creditsH = h.credits_used > 0 ? Math.max(2, (h.credits_used / maxReq) * maxHeight) : 0;
    const hourLabel = h.hour.split(' ')[1] || h.hour.slice(-5);
    return `
      <div class="trend-bar-group">
        <div class="trend-bar" style="height: ${barH}px">
          <div class="trend-tooltip">${h.requests} 请求 · ${h.credits_used || 0} credits</div>
        </div>
        ${creditsH > 0 ? `<div class="trend-credits-bar" style="height: ${creditsH}px"></div>` : ''}
        <span class="trend-label">${hourLabel}</span>
      </div>
    `;
  }).join('');
}

function renderErrors(errors) {
  const container = document.getElementById('error-list');
  if (!errors || errors.length === 0) {
    container.innerHTML = '<div class="empty-state">无错误记录</div>';
    return;
  }

  container.innerHTML = errors.map(e => {
    const shortError = (e.error_text || '').slice(0, 80);
    return `
      <div class="error-item">
        <span class="error-status">${e.status_code}</span>
        <span class="error-model" title="${escapeHtml(e.model)}">${escapeHtml(e.model)}</span>
        <span class="error-time">${formatTime(e.created_at)}</span>
        <span class="error-detail" title="${escapeHtml(e.error_text || '')}">${escapeHtml(shortError)}</span>
      </div>
    `;
  }).join('');
}

// ---- Modal ----
function toggleModal(show) {
  document.getElementById('settings-modal').classList.toggle('hidden', !show);
}

function toggleImportModal(show) {
  document.getElementById('import-modal').classList.toggle('hidden', !show);
  if (show) {
    document.getElementById('import-textarea').value = '';
    document.getElementById('import-progress').classList.add('hidden');
    document.getElementById('import-results').classList.add('hidden');
    document.getElementById('btn-do-import').disabled = false;
    document.getElementById('btn-do-import').textContent = '开始导入';
  }
}

// ---- Accounts ----
async function loadAccounts() {
  try {
    const resp = await fetch(`${API}/api/accounts`);
    accountsData = await resp.json();
    renderAccounts(accountsData);
    renderAccountsStats(accountsData);
  } catch (e) {
    console.error('Failed to load accounts:', e);
  }
}

function renderAccountsStats(accounts) {
  if (!accounts || accounts.length === 0) {
    document.getElementById('acct-total').textContent = '0';
    document.getElementById('acct-active').textContent = '0';
    document.getElementById('acct-expired').textContent = '0';
    document.getElementById('acct-credits-total').textContent = '—';
    document.getElementById('acct-active-pct').textContent = '—';
    document.getElementById('acct-count-badge').textContent = '0 个账号';
    return;
  }

  const total = accounts.length;
  const now = Date.now();
  let active = 0, expired = 0;
  accounts.forEach(a => {
    const isExpired = a.expires_at && new Date(a.expires_at).getTime() < now;
    if (a.status === 'error' || isExpired) expired++;
    else active++;
  });

  document.getElementById('acct-total').textContent = total;
  document.getElementById('acct-active').textContent = active;
  document.getElementById('acct-expired').textContent = expired;
  document.getElementById('acct-active-pct').textContent = total > 0 ? `${((active / total) * 100).toFixed(0)}% 可用` : '—';
  document.getElementById('acct-count-badge').textContent = `${total} 个账号`;

  // Credits total from creditsData
  if (creditsData && creditsData.length > 0) {
    const totalCredits = creditsData.reduce((sum, c) => sum + (c.credit_amount || 0), 0);
    document.getElementById('acct-credits-total').textContent = totalCredits > 0 ? `$${totalCredits.toFixed(2)}` : '—';
  }
}

function renderAccounts(accounts) {
  const container = document.getElementById('accounts-list');
  if (!accounts || accounts.length === 0) {
    container.innerHTML = '<div class="empty-state">暂无账号 — 点击"导入 RT"添加 Google 账号</div>';
    return;
  }

  container.innerHTML = accounts.map(a => {
    const isExpired = a.expires_at && new Date(a.expires_at).getTime() < Date.now();
    const statusClass = a.status === 'error' ? 'error' : isExpired ? 'expired' : 'active';
    const statusText = a.status === 'error' ? '异常' : isExpired ? '已过期' : '正常';
    const tierClass = a.subscription_tier ? `tier-${a.subscription_tier}` : 'tier-FREE';
    const rtShort = a.refresh_token ? a.refresh_token.slice(0, 15) + '...' : '—';

    return `
      <div class="account-item">
        <div class="account-avatar">${a.email ? a.email[0].toUpperCase() : '?'}</div>
        <div class="account-info">
          <div class="account-email">${escapeHtml(a.email)}</div>
          <div class="account-meta">
            <span class="tier-badge ${tierClass}">${a.subscription_tier || 'FREE'}</span>
            <span>RT: ${escapeHtml(rtShort)}</span>
            ${a.project_id ? `<span>Proj: ${escapeHtml(a.project_id.slice(0, 20))}</span>` : ''}
          </div>
        </div>
        <span class="account-status ${statusClass}">${statusText}</span>
        <div class="account-actions">
          <button class="btn btn-sm btn-outline" onclick="refreshAccountAction('${escapeHtml(a.account_id)}')" title="刷新 Token"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg></button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccountAction('${escapeHtml(a.account_id)}')" title="删除"><svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
        </div>
      </div>
    `;
  }).join('');
}

// ---- Import Tokens ----
async function doImportTokens() {
  const textarea = document.getElementById('import-textarea');
  const raw = textarea.value.trim();
  if (!raw) return;

  const tokens = parseTokenInput(raw);
  if (tokens.length === 0) {
    alert('未检测到有效的 Refresh Token');
    return;
  }

  const progressEl = document.getElementById('import-progress');
  const progressBar = document.getElementById('import-progress-bar');
  const statusEl = document.getElementById('import-status');
  const resultsEl = document.getElementById('import-results');
  const btnImport = document.getElementById('btn-do-import');

  progressEl.classList.remove('hidden');
  progressEl.classList.add('active');
  resultsEl.classList.add('hidden');
  btnImport.disabled = true;
  btnImport.textContent = '导入中...';
  progressBar.style.width = '10%';
  statusEl.textContent = `正在验证 ${tokens.length} 个 token...`;

  try {
    const resp = await fetch(`${API}/api/import-tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tokens }),
    });

    progressBar.style.width = '100%';
    progressEl.classList.remove('active');

    const data = await resp.json();
    statusEl.textContent = `完成: ${data.success} 成功, ${data.failed} 失败`;

    resultsEl.classList.remove('hidden');
    resultsEl.innerHTML = (data.results || []).map(r => {
      if (r.status === 'success') {
        return `
          <div class="import-result-item success">
            <span class="import-result-icon"><svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#10b981" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></span>
            <span class="import-result-text"><strong>${escapeHtml(r.email)}</strong> · ${r.tier} · Credits: $${r.credits || 0}</span>
          </div>`;
      } else {
        return `
          <div class="import-result-item error">
            <span class="import-result-icon"><svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="#ef4444" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></span>
            <span class="import-result-text">${escapeHtml(r.refresh_token || '')} — ${escapeHtml(r.error || '未知错误')}</span>
          </div>`;
      }
    }).join('');

    btnImport.textContent = `导入完成 (${data.success}/${data.total})`;
    await loadAll();

  } catch (e) {
    progressBar.style.width = '100%';
    progressEl.classList.remove('active');
    statusEl.textContent = `导入失败: ${e.message}`;
    btnImport.textContent = '导入失败';
  }

  setTimeout(() => { btnImport.disabled = false; }, 3000);
}

function parseTokenInput(raw) {
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map(t => typeof t === 'string' ? t.trim() : (t.refresh_token || '').trim()).filter(Boolean);
    }
  } catch { /* not JSON */ }

  return raw
    .split(/[\n,;]+/)
    .map(t => t.trim())
    .filter(t => t.length > 10 && !t.startsWith('#') && !t.startsWith('//'))
    ;
}

async function deleteAccountAction(accountId) {
  if (!confirm('确定删除该账号？')) return;
  await fetch(`${API}/api/accounts/${accountId}`, { method: 'DELETE' });
  await loadAll();
}

async function refreshAccountAction(accountId) {
  try {
    const resp = await fetch(`${API}/api/accounts/${accountId}/refresh`, { method: 'POST' });
    const data = await resp.json();
    if (data.ok) {
      alert(`Token 刷新成功: ${data.email}`);
    } else {
      alert(`刷新失败: ${data.error}`);
    }
  } catch (e) {
    alert(`网络错误: ${e.message}`);
  }
  await loadAll();
}

// ---- Helpers ----
function resetSyncBtn(btn) {
  btn.innerHTML = '<svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> 同步';
}

function formatNum(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTime(isoStr) {
  if (!isoStr) return '—';
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch { return isoStr; }
}

function isInCooldown(untilStr) {
  if (!untilStr) return false;
  return new Date(untilStr).getTime() > Date.now();
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
