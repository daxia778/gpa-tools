// ============================================================
// NexusGate — 数据存储层 (rusqlite)
// 完整移植自 Node.js store.js
// ============================================================

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::path::PathBuf;

pub struct Database {
    conn: Mutex<Connection>,
}

// ---- Data Models ----

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct UsageLog {
    pub trace_id: String,
    pub account_email: String,
    pub model: String,
    pub upstream_model: Option<String>,
    pub status_code: i32,
    pub credits_used: bool,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub latency_ms: i64,
    pub error_text: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct UsageTotal {
    pub total_requests: i64,
    pub success: i64,
    pub errors: i64,
    pub credits_requests: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub avg_latency_ms: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelStats {
    pub model: String,
    pub requests: i64,
    pub success: i64,
    pub credits_used: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub avg_latency: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HourStats {
    pub hour: String,
    pub requests: i64,
    pub credits_used: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ErrorEntry {
    pub trace_id: String,
    pub account_email: String,
    pub model: String,
    pub status_code: i32,
    pub error_text: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UsageStats {
    pub total: UsageTotal,
    #[serde(rename = "byModel")]
    pub by_model: Vec<ModelStats>,
    #[serde(rename = "byHour")]
    pub by_hour: Vec<HourStats>,
    #[serde(rename = "recentErrors")]
    pub recent_errors: Vec<ErrorEntry>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AccountCredits {
    pub account_id: String,
    pub email: String,
    pub credits_enabled: bool,
    pub credits_exhausted: bool,
    pub credits_exhausted_until: Option<String>,
    pub credit_type: Option<String>,
    pub credit_amount: f64,
    pub minimum_for_usage: f64,
    pub subscription_tier: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct QuotaSnapshot {
    pub id: Option<i64>,
    pub account_id: String,
    pub email: String,
    pub model_name: String,
    pub utilization: i32,
    pub reset_time: Option<String>,
    pub is_forbidden: bool,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Account {
    pub account_id: String,
    pub email: String,
    pub name: String,
    pub refresh_token: String,
    pub access_token: Option<String>,
    pub expires_at: Option<String>,
    pub project_id: String,
    pub subscription_tier: Option<String>,
    pub status: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConfigRow {
    pub key: String,
    pub value: String,
}

impl Database {
    pub fn new(data_dir: &PathBuf) -> Self {
        std::fs::create_dir_all(data_dir).ok();
        let db_path = data_dir.join("bridge.db");
        let conn = Connection::open(&db_path).expect("Failed to open database");

        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;").ok();

        conn.execute_batch("
            CREATE TABLE IF NOT EXISTS usage_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                trace_id TEXT NOT NULL,
                account_email TEXT NOT NULL,
                model TEXT NOT NULL,
                upstream_model TEXT,
                status_code INTEGER NOT NULL,
                credits_used INTEGER DEFAULT 0,
                input_tokens INTEGER DEFAULT 0,
                output_tokens INTEGER DEFAULT 0,
                latency_ms INTEGER DEFAULT 0,
                error_text TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS account_credits (
                account_id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                credits_enabled INTEGER DEFAULT 0,
                credits_exhausted INTEGER DEFAULT 0,
                credits_exhausted_until TEXT,
                credit_type TEXT DEFAULT 'GOOGLE_ONE_AI',
                credit_amount REAL DEFAULT 0,
                minimum_for_usage REAL DEFAULT 0,
                subscription_tier TEXT,
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS quota_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account_id TEXT NOT NULL,
                email TEXT NOT NULL,
                model_name TEXT NOT NULL,
                utilization INTEGER DEFAULT 0,
                reset_time TEXT,
                is_forbidden INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS config (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE IF NOT EXISTS accounts (
                account_id TEXT PRIMARY KEY,
                email TEXT NOT NULL,
                name TEXT DEFAULT '',
                refresh_token TEXT NOT NULL,
                access_token TEXT,
                expires_at TEXT,
                project_id TEXT DEFAULT '',
                subscription_tier TEXT,
                status TEXT DEFAULT 'active',
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_usage_logs_created ON usage_logs(created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_email ON usage_logs(account_email);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_model ON usage_logs(model);
            CREATE INDEX IF NOT EXISTS idx_usage_logs_credits ON usage_logs(credits_used);
            CREATE INDEX IF NOT EXISTS idx_quota_snapshots_account ON quota_snapshots(account_id, created_at);
        ").expect("Failed to create tables");

        // Default config
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('at_proxy_url', 'http://127.0.0.1:8045')", []).ok();
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('sub2api_url', 'http://127.0.0.1:8080')", []).ok();
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('bridge_port', '8600')", []).ok();
        conn.execute("INSERT OR IGNORE INTO config (key, value) VALUES ('credits_auto_inject', 'true')", []).ok();

        tracing::info!("✅ Database initialized at {:?}", db_path);

        Database { conn: Mutex::new(conn) }
    }

    // ---- Usage Logs ----

    pub fn log_usage(&self, data: &UsageLog) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO usage_logs (trace_id, account_email, model, upstream_model, status_code, credits_used, input_tokens, output_tokens, latency_ms, error_text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                data.trace_id, data.account_email, data.model, data.upstream_model,
                data.status_code, if data.credits_used { 1 } else { 0 },
                data.input_tokens, data.output_tokens, data.latency_ms, data.error_text
            ],
        ).ok();
    }

    pub fn get_usage_stats(&self, hours: i32) -> UsageStats {
        let conn = self.conn.lock().unwrap();
        let since = chrono::Utc::now() - chrono::Duration::hours(hours as i64);
        let since_str = since.format("%Y-%m-%dT%H:%M:%S").to_string();

        let total = conn.query_row(
            "SELECT COUNT(*) as total_requests,
                    COALESCE(SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END), 0) as success,
                    COALESCE(SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END), 0) as errors,
                    COALESCE(SUM(credits_used), 0) as credits_requests,
                    COALESCE(SUM(input_tokens), 0) as total_input_tokens,
                    COALESCE(SUM(output_tokens), 0) as total_output_tokens,
                    AVG(latency_ms) as avg_latency_ms
             FROM usage_logs WHERE created_at >= ?1",
            params![since_str],
            |row| Ok(UsageTotal {
                total_requests: row.get(0)?,
                success: row.get(1)?,
                errors: row.get(2)?,
                credits_requests: row.get(3)?,
                total_input_tokens: row.get(4)?,
                total_output_tokens: row.get(5)?,
                avg_latency_ms: row.get(6)?,
            }),
        ).unwrap_or_default();

        let mut stmt = conn.prepare(
            "SELECT model, COUNT(*) as requests,
                    SUM(CASE WHEN status_code < 400 THEN 1 ELSE 0 END),
                    SUM(credits_used), SUM(input_tokens), SUM(output_tokens), AVG(latency_ms)
             FROM usage_logs WHERE created_at >= ?1
             GROUP BY model ORDER BY requests DESC"
        ).unwrap();
        let by_model: Vec<ModelStats> = stmt.query_map(params![since_str], |row| {
            Ok(ModelStats {
                model: row.get(0)?,
                requests: row.get(1)?,
                success: row.get(2)?,
                credits_used: row.get(3)?,
                input_tokens: row.get(4)?,
                output_tokens: row.get(5)?,
                avg_latency: row.get(6)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect();

        let mut stmt = conn.prepare(
            "SELECT strftime('%Y-%m-%d %H:00', created_at) as hour,
                    COUNT(*), SUM(credits_used)
             FROM usage_logs WHERE created_at >= ?1
             GROUP BY hour ORDER BY hour"
        ).unwrap();
        let by_hour: Vec<HourStats> = stmt.query_map(params![since_str], |row| {
            Ok(HourStats {
                hour: row.get(0)?,
                requests: row.get(1)?,
                credits_used: row.get(2)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect();

        let mut stmt = conn.prepare(
            "SELECT trace_id, account_email, model, status_code, error_text, created_at
             FROM usage_logs WHERE status_code >= 400 AND created_at >= ?1
             ORDER BY created_at DESC LIMIT 20"
        ).unwrap();
        let recent_errors: Vec<ErrorEntry> = stmt.query_map(params![since_str], |row| {
            Ok(ErrorEntry {
                trace_id: row.get(0)?,
                account_email: row.get(1)?,
                model: row.get(2)?,
                status_code: row.get(3)?,
                error_text: row.get(4)?,
                created_at: row.get(5)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect();

        UsageStats { total, by_model, by_hour, recent_errors }
    }

    // ---- Credits ----

    pub fn upsert_account_credits(&self, data: &AccountCredits) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO account_credits (account_id, email, credits_enabled, credits_exhausted, credits_exhausted_until, credit_type, credit_amount, minimum_for_usage, subscription_tier, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
             ON CONFLICT(account_id) DO UPDATE SET
               email=excluded.email, credits_enabled=excluded.credits_enabled,
               credits_exhausted=excluded.credits_exhausted, credits_exhausted_until=excluded.credits_exhausted_until,
               credit_type=excluded.credit_type, credit_amount=excluded.credit_amount,
               minimum_for_usage=excluded.minimum_for_usage, subscription_tier=excluded.subscription_tier,
               updated_at=datetime('now')",
            params![
                data.account_id, data.email,
                if data.credits_enabled { 1 } else { 0 },
                if data.credits_exhausted { 1 } else { 0 },
                data.credits_exhausted_until,
                data.credit_type.as_deref().unwrap_or("GOOGLE_ONE_AI"),
                data.credit_amount, data.minimum_for_usage, data.subscription_tier,
            ],
        ).ok();
    }

    pub fn get_all_account_credits(&self) -> Vec<AccountCredits> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT account_id, email, credits_enabled, credits_exhausted, credits_exhausted_until, credit_type, credit_amount, minimum_for_usage, subscription_tier, updated_at FROM account_credits ORDER BY email").unwrap();
        stmt.query_map([], |row| {
            Ok(AccountCredits {
                account_id: row.get(0)?,
                email: row.get(1)?,
                credits_enabled: row.get::<_, i32>(2)? != 0,
                credits_exhausted: row.get::<_, i32>(3)? != 0,
                credits_exhausted_until: row.get(4)?,
                credit_type: row.get(5)?,
                credit_amount: row.get(6)?,
                minimum_for_usage: row.get(7)?,
                subscription_tier: row.get(8)?,
                updated_at: row.get(9)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn toggle_credits(&self, account_id: &str, enabled: bool) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE account_credits SET credits_enabled = ?1, updated_at = datetime('now') WHERE account_id = ?2",
            params![if enabled { 1 } else { 0 }, account_id],
        ).ok();
    }

    pub fn clear_credits_exhausted(&self, account_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE account_credits SET credits_exhausted = 0, credits_exhausted_until = NULL, updated_at = datetime('now') WHERE account_id = ?1",
            params![account_id],
        ).ok();
    }

    // ---- Quota Snapshots ----

    pub fn save_quota_snapshot(&self, data: &QuotaSnapshot) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO quota_snapshots (account_id, email, model_name, utilization, reset_time, is_forbidden) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![data.account_id, data.email, data.model_name, data.utilization, data.reset_time, if data.is_forbidden { 1 } else { 0 }],
        ).ok();
    }

    pub fn get_latest_quota_snapshots(&self) -> Vec<QuotaSnapshot> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT qs.id, qs.account_id, qs.email, qs.model_name, qs.utilization, qs.reset_time, qs.is_forbidden, qs.created_at
             FROM quota_snapshots qs
             INNER JOIN (SELECT account_id, model_name, MAX(created_at) as latest FROM quota_snapshots GROUP BY account_id, model_name) latest
             ON qs.account_id = latest.account_id AND qs.model_name = latest.model_name AND qs.created_at = latest.latest
             ORDER BY qs.account_id, qs.model_name"
        ).unwrap();
        stmt.query_map([], |row| {
            Ok(QuotaSnapshot {
                id: row.get(0)?,
                account_id: row.get(1)?,
                email: row.get(2)?,
                model_name: row.get(3)?,
                utilization: row.get(4)?,
                reset_time: row.get(5)?,
                is_forbidden: row.get::<_, i32>(6)? != 0,
                created_at: row.get(7)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    // ---- Config ----

    pub fn get_config(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row("SELECT value FROM config WHERE key = ?1", params![key], |row| row.get(0)).ok()
    }

    pub fn set_config(&self, key: &str, value: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?1, ?2, datetime('now'))", params![key, value]).ok();
    }

    pub fn get_all_config(&self) -> Vec<ConfigRow> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT key, value FROM config").unwrap();
        stmt.query_map([], |row| Ok(ConfigRow { key: row.get(0)?, value: row.get(1)? }))
            .unwrap().filter_map(|r| r.ok()).collect()
    }

    // ---- Accounts (RT Import) ----

    pub fn upsert_account(&self, data: &Account) {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO accounts (account_id, email, name, refresh_token, access_token, expires_at, project_id, subscription_tier, status, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
             ON CONFLICT(account_id) DO UPDATE SET
               email=excluded.email, name=excluded.name, refresh_token=excluded.refresh_token,
               access_token=excluded.access_token, expires_at=excluded.expires_at,
               project_id=excluded.project_id, subscription_tier=excluded.subscription_tier,
               status=excluded.status, updated_at=datetime('now')",
            params![
                data.account_id, data.email, data.name, data.refresh_token,
                data.access_token, data.expires_at, data.project_id,
                data.subscription_tier, data.status,
            ],
        ).ok();
    }

    pub fn get_all_accounts(&self) -> Vec<Account> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT account_id, email, name, refresh_token, access_token, expires_at, project_id, subscription_tier, status, created_at, updated_at FROM accounts ORDER BY created_at DESC"
        ).unwrap();
        stmt.query_map([], |row| {
            Ok(Account {
                account_id: row.get(0)?,
                email: row.get(1)?,
                name: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                refresh_token: row.get(3)?,
                access_token: row.get(4)?,
                expires_at: row.get(5)?,
                project_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                subscription_tier: row.get(7)?,
                status: row.get::<_, Option<String>>(8)?.unwrap_or("active".into()),
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn delete_account(&self, account_id: &str) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM accounts WHERE account_id = ?1", params![account_id]).ok();
        conn.execute("DELETE FROM account_credits WHERE account_id = ?1", params![account_id]).ok();
    }

    // ---- Grouped Quota Query ----

    pub fn get_quotas_grouped(&self) -> Vec<GroupedAccountQuota> {
        let conn = self.conn.lock().unwrap();
        let accounts: Vec<Account> = {
            let mut stmt = conn.prepare(
                "SELECT account_id, email, name, refresh_token, access_token, expires_at, project_id, subscription_tier, status, created_at, updated_at FROM accounts ORDER BY email"
            ).unwrap();
            stmt.query_map([], |row| {
                Ok(Account {
                    account_id: row.get(0)?, email: row.get(1)?,
                    name: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    refresh_token: row.get(3)?, access_token: row.get(4)?,
                    expires_at: row.get(5)?,
                    project_id: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    subscription_tier: row.get(7)?,
                    status: row.get::<_, Option<String>>(8)?.unwrap_or("active".into()),
                    created_at: row.get(9)?, updated_at: row.get(10)?,
                })
            }).unwrap().filter_map(|r| r.ok()).collect()
        };

        let mut results = vec![];
        for acct in accounts {
            // Get credits
            let credits = conn.query_row(
                "SELECT credits_enabled, credits_exhausted, credit_type, credit_amount, minimum_for_usage, subscription_tier FROM account_credits WHERE account_id = ?1",
                params![acct.account_id],
                |row| Ok(AccountCredits {
                    account_id: acct.account_id.clone(), email: acct.email.clone(),
                    credits_enabled: row.get::<_, i32>(0)? != 0,
                    credits_exhausted: row.get::<_, i32>(1)? != 0,
                    credit_type: row.get(2)?, credit_amount: row.get(3)?,
                    minimum_for_usage: row.get(4)?, subscription_tier: row.get(5)?,
                    ..Default::default()
                }),
            ).ok();

            // Get quotas
            let mut stmt = conn.prepare(
                "SELECT qs.model_name, qs.utilization, qs.reset_time, qs.is_forbidden
                 FROM quota_snapshots qs
                 INNER JOIN (SELECT account_id, model_name, MAX(created_at) as latest FROM quota_snapshots WHERE account_id = ?1 GROUP BY model_name) latest
                 ON qs.account_id = latest.account_id AND qs.model_name = latest.model_name AND qs.created_at = latest.latest
                 ORDER BY qs.utilization DESC, qs.model_name"
            ).unwrap();
            let quotas: Vec<ModelQuotaCompact> = stmt.query_map(params![acct.account_id], |row| {
                Ok(ModelQuotaCompact {
                    model: row.get(0)?, utilization: row.get(1)?,
                    remaining: 100 - row.get::<_, i32>(1)?,
                    reset_time: row.get(2)?,
                    is_forbidden: row.get::<_, i32>(3)? != 0,
                })
            }).unwrap().filter_map(|r| r.ok()).collect();

            results.push(GroupedAccountQuota {
                account_id: acct.account_id,
                email: acct.email,
                name: acct.name,
                status: acct.status,
                subscription_tier: acct.subscription_tier,
                project_id: acct.project_id,
                credits,
                quotas,
            });
        }
        results
    }

    // ---- Usage Logs (paginated) ----

    pub fn get_usage_logs_paginated(&self, limit: i64, offset: i64, filter: &str, errors_only: bool) -> Vec<UsageLog> {
        let conn = self.conn.lock().unwrap();
        let mut conditions = vec!["1=1".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if errors_only {
            conditions.push("status_code >= 400".into());
        }
        if !filter.is_empty() {
            conditions.push("(model LIKE ?1 OR account_email LIKE ?1 OR trace_id LIKE ?1)".into());
            params_vec.push(Box::new(format!("%{}%", filter)));
        }

        let sql = format!(
            "SELECT trace_id, account_email, model, upstream_model, status_code, credits_used, input_tokens, output_tokens, latency_ms, error_text, created_at
             FROM usage_logs WHERE {} ORDER BY created_at DESC LIMIT {} OFFSET {}",
            conditions.join(" AND "), limit, offset
        );

        let mut stmt = conn.prepare(&sql).unwrap();
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        stmt.query_map(param_refs.as_slice(), |row| {
            Ok(UsageLog {
                trace_id: row.get(0)?, account_email: row.get(1)?,
                model: row.get(2)?, upstream_model: row.get(3)?,
                status_code: row.get(4)?, credits_used: row.get::<_, i32>(5)? != 0,
                input_tokens: row.get(6)?, output_tokens: row.get(7)?,
                latency_ms: row.get(8)?, error_text: row.get(9)?,
            })
        }).unwrap().filter_map(|r| r.ok()).collect()
    }

    pub fn get_usage_log_count(&self, filter: &str, errors_only: bool) -> i64 {
        let conn = self.conn.lock().unwrap();
        let mut conditions = vec!["1=1".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::types::ToSql>> = vec![];

        if errors_only { conditions.push("status_code >= 400".into()); }
        if !filter.is_empty() {
            conditions.push("(model LIKE ?1 OR account_email LIKE ?1 OR trace_id LIKE ?1)".into());
            params_vec.push(Box::new(format!("%{}%", filter)));
        }

        let sql = format!("SELECT COUNT(*) FROM usage_logs WHERE {}", conditions.join(" AND "));
        let mut stmt = conn.prepare(&sql).unwrap();
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = params_vec.iter().map(|p| p.as_ref()).collect();
        stmt.query_row(param_refs.as_slice(), |row| row.get(0)).unwrap_or(0)
    }

    pub fn clear_usage_logs(&self) {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM usage_logs", []).ok();
    }
}

// ---- New structs for grouped queries ----

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelQuotaCompact {
    pub model: String,
    pub utilization: i32,
    pub remaining: i32,
    pub reset_time: Option<String>,
    pub is_forbidden: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GroupedAccountQuota {
    pub account_id: String,
    pub email: String,
    pub name: String,
    pub status: String,
    pub subscription_tier: Option<String>,
    pub project_id: String,
    pub credits: Option<AccountCredits>,
    pub quotas: Vec<ModelQuotaCompact>,
}
