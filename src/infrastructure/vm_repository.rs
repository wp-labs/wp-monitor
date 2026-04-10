use crate::domain::model::{
    LogTypeNode, MetricsSnapshot, NodeTimeSeries, ParseNode, SinkGroupNode, SinkLeafNode,
    SourceNode, SysMetrics, TimePoint, TimeRangeQuery,
};
use async_trait::async_trait;
use chrono::Utc;
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use tracing::{debug, warn};

/// VM 仓储错误：
/// - Request：网络请求/连接错误；
/// - InvalidResponse：响应 JSON 结构不符合预期。
#[derive(Debug, thiserror::Error)]
pub enum VmRepoError {
    #[error("vm request failed: {0}")]
    Request(String),
    #[error("vm response invalid: {0}")]
    InvalidResponse(String),
}

/// 从 VM 查询后，应用层所需的基础快照原始数据。
#[derive(Debug, Clone)]
pub struct VmSnapshotData {
    pub sources: Vec<SourceNode>,
    pub parses: Vec<ParseNode>,
    pub sinks: Vec<SinkGroupNode>,
    pub sys_metrics: SysMetrics,
}

/// VM 仓储抽象：
/// - fetch_snapshot_data：查一次“当前时刻”聚合快照；
/// - fetch_node_timeseries：按节点拉区间序列。
#[async_trait]
pub trait VmRepository: Send + Sync {
    async fn fetch_snapshot_data(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<VmSnapshotData, VmRepoError>;
    async fn fetch_miss_metrics(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<MetricsSnapshot, VmRepoError>;
    async fn fetch_node_timeseries(
        &self,
        node_id: &str,
        query: &TimeRangeQuery,
    ) -> Result<NodeTimeSeries, VmRepoError>;
}

/// 基于 HTTP 协议访问 VictoriaMetrics 的仓储实现。
pub struct VmHttpRepository {
    client: Client,
    base_url: String,
}

impl VmHttpRepository {
    /// 创建仓储实例，自动去掉 base_url 尾部 `/`，避免 URL 拼接重复分隔符。
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// VM 返回 value 为字符串，这里统一兜底解析为 f64。
    fn parse_value(v: &str) -> f64 {
        let x = v.parse::<f64>().unwrap_or(0.0);
        (x * 100.0).round() / 100.0
    }

    /// 按时间范围自动计算 query_range 的步长，目标约 60 个点。
    /// 返回值：(step_str, rate_window_str, step_secs)
    ///
    /// step 与 rate_window 必须分开：
    /// - step 决定返回的数据点密度（60 个点）
    /// - rate_window 是 PromQL rate([Ns]) 的回看窗口，必须 ≥ 4× push 间隔
    ///   才能保证每个评估点内始终有多个样本，避免因单秒 push 缺失/重复
    ///   导致 rate() 输出 0.0 / 0.5 / 2.0 的抖动。
    ///   push 间隔为 1s，故 rate_window 最小 10s（≥ 4×1s，留有余量）。
    fn auto_step_for_timeseries(query: &TimeRangeQuery) -> (String, String, i64) {
        let total_secs = (query.end_time.timestamp() - query.start_time.timestamp()).max(1);
        let step_secs = ((total_secs + 59) / 60).max(1);
        // rate_window 至少为 step 的 8 倍，且不低于 20s，确保窗口内有足够多样本。
        // 更大的窗口能平滑 OS sleep 调度抖动引起的 ±1 事件滑移，
        // 将 ±5%(step*4) 降低到 ±2.5%(step*8)，
        // 代价是速率变化的响应时间延迟约一个 rate_window。
        let rate_window_secs = (step_secs * 8).max(20);
        (format!("{}s", step_secs), format!("{}s", rate_window_secs), step_secs)
    }

    /// 执行 instant query（单时刻查询）。
    async fn instant_query(
        &self,
        promql: &str,
        at_unix: i64,
    ) -> Result<Vec<VmSeriesValue>, VmRepoError> {
        let url = format!("{}/api/v1/query", self.base_url);
        debug!(
            endpoint = "/api/v1/query",
            at_unix = at_unix,
            promql = promql,
            "vm_repository.instant_query.start"
        );
        let resp = self
            .client
            .get(url)
            .query(&[("query", promql), ("time", &at_unix.to_string())])
            .send()
            .await
            .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let data = resp
            .json::<VmQueryResp>()
            .await
            .map_err(|e| VmRepoError::InvalidResponse(e.to_string()))?;
        debug!(
            endpoint = "/api/v1/query",
            result_size = data.data.result.len(),
            "vm_repository.instant_query.success"
        );

        Ok(data
            .data
            .result
            .into_iter()
            .map(|item| VmSeriesValue {
                metric: item.metric,
                ts: item.value[0].as_f64().unwrap_or(0.0),
                value: Self::parse_value(item.value[1].as_str().unwrap_or("0.00")),
            })
            .collect())
    }

    /// 执行 range query（时间区间序列查询）。
    async fn range_query(
        &self,
        promql: &str,
        start_unix: i64,
        end_unix: i64,
        step: &str,
    ) -> Result<Vec<VmRangeSeries>, VmRepoError> {
        let url = format!("{}/api/v1/query_range", self.base_url);
        debug!(
            endpoint = "/api/v1/query_range",
            start_unix = start_unix,
            end_unix = end_unix,
            step = step,
            promql = promql,
            "vm_repository.range_query.start"
        );
        let resp = self
            .client
            .get(url)
            .query(&[
                ("query", promql),
                ("start", &start_unix.to_string()),
                ("end", &end_unix.to_string()),
                ("step", step),
            ])
            .send()
            .await
            .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let data = resp
            .json::<VmRangeResp>()
            .await
            .map_err(|e| VmRepoError::InvalidResponse(e.to_string()))?;
        debug!(
            endpoint = "/api/v1/query_range",
            series_size = data.data.result.len(),
            "vm_repository.range_query.success"
        );

        Ok(data
            .data
            .result
            .into_iter()
            .map(|item| VmRangeSeries {
                metric: item.metric,
                values: item
                    .values
                    .into_iter()
                    .map(|vv| VmPoint {
                        ts: vv[0].as_f64().unwrap_or(0.0),
                        value: Self::parse_value(vv[1].as_str().unwrap_or("0")),
                    })
                    .collect(),
            })
            .collect())
    }

    /// 构建统一的指标快照结构。
    fn metric(rate: f64, count: u64, collected_at: &str) -> MetricsSnapshot {
        MetricsSnapshot {
            log_rate_eps: rate,
            log_count: count,
            collected_at: collected_at.to_string(),
        }
    }

    /// 将 source 的 rate/increase 结果合并成 SourceNode。
    fn build_source_nodes(
        &self,
        rate_rows: Vec<VmSeriesValue>,
        count_rows: Vec<VmSeriesValue>,
    ) -> Vec<SourceNode> {
        let mut count_map: HashMap<(String, String), f64> = HashMap::new();
        for c in count_rows {
            let st = c.metric.get("source_type").cloned().unwrap_or_default();
            let sn = c.metric.get("source_name").cloned().unwrap_or_default();
            count_map.insert((st, sn), c.value);
        }

        let collected_at = Utc::now().to_rfc3339();
        let mut out = Vec::new();
        for r in rate_rows {
            let source_type = r.metric.get("source_type").cloned().unwrap_or_default();
            let source_name = r.metric.get("source_name").cloned().unwrap_or_default();
            let count = count_map
                .get(&(source_type.clone(), source_name.clone()))
                .cloned()
                .unwrap_or(0.0)
                .round() as u64;
            out.push(SourceNode {
                id: format!("source:{}:{}", source_type, source_name),
                name: format!("{}:{}", source_type, source_name),
                protocol: source_type,
                metrics: Self::metric(r.value, count, &collected_at),
            });
        }
        out
    }

    /// 将 parse 的 rate/increase 结果先聚成 log，再聚成 package。
    fn build_parse_nodes(
        &self,
        rate_rows: Vec<VmSeriesValue>,
        count_rows: Vec<VmSeriesValue>,
    ) -> Vec<ParseNode> {
        let mut count_map: HashMap<(String, String), f64> = HashMap::new();
        for c in count_rows {
            let pkg = c.metric.get("package_name").cloned().unwrap_or_default();
            let rule = c.metric.get("rule_name").cloned().unwrap_or_default();
            count_map.insert((pkg, rule), c.value);
        }

        let mut pkg_map: HashMap<String, Vec<LogTypeNode>> = HashMap::new();
        let collected_at = Utc::now().to_rfc3339();

        for r in rate_rows {
            let pkg = r.metric.get("package_name").cloned().unwrap_or_default();
            let rule = r.metric.get("rule_name").cloned().unwrap_or_default();
            let count = count_map
                .get(&(pkg.clone(), rule.clone()))
                .cloned()
                .unwrap_or(0.0)
                .round() as u64;
            let log = LogTypeNode {
                id: format!("log:{}:{}", pkg, rule),
                name: rule,
                metrics: Self::metric(r.value, count, &collected_at),
            };
            pkg_map.entry(pkg).or_default().push(log);
        }

        let mut out = Vec::new();
        for (pkg, logs) in pkg_map {
            let total_rate = logs.iter().map(|x| x.metrics.log_rate_eps).sum::<f64>();
            let total_count = logs.iter().map(|x| x.metrics.log_count).sum::<u64>();
            out.push(ParseNode {
                id: format!("package:{}", pkg),
                package_name: pkg,
                metrics: Self::metric(total_rate, total_count, &collected_at),
                logs,
            });
        }
        out
    }

    /// 将 sink_group / sink_name 两层结果组装成输出层节点。
    /// 约定：
    /// - group 指标按 sink_group 聚合；
    /// - sink 指标按 sink_group + sink_name 聚合。
    fn build_sink_groups(
        &self,
        group_rate_rows: Vec<VmSeriesValue>,
        group_count_rows: Vec<VmSeriesValue>,
        sink_rate_rows: Vec<VmSeriesValue>,
        sink_count_rows: Vec<VmSeriesValue>,
    ) -> Vec<SinkGroupNode> {
        let mut group_rate_map: HashMap<String, f64> = HashMap::new();
        let mut group_count_map: HashMap<String, f64> = HashMap::new();
        let mut sink_rate_map: HashMap<(String, String), f64> = HashMap::new();
        let mut sink_count_map: HashMap<(String, String), f64> = HashMap::new();

        for r in group_rate_rows {
            let g = r.metric.get("sink_group").cloned().unwrap_or_default();
            group_rate_map.insert(g, r.value);
        }
        for c in group_count_rows {
            let g = c.metric.get("sink_group").cloned().unwrap_or_default();
            group_count_map.insert(g, c.value);
        }
        for r in sink_rate_rows {
            let g = r.metric.get("sink_group").cloned().unwrap_or_default();
            let n = r.metric.get("sink_name").cloned().unwrap_or_default();
            sink_rate_map.insert((g, n), r.value);
        }
        for c in sink_count_rows {
            let g = c.metric.get("sink_group").cloned().unwrap_or_default();
            let n = c.metric.get("sink_name").cloned().unwrap_or_default();
            sink_count_map.insert((g, n), c.value);
        }

        let collected_at = Utc::now().to_rfc3339();
        let mut grouped: HashMap<String, Vec<SinkLeafNode>> = HashMap::new();

        for ((group, name), rate) in sink_rate_map {
            let count = sink_count_map
                .get(&(group.clone(), name.clone()))
                .cloned()
                .unwrap_or(0.0)
                .round() as u64;
            grouped
                .entry(group.clone())
                .or_default()
                .push(SinkLeafNode {
                    id: format!("sink:{}:{}", group, name),
                    sink_group: group,
                    sink_name: name,
                    metrics: Self::metric(rate, count, &collected_at),
                });
        }

        let mut out = Vec::new();
        for (group, sinks) in grouped {
            out.push(SinkGroupNode {
                id: format!("group:{}", group),
                sink_group: group.clone(),
                metrics: Self::metric(
                    group_rate_map.get(&group).cloned().unwrap_or(0.0),
                    group_count_map.get(&group).cloned().unwrap_or(0.0).round() as u64,
                    &collected_at,
                ),
                sinks,
            });
        }

        out
    }

    /// 节点 ID 解析规则：
    /// - source:source_type:source_name
    /// - log:package_name:rule_name
    /// - group:sink_group
    /// - sink:sink_group:sink_name
    fn parse_node_id(node_id: &str) -> (&str, Vec<&str>) {
        let parts = node_id.split(':').collect::<Vec<_>>();
        if parts.is_empty() {
            return ("unknown", vec![]);
        }
        (parts[0], parts[1..].to_vec())
    }

    fn metric_key(metric: &HashMap<String, String>, labels: &[&str]) -> String {
        labels
            .iter()
            .map(|k| format!("{}={}", k, metric.get(*k).cloned().unwrap_or_default()))
            .collect::<Vec<_>>()
            .join("|")
    }

    fn diff_rows_by_labels(
        end_rows: Vec<VmSeriesValue>,
        start_rows: Vec<VmSeriesValue>,
        labels: &[&str],
    ) -> Vec<VmSeriesValue> {
        let mut start_map: HashMap<String, f64> = HashMap::new();
        for r in start_rows {
            let key = Self::metric_key(&r.metric, labels);
            start_map.insert(key, r.value);
        }

        end_rows
            .into_iter()
            .map(|mut r| {
                let key = Self::metric_key(&r.metric, labels);
                let base = start_map.get(&key).copied().unwrap_or(0.0);
                r.value = (r.value - base).max(0.0);
                r
            })
            .collect()
    }

    fn rate_from_count_rows(count_rows: &[VmSeriesValue], window_secs: f64) -> Vec<VmSeriesValue> {
        let denom = window_secs.max(1.0);
        count_rows
            .iter()
            .cloned()
            .map(|mut r| {
                r.value /= denom;
                r
            })
            .collect()
    }
}

#[async_trait]
impl VmRepository for VmHttpRepository {
    /// 查询分层快照：
    /// 1. 按业务指标构造 PromQL；
    /// 2. 并发查询 source/parse/sink/cpu/mem；
    /// 3. 按层级聚合并返回统一结构。
    async fn fetch_snapshot_data(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<VmSnapshotData, VmRepoError> {
        let at_start = query.start_time.timestamp();
        let at_end = query.end_time.timestamp();
        let window_secs = (at_end - at_start).max(1) as f64;
        debug!(
            start_time = %query.start_time,
            end_time = %query.end_time,
            window_secs = window_secs,
            "vm_repository.snapshot.start"
        );

        let source_total_q = "sum by (source_type, source_name) (wparse_receive_data)";
        let parse_total_q = "sum by (package_name, rule_name) (wparse_parse_all)";
        let sink_group_total_q = "sum by (sink_group) (wparse_send_to_sink{sink_group!~\"monitor|default|miss|residue|error\"})";
        let sink_total_q = "sum by (sink_group, sink_name) (wparse_send_to_sink{sink_group!~\"monitor|default|miss|residue|error\"})";

        let (source_end, parse_end, sink_group_end, sink_end) = tokio::try_join!(
            self.instant_query(source_total_q, at_end),
            self.instant_query(parse_total_q, at_end),
            self.instant_query(sink_group_total_q, at_end),
            self.instant_query(sink_total_q, at_end),
        )
        .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let (source_start, parse_start, sink_group_start, sink_start) = tokio::try_join!(
            self.instant_query(source_total_q, at_start),
            self.instant_query(parse_total_q, at_start),
            self.instant_query(sink_group_total_q, at_start),
            self.instant_query(sink_total_q, at_start),
        )
        .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let source_count =
            Self::diff_rows_by_labels(source_end, source_start, &["source_type", "source_name"]);
        let parse_count =
            Self::diff_rows_by_labels(parse_end, parse_start, &["package_name", "rule_name"]);
        let sink_group_count =
            Self::diff_rows_by_labels(sink_group_end, sink_group_start, &["sink_group"]);
        let sink_count =
            Self::diff_rows_by_labels(sink_end, sink_start, &["sink_group", "sink_name"]);

        let source_rate = Self::rate_from_count_rows(&source_count, window_secs);
        let parse_rate = Self::rate_from_count_rows(&parse_count, window_secs);
        let sink_group_rate = Self::rate_from_count_rows(&sink_group_count, window_secs);
        let sink_rate = Self::rate_from_count_rows(&sink_count, window_secs);

        // 系统指标只取全局最大值，避免多序列场景出现重复。
        let (cpu_rows, mem_rows) = tokio::try_join!(
            self.instant_query("max(wparse_cpu_usage)", at_end),
            self.instant_query("max(wparse_memory_usage)", at_end),
        )
        .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let cpu = cpu_rows.first().map(|x| x.value).unwrap_or(0.0000);
        let mem = mem_rows.first().map(|x| x.value).unwrap_or(0.0000);
        debug!(
            source_rate_rows = source_rate.len(),
            source_count_rows = source_count.len(),
            parse_rate_rows = parse_rate.len(),
            parse_count_rows = parse_count.len(),
            sink_group_rate_rows = sink_group_rate.len(),
            sink_group_count_rows = sink_group_count.len(),
            sink_rate_rows = sink_rate.len(),
            sink_count_rows = sink_count.len(),
            "vm_repository.snapshot.series_stats"
        );

        Ok(VmSnapshotData {
            sources: self.build_source_nodes(source_rate, source_count),
            parses: self.build_parse_nodes(parse_rate, parse_count),
            sinks: self.build_sink_groups(sink_group_rate, sink_group_count, sink_rate, sink_count),
            sys_metrics: SysMetrics {
                cpu_usage_pct: cpu,
                memory_used_mb: mem.round() as u64,
            },
        })
    }

    /// 查询 MISS 指标快照（速率 + 时间窗口累计数量）。
    /// 指标来源：
    async fn fetch_miss_metrics(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<MetricsSnapshot, VmRepoError> {
        let at_start = query.start_time.timestamp();
        let at_end = query.end_time.timestamp();
        let window_secs = (at_end - at_start).max(1) as f64;
        debug!(
            start_time = %query.start_time,
            end_time = %query.end_time,
            window_secs = window_secs,
            "vm_repository.miss_metrics.start"
        );
        let miss_selector =
            r#"wparse_send_to_sink{sink_group="miss",sink_name="victorialogs_output"}"#;
        let total_q = format!("sum({})", miss_selector);
        let (end_rows, start_rows) = tokio::try_join!(
            self.instant_query(&total_q, at_end),
            self.instant_query(&total_q, at_start),
        )
        .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let end_v = end_rows.first().map(|x| x.value).unwrap_or(0.0);
        let start_v = start_rows.first().map(|x| x.value).unwrap_or(0.0);
        let count_f = (end_v - start_v).max(0.0);
        let count = count_f.round() as u64;
        let rate = count_f / window_secs;
        debug!(
            rate = rate,
            count = count,
            "vm_repository.miss_metrics.success"
        );
        Ok(MetricsSnapshot {
            log_rate_eps: rate,
            log_count: count,
            collected_at: Utc::now().to_rfc3339(),
        })
    }

    /// 查询单节点时间序列：
    /// 1. 根据 node_id 解析节点类型和标签；
    /// 2. 直接使用 rate() 进行区间查询，返回每秒速率；
    /// 3. 统一做非负兜底，避免极端边界出现负值噪声。
    async fn fetch_node_timeseries(
        &self,
        node_id: &str,
        query: &TimeRangeQuery,
    ) -> Result<NodeTimeSeries, VmRepoError> {
        let (step, rate_window, step_secs) = Self::auto_step_for_timeseries(query);

        // 实时查询右边界会受到入库延迟/窗口边界影响：
        // 为保证”最近窗口”也尽量返回真实值，统一回退一个安全延迟。
        let safe_lag_secs = step_secs.max(2);
        let start = query.start_time.timestamp();
        let requested_end = query.end_time.timestamp();
        let now_safe_end = Utc::now().timestamp() - safe_lag_secs;
        let end = requested_end.min(now_safe_end);

        if start >= end {
            debug!(
                node_id = node_id,
                start_time = %query.start_time,
                end_time = %query.end_time,
                safe_lag_secs = safe_lag_secs,
                "vm_repository.node_timeseries.empty_due_to_realtime_boundary"
            );
            return Ok(NodeTimeSeries {
                node_id: node_id.to_string(),
                log_rate_eps: Vec::new(),
                log_count: Vec::new(),
            });
        }
        debug!(
            node_id = node_id,
            start_time = %query.start_time,
            end_time = %query.end_time,
            effective_end_unix = end,
            safe_lag_secs = safe_lag_secs,
            step = %step,
            "vm_repository.node_timeseries.start"
        );

        let (kind, parts) = Self::parse_node_id(node_id);

        // 未识别节点类型时返回 vector(0)，保证接口语义稳定且不报错。
        let rate_q = match kind {
            "source" if parts.len() >= 2 => {
                let source_type = parts[0];
                let source_name = parts[1];
                format!(
                    "sum(rate(wparse_receive_data{{source_type=\"{}\",source_name=\"{}\"}}[{}]))",
                    source_type, source_name, rate_window
                )
            }
            "log" if parts.len() >= 2 => {
                let package = parts[0];
                let rule = parts[1];
                format!(
                    "sum(rate(wparse_parse_all{{package_name=\"{}\",rule_name=\"{}\"}}[{}]))",
                    package, rule, rate_window
                )
            }
            "group" if !parts.is_empty() => {
                let g = parts[0];
                format!(
                    "sum(rate(wparse_send_to_sink{{sink_group=\"{}\",sink_group!~\"monitor|default|miss|residue|error\"}}[{}]))",
                    g, rate_window
                )
            }
            "sink" if parts.len() >= 2 => {
                let g = parts[0];
                let s = parts[1];
                format!(
                    "sum(rate(wparse_send_to_sink{{sink_group=\"{}\",sink_name=\"{}\",sink_group!~\"monitor|default|miss|residue|error\"}}[{}]))",
                    g, s, rate_window
                )
            }
            _ => "vector(0)".to_string(),
        };
        if rate_q == "vector(0)" {
            warn!(
                node_id = node_id,
                "vm_repository.node_timeseries.unknown_node"
            );
        }

        let rate_series = self
            .range_query(&rate_q, start, end, &step)
            .await
            .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let rate_points = rate_series
            .first()
            .map(|s| {
                s.values
                    .iter()
                    .map(|p| TimePoint {
                        ts: chrono::DateTime::from_timestamp(p.ts as i64, 0)
                            .map(|d| d.to_rfc3339())
                            .unwrap_or_else(|| Utc::now().to_rfc3339()),
                        value: p.value.max(0.0),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        debug!(
            node_id = node_id,
            rate_points = rate_points.len(),
            "vm_repository.node_timeseries.success"
        );

        Ok(NodeTimeSeries {
            node_id: node_id.to_string(),
            log_rate_eps: rate_points,
            log_count: Vec::new(),
        })
    }
}

/// -------- VictoriaMetrics 响应结构定义（仅用于反序列化） --------
#[derive(Debug, Deserialize)]
struct VmQueryResp {
    data: VmQueryData,
}

#[derive(Debug, Deserialize)]
struct VmQueryData {
    result: Vec<VmQueryItem>,
}

#[derive(Debug, Deserialize)]
struct VmQueryItem {
    metric: HashMap<String, String>,
    value: [serde_json::Value; 2],
}

#[derive(Debug, Clone)]
struct VmSeriesValue {
    metric: HashMap<String, String>,
    #[allow(dead_code)]
    ts: f64,
    value: f64,
}

#[derive(Debug, Deserialize)]
struct VmRangeResp {
    data: VmRangeData,
}

#[derive(Debug, Deserialize)]
struct VmRangeData {
    result: Vec<VmRangeItem>,
}

#[derive(Debug, Deserialize)]
struct VmRangeItem {
    metric: HashMap<String, String>,
    values: Vec<[serde_json::Value; 2]>,
}

#[derive(Debug, Clone)]
struct VmRangeSeries {
    #[allow(dead_code)]
    metric: HashMap<String, String>,
    values: Vec<VmPoint>,
}

#[derive(Debug, Clone)]
struct VmPoint {
    ts: f64,
    value: f64,
}
