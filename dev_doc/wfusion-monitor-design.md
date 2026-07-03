# wfusion 引擎监控页面 — 设计文档

## 概述

将原型 `warp-fusion/docs/config/monitoring-aegis.html` 整合到 wp-monitor-v2/backend 中，作为现有监控系统的一个新 tab 页面。采用混合方式：先用 mock 数据实现完整页面 + 预留真实 API 接口设计。

## 导航方式

在现有 wp-monitor 页面顶部增加 tab 切换：
- **流水线监控** — 现有监控内容（不变）
- **引擎监控** — 新增的 wfusion 监控

## 数据来源

全部数据来源于 VictoriaMetrics，通过标签（label）区分不同维度：

| 类别 | 依赖指标 | 关键标签 |
|------|---------|---------|
| 流水线概览 | wf_receive_total, wf_window_*, wf_rule_*, wf_alert_*, wf_event_e2e_latency_second_p99 | — |
| 来源列表 | wf_receive_total | source_name, source_type |
| 窗口列表 | wf_window_rows_total 等 | window_name |
| 规则列表 | wf_rule_instances_total, wf_alert_emitted_total | rule_name, alert_name |
| 设备维度（来源） | wf_receive_total | machine_name（`machine_name!=""`） |
| 设备维度（告警） | wf_alert_emitted_total | machine_name（`machine_name!=""`） |
| state machine 实例 | wf_alert_emitted_total | scope_key（`scope_key!="-"`） |
| 时序 | 上述 counter/gauge | — |

### 关键变化（相对于旧版 metrics）

- **不再有独立的 `wf_receive_by_machine` / `wf_alert_emitted_by_machine` 指标** — 机器维度通过主指标的 `machine_name` 标签过滤获取
- **state machine 实例不再依赖 NDJSON** — `scope_key` 标签已加入 `wf_alert_emitted_total`，VM 直接可查
- **来源类型**通过 `source_type` 标签获取（`tcp` / `file` / `kafka` 等）

---

## 后端 API 接口设计（预留）

### 设计原则

- **不分页**：VM 不支持 offset/limit，后端返回全量数据，前端做分页/排序/搜索
- **不区分活跃/静默**：后端返回全部数据，前端按指标值 > 0 / = 0 过滤
- **资源导向**：URL 路径表达资源层级
- **响应统一**：`ApiResponse<T>` = `{ code: 0, message: "ok", data: T }`

---

### 接口列表

#### 1. `GET /api/v1/wp-monitor/wf/pipeline?start_time=...&end_time=...`

流水线概览（页面第一行 3 个 stage 卡片）。参考 `monitoring-design.md` §8.1–§8.4 + §8.11。

```json
{
  "code": 0, "message": "ok",
  "data": {
    "generated_at": "2026-06-25T10:00:00Z",
    "receiver": {
      "total_rows": 12500000,
      "rate_rows_per_sec": 850,
      "route_errors": 12,
      "source_count": 3
    },
    "window": {
      "window_count": 4,
      "total_rows": 186000,
      "total_memory_bytes": 134217728,
      "late_dropped": 5
    },
    "rule": {
      "rule_count": 2,
      "total_state_machines": 15,
      "hit_rate_pct": 12.5,
      "total_emitted": 3200,
      "send_failed": 5,
      "e2e_p99_ms": 2.3
    }
  }
}
```

#### 2. `GET /api/v1/wp-monitor/wf/sources?start_time=...&end_time=...`

所有来源（全量）。参考 §8.5。

```json
{
  "code": 0, "message": "ok",
  "data": [
    {
      "name": "netflow_tcp", "type": "tcp",
      "rows": 5000000, "route_errors": 3,
      "machines": ["127.0.0.1", "127.0.0.2"]
    }
  ]
}
```

#### 3. `GET /api/v1/wp-monitor/wf/sources/machines?start_time=...&end_time=...`

设备维度来源聚合（全量）。参考 §8.12。

```json
{
  "code": 0, "message": "ok",
  "data": [
    { "machine": "127.0.0.1", "rows": 2000000, "route_errors": 1, "source_count": 3 }
  ]
}
```

#### 4. `GET /api/v1/wp-monitor/wf/windows?start_time=...&end_time=...`

所有窗口（全量）。参考 §8.6。

```json
{
  "code": 0, "message": "ok",
  "data": [
    {
      "name": "conn_events",
      "rows": 45000, "memory_bytes": 33554432,
      "capacity_bytes": 67108864, "late_dropped": 0
    }
  ]
}
```

#### 5. `GET /api/v1/wp-monitor/wf/rules?start_time=...&end_time=...`

所有规则（全量）。参考 §8.7。

```json
{
  "code": 0, "message": "ok",
  "data": [
    { "name": "rat_propagation", "emitted": 3200, "instances": 3 }
  ]
}
```

#### 6. `GET /api/v1/wp-monitor/wf/rules/{rule_name}/state-machines`

某规则的 state machine 实例告警分布（数据来自 NDJSON 的 instance 字段）。

```json
{
  "code": 0, "message": "ok",
  "data": [
    { "scope_key": "sm_prop_scan", "emitted": 1200 },
    { "scope_key": "sm_prop_beacon", "emitted": 1100 }
  ]
}
```

