# 后端改动文档

本文档描述为支持 Parse 节点优化功能，后端需要的 API 改动。前端改动详见 `backend/dev_doc/FrontendImplementation.md`。

---

## 改动概览

| # | 改动项 | 涉及文件 | 类型 |
|---|--------|----------|------|
| 1 | `/nodes/timeseries` 新增 `node_ids` 参数 | `handlers.rs` + `layer_service.rs` | 新增参数 |
| 2 | Package 级时序数据确认 | 无需改动 | 确认现有能力 |

---

## 1. `/nodes/timeseries` 新增 `node_ids` 参数

### 场景

当前 `/nodes/timeseries?scope=parse`（不带 `package_name`）会返回**所有** parse 节点的时序数据。当 parse 节点达到数百个时，数据量过大。前端需要能够只查询指定的一组 node 的时序数据。

### 当前请求结构

**文件**: `src/interfaces/vm/handlers.rs` 行 178-187

```rust
#[derive(Debug, Deserialize)]
pub struct NodesTimeSeriesRequest {
    pub scope: Option<TimeSeriesScope>,
    pub package_name: Option<String>,
    pub rule_name: Option<String>,
    pub sink_group: Option<String>,
    pub start_time: String,
    pub end_time: String,
    pub max_data_points: Option<usize>,
}
```

### 改动

新增可选参数 `node_ids`：

```rust
#[derive(Debug, Deserialize)]
pub struct NodesTimeSeriesRequest {
    pub scope: Option<TimeSeriesScope>,
    pub package_name: Option<String>,
    pub rule_name: Option<String>,
    pub sink_group: Option<String>,
    pub node_ids: Option<String>,  // 新增：逗号分隔的 node ID 列表
    pub start_time: String,
    pub end_time: String,
    pub max_data_points: Option<usize>,
}
```

### Handler 改动

**文件**: `src/interfaces/vm/handlers.rs` 行 225-237

在 `TimeSeriesScope::Parse` 分支中，传递 `node_ids` 参数：

```rust
TimeSeriesScope::Parse => svc
    .get_parse_timeseries(
        query,
        req.package_name.clone(),
        req.rule_name.clone(),
        req.max_data_points,
        req.node_ids.clone(),  // 新增参数
    )
    .await
```

### Service 层改动

**文件**: `src/application/layer_service.rs` 行 540-554

修改 `get_parse_timeseries` 函数签名，新增 `node_ids: Option<String>` 参数：

```rust
pub async fn get_parse_timeseries(
    &self,
    query: TimeRangeQuery,
    package_name: Option<String>,
    rule_name: Option<String>,
    max_data_points: Option<usize>,
    node_ids: Option<String>,  // 新增
) -> Result<Vec<NodeTimeSeries>, AppError> {
    // 解析 node_ids
    let ids: Option<Vec<String>> = node_ids.map(|s| {
        s.split(',').map(|id| id.trim().to_string()).collect()
    });
    self.vm_repo
        .fetch_parse_timeseries(query, package_name, rule_name, max_data_points, ids)
        .await
}
```

### Repository 层改动

在 `fetch_parse_timeseries` 实现中，如果 `node_ids` 参数非空，则在查询中增加 node ID 过滤条件（如 SQL `WHERE node_id IN (...)` 或 VictoriaMetrics `node_id=~"id1|id2|..."`）。

### 前端调用方式

```typescript
const url = `/api/v1/wp-monitor/nodes/timeseries?scope=parse&start_time=...&end_time=...&node_ids=pkg1,pkg3,pkg5`;
```

### 兼容性

该参数为可选，不传时保持现有行为（返回所有匹配的 node）。向后兼容。

---

## 2. Package 级别时序数据

### 现状确认

当前 `/nodes/timeseries?scope=parse` 在**不传** `package_name` 时，返回的 `Vec<NodeTimeSeries>` 中每个元素的 `node_id` 即为 package 的 ID（而非 log 的 ID）。

Parse 层的节点层级：
```
Parse Layer
├── package: "apache" (node_id = "pkg_xxx")    ← 包级别节点
│   ├── log: "access_log" (node_id = "log_xxx_1") ← 日志级别节点
│   └── log: "error_log"  (node_id = "log_xxx_2")
├── package: "nginx"
│   └── ...
```

现有 API `scope=parse` 返回的是**包级别**的时序数据（即每个 package 对应一个 `NodeTimeSeries`）。这正好满足「Parse 标题 → Package 趋势图」的需求。

### 需要确认的点

- `scope=parse` 不传 `package_name` 时，返回的是否确实是 package 级别节点而非 log 级别节点
- 如果是 log 级别，需要在 VictoriaMetrics 查询中增加过滤，仅返回 package 级别节点

### 如不是 package 级别

如果现有查询返回的是 log 级别节点，则需要在 repository 层增加过滤逻辑：

```
// 只查询 package 级别的节点（排除 log 子节点）
// 通过在查询中过滤 node_id 模式（如不以 "log_" 开头）
```

或者新增 `granularity` 参数：

```rust
pub enum TimeSeriesGranularity {
    #[serde(rename = "package")]
    Package,
    #[serde(rename = "log")]
    Log,
}
```

---

## 3. 不需要改动的部分

以下现有 API 无需修改：

| API | 用途 | 状态 |
|-----|------|------|
| `GET /layers/snapshot` | 获取三列节点列表 + miss | 无需改动 |
| `GET /nodes/{nodeId}/timeseries` | 单个节点（source/log/sink/miss）的时序 | 无需改动 |
| `GET /nodes/{nodeId}/detail` | 单个节点详情 | 无需改动 |
| `GET /layers/metrics` | 批量刷新节点指标 | 无需改动 |
| `GET /vlog/missed` | MISS 日志查询 | 无需改动 |

---

## 改动文件清单

| 文件 | 改动 |
|------|------|
| `src/interfaces/vm/handlers.rs` | `NodesTimeSeriesRequest` 新增 `node_ids` 字段；`get_parse_timeseries` 调用传入新参数 |
| `src/application/layer_service.rs` | `get_parse_timeseries` 签名新增 `node_ids` 参数 |
| `src/infrastructure/vm_repo.rs` (或对应的 repository 实现) | 底层查询增加 node ID IN 过滤 |

---

## 前端对应 API 变更

**文件**: `frontend/src/services/monitor.ts`

```typescript
export async function fetchParseTimeSeries(
  scope: "parse" | "source" | "sink",
  startTime: string,
  endTime: string,
  maxDataPoints?: number,
  packageName?: string,
  sinkGroup?: string,
  nodeIds?: string[],  // 新增
) {
  // ...
  if (nodeIds && nodeIds.length > 0) {
    params.set("node_ids", nodeIds.join(","));
  }
  // ...
}
```
