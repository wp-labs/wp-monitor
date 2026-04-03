## 🚀 WP Monitor Backend

**Layered monitoring backend service for WP data pipelines (Rust + Actix Web)**

[中文](README.md) | English

---

## 📖 Introduction

**WP Monitor Backend** is a monitoring service for WP data pipelines. It provides layer snapshot APIs, node metrics and time-series queries, VLog missed-data pagination/export, and serves embedded frontend assets for visualization.

### 🏗️ Architecture Highlights

- **🦀 Rust Backend**: High-performance HTTP APIs powered by Actix Web.
- **⚛️ Embedded React Frontend**: Packs `frontend/dist` into the binary via `rust-embed`.
- **📦 Single-Service Delivery**: API and static assets are served by one process.
- **🔧 Config-Driven**: Uses `config/app.toml` for VM/VLog endpoints and frontend init settings.

## ✨ Features

### 📊 Monitoring APIs

- **Layer Snapshot**: Full Source / Parse / Sink / Miss topology and metrics.
- **Incremental Metrics**: Refresh metrics by `node_ids` for periodic UI updates.
- **Node Detail**: Fetch details by node ID.
- **Node Time Series**: Query log-rate series.

### 📄 VLog Missed Data

- **Paged Query**: Query missed logs by time range with pagination.
- **DAT Export**: Export raw missed logs as DAT content.

### 🧩 Frontend Hosting

- **Static Asset Serving**: Returns built frontend artifacts.
- **SPA Fallback**: Non-API paths fallback to `index.html`.

## ⚙️ Requirements

- Rust stable
- Node.js 20+ and npm
- Reachable VictoriaMetrics and VLog services

## 🚀 Quick Start

### 1. Configure

Default file: `config/app.toml`

```toml
vm_base_url = "http://127.0.0.1:8428"
refresh_interval_sec = 5
default_window_min = 15
time_presets = [5, 15, 30, 60]
api_version = "v1"
vlog_base_url = "http://127.0.0.1:9428"
```

Override config path via env var:

```bash
APP_CONFIG_PATH=./config/app.toml cargo run
```

### 2. Local Development

```bash
# Run backend
cargo run

# Run frontend dev server (optional)
cd frontend
npm ci
npm run dev
```

- Backend: `http://127.0.0.1:18080`
- Frontend Dev: `http://127.0.0.1:5173` (`/api` is proxied to backend)

### 3. Build

> Backend embeds frontend static assets, so build frontend first.

```bash
cd frontend
npm ci
npm run build
cd ..
cargo build --all
```

## 🔌 API Overview

Base path: `/api/v1/wp-monitor`

- `GET /layers/snapshot?start_time=<RFC3339>&end_time=<RFC3339>`
- `GET /layers/metrics?start_time=<RFC3339>&end_time=<RFC3339>&node_ids=a,b`
- `GET /nodes/{node_id}/detail?start_time=<RFC3339>&end_time=<RFC3339>`
- `GET /nodes/{node_id}/timeseries?start_time=<RFC3339>&end_time=<RFC3339>&step=30s`
- `GET /meta/config`
- `GET /health/ready`
- `GET /vlog/missed?start=<RFC3339>&end=<RFC3339>&query=wp_stage:miss&page=1&page_size=10`
- `GET /vlog/missed/export?start=<RFC3339>&end=<RFC3339>&query=wp_stage:miss`

Example:

```bash
curl "http://127.0.0.1:18080/api/v1/wp-monitor/health/ready"
```

## 🧪 Quality Checks

```bash
cargo fmt --check
cargo test --all
```

## 📌 Version

```bash
cargo run -- --version
```
