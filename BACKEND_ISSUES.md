# 后端问题与修复方案

> wp-monitor 后端代码全面审查结果。
> 已完成项标记为 ~~删除线~~。

---

## 🔴 高严重度

### 1. `parse_value` 不过滤 NaN/Inf，导致 serde_json 序列化报 500

**文件**: `src/infrastructure/wf_repository.rs:73-74`

**问题**: `parse_value` 用 `v.parse::<f64>().unwrap_or(0.0)`，但 NaN 和 Inf 也能 parse 成功。当 PromQL 除法产生 +Inf/NaN 时（如无事件数据时 `sum(rate(matches))/sum(rate(events))` 分母为零），该值流入 `hit_rate_pct` 等字段。`serde_json` 拒绝序列化非有限浮点数，`/wf/pipeline` 整个接口返回 HTTP 500。

`range_to_time_points`（第 151 行）同样有问题：`val.max(0.0)` 遇到 +Inf 仍是 +Inf。

**修复**:
```rust
fn parse_value(v: &str) -> f64 {
    let x = v.parse::<f64>().unwrap_or(0.0);
    if x.is_finite() { x } else { 0.0 }
}

fn range_to_time_points(values: &[(i64, f64)]) -> Vec<TimePoint> {
    values.iter().map(|(ts, val)| TimePoint {
        ts: ts_to_rfc3339(*ts),
        value: if val.is_finite() { Some(val.max(0.0)) } else { None },
    }).collect()
}
```

---

### 2. `vlog/missed/clear` 用 GET 方法执行删除操作

**文件**: `src/interfaces/vlog/handlers.rs:224-256`

**问题**: `#[get("/vlog/missed/clear")]` 会截断文件或从 VictoriaLogs 删除日志。GET 请求可被跨站触发（`<img src=...>`），无认证、无确认。服务绑定 0.0.0.0:18080。

**修复**: 改为 POST：
```rust
// handlers.rs
#[post("/vlog/missed/clear")]  // 原为 #[get(...)]
pub async fn clear_missed_logs(
    state: web::Data<AppState>,
    req: web::Json<ClearMissedRequest>,  // 原为 web::Query
) -> Result<HttpResponse> {
    // ...
}
```
同时新增 `#[derive(Deserialize)] struct ClearMissedRequest { query: String, source: Option<String> }`。

---

### 3. mmap 并发截断导致 SIGBUS 进程崩溃

**文件**: `src/infrastructure/miss_repository_impl.rs:59-73`、`src/infrastructure/file_repository.rs:33-51`

**问题**: `clear_miss_data` 调用 `std::fs::write(&file.file_path, "")` 截断文件，而此时 `tail_records` 可能正持有同一文件的 `Mmap`。读取已被截断文件的过期 mmap 映射区域触发 SIGBUS → 进程终止。两者均通过 `spawn_blocking` 并发执行，竞态真实存在。

**修复**: 在 `FileMissRepository` 中加 `RwLock` 串行化读写：
```rust
pub struct FileMissRepository {
    file_path: PathBuf,
    lock: RwLock<()>,
}

async fn fetch_records(&self, query: MissQuery) -> Result<MissPage, AppError> {
    let _guard = self.lock.read().await;
    // 原有 mmap 逻辑 ...
}

async fn clear_miss_data(&self, query: &str) -> Result<(), AppError> {
    let _guard = self.lock.write().await;
    std::fs::write(&self.file_path, "")?;
    Ok(())
}
```

---

### 4. 正则缺少 `^...$` 锚点导致子串匹配，统计偏大

**文件**: `src/infrastructure/vm_repository.rs:629-651`

**问题**: 过滤正则没有锚点。`package_name=~"auth"` 会匹配到 `auth_fail`、`my_auth`。同一个文件里 `fetch_packages_timeseries`（第 990-998 行）是有 `^...$` 锚点的，导致快照统计数据与逐包图表数据不一致。

