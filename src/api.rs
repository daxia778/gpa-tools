// ============================================================
// GPA Tools — REST API 路由
// 完整移植自 server.js 的所有 API 端点
// ============================================================

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{Html, IntoResponse},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::{db::{Account, AccountCredits}, oauth, quota, AppState};

// ---- Query params ----

#[derive(Deserialize)]
pub struct StatsQuery {
    pub hours: Option<i32>,
}

// ---- Stats ----

pub async fn get_stats(State(state): State<AppState>, Query(q): Query<StatsQuery>) -> Json<Value> {
    let hours = q.hours.unwrap_or(24);
    let stats = state.db.get_usage_stats(hours);
    Json(serde_json::to_value(stats).unwrap_or(json!({})))
}

// ---- Credits ----

pub async fn get_credits(State(state): State<AppState>) -> Json<Value> {
    let credits = state.db.get_all_account_credits();
    Json(serde_json::to_value(credits).unwrap_or(json!([])))
}

#[derive(Deserialize)]
pub struct ToggleBody {
    pub enabled: bool,
}

pub async fn toggle_credits(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
    Json(body): Json<ToggleBody>,
) -> Json<Value> {
    state.db.toggle_credits(&account_id, body.enabled);
    Json(json!({ "ok": true, "account_id": account_id, "credits_enabled": body.enabled }))
}

pub async fn clear_credits_exhausted(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
) -> Json<Value> {
    state.db.clear_credits_exhausted(&account_id);
    Json(json!({ "ok": true, "account_id": account_id }))
}

// ---- Import Tokens ----

#[derive(Deserialize)]
pub struct ImportTokensBody {
    pub tokens: Vec<Value>,
}

#[derive(Serialize)]
struct ImportResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    account_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    credits: Option<f64>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    refresh_token: Option<String>,
}

pub async fn import_tokens(
    State(state): State<AppState>,
    Json(body): Json<ImportTokensBody>,
) -> Json<Value> {
    let mut results: Vec<ImportResult> = vec![];

    for token_val in &body.tokens {
        let refresh_token = match token_val {
            Value::String(s) => s.trim().to_string(),
            Value::Object(o) => o.get("refresh_token")
                .and_then(|v| v.as_str())
                .unwrap_or("").trim().to_string(),
            _ => String::new(),
        };

        if refresh_token.is_empty() {
            results.push(ImportResult {
                status: "skipped".into(), error: Some("空 token".into()),
                refresh_token: Some("(empty)".into()),
                ..Default::default()
            });
            continue;
        }

        tracing::info!("🔑 [Import] Validating token: {}...", &refresh_token[..refresh_token.len().min(20)]);

        // 1. Refresh token
        let token_resp = match oauth::refresh_access_token(&refresh_token).await {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("❌ [Import] Token failed: {}", e);
                results.push(ImportResult {
                    status: "error".into(), error: Some(e),
                    refresh_token: Some(format!("{}...", &refresh_token[..refresh_token.len().min(20)])),
                    ..Default::default()
                });
                continue;
            }
        };

        // 2. Get user info
        let user_info = match oauth::get_user_info(&token_resp.access_token).await {
            Ok(u) => u,
            Err(e) => {
                results.push(ImportResult {
                    status: "error".into(), error: Some(e),
                    refresh_token: Some(format!("{}...", &refresh_token[..refresh_token.len().min(20)])),
                    ..Default::default()
                });
                continue;
            }
        };

        // 3. Get subscription info
        let sub_info = quota::fetch_subscription_info(&token_resp.access_token).await;

        // 4. Generate account_id
        let account_id = format!("bridge_{}", user_info.email.replace(|c: char| !c.is_alphanumeric(), "_"));

        // 5. Save to DB
        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(token_resp.expires_in);
        state.db.upsert_account(&Account {
            account_id: account_id.clone(),
            email: user_info.email.clone(),
            name: user_info.name.unwrap_or_default(),
            refresh_token: refresh_token.clone(),
            access_token: Some(token_resp.access_token),
            expires_at: Some(expires_at.to_rfc3339()),
            project_id: sub_info.project_id.unwrap_or_default(),
            subscription_tier: sub_info.tier.clone(),
            status: "active".into(),
            ..Default::default()
        });

        // 6. Sync credits (always create entry)
        let credit_amount = sub_info.credits.first().map(|c| c.credit_amount).unwrap_or(0.0);
        let credit_min = sub_info.credits.first().map(|c| c.minimum_for_usage).unwrap_or(0.0);
        let credit_type = sub_info.credits.first().map(|c| c.credit_type.clone());
        let is_paid = sub_info.tier.as_deref().map(|t| t != "FREE").unwrap_or(false);
        state.db.upsert_account_credits(&AccountCredits {
            account_id: account_id.clone(),
            email: user_info.email.clone(),
            credits_enabled: is_paid, // auto-enable for paid tiers
            credit_type,
            credit_amount,
            minimum_for_usage: credit_min,
            subscription_tier: sub_info.tier.clone(),
            ..Default::default()
        });

        tracing::info!("✅ [Import] {} ({}) imported successfully", user_info.email, sub_info.tier.as_deref().unwrap_or("FREE"));
        results.push(ImportResult {
            email: Some(user_info.email),
            account_id: Some(account_id),
            tier: Some(sub_info.tier.unwrap_or("FREE".into())),
            credits: sub_info.credits.first().map(|c| c.credit_amount),
            status: "success".into(),
            ..Default::default()
        });
    }

    let success = results.iter().filter(|r| r.status == "success").count();
    let failed = results.iter().filter(|r| r.status == "error").count();

    Json(json!({
        "ok": true,
        "total": body.tokens.len(),
        "success": success,
        "failed": failed,
        "results": results,
    }))
}

