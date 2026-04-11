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
        max_data_points: Option<usize>,
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

    /// 转义 PromQL 双引号字符串字面量。
    fn escape_promql_string(v: &str) -> String {
        v.replace('\\', r"\\").replace('"', r#"\""#)
    }

    /// 按时间范围与目标点数自动计算 query_range 的步长（Grafana 风格）。
    /// 返回值：(step_str, rate_window_str, step_secs)
    ///
    /// step 与 rate_window 必须分开：
    /// - step 决定返回的数据点密度（60 个点）
    /// - rate_window 是 PromQL rate([Ns]) 的回看窗口，必须 ≥ 4× push 间隔
    ///   才能保证每个评估点内始终有多个样本，避免因单秒 push 缺失/重复
    ///   导致 rate() 输出 0.0 / 0.5 / 2.0 的抖动。
    ///   push 间隔为 1s，故 rate_window 最小 10s（≥ 4×1s，留有余量）。
    fn auto_step_for_timeseries(
        query: &TimeRangeQuery,
        max_data_points: Option<usize>,
    ) -> (String, String, i64) {
        let total_secs = (query.end_time.timestamp() - query.start_time.timestamp()).max(1);
        let target_points = max_data_points.unwrap_or(480).clamp(60, 2000) as i64;
        let raw_step_secs = ((total_secs + target_points - 1) / target_points).max(1);
        let step_secs = Self::nice_step_secs(raw_step_secs);
        // rate_window 不再无限随 step 放大：
        // - 下限 20s，保障样本数；
        // - 同时满足 Grafana 的 __rate_interval 思路：至少与 step 同级；
        // - 上限 1800s，避免窗口无限放大。
        let rate_window_secs = (step_secs * 4).max(step_secs).clamp(20, 1800);
        (
            format!("{}s", step_secs),
            format!("{}s", rate_window_secs),
            step_secs,
        )
    }

    /// 将原始步长归一化到 1/2/5×10^n，符合 Grafana 常见时间分辨率。
    fn nice_step_secs(raw: i64) -> i64 {
        let raw = raw.max(1) as f64;
        let pow10 = 10f64.powf(raw.log10().floor());
        let norm = raw / pow10;
        let factor = if norm <= 1.0 {
            1.0
        } else if norm <= 2.0 {
            2.0
        } else if norm <= 5.0 {
            5.0
        } else {
            10.0
        };
        (factor * pow10).round() as i64
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

    fn series_to_points(series: &[VmRangeSeries]) -> Vec<TimePoint> {
        // 选择“最大值最高”的序列，避免多序列场景错误取到全 0 序列。
        let chosen = series.iter().max_by(|a, b| {
            let a_max = a
                .values
                .iter()
                .map(|p| p.value)
                .fold(f64::NEG_INFINITY, f64::max);
            let b_max = b
                .values
                .iter()
                .map(|p| p.value)
                .fold(f64::NEG_INFINITY, f64::max);
            a_max
                .partial_cmp(&b_max)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.values.len().cmp(&b.values.len()))
        });
        chosen
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
            .unwrap_or_default()
    }

    fn build_zero_points(start: i64, end: i64, step_secs: i64) -> Vec<TimePoint> {
        if start > end || step_secs <= 0 {
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut ts = start;
        while ts <= end {
            let ts_text = chrono::DateTime::from_timestamp(ts, 0)
                .map(|d| d.to_rfc3339())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            out.push(TimePoint {
                ts: ts_text,
                value: 0.0,
            });
            ts += step_secs;
        }
        out
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
        let window = format!("{}s", (at_end - at_start).max(1));

        let source_count_q = format!(
            r#"sum by (source_type, source_name) (increase(wparse_receive_data[{}]))"#,
            window
        );
        let parse_count_q = format!(
            r#"sum by (package_name, rule_name) (increase(wparse_parse_all[{}]))"#,
            window
        );
        let sink_group_count_q = format!(
            r#"sum by (sink_group) (increase(wparse_send_to_sink{{sink_group!~"monitor|default|miss|residue|error"}}[{}]))"#,
            window
        );
        let sink_count_q = format!(
            r#"sum by (sink_group, sink_name) (increase(wparse_send_to_sink{{sink_group!~"monitor|default|miss|residue|error"}}[{}]))"#,
            window
        );

        let (source_count, parse_count, sink_group_count, sink_count) = tokio::try_join!(
            self.instant_query(&source_count_q, at_end),
            self.instant_query(&parse_count_q, at_end),
            self.instant_query(&sink_group_count_q, at_end),
            self.instant_query(&sink_count_q, at_end),
        )
        .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let source_rate = Self::rate_from_count_rows(&source_count, window_secs);
        let parse_rate = Self::rate_from_count_rows(&parse_count, window_secs);
        let sink_group_rate = Self::rate_from_count_rows(&sink_group_count, window_secs);
        let sink_rate = Self::rate_from_count_rows(&sink_count, window_secs);

        // 系统指标只取全局最大值，避免多序列场景出现重复。
        let cpu_query = "max(wparse_cpu_usage)".to_string();
        let mem_query = "max(wparse_memory_usage)".to_string();
        let (cpu_rows, mem_rows) = tokio::try_join!(
            self.instant_query(&cpu_query, at_end),
            self.instant_query(&mem_query, at_end),
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
        let total_q = format!(
            r#"sum(increase(wparse_send_to_sink{{sink_group="miss",sink_name="victorialogs_output"}}[{}s]))"#,
            (at_end - at_start).max(1)
        );
        let end_rows = self
            .instant_query(&total_q, at_end)
            .await
            .map_err(|e| VmRepoError::Request(e.to_string()))?;
        let count_f = end_rows.first().map(|x| x.value).unwrap_or(0.0).max(0.0);
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
        max_data_points: Option<usize>,
    ) -> Result<NodeTimeSeries, VmRepoError> {
        let (step, rate_window, step_secs) = Self::auto_step_for_timeseries(query, max_data_points);

        // 实时查询右边界会受到入库延迟/窗口边界影响：
        // 为保证”最近窗口”也尽量返回真实值，统一回退一个安全延迟。
        // 右边界保护使用固定小延迟，不能随 step 放大，否则长时间范围会丢失最近数据。
        let safe_lag_secs = 10;
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
                step_secs,
                rate_window_secs: rate_window
                    .trim_end_matches('s')
                    .parse::<i64>()
                    .unwrap_or(0),
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
            max_data_points = max_data_points.unwrap_or(0),
            "vm_repository.node_timeseries.start"
        );
        let (kind, parts) = Self::parse_node_id(node_id);

        let range_secs = (end - start).max(1);
        let use_bucket_aggregation = range_secs >= 48 * 3600;
        // 未识别节点类型时返回 vector(0)，保证接口语义稳定且不报错。
        // 同时查询两条序列：
        // 1) 平均线：按动态窗口 rate；
        // 2) 峰值线：在同一口径速率基线上做桶内 max_over_time。
        let avg_rate_base_q = match kind {
            "source" if parts.len() >= 2 => {
                let source_type = parts[0];
                let source_name = parts[1];
                let source_type = Self::escape_promql_string(source_type);
                let source_name = Self::escape_promql_string(source_name);
                format!(
                    r#"sum(rate(wparse_receive_data{{source_type="{}",source_name="{}"}}[{}]))"#,
                    source_type, source_name, rate_window
                )
            }
            "log" if parts.len() >= 2 => {
                let package = parts[0];
                let rule = parts[1];
                let package = Self::escape_promql_string(package);
                let rule = Self::escape_promql_string(rule);
                format!(
                    r#"sum(rate(wparse_parse_all{{package_name="{}",rule_name="{}"}}[{}]))"#,
                    package, rule, rate_window
                )
            }
            "group" if !parts.is_empty() => {
                let g = parts[0];
                let g = Self::escape_promql_string(g);
                format!(
                    r#"sum(rate(wparse_send_to_sink{{sink_group="{}",sink_group!~"monitor|default|miss|residue|error"}}[{}]))"#,
                    g, rate_window
                )
            }
            "sink" if parts.len() >= 2 => {
                let g = parts[0];
                let s = parts[1];
                let g = Self::escape_promql_string(g);
                let s = Self::escape_promql_string(s);
                format!(
                    r#"sum(rate(wparse_send_to_sink{{sink_group="{}",sink_name="{}",sink_group!~"monitor|default|miss|residue|error"}}[{}]))"#,
                    g, s, rate_window
                )
            }
            _ => "vector(0)".to_string(),
        };
        if avg_rate_base_q == "vector(0)" {
            warn!(
                node_id = node_id,
                "vm_repository.node_timeseries.unknown_node"
            );
        }
        let rate_q = if use_bucket_aggregation {
            format!("avg_over_time(({})[{}:{}s])", avg_rate_base_q, step, 30)
        } else {
            avg_rate_base_q.clone()
        };
        let rate_series = self
            .range_query(&rate_q, start, end, &step)
            .await
            .map_err(|e| VmRepoError::Request(e.to_string()))?;

        let mut rate_points = Self::series_to_points(&rate_series);
        if rate_points.is_empty() {
            rate_points = Self::build_zero_points(start, end, step_secs);
        }

        debug!(
            node_id = node_id,
            rate_points = rate_points.len(),
            "vm_repository.node_timeseries.success"
        );

        Ok(NodeTimeSeries {
            node_id: node_id.to_string(),
            log_rate_eps: rate_points,
            step_secs,
            rate_window_secs: rate_window
                .trim_end_matches('s')
                .parse::<i64>()
                .unwrap_or(0),
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