#### 7. `GET /api/v1/wp-monitor/wf/rules/machines?start_time=...&end_time=...`

设备维度告警聚合（全量）。参考 §8.12。

```json
{
  "code": 0, "message": "ok",
  "data": [
    { "machine": "127.0.0.1", "emitted": 1500, "rule_count": 2 }
  ]
}
```

#### 8–10. 时序接口

全部返回 `ApiResponse<Vec<NodeTimeSeries>>`（复用现有类型）。`max_data_points` 控制 VM range query 的 step/resolution。

| # | 端点 | 参数 | 参考 |
|---|------|------|------|
| 8 | `GET /wf/timeseries/throughput` | start_time, end_time, group_by(`source`\|`machine`), max_data_points | §8.8 |
| 9 | `GET /wf/timeseries/windows` | start_time, end_time, metric(`rows`\|`memory`\|`late`), max_data_points | §8.9 |
| 10 | `GET /wf/timeseries/alerts` | start_time, end_time, group_by(`rule`\|`machine`), max_data_points | §8.10 |

---

### 汇总

| # | 方法 | 路径 | 用途 | 源 |
|---|------|------|------|-----|
| 1 | GET | `/wf/pipeline` | 流水线概览 | VM |
| 2 | GET | `/wf/sources` | 来源列表 | VM |
| 3 | GET | `/wf/sources/machines` | 设备维度来源 | VM |
| 4 | GET | `/wf/windows` | 窗口列表 | VM |
| 5 | GET | `/wf/rules` | 规则列表 | VM |
| 6 | GET | `/wf/rules/{name}/state-machines` | 状态机实例 | VM |
| 7 | GET | `/wf/rules/machines` | 设备维度告警 | VM |
| 8 | GET | `/wf/timeseries/throughput` | 吞吐量时序 | VM |
| 9 | GET | `/wf/timeseries/windows` | 窗口时序 | VM |
| 10 | GET | `/wf/timeseries/alerts` | 告警时序 | VM |

---

## 前端实现

### 文件变更

| 操作 | 文件 | 用途 |
|------|------|------|
| 追加 | `frontend/src/types/monitor.ts` | wf 类型定义 |
| 追加 | `frontend/src/services/monitor.ts` | 10 个 wf API 函数（mock） |
| 新增 | `frontend/src/views/components/monitor/wfMock.ts` | mock 数据生成 |
| 新增 | `frontend/src/views/components/monitor/WfMonitor.tsx` | 主组件 |
| 新增 | `frontend/src/views/components/monitor/WfMonitor.css` | 样式 |
| 修改 | `frontend/src/views/pages/wp-monitor/index.tsx` | tab 切换 |
| 修改 | `frontend/src/views/pages/wp-monitor/index.css` | tab 样式 |
| 追加 | `frontend/src/i18n/resources/zh-CN.ts` | wfMonitor 文案 |

### 组件结构

```
WpMonitorPage
├── TabBar ("流水线监控" | "引擎监控")
├── [tab=流水线] 现有（不变）
└── [tab=引擎监控] WfMonitor
    ├── PipelineStages          — GET /wf/pipeline
    ├── DetailTables
    │   ├── SourceTable         — GET /wf/sources | /wf/sources/machines
    │   ├── WindowTable         — GET /wf/windows
    │   └── AlertTable          — GET /wf/rules | /wf/rules/machines
    │       └── SmPopover       — GET /wf/rules/{name}/state-machines
    └── TrendCharts
        ├── ThroughputChart     — GET /wf/timeseries/throughput
        ├── WindowChart         — GET /wf/timeseries/windows
        ├── AlertTrendChart     — GET /wf/timeseries/alerts
```

### 前端负责的逻辑

| 功能 | 方式 |
|------|------|
| 分页 | 后端全量返回，前端按 PAGE_SIZE 切片 |
| 排序 | 后端全量返回，前端 Array.sort() |
| 搜索 | 后端全量返回，前端 Array.filter() |
| 活跃/静默切换 | 后端全量返回，前端按 rows > 0 / rows === 0 过滤 |
| 来源/设备切换 | 调不同接口（/wf/sources vs /wf/sources/machines） |
| 规则/设备切换 | 调不同接口（/wf/rules vs /wf/rules/machines） |

### 数据刷新

进入引擎监控 tab 时启动 5s 轮询，切走暂停。Pipeline、表格、时序接口按需独立刷新。

### 关键细节

- **主题**：复用 `useTheme()`，不引入原型 CSS 变量体系
- **图表**：复用 `TimeSeriesChart` 的 `multiSeries` 模式
- **表格**：原生 `<table>` + Antd `Input`/`Button`
- **Popover**：fixed 定位 + portal 到 body

## 验证

1. `cd frontend && pnpm dev`
2. 切换 tab，三行布局渲染
3. 主题切换 3 种
4. 表格：搜索/排序/翻页/维度切换/活跃静默
5. 图表：指标切换、hover tooltip
6. 告警 hover popover
7. 5s 刷新
8. 切回流水线监控正常