impl Default for ImportResult {
    fn default() -> Self {
        Self {
            email: None, account_id: None, tier: None, credits: None,
            status: String::new(), error: None, refresh_token: None,
        }
    }
}

// ---- Accounts ----

pub async fn get_accounts(State(state): State<AppState>) -> Json<Value> {
    let accounts = state.db.get_all_accounts();
    Json(serde_json::to_value(accounts).unwrap_or(json!([])))
}

pub async fn delete_account(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
) -> Json<Value> {
    state.db.delete_account(&account_id);
    Json(json!({ "ok": true }))
}

pub async fn refresh_account(
    State(state): State<AppState>,
    Path(account_id): Path<String>,
) -> impl IntoResponse {
    let accounts = state.db.get_all_accounts();
    let account = match accounts.iter().find(|a| a.account_id == account_id) {
        Some(a) => a.clone(),
        None => return (StatusCode::NOT_FOUND, Json(json!({ "error": "Account not found" }))),
    };

    match oauth::refresh_access_token(&account.refresh_token).await {
        Ok(token_resp) => {
            let expires_at = chrono::Utc::now() + chrono::Duration::seconds(token_resp.expires_in);
            state.db.upsert_account(&Account {
                access_token: Some(token_resp.access_token),
                expires_at: Some(expires_at.to_rfc3339()),
                status: "active".into(),
                ..account
            });
            (StatusCode::OK, Json(json!({ "ok": true, "email": account_id, "expires_in": token_resp.expires_in })))
        }
        Err(e) => {
            state.db.upsert_account(&Account { status: "error".into(), ..account });
            (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e })))
        }
    }
}

// ---- Quotas ----

pub async fn get_quotas(State(state): State<AppState>) -> Json<Value> {
    let snapshots = state.db.get_latest_quota_snapshots();
    Json(serde_json::to_value(snapshots).unwrap_or(json!([])))
}

