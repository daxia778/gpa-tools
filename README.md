# GPA Tools — Google Partner API 代理管理工具

原生 macOS 桌面应用，用于管理 Google Partner API 账号、配额监控和 AI 请求代理。

## 功能

- 🔐 **账号管理** — 导入/管理 Google OAuth Refresh Token
- 📊 **配额监控** — 实时模型配额使用率、请求趋势
- 🔀 **AI 代理** — OpenAI 兼容 API 代理 (`/v1/chat/completions`)
- 💰 **Credits 管理** — AI Credits 余额追踪与自动注入
- 🖥️ **原生体验** — Rust + WebView，macOS 原生窗口

## 技术栈

- **后端**: Rust + Axum + SQLite (rusqlite)
- **前端**: 原生 HTML/CSS/JS（对齐 AT Manager 设计系统）
- **窗口**: tao (窗口) + wry (WebView)
- **端口**: `8600`（默认）

## 构建

```bash
cargo build --release
```

二进制产物: `target/release/gpa-tools`

## 运行

```bash
./target/release/gpa-tools
```

打开浏览器访问 `http://localhost:8600`，或使用 `.app` 包以原生窗口启动。

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/stats` | GET | 使用统计 |
| `/api/accounts` | GET | 账号列表 |
| `/api/import-tokens` | POST | 批量导入 RT |
| `/api/credits` | GET | Credits 列表 |
| `/api/quotas` | GET | 配额信息 |
| `/api/config` | GET/POST | 配置管理 |
| `/v1/chat/completions` | POST | AI 代理 |

## License

MIT
