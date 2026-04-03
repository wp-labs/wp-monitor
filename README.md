## 🚀 WP Monitor Backend

**面向 WP 数据链路的分层监控后端服务（Rust + Actix Web）**

中文 | [English](README.en.md)

---

## 📖 项目简介

**WP Monitor Backend** 是一个用于 WP 数据链路监控的后端服务，提供分层拓扑快照、节点指标查询、时序分析、VLog 缺失数据分页与导出能力，并内嵌前端静态页面用于可视化展示。

### 🏗️ 架构特点

- **🦀 Rust 后端**：基于 Actix Web，提供高性能 HTTP API。
- **⚛️ React 前端内嵌**：通过 `rust-embed` 将 `frontend/dist` 打包进可执行文件。
- **📦 单服务交付**：后端同时承载 API 和静态资源，部署路径清晰。
- **🔧 配置驱动**：通过 `config/app.toml` 统一管理 VM/VLog 地址与前端初始化参数。

## ✨ 功能特性

### 📊 监控接口

- **分层快照**：获取 Source / Parse / Sink / Miss 全量结构与指标。
- **增量刷新**：按 `node_ids` 拉取节点指标，支持前端定时刷新。
- **节点详情**：按节点 ID 查询详情信息。
- **节点时序**：查询日志速率时间序列。

### 📄 VLog 缺失数据

- **分页查询**：按时间窗口分页获取缺失日志。
- **DAT 导出**：按时间窗口导出缺失日志原文。

### 🧩 前端托管

- **静态资源服务**：自动返回前端构建产物。
- **SPA 回退路由**：非 API 路径自动回退到 `index.html`。

## ⚙️ 运行要求

- Rust stable
- Node.js 20+ 与 npm
- 可访问的 VictoriaMetrics 与 VLog 服务

## 🚀 快速开始

### 1. 配置

默认配置文件：`config/app.toml`

```toml
vm_base_url = "http://127.0.0.1:8428"
refresh_interval_sec = 5
default_window_min = 15
time_presets = [5, 15, 30, 60]
api_version = "v1"
vlog_base_url = "http://127.0.0.1:9428"
```

可通过环境变量覆盖配置路径：

```bash
APP_CONFIG_PATH=./config/app.toml cargo run
```

### 2. 本地开发

```bash
# 启动后端
cargo run

# 启动前端开发服务（可选）
cd frontend
npm ci
npm run dev
```

- 后端默认地址：`http://127.0.0.1:18080`
- 前端开发地址：`http://127.0.0.1:5173`（`/api` 自动代理到后端）

### 3. 构建

> 后端内嵌前端静态资源，请先构建前端再构建 Rust。

```bash
cd frontend
npm ci
npm run build
cd ..
cargo build --all
```

## 🔌 API 概览

统一前缀：`/api/v1/wp-monitor`

- `GET /layers/snapshot?start_time=<RFC3339>&end_time=<RFC3339>`
- `GET /layers/metrics?start_time=<RFC3339>&end_time=<RFC3339>&node_ids=a,b`
- `GET /nodes/{node_id}/detail?start_time=<RFC3339>&end_time=<RFC3339>`
- `GET /nodes/{node_id}/timeseries?start_time=<RFC3339>&end_time=<RFC3339>&step=30s`
- `GET /meta/config`
- `GET /health/ready`
- `GET /vlog/missed?start=<RFC3339>&end=<RFC3339>&query=wp_stage:miss&page=1&page_size=10`
- `GET /vlog/missed/export?start=<RFC3339>&end=<RFC3339>&query=wp_stage:miss`

示例：

```bash
curl "http://127.0.0.1:18080/api/v1/wp-monitor/health/ready"
```

## 🧪 质量检查

```bash
cargo fmt --check
cargo test --all
```

## 📌 版本

```bash
cargo run -- --version
```
