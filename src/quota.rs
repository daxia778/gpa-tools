// ============================================================
// NexusGate — 配额查询模块
// 直连 Google v1internal API 获取配额和订阅信息
// 移植自 quota.js
// ============================================================

use serde::{Deserialize, Serialize};
use serde_json::Value;

const QUOTA_ENDPOINTS: &[&str] = &[
    "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
    "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];

const CLOUD_CODE_BASE: &str = "https://daily-cloudcode-pa.sandbox.googleapis.com";

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelQuota {
    pub model: String,
    pub utilization: i32,
    pub remaining_pct: i32,
    pub reset_time: Option<String>,
    pub display_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CreditInfo {
    pub credit_type: String,
    pub credit_amount: f64,
    pub minimum_for_usage: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SubscriptionInfo {
    pub project_id: Option<String>,
    pub tier: Option<String>,
    pub credits: Vec<CreditInfo>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FullQuotaResult {
    pub quotas: Vec<ModelQuota>,
    pub is_forbidden: bool,
    pub project_id: Option<String>,
    pub subscription_tier: Option<String>,
    pub credits: Vec<CreditInfo>,
    pub error: Option<String>,
}

/// 获取订阅信息和 Credits 余额
pub async fn fetch_subscription_info(access_token: &str) -> SubscriptionInfo {
    let client = reqwest::Client::new();
    let url = format!("{}/v1internal:loadCodeAssist", CLOUD_CODE_BASE);

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", access_token))
        .header("User-Agent", "antigravity-manager/1.0")
        .json(&serde_json::json!({ "metadata": { "ideType": "ANTIGRAVITY" } }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await;

    let resp = match resp {
        Ok(r) if r.status().is_success() => r,
        _ => return SubscriptionInfo { project_id: None, tier: None, credits: vec![] },
    };

    let data: Value = match resp.json().await {
        Ok(v) => v,
        Err(_) => return SubscriptionInfo { project_id: None, tier: None, credits: vec![] },
    };

    let project_id = data.get("cloudaicompanionProject").and_then(|v| v.as_str()).map(|s| s.to_string());

    // Extract tier
    let tier_raw = data.pointer("/paidTier/name").or(data.pointer("/paidTier/id"))
        .or(data.pointer("/currentTier/name")).or(data.pointer("/currentTier/id"))
        .and_then(|v| v.as_str());

    let tier = tier_raw.map(|raw| {
        let lower = raw.to_lowercase();
        if lower.contains("ultra") { "ULTRA".into() }
        else if lower.contains("pro") { "PRO".into() }
        else if lower.contains("free") { "FREE".into() }
        else { "UNKNOWN".into() }
    });

    // Parse credits
    let mut credits = vec![];
    if let Some(arr) = data.pointer("/paidTier/availableCredits").and_then(|v| v.as_array()) {
        for c in arr {
            credits.push(CreditInfo {
                credit_type: c.get("creditType").and_then(|v| v.as_str()).unwrap_or("GOOGLE_ONE_AI").to_string(),
                credit_amount: c.get("creditAmount").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0),
                minimum_for_usage: c.get("minimumCreditAmountForUsage").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()).unwrap_or(0.0),
            });
        }
    }

    SubscriptionInfo { project_id, tier, credits }
}

/// 获取模型配额
pub async fn fetch_available_models(access_token: &str, project_id: Option<&str>) -> (Vec<ModelQuota>, bool, Option<String>) {
    let client = reqwest::Client::new();
    let payload = if let Some(pid) = project_id {
        serde_json::json!({ "project": pid })
    } else {
        serde_json::json!({})
    };

    for endpoint in QUOTA_ENDPOINTS {
        let resp = client
            .post(*endpoint)
            .header("Authorization", format!("Bearer {}", access_token))
            .header("User-Agent", "antigravity-manager/1.0")
            .json(&payload)
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await;

        let resp = match resp {
            Ok(r) => r,
            Err(_) => { tokio::time::sleep(std::time::Duration::from_secs(1)).await; continue; }
        };

        if resp.status().as_u16() == 403 {
            return (vec![], true, Some("forbidden".into()));
        }
        if resp.status().as_u16() == 429 || resp.status().as_u16() >= 500 {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            continue;
        }
        if !resp.status().is_success() {
            return (vec![], false, Some(format!("HTTP {}", resp.status())));
        }

        let data: Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => return (vec![], false, Some(format!("Parse error: {}", e))),
        };

        let mut quotas = vec![];
        if let Some(models) = data.get("models").and_then(|v| v.as_object()) {
            for (name, info) in models {
                let remaining = info.pointer("/quotaInfo/remainingFraction")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(1.0);
                quotas.push(ModelQuota {
                    model: name.clone(),
                    utilization: ((1.0 - remaining) * 100.0).round() as i32,
                    remaining_pct: (remaining * 100.0).round() as i32,
                    reset_time: info.pointer("/quotaInfo/resetTime").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    display_name: info.get("displayName").and_then(|v| v.as_str()).unwrap_or(name).to_string(),
                });
            }
        }

        quotas.sort_by(|a, b| b.utilization.cmp(&a.utilization));
        return (quotas, false, None);
    }

    (vec![], false, Some("All endpoints failed".into()))
}

/// 综合获取配额
pub async fn fetch_full_quota(access_token: &str, project_id: Option<&str>) -> FullQuotaResult {
    let sub_info = if project_id.is_none() {
        fetch_subscription_info(access_token).await
    } else {
        SubscriptionInfo { project_id: project_id.map(|s| s.to_string()), tier: None, credits: vec![] }
    };

    let pid = sub_info.project_id.as_deref().or(project_id);
    let (quotas, is_forbidden, error) = fetch_available_models(access_token, pid).await;

    FullQuotaResult {
        quotas,
        is_forbidden,
        project_id: sub_info.project_id.or(project_id.map(|s| s.to_string())),
        subscription_tier: sub_info.tier,
        credits: sub_info.credits,
        error,
    }
}