另外 `escape_pipe_separated` 生成的 `^a|b$` 被 RE2 解析为 `(^a)|(b$)`，运算符优先级错误。

**修复**:
```rust
// 第 633 行：加锚点
let pkg_regex = format!("^{}$", escape_regex_chars(&f.package_name));

// 第 997、919 行：修复交替运算符分组
format!("^(?:{})$", escape_pipe_separated(package_name))
format!("^(?:{})$", escape_pipe_separated(rule_names))
```

---

### 5. ~~`fetch_pipeline` 单点故障（14 个并发查询任一失败全丢弃）~~ ✅ 已修复

已将 6 处 `tokio::try_join!` 替换为 `tokio::join!` + `guard()` 降级函数。

---

## 🟡 中严重度

### 6. `reqwest::Client` 无超时配置

**文件**: `src/infrastructure/wf_repository.rs:68`、`vm_repository.rs:56`、`vlog_repository.rs:18`

**问题**: 所有 `Client::new()` 均无超时。VictoriaMetrics/VictoriaLogs 挂住时请求永久阻塞，无取消路径。

**修复**: 提取公共构造器：
```rust
fn build_client() -> Client {
    Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .connect_timeout(std::time::Duration::from_secs(5))
        .build()
        .expect("reqwest client build")
}
```
三个 `::new()` 构造器中统一使用。

---

### 7. `wf_repository.rs` 缺少安全延迟（`vm_repository.rs` 有 10s 缓冲区）

**文件**: `src/infrastructure/wf_repository.rs:77-81`

**问题**: `vm_repository.rs` 对查询右边界做了 `SAFE_LAG_SECS = 10` 的缓冲区，避免读到 VictoriaMetrics 尚未落盘的最新数据。`wf_repository.rs` 没有，可能返回最近 10 秒的不完整/零值数据。

**修复**:
```rust
const SAFE_LAG_SECS: i64 = 10;

fn effective_query_range(query: &TimeRangeQuery) -> Option<(i64, i64)> {
    let start = query.start_time.timestamp();
    let end = query.end_time.timestamp().min(Utc::now().timestamp() - SAFE_LAG_SECS);
    (start < end).then_some((start, end))
}
```

---

### 8. `pick_latest_by_window_name` 用 HashMap 导致结果顺序不确定

**文件**: `src/infrastructure/wf_repository.rs:131-143`

**问题**: HashMap 迭代顺序非确定性。`fetch_windows` 调用此函数构建窗口列表，每轮刷新结果顺序可能跳动，前端表格行位置不稳。

**修复**: 改用 `BTreeMap`，按窗口名字典序排列：
```rust
fn pick_latest_by_window_name(series: &[VmSeriesValue]) -> BTreeMap<&str, f64> {
    let mut map: BTreeMap<&str, (f64, f64)> = BTreeMap::new();
    // ... 其余逻辑不变 ...
    map.into_iter().map(|(k, (_, v))| (k, v)).collect()
}
```

---

### 9. `LayerNodeCache` 只增不删，内存泄漏

**文件**: `src/application/layer_service.rs:61-132`

**问题**: `upsert_from_snapshot` 永远只 insert，不删除。当 source/parse/sink 从系统中移除后，缓存中对应的过期节点永久残留，持续增长。

**修复**: 在 upsert 前清理不在当前快照中的节点：
```rust
fn upsert_from_snapshot(&mut self, data: &VmSnapshotData) {
    let active_source_ids: HashSet<_> = data.sources.iter().map(|s| &s.id).collect();
    self.sources.retain(|s| active_source_ids.contains(&s.id));
    // parse、sink 同理 ...
    // 原有 upsert 逻辑 ...
}
```

---

### 10. MISS `count_total` 用硬编码查询，与用户 filter 不一致

**文件**: `src/interfaces/vlog/handlers.rs:105-126`、`src/infrastructure/miss_repository_impl.rs:120-122`

**问题**: `items` 按用户查询条件过滤，但 `total` 始终统计固定查询 `DEFAULT_MISS_QUERY`（"wp_stage:miss"）。用户传入自定义 query 时，前端显示的"共 N 条"与可见列表不匹配。