/// 手动刷新所有账号的配额
pub async fn refresh_quotas(State(state): State<AppState>) -> impl IntoResponse {
    let accounts = state.db.get_all_accounts();
    let mut refreshed = 0;
    let mut errors = 0;

    for account in &accounts {
        let at = match &account.access_token {
            Some(t) if !t.is_empty() => t.clone(),
            _ => {
                // Try to refresh token first
                match oauth::refresh_access_token(&account.refresh_token).await {
                    Ok(tr) => {
                        let expires_at = chrono::Utc::now() + chrono::Duration::seconds(tr.expires_in);
                        state.db.upsert_account(&Account {
                            access_token: Some(tr.access_token.clone()),
                            expires_at: Some(expires_at.to_rfc3339()),
                            status: "active".into(),
                            ..account.clone()
                        });
                        tr.access_token
                    }
                    Err(_) => { errors += 1; continue; }
                }
            }
        };

        let pid = if account.project_id.is_empty() { None } else { Some(account.project_id.as_str()) };
        let (quotas, is_forbidden, _) = quota::fetch_available_models(&at, pid).await;

        for q in &quotas {
            state.db.save_quota_snapshot(&crate::db::QuotaSnapshot {
                account_id: account.account_id.clone(),
                email: account.email.clone(),
                model_name: q.model.clone(),
                utilization: q.utilization,
                reset_time: q.reset_time.clone(),
                is_forbidden,
                ..Default::default()
            });
        }

        if !quotas.is_empty() {
            refreshed += 1;
        }

        // Also refresh subscription/credits info
        let sub_info = quota::fetch_subscription_info(&at).await;
        let credit_amount = sub_info.credits.first().map(|c| c.credit_amount).unwrap_or(0.0);
        state.db.upsert_account_credits(&AccountCredits {
            account_id: account.account_id.clone(),
            email: account.email.clone(),
            credits_enabled: true, // keep it enabled
            credit_type: sub_info.credits.first().map(|c| c.credit_type.clone()),
            credit_amount,
            minimum_for_usage: sub_info.credits.first().map(|c| c.minimum_for_usage).unwrap_or(0.0),
            subscription_tier: sub_info.tier.clone(),
            ..Default::default()
        });
    }

    (StatusCode::OK, Json(json!({
        "ok": true,
        "total_accounts": accounts.len(),
        "refreshed": refreshed,
        "errors": errors,
    })))
}

// ---- Grouped Quotas (账号分组配额+积分) ----

pub async fn get_quotas_grouped(State(state): State<AppState>) -> Json<Value> {
    let grouped = state.db.get_quotas_grouped();
    Json(serde_json::to_value(grouped).unwrap_or(json!([])))
}

// ---- Usage Logs (请求流量监控) ----

#[derive(Deserialize)]
pub struct UsageLogsQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub filter: Option<String>,
    pub errors_only: Option<bool>,
}

pub async fn get_usage_logs(State(state): State<AppState>, Query(q): Query<UsageLogsQuery>) -> Json<Value> {
    let limit = q.limit.unwrap_or(50).min(500);
    let offset = q.offset.unwrap_or(0);
    let filter = q.filter.unwrap_or_default();
    let errors_only = q.errors_only.unwrap_or(false);

    let logs = state.db.get_usage_logs_paginated(limit, offset, &filter, errors_only);
    let total = state.db.get_usage_log_count(&filter, errors_only);

    Json(json!({
        "logs": logs,
        "total": total,
        "limit": limit,
        "offset": offset,
    }))
}

pub async fn clear_usage_logs(State(state): State<AppState>) -> Json<Value> {
    state.db.clear_usage_logs();
    Json(json!({ "ok": true }))
}

// ---- API Key ----

pub async fn get_api_key(State(state): State<AppState>) -> Json<Value> {
    let key = state.db.get_config("api_key").unwrap_or_default();
    Json(json!({ "api_key": key }))
}

