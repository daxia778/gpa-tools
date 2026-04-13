// ============================================================
// GPA Tools — OAuth 模块
// Google OAuth2 refresh_token → access_token 兑换
// ============================================================

use serde::{Deserialize, Serialize};

fn get_client_id() -> String {
    std::env::var("GPA_OAUTH_CLIENT_ID")
        .unwrap_or_else(|_| String::from("SET_YOUR_GOOGLE_OAUTH_CLIENT_ID"))
}

fn get_client_secret() -> String {
    std::env::var("GPA_OAUTH_CLIENT_SECRET")
        .unwrap_or_else(|_| String::from("SET_YOUR_GOOGLE_OAUTH_CLIENT_SECRET"))
}

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v2/userinfo";

#[derive(Debug, Serialize, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub expires_in: i64,
    pub token_type: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfo {
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

/// 使用 refresh_token 换取 access_token
pub async fn refresh_access_token(refresh_token: &str) -> Result<TokenResponse, String> {
    let client = reqwest::Client::new();
    let client_id = get_client_id();
    let client_secret = get_client_secret();
    let resp = client
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id.as_str()),
            ("client_secret", client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ])
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        // Try to parse Google error
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            let detail = json.get("error_description")
                .or(json.get("error"))
                .and_then(|v| v.as_str())
                .unwrap_or(&text);
            return Err(format!("Token 刷新失败 ({}): {}", status, detail));
        }
        return Err(format!("Token 刷新失败 ({}): {}", status, text));
    }

    resp.json::<TokenResponse>()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))
}

/// 获取 Google 用户信息
pub async fn get_user_info(access_token: &str) -> Result<UserInfo, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(USERINFO_URL)
        .header("Authorization", format!("Bearer {}", access_token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("获取用户信息失败 ({})", resp.status()));
    }

    resp.json::<UserInfo>()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))
}