**修复**: 把实际 query 传给 `count_total`：
```rust
// handlers.rs
let actual_query = normalize_query(&req.query);
let (items_res, count_res) = tokio::join!(
    miss_service.fetch_records(MissQuery { query: actual_query.clone(), ... }),
    miss_service.count_total(&actual_query),
);
```

---

### 11. `get_layers_metrics` 高频轮询每次做全量快照

**文件**: `src/application/layer_service.rs:405-474`

**问题**: `get_layers_metrics`（5 秒一轮的高频接口）内部调用 `get_layers_snapshot`，每次做 6-8 个 VM 查询 + MISS 数据库查询 + 缓存合并 + 稳定哈希计算。开销大。

**修复**: 缓存 `layer_versions`，仅在节点结构变化时重新计算。在 `LayerService` 中新增缓存字段，按 source+parse+sink 节点 ID 集合的哈希为键。

---

### 12. `parse_miss_source` 非法输入静默回退

**文件**: `src/interfaces/vm/handlers.rs:43-47`

**问题**: `MissSource::from("fil")` 或 `MissSource::from("FILE")` 静默返回 `MissSource::Vlog`，不做任何提示。用户从错误的数据源获取数据，毫无感知。

**修复**: 非法值返回错误：
```rust
impl TryFrom<&str> for MissSource {
    type Error = AppError;
    fn try_from(s: &str) -> Result<Self, AppError> {
        match s.to_lowercase().as_str() {
            "file" => Ok(MissSource::File),
            "vlog" => Ok(MissSource::Vlog),
            other => Err(AppReason::InvalidMissSource.to_err()
                .with_detail(format!("未知 miss 来源: {other}")))
        }
    }
}
```

---

### 13. 成功与错误响应信封不一致

**文件**: `src/shared/api.rs:2-18`、`src/shared/error.rs:67-81`

**问题**: 成功用 `ApiResponse { code: i32, message, data: T }`（`code: 0`）。错误用 `AppErrorResponse`，结构为 `{ status, code, category, message, visibility, hints }`。两个结构完全不同。前端 `ApiErrorBody` 类型匹配了错误结构，但如果后端返回 HTTP 200 + `code != 0` 的业务错误，前端 `requestJson` 会当成功处理。

**修复**: 已在 `/monitor.ts` 中修复 — `requestJson` 先检查 `resp.ok` 再解析 JSON。后端侧需确保所有错误均通过 `AppErrorResponse` 以正确 HTTP 状态码返回。

---

### 14. `fetch_rules` 数据对齐：matched/instances 键不同

**文件**: `src/infrastructure/wf_repository.rs:576-617`

**问题**: `matched_map` 按 `rule_name` 键（来自 `wf_rule_matches_total`），`inst_map` 也按 `rule_name`（来自 `wf_rule_instances_total`），但 rules 列表是从 `emitted` 迭代的，而 `emitted` 按 `alert_name`（来自 `wf_alert_emitted_total`）。如果某个规则的 `rule_name` 和 `alert_name` 不同，它的 `matched` 和 `instances` 会是 0。

**修复**: 统一用 `alert_name` 做键，或用 `rule_name` 过滤 `emitted` 结果。

---

### 15. `vm_repository.rs` 即时查询 `parse_value` 不过滤 NaN

**文件**: `src/infrastructure/vm_repository.rs:62-65`

**问题**: `parse_value`（即时查询用）不检查 `is_finite`，但 `parse_optional_value`（区间查询用）检查了。即时查询返回的 NaN 通过 `build_source_nodes`/`build_parse_nodes` 传播，同样导致 serde_json 序列化 500。

**修复**: 让 `parse_value` 与 `parse_optional_value` 一样安全：
```rust
fn parse_value(v: &str) -> f64 {
    let x = v.parse::<f64>().unwrap_or(0.0);
    if x.is_finite() { (x * 100.0).round() / 100.0 } else { 0.0 }
}
```