pub async fn generate_api_key(State(state): State<AppState>) -> Json<Value> {
    let key = format!("gpa-{}", &uuid::Uuid::new_v4().to_string().replace("-", "")[..24]);
    state.db.set_config("api_key", &key);
    Json(json!({ "ok": true, "api_key": key }))
}

// ---- CLI One-Click Sync (一键导入配置) ----

#[derive(Deserialize)]
pub struct CliSyncRequest {
    pub app: String,          // "claude" | "codex" | "gemini"
    pub model: Option<String>,
}

/// 获取 CLI 配置状态
pub async fn get_cli_status(State(state): State<AppState>, Query(q): Query<std::collections::HashMap<String, String>>) -> Json<Value> {
    let app = q.get("app").map(|s| s.as_str()).unwrap_or("claude");
    let api_key = state.db.get_config("api_key").unwrap_or_default();
    let home = dirs::home_dir().unwrap_or_default();

    match app {
        "claude" => {
            let config_path = home.join(".claude").join("settings.json");
            let exists = config_path.exists();
            let mut current_url = String::new();
            let mut is_synced = false;
            if exists {
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    if let Ok(v) = serde_json::from_str::<Value>(&content) {
                        current_url = v.get("env").and_then(|e| e.get("ANTHROPIC_BASE_URL")).and_then(|v| v.as_str()).unwrap_or("").into();
                        is_synced = current_url.contains("localhost:8600");
                    }
                }
            }
            Json(json!({
                "app": "claude", "config_path": config_path.to_string_lossy(),
                "exists": exists, "is_synced": is_synced,
                "current_base_url": current_url,
            }))
        }
        "codex" => {
            let config_path = home.join(".codex").join("config.toml");
            let exists = config_path.exists();
            let mut current_url = String::new();
            let mut is_synced = false;
            if exists {
                if let Ok(content) = std::fs::read_to_string(&config_path) {
                    is_synced = content.contains("localhost:8600");
                    // Extract base_url
                    for line in content.lines() {
                        if line.contains("base_url") {
                            current_url = line.split('=').nth(1).unwrap_or("").trim().trim_matches('"').into();
                        }
                    }
                }
            }
            Json(json!({
                "app": "codex", "config_path": config_path.to_string_lossy(),
                "exists": exists, "is_synced": is_synced,
                "current_base_url": current_url,
            }))
        }
        "gemini" => {
            let config_path = home.join(".gemini").join("settings.json");
            let exists = config_path.exists();
            Json(json!({
                "app": "gemini", "config_path": config_path.to_string_lossy(),
                "exists": exists, "is_synced": false,
                "current_base_url": "",
                "note": "Gemini CLI 需设置 GEMINI_API_KEY 环境变量",
            }))
        }
        _ => Json(json!({"error": "Unknown app"})),
    }
}

