# WP-MONITOR

[English](#english) | [中文](#中文)

---

## English

## 🚀 WP-MONITOR

**A unified monitoring product for WarpParse data pipelines, delivered as one service (backend + frontend).**

### What It Solves

WP-MONITOR is built for operations and platform teams that need to quickly answer:
- Where is traffic flowing now?
- Which stage is abnormal?
- Are sink outputs healthy?
- How much data is being missed?

It provides a clear operational view of Source → Parse → Sink → Miss, so teams can detect issues early and reduce recovery time.

### Business-Oriented Capabilities

- **End-to-end pipeline visibility**
  - One screen to observe the full WP pipeline layers and key metrics.
- **Fast abnormality locating**
  - Drill down from layer to node for rapid troubleshooting.
- **Missed data governance**
  - Query, paginate, and export missed logs for incident analysis.
- **Operational efficiency**
  - Supports near-real-time updates and quick time-range switching.

### Product Delivery Model

- **Frontend + backend in one project**
- **Frontend build (`frontend/dist`) is served by backend**
- **Single service endpoint for UI and APIs**

This keeps deployment and operations simple, especially in controlled environments.

### Typical Use Cases

- Daily production inspection for data pipelines
- Real-time anomaly investigation during incidents
- Post-incident analysis with missed log export
- Capacity/risk observation across source, parse, and sink layers

---

## 中文

## 🚀 WP-MONITOR

**面向 WarpParse 数据链路的一体化监控产品（前后端一体交付）。**

### 解决什么问题

WP-MONITOR 主要帮助运维与平台团队快速回答这些业务问题：
- 当前流量在链路中的流向是否正常？
- 哪一层、哪个节点出现异常？
- 下游输出是否健康？
- 缺失数据规模有多大？

它提供 Source → Parse → Sink → Miss 的统一监控视图，帮助团队更早发现问题并缩短恢复时间。

### 业务能力

- **全链路可视化**
  - 在一个界面中查看 WP 链路各层状态与关键指标。
- **异常快速定位**
  - 支持从层级到节点的下钻定位，提升排障效率。
- **缺失数据治理**
  - 支持 MISS 日志查询、分页和导出，便于复盘与审计。
- **运维效率提升**
  - 支持近实时刷新与快捷时间范围切换。

### 产品交付形态

- **前后端同仓库、同服务交付**
- **前端构建产物（`frontend/dist`）由后端统一代理/托管**
- **一个服务地址同时提供页面与 API**

这种交付方式部署简单、运维成本低，适合生产环境统一管理。

### 典型场景

- 数据链路日常巡检
- 线上异常实时排查
- 事故后 MISS 数据导出分析
- Source/Parse/Sink 各层容量与风险观察

