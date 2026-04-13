// ============================================================
// NexusGate — 反向代理模块
// 转发 AI 推理请求到 AT Manager
// 移植自 proxy.js
// ============================================================

use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use crate::{credits, db::UsageLog, AppState};
use std::time::Instant;

/// 代理处理函数
pub async fn proxy_handler(
    State(state): State<AppState>,
    req: Request<Body>,
) -> Response {
    let trace_id = format!("br-{}", &uuid::Uuid::new_v4().to_string()[..8]);
    let start = Instant::now();
    let method = req.method().clone();
    let uri = req.uri().path_and_query().map(|pq| pq.to_string()).unwrap_or_default();

    let at_url = state.db.get_config("at_proxy_url").unwrap_or_else(|| "http://127.0.0.1:8045".into());
    let target_url = format!("{}{}", at_url, uri);

    // Collect request headers (filter hop-by-hop)
    let mut fwd_headers = HeaderMap::new();
    for (key, value) in req.headers() {
        let k = key.as_str().to_lowercase();
        if ["host", "connection", "transfer-encoding", "keep-alive", "upgrade"].contains(&k.as_str()) {
            continue;
        }
        fwd_headers.insert(key.clone(), value.clone());
    }
    if let Ok(v) = trace_id.parse() { fwd_headers.insert("x-trace-id", v); }
    if let Ok(v) = "at-sub2api-bridge".parse() { fwd_headers.insert("x-forwarded-by", v); }

    // Read body
    let body_bytes = match axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024).await {
        Ok(b) => b,
        Err(e) => {
            return (StatusCode::BAD_REQUEST, format!("Body read error: {}", e)).into_response();
        }
    };

    // Extract model name
    let mut model_name = "unknown".to_string();
    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body_bytes) {
        if let Some(m) = json.get("model").and_then(|v| v.as_str()) {
            model_name = m.to_string();
        }
    }

    tracing::info!("🔄 [{}] {} {} model={}", trace_id, method, uri, model_name);

    // Forward to AT Manager
    let client = reqwest::Client::new();
    let mut req_builder = client.request(method.clone(), &target_url).headers(fwd_headers.clone());
    if method != "GET" && method != "HEAD" {
        req_builder = req_builder.body(body_bytes.clone());
    }
    req_builder = req_builder.timeout(std::time::Duration::from_secs(300));

    let proxy_resp = match req_builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let latency = start.elapsed().as_millis() as i64;
            tracing::error!("❌ [{}] Proxy error ({}ms): {}", trace_id, latency, e);
            state.db.log_usage(&UsageLog {
                trace_id: trace_id.clone(),
                account_email: "error".into(),
                model: model_name,
                status_code: 502, latency_ms: latency,
                error_text: Some(e.to_string()),
                ..Default::default()
            });
            return (StatusCode::BAD_GATEWAY, serde_json::json!({
                "error": { "type": "proxy_error", "message": format!("Bridge proxy error: {}", e) }
            }).to_string()).into_response();
        }
    };

    let status = proxy_resp.status().as_u16();
    let account_email = proxy_resp.headers().get("x-account-email")
        .and_then(|v| v.to_str().ok()).unwrap_or("unknown").to_string();
    let mapped_model = proxy_resp.headers().get("x-mapped-model")
        .and_then(|v| v.to_str().ok()).unwrap_or(&model_name).to_string();
    let credits_used = proxy_resp.headers().get("x-credits-used")
        .and_then(|v| v.to_str().ok()) == Some("true");

    // 429 Credits injection logic
    if status == 429 && !body_bytes.is_empty() {
        let body_str = String::from_utf8_lossy(&body_bytes);
        let error_body = proxy_resp.text().await.unwrap_or_default();
        let category = credits::classify_429(&error_body);

        if category == credits::Category429::QuotaExhausted {
            tracing::info!("💰 [{}] Quota exhausted, attempting Credits injection...", trace_id);

            if let Some(credits_body) = credits::inject_credit_types(&body_str) {
                let mut retry_headers = fwd_headers.clone();
                if let Ok(v) = format!("{}-credits", trace_id).parse() {
                    retry_headers.insert("x-trace-id", v);
                }

                let mut retry_builder = client.request(method.clone(), &target_url).headers(retry_headers);
                retry_builder = retry_builder.body(credits_body);
                retry_builder = retry_builder.timeout(std::time::Duration::from_secs(300));

                if let Ok(credits_resp) = retry_builder.send().await {
                    if credits_resp.status().is_success() {
                        tracing::info!("💰 [{}] Credits retry SUCCESS!", trace_id);
                        let latency = start.elapsed().as_millis() as i64;
                        state.db.log_usage(&UsageLog {
                            trace_id: trace_id.clone(),
                            account_email: account_email.clone(),
                            model: model_name, upstream_model: Some(mapped_model),
                            status_code: credits_resp.status().as_u16() as i32,
                            credits_used: true, latency_ms: latency,
                            ..Default::default()
                        });
                        return convert_reqwest_response(credits_resp).await;
                    }
                }
            }
        }

        // Return original 429
        let latency = start.elapsed().as_millis() as i64;
        state.db.log_usage(&UsageLog {
            trace_id, account_email, model: model_name,
            upstream_model: Some(mapped_model), status_code: status as i32,
            credits_used, latency_ms: latency,
            error_text: Some(error_body.chars().take(500).collect()),
            ..Default::default()
        });
        return (StatusCode::from_u16(status).unwrap_or(StatusCode::TOO_MANY_REQUESTS), error_body).into_response();
    }

    // Log and forward
    let latency = start.elapsed().as_millis() as i64;
    let icon = if status < 400 { "✅" } else { "❌" };
    let credits_tag = if credits_used { " 💰" } else { "" };
    tracing::info!("{} [{}] {} {} {} {}ms{}", icon, trace_id, status, model_name, account_email, latency, credits_tag);

    state.db.log_usage(&UsageLog {
        trace_id, account_email, model: model_name,
        upstream_model: Some(mapped_model), status_code: status as i32,
        credits_used, latency_ms: latency,
        ..Default::default()
    });

    convert_reqwest_response(proxy_resp).await
}

async fn convert_reqwest_response(resp: reqwest::Response) -> Response {
    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let mut builder = Response::builder().status(status);

    for (k, v) in resp.headers() {
        let k_str = k.as_str().to_lowercase();
        if ["transfer-encoding", "connection"].contains(&k_str.as_str()) { continue; }
        builder = builder.header(k, v);
    }

    let body_bytes = resp.bytes().await.unwrap_or_default();
    builder.body(Body::from(body_bytes)).unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}