/// 一键写入 CLI 配置
pub async fn execute_cli_sync(State(state): State<AppState>, Json(req): Json<CliSyncRequest>) -> impl IntoResponse {
    let api_key = state.db.get_config("api_key").unwrap_or_default();
    if api_key.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": "请先生成 API Key"}))).into_response();
    }
    let home = dirs::home_dir().unwrap_or_default();
    let proxy_url = "http://localhost:8600";

    match req.app.as_str() {
        "claude" => {
            let config_path = home.join(".claude").join("settings.json");
            // Read existing config or create new one
            let mut config: Value = if config_path.exists() {
                let content = std::fs::read_to_string(&config_path).unwrap_or("{}".into());
                serde_json::from_str(&content).unwrap_or(json!({}))
            } else {
                std::fs::create_dir_all(home.join(".claude")).ok();
                json!({})
            };

            // Backup original
            if config_path.exists() {
                let backup = home.join(".claude").join("settings.json.gpa-backup");
                std::fs::copy(&config_path, &backup).ok();
            }

            // Merge env settings (preserve other fields like mcpServers)
            let env = config.as_object_mut().unwrap()
                .entry("env").or_insert(json!({}));
            env["ANTHROPIC_API_KEY"] = json!(api_key);
            env["ANTHROPIC_BASE_URL"] = json!(proxy_url);

            // Set model if provided
            if let Some(model) = &req.model {
                config["model"] = json!(model);
            }

            let pretty = serde_json::to_string_pretty(&config).unwrap();
            match std::fs::write(&config_path, &pretty) {
                Ok(_) => Json(json!({"ok": true, "app": "claude", "path": config_path.to_string_lossy()})).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"ok": false, "error": e.to_string()}))).into_response(),
            }
        }
        "codex" => {
            let config_path = home.join(".codex").join("config.toml");
            // Backup original
            if config_path.exists() {
                let backup = home.join(".codex").join("config.toml.gpa-backup");
                std::fs::copy(&config_path, &backup).ok();
            } else {
                std::fs::create_dir_all(home.join(".codex")).ok();
            }

            let model = req.model.as_deref().unwrap_or("gpt-4o");
            let toml_content = format!(
r#"model_provider = "gpatools"
model = "{model}"

[model_providers.gpatools]
name = "GPA Tools Proxy"
base_url = "{proxy_url}/v1"
wire_api = "responses"
env_key = "GPA_API_KEY"
"#);
            // Also set env var hint
            match std::fs::write(&config_path, &toml_content) {
                Ok(_) => Json(json!({"ok": true, "app": "codex", "path": config_path.to_string_lossy(), "env_hint": format!("export GPA_API_KEY={}", api_key)})).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"ok": false, "error": e.to_string()}))).into_response(),
            }
        }
        _ => (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": "不支持的 CLI 类型"}))).into_response(),
    }
}

/// 恢复 CLI 原始配置 (从备份)
pub async fn restore_cli_config(Json(req): Json<CliSyncRequest>) -> impl IntoResponse {
    let home = dirs::home_dir().unwrap_or_default();
    let (config_path, backup_path) = match req.app.as_str() {
        "claude" => (home.join(".claude/settings.json"), home.join(".claude/settings.json.gpa-backup")),
        "codex" => (home.join(".codex/config.toml"), home.join(".codex/config.toml.gpa-backup")),
        _ => return (StatusCode::BAD_REQUEST, Json(json!({"ok": false, "error": "不支持的 CLI 类型"}))).into_response(),
    };

    if backup_path.exists() {
        match std::fs::copy(&backup_path, &config_path) {
            Ok(_) => {
                std::fs::remove_file(&backup_path).ok();
                Json(json!({"ok": true, "restored": true})).into_response()
            }
            Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"ok": false, "error": e.to_string()}))).into_response(),
        }
    } else {
        Json(json!({"ok": true, "restored": false, "message": "无备份文件"})).into_response()
    }
}

/// 读取 CLI 配置文件内容
pub async fn view_cli_config(Query(q): Query<std::collections::HashMap<String, String>>) -> Json<Value> {
    let app = q.get("app").map(|s| s.as_str()).unwrap_or("claude");
    let home = dirs::home_dir().unwrap_or_default();
    let config_path = match app {
        "claude" => home.join(".claude/settings.json"),
        "codex" => home.join(".codex/config.toml"),
        "gemini" => home.join(".gemini/settings.json"),
        _ => return Json(json!({"error": "Unknown app"})),
    };

    let content = std::fs::read_to_string(&config_path).unwrap_or_else(|_| "文件不存在".into());
    let has_backup = match app {
        "claude" => home.join(".claude/settings.json.gpa-backup").exists(),
        "codex" => home.join(".codex/config.toml.gpa-backup").exists(),
        _ => false,
    };

    Json(json!({
        "app": app, "path": config_path.to_string_lossy(),
        "content": content, "has_backup": has_backup,
    }))
}

// ---- Sync from AT Manager ----

