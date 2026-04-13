// ============================================================
// NexusGate — Credits 管理模块
// 429 分类 / Credits 注入 / 耗尽检测
// 移植自 credits.js
// ============================================================

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub enum Category429 {
    Unknown,
    RateLimited,
    QuotaExhausted,
}

const QUOTA_EXHAUSTED_KEYWORDS: &[&str] = &[
    "quota_exhausted", "quota exhausted", "QUOTA_EXHAUSTED",
];

const RATE_LIMIT_KEYWORDS: &[&str] = &[
    "per minute", "rate limit", "too many requests", "RATE_LIMIT_EXCEEDED",
];

const CREDITS_EXHAUSTED_KEYWORDS: &[&str] = &[
    "google_one_ai", "insufficient credit", "insufficient credits",
    "not enough credit", "not enough credits", "credit exhausted",
    "credits exhausted", "credit balance", "minimumcreditamountforusage",
    "minimum credit amount for usage", "minimum credit",
    "resource has been exhausted",
];

/// 分类 429 错误类型
pub fn classify_429(body: &str) -> Category429 {
    let lower = body.to_lowercase();

    for kw in QUOTA_EXHAUSTED_KEYWORDS {
        if lower.contains(&kw.to_lowercase()) {
            return Category429::QuotaExhausted;
        }
    }

    for kw in RATE_LIMIT_KEYWORDS {
        if lower.contains(&kw.to_lowercase()) {
            return Category429::RateLimited;
        }
    }

    // Try JSON parsing
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if let Some(reason) = json.pointer("/error/details/0/reason").and_then(|v| v.as_str()) {
            match reason {
                "QUOTA_EXHAUSTED" => return Category429::QuotaExhausted,
                "RATE_LIMIT_EXCEEDED" => return Category429::RateLimited,
                _ => {}
            }
        }
    }

    Category429::Unknown
}

/// 向请求体注入 enabledCreditTypes
pub fn inject_credit_types(body_str: &str) -> Option<String> {
    let mut payload: Value = serde_json::from_str(body_str).ok()?;
    payload["enabledCreditTypes"] = serde_json::json!(["GOOGLE_ONE_AI"]);
    Some(serde_json::to_string(&payload).ok()?)
}

/// 判断是否应标记 Credits 耗尽
pub fn should_mark_credits_exhausted(status_code: u16, body: &str) -> bool {
    if status_code >= 500 || status_code == 408 {
        return false;
    }

    // Check for RetryInfo
    if let Ok(json) = serde_json::from_str::<Value>(body) {
        if let Some(details) = json.pointer("/error/details").and_then(|v| v.as_array()) {
            for d in details {
                if let Some(t) = d.get("@type").and_then(|v| v.as_str()) {
                    if t.contains("RetryInfo") {
                        return false;
                    }
                }
            }
        }
    }

    let lower = body.to_lowercase();
    for kw in CREDITS_EXHAUSTED_KEYWORDS {
        if lower.contains(kw) {
            return true;
        }
    }

    false
}