---

## 🟢 低严重度

### 16. `vlog/missed/clear` query 参数未校验

**文件**: `src/interfaces/vlog/handlers.rs:224`

**问题**: 删除接口的 `query` 参数仅做 normalize，不限制内容。VictoriaLogs 模式下 `query=*` 可删除全部日志。

**修复**: 要求明确的非通配符查询模式。

---

### 17. `get_node_detail` 未知节点返回 200 + 伪造数据

**文件**: `src/application/layer_service.rs:567-579`

**问题**: 不存在的 node ID 返回 HTTP 200 + 零值节点。调用方无法区分「节点存在但无数据」和「节点不存在」。应为 404。

**修复**: 返回错误：
```rust
warn!(node_id = %node_id, "layer_service.node_detail.unknown");
Err(AppReason::NotFound.to_err().with_detail(format!("未知节点: {node_id}")))
```

---

### 18. `log_level` 字段无校验

**文件**: `src/shared/config.rs:11-18`、`src/shared/logging.rs:9-24`

**问题**: `log_level` 接受任意字符串，默认 "info"。无效值在运行时才报错（tracing subscriber 初始化失败），而非启动时校验。

**修复**: 在 `AppConfig::load_from_file` 中用 `tracing_subscriber::EnvFilter::try_new` 校验。

---

### 19. `AppReason` 有 PartialEq 无 Eq

**文件**: `src/shared/error.rs:7`

**问题**: `AppReason` derive 了 `PartialEq` 但未 derive `Eq`。调用方无法将其用作 HashMap 的键或 assert_eq! 宏的参数。

**修复**: 添加 `Eq` derive。`General(UnifiedReason)` 变体可能阻止 Eq——如有必要，将 `UnifiedReason` 从 `AppReason` 中拆分。

---

### 20. `stable_hash_json` 用 DefaultHasher 不跨版本稳定

**文件**: `src/shared/hash.rs:1-10`

**问题**: 文档描述为"稳定哈希"用于层版本检测，但 `std::collections::hash_map::DefaultHasher` 明确声明不保证跨 Rust 版本稳定。工具链升级可能突然改变所有层版本号，触发不必要的全量刷新。

**修复**: 使用确定性哈希如 `sha2::Sha256` 或 `xxhash_rust::xxh3::xxh3_64`。

---

### 21. `FileMissRepository::count_records` 假设每记录 6 行

**文件**: `src/infrastructure/file_repository.rs:33-47`

**问题**: 用 `wc -l` 除以 6 算记录数，假设每条 MISS 记录固定 6 行。`tail_records` 按空行分割，实际记录行数可变。格式变化时计数错误。

**修复**: 与 `tail_records` 一致，用空行分割逻辑计数。

---

### 22. `tail_records` 返回逆序记录

**文件**: `src/infrastructure/file_repository.rs:66-102`

**问题**: 从文件尾部反向扫描 push 记录，结果是最新在前。分页语义为 page 1 = 最新，但传统分页通常期望 page 1 = 最早。

**修复**: 末尾加 `.reverse()` 调整或明确文档说明分页方向。

---

## 📊 总览

| 严重度 | 数量 | 状态 |
|--------|------|------|
| 🔴 高 | 5 | 1 已修复，4 待修复 |
| 🟡 中 | 10 | 0 已修复，10 待修复 |
| 🟢 低 | 7 | 0 已修复，7 待修复 |
| **合计** | **22** | **1 已修复，21 待修复** |

### 修复优先级

1. `parse_value` NaN/Inf 过滤（#1）— 防生产 500
2. SIGBUS 崩溃（#3）— 防进程终止
3. 正则锚点缺失（#4）— 数据正确性
4. MISS clear GET → POST（#2）— 安全
5. Client 超时（#6）— 防连接挂起
6. 窗口排序（#8）— UI 一致性
7. LayerNodeCache 淘汰（#9）— 内存稳定性