pub async fn sync_accounts(State(state): State<AppState>) -> impl IntoResponse {
    let at_url = state.db.get_config("at_proxy_url").unwrap_or_else(|| "http://127.0.0.1:8045".into());
    let client = reqwest::Client::new();

    match client.get(format!("{}/admin/accounts", at_url))
        .timeout(std::time::Duration::from_secs(10))
        .send().await
    {
        Ok(resp) if resp.status().is_success() => {
            let data: Value = resp.json().await.unwrap_or(json!({}));
            let accounts = data.get("accounts").or(Some(&data))
                .and_then(|v| v.as_array());
            let mut synced = 0;
            if let Some(arr) = accounts {
                for acc in arr {
                    state.db.upsert_account_credits(&AccountCredits {
                        account_id: acc.get("id").or(acc.get("account_id")).and_then(|v| v.as_str()).unwrap_or("").into(),
                        email: acc.get("email").and_then(|v| v.as_str()).unwrap_or("").into(),
                        credits_enabled: acc.get("credits_enabled").and_then(|v| v.as_bool()).unwrap_or(false),
                        credits_exhausted: acc.get("credits_exhausted").and_then(|v| v.as_bool()).unwrap_or(false),
                        subscription_tier: acc.get("subscription_tier").and_then(|v| v.as_str()).map(|s| s.into()),
                        ..Default::default()
                    });
                    synced += 1;
                }
            }
            (StatusCode::OK, Json(json!({ "ok": true, "synced": synced })))
        }
        Ok(resp) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": format!("AT returned {}", resp.status()) }))),
        Err(e) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": e.to_string() }))),
    }
}

// ---- Config ----

pub async fn get_config(State(state): State<AppState>) -> Json<Value> {
    let all = state.db.get_all_config();
    let mut map = serde_json::Map::new();
    for row in all { map.insert(row.key, json!(row.value)); }
    Json(Value::Object(map))
}

pub async fn save_config(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Json<Value> {
    if let Some(obj) = body.as_object() {
        for (key, value) in obj {
            state.db.set_config(key, value.as_str().unwrap_or(&value.to_string()));
        }
    }
    Json(json!({ "ok": true }))
}

// ---- Health ----

pub async fn health(State(state): State<AppState>) -> Json<Value> {
    let at_url = state.db.get_config("at_proxy_url").unwrap_or_else(|| "http://127.0.0.1:8045".into());
    let client = reqwest::Client::new();

    let at_status = match client.get(format!("{}/health", at_url))
        .timeout(std::time::Duration::from_secs(3))
        .send().await
    {
        Ok(r) if r.status().is_success() => "online".to_string(),
        Ok(r) => format!("error:{}", r.status()),
        Err(_) => "offline".to_string(),
    };

    let uptime = state.start_time.elapsed().as_secs();

    Json(json!({
        "bridge": "online",
        "port": 8600,
        "at_proxy": at_status,
        "at_proxy_url": at_url,
        "uptime_seconds": uptime,
    }))
}

// ---- Static files (embedded via rust-embed) ----

use rust_embed::Embed;

#[derive(Embed)]
#[folder = "frontend/"]
pub struct FrontendAssets;

pub async fn serve_frontend(uri: axum::http::Uri) -> impl IntoResponse {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    match FrontendAssets::get(path) {
        Some(content) => {
            let mime = mime_guess::from_path(path).first_or_octet_stream();
            (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, mime.as_ref())],
                content.data.into_owned(),
            ).into_response()
        }
        None => {
            // SPA fallback to index.html
            match FrontendAssets::get("index.html") {
                Some(content) => (
                    StatusCode::OK,
                    [(axum::http::header::CONTENT_TYPE, "text/html")],
                    content.data.into_owned(),
                ).into_response(),
                None => (StatusCode::NOT_FOUND, "Not Found").into_response(),
            }
        }
    }
}
