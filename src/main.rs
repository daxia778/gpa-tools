// ============================================================
// GPA Tools — Google Partner API 代理管理工具
// 原生 WebView 窗口 + Axum HTTP 服务器
// ============================================================

mod db;
mod oauth;
mod credits;
mod quota;
mod proxy;
mod api;

use axum::{routing::{get, post, delete}, Router};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Instant;
use tower_http::cors::CorsLayer;

use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoop},
    window::WindowBuilder,
};
use wry::WebViewBuilder;

#[derive(Clone)]
pub struct AppState {
    pub db: Arc<db::Database>,
    pub start_time: Instant,
}

fn main() {
    // Load .env file (if exists next to binary or in cwd)
    load_dotenv();

    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "gpa_tools=info".into()),
        )
        .init();

    // Data directory — next to the executable
    let data_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap());

    let database = Arc::new(db::Database::new(&data_dir));
    let state = AppState {
        db: database,
        start_time: Instant::now(),
    };

    // Build Axum router
    let app = Router::new()
        // Dashboard API
        .route("/api/stats", get(api::get_stats))
        .route("/api/credits", get(api::get_credits))
        .route("/api/credits/{account_id}/toggle", post(api::toggle_credits))
        .route("/api/credits/{account_id}/clear-exhausted", post(api::clear_credits_exhausted))
        // Import & Accounts
        .route("/api/import-tokens", post(api::import_tokens))
        .route("/api/accounts", get(api::get_accounts))
        .route("/api/accounts/{account_id}", delete(api::delete_account))
        .route("/api/accounts/{account_id}/refresh", post(api::refresh_account))
        // Quotas
        .route("/api/quotas", get(api::get_quotas))
        .route("/api/quotas/refresh", post(api::refresh_quotas))
        .route("/api/quotas/grouped", get(api::get_quotas_grouped))
        // Usage logs (traffic monitor)
        .route("/api/usage-logs", get(api::get_usage_logs))
        .route("/api/usage-logs/clear", post(api::clear_usage_logs))
        // API Key
        .route("/api/api-key", get(api::get_api_key))
        .route("/api/api-key/generate", post(api::generate_api_key))
        // Sync & Config
        .route("/api/sync-accounts", post(api::sync_accounts))
        .route("/api/config", get(api::get_config).post(api::save_config))
        // Health
        .route("/api/health", get(api::health))
        // AI Proxy routes (forward to AT Manager)
        .route("/v1/{*rest}", axum::routing::any(proxy::proxy_handler))
        .route("/anthropic/{*rest}", axum::routing::any(proxy::proxy_handler))
        .route("/gemini/{*rest}", axum::routing::any(proxy::proxy_handler))
        // Frontend (embedded static files) — must be last
        .fallback(api::serve_frontend)
        .layer(CorsLayer::permissive())
        .with_state(state.clone());

    // Background quota refresh task (every 5 minutes)
    let bg_state = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            // Wait for initial server startup
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            loop {
                tracing::info!("🔄 Background quota refresh starting...");
                let accounts = bg_state.db.get_all_accounts();
                for account in &accounts {
                    let at = match &account.access_token {
                        Some(t) if !t.is_empty() => t.clone(),
                        _ => match crate::oauth::refresh_access_token(&account.refresh_token).await {
                            Ok(tr) => {
                                let expires_at = chrono::Utc::now() + chrono::Duration::seconds(tr.expires_in);
                                bg_state.db.upsert_account(&db::Account {
                                    access_token: Some(tr.access_token.clone()),
                                    expires_at: Some(expires_at.to_rfc3339()),
                                    status: "active".into(),
                                    ..account.clone()
                                });
                                tr.access_token
                            }
                            Err(e) => {
                                tracing::warn!("BG refresh failed for {}: {}", account.email, e);
                                continue;
                            }
                        }
                    };

                    let pid = if account.project_id.is_empty() { None } else { Some(account.project_id.as_str()) };
                    let (quotas, is_forbidden, _) = crate::quota::fetch_available_models(&at, pid).await;
                    for q in &quotas {
                        bg_state.db.save_quota_snapshot(&db::QuotaSnapshot {
                            account_id: account.account_id.clone(),
                            email: account.email.clone(),
                            model_name: q.model.clone(),
                            utilization: q.utilization,
                            reset_time: q.reset_time.clone(),
                            is_forbidden,
                            ..Default::default()
                        });
                    }
                }
                tracing::info!("✅ Background quota refresh done ({} accounts)", accounts.len());
                tokio::time::sleep(std::time::Duration::from_secs(300)).await;
            }
        });
    });

    // Start Axum server in background thread
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("Failed to create Tokio runtime");
        rt.block_on(async {
            let addr = SocketAddr::from(([127, 0, 0, 1], 8600));
            println!();
            println!("╔════════════════════════════════════════════════╗");
            println!("║   GPA Tools v1.0 — Google Partner API Proxy    ║");
            println!("║   Rust Native • 账号管理 + 配额监控 + AI 代理     ║");
            println!("╠════════════════════════════════════════════════╣");
            println!("║   🌐 Dashboard:  http://localhost:8600           ║");
            println!("║   🔌 AI Proxy:   http://localhost:8600/v1        ║");
            println!("╚════════════════════════════════════════════════╝");
            println!();
            let listener = tokio::net::TcpListener::bind(addr).await.expect("Failed to bind port 8600");
            tracing::info!("🚀 GPA Tools HTTP server on {}", addr);
            axum::serve(listener, app).await.expect("Server error");
        });
    });

    // Wait for server to be ready
    std::thread::sleep(std::time::Duration::from_millis(800));

    // ---- Native WebView window ----
    let event_loop = EventLoop::new();

    #[cfg(target_os = "macos")]
    let window = {
        use tao::platform::macos::WindowBuilderExtMacOS;
        WindowBuilder::new()
            .with_title("GPA Tools")
            .with_inner_size(tao::dpi::LogicalSize::new(1280.0, 860.0))
            .with_min_inner_size(tao::dpi::LogicalSize::new(800.0, 600.0))
            .with_titlebar_transparent(true)
            .with_fullsize_content_view(true)
            .with_title_hidden(true)
            .build(&event_loop)
            .expect("Failed to create window")
    };

    #[cfg(not(target_os = "macos"))]
    let window = WindowBuilder::new()
        .with_title("GPA Tools")
        .with_inner_size(tao::dpi::LogicalSize::new(1280.0, 860.0))
        .with_min_inner_size(tao::dpi::LogicalSize::new(800.0, 600.0))
        .build(&event_loop)
        .expect("Failed to create window");

    let _webview = WebViewBuilder::new()
        .with_url("http://localhost:8600")
        .with_devtools(true)
        .build(&window)
        .expect("Failed to create WebView");

    tracing::info!("🖥️ Native window created");

    // macOS event loop (blocks main thread — required for proper GUI)
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => {
                tracing::info!("👋 GPA Tools shutting down");
                *control_flow = ControlFlow::Exit;
            }
            _ => {}
        }
    });
}

/// Simple .env file loader — searches next to binary, then cwd
fn load_dotenv() {
    let candidates = [
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join(".env"))),
        Some(std::path::PathBuf::from(".env")),
    ];
    for candidate in &candidates {
        if let Some(path) = candidate {
            if path.exists() {
                if let Ok(content) = std::fs::read_to_string(path) {
                    for line in content.lines() {
                        let line = line.trim();
                        if line.is_empty() || line.starts_with('#') { continue; }
                        if let Some((key, value)) = line.split_once('=') {
                            let key = key.trim();
                            let value = value.trim();
                            if std::env::var(key).is_err() {
                                std::env::set_var(key, value);
                            }
                        }
                    }
                }
                return;
            }
        }
    }
}
