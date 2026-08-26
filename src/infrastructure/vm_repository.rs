use super::vm_utils::{align_points_to_grid, ts_to_rfc3339};
use crate::domain::model::{
    LogTypeNode, MetricsSnapshot, NodeTimeSeries, ParseNode, SinkGroupNode, SinkLeafNode,
    SourceNode, SysMetrics, TimePoint, TimeRangeQuery,
};
use crate::domain::vm_repository::{
    PackageFilter, TimeSeriesMetricMode, VmRepository, VmSnapshotData,
};
use crate::shared::error::{AppError, AppReason};
use async_trait::async_trait;
use chrono::Utc;
use orion_error::{OperationContext, prelude::*};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use tracing::{debug, warn};

/// 转义 PromQL 正则特殊字符。
fn escape_regex_chars(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\\' | '.' | '+' | '*' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' => {
                out.push('\\');
                out.push(ch);
            }
            _ => out.push(ch),
        }
    }
    out
}

/// 将 `|` 分隔的多个名称分别转义后重新拼接为正则分支。
fn escape_pipe_separated(s: &str) -> String {
    s.split('|')
        .map(escape_regex_chars)
        .collect::<Vec<_>>()
        .join("|")
}

/// 基于 HTTP 协议访问 VictoriaMetrics 的仓储实现。
pub struct VmHttpRepository {
    client: Client,
    base_url: String,
}

impl VmHttpRepository {
    /// 实时查询统一安全回退秒数，避免读取到尚未稳定写入的尾部点。
    const SAFE_LAG_SECS: i64 = 10;
    /// 节点详情趋势图固定步长策略按 VictoriaMetrics 默认上限 30000 的 2/3 保守取值。
    const DETAIL_MAX_DATA_POINTS: usize = 20_000;

    /// 创建仓储实例，自动去掉 base_url 尾部 `/`，避免 URL 拼接重复分隔符。
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client build"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// VM 即时查询返回 value 为字符串，这里统一兜底解析为有限 f64。
    fn parse_value(v: &str) -> f64 {
        let x = v.parse::<f64>().unwrap_or(0.0);
        if x.is_finite() {
            (x * 100.0).round() / 100.0
        } else {
            0.0
        }
    }

    /// VM 区间查询的点值可能返回 `NaN` / `Inf` / 非法字符串。
    /// 这些值在时序接口里应保留为空，交给补点逻辑输出 `null`，
    /// 不能吞成 `0.0`，否则会把“无数据”伪装成“零增量”。
    fn parse_optional_value(v: &str) -> Option<f64> {
        let x = v.parse::<f64>().ok()?;
        x.is_finite().then_some((x * 100.0).round() / 100.0)
    }

    /// 将秒级时间戳安全转换为 RFC3339 字符串。
    /// 计算实际查询时间范围，并对右边界做安全回退。
    /// 这里保留用户选择的左边界，避免“本周/今天”等自然时间范围被意外截断。
    fn effective_query_range(query: &TimeRangeQuery) -> Option<(i64, i64)> {
        let requested_start = query.start_time.timestamp();
        let requested_end = query.end_time.timestamp();
        let now_safe_end = Utc::now().timestamp() - Self::SAFE_LAG_SECS;
        let end = requested_end.min(now_safe_end);
        (requested_start < end).then_some((requested_start, end))
    }

    /// 将 VM 点位统一转换为时序点并做非负兜底。
    fn vm_points_to_time_points(values: &[VmPoint]) -> Vec<TimePoint> {
        values
            .iter()
            .map(|p| TimePoint {
                ts: ts_to_rfc3339(p.ts as i64),
                value: p.value.map(|v| v.max(0.0)),
            })
            .collect::<Vec<_>>()
    }

    /// 转义 PromQL 双引号字符串字面量。
    fn escape_promql_string(v: &str) -> String {
        v.replace('\\', r"\\").replace('"', r#"\""#)
    }

    /// 生成 VictoriaMetrics counter 增量表达式。
    /// `increase_pure` 会把窗口内首次出现的 counter 视为从 0 起步，避免漏掉首批样本。
    fn counter_increase_expr(metric_selector: &str, window: &str) -> String {
        format!(r#"increase_pure({metric_selector}[{window}])"#)
    }

    /// 生成“窗口内存在原始样本”的判定表达式。
    /// 仅当窗口内存在至少一个原始点时，才保留对应时序值；
    /// 这样可以把 VictoriaMetrics 因 lookback 语义延展出来的尾部伪 `0`
    /// 重新变回缺失点，最终由补点逻辑输出为 `null`。
    fn counter_presence_expr(metric_selector: &str, window: &str) -> String {
        format!(r#"present_over_time({metric_selector}[{window}])"#)
    }

    /// 为时序表达式增加“窗口内必须存在原始样本”的约束。
    fn guard_timeseries_expr(
        value_expr: String,
        metric_selector: &str,
        window: &str,
        group_labels: &[&str],
    ) -> String {
        let presence_raw = Self::counter_presence_expr(metric_selector, window);
        if group_labels.is_empty() {
            let presence = format!(r#"sum({presence_raw})"#);
            format!(r#"({value_expr}) and ({presence})"#)
        } else {
            let labels = group_labels.join(", ");
            let presence = format!(r#"sum by ({labels}) ({presence_raw})"#);
            format!(r#"({value_expr}) and on ({labels}) ({presence})"#)
        }
    }

    /// 计算速率序列的统计窗口：
    /// - 1s 步长使用 3s，减少单秒抖动；
    /// - 2s 步长使用 4s，保持轻微平滑；
    /// - 5s 及以上默认与 step 一致，避免窗口被过度放大。
    fn rate_window_secs_for_step(step_secs: i64) -> i64 {
        match step_secs {
            0..=1 => 3,
            2 => 4,
            _ => step_secs.max(1),
        }
    }

    /// 按时间范围与目标点数自动计算 query_range 的步长（Grafana 风格）。
    /// 返回值：(step_str, rate_window_str, step_secs)
    ///
    /// step 与 rate_window 必须分开：
    /// - step 决定返回的数据点密度，同时作为 count 模式的统计桶；
    /// - rate 模式的 rate_window 在 1s/2s 步长下使用短窗口平滑采样抖动，较大步长与 step 一致。
    fn auto_step_for_timeseries(
        query: &TimeRangeQuery,
        max_data_points: Option<usize>,
    ) -> (String, String, i64) {
        let total_secs = (query.end_time.timestamp() - query.start_time.timestamp()).max(1);
        let target_points = max_data_points
            .unwrap_or(500)
            .clamp(60, Self::DETAIL_MAX_DATA_POINTS) as i64;
        let raw_step_secs = ((total_secs + target_points - 1) / target_points).max(1);
        let step_secs = Self::nice_step_secs(raw_step_secs);
        Self::step_strings(step_secs)
    }

    fn step_strings(step_secs: i64) -> (String, String, i64) {
        let rate_window_secs = Self::rate_window_secs_for_step(step_secs);
        (
            format!("{}s", step_secs),
            format!("{}s", rate_window_secs),
            step_secs,
        )
    }

    /// 节点详情趋势图复用自动步长策略，前端通过 ECharts LTTB 按像素宽度降采样。
    fn detail_step_for_timeseries(query: &TimeRangeQuery) -> (String, String, i64, usize) {
        let max_points = 500;
        let (step, rate_window, step_secs) =
            Self::auto_step_for_timeseries(query, Some(max_points));
        (step, rate_window, step_secs, max_points)
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
    ) -> Result<Vec<VmSeriesValue>, AppError> {
        let url = format!("{}/api/v1/query", self.base_url);
        let ctx = OperationContext::doing("instant_query")
            .with_field("url", url.clone())
            .with_field("promql", promql.to_string());

        let resp = self
            .client
            .get(url)
            .query(&[("query", promql), ("time", &at_unix.to_string())])
            .send()
            .await
            .source_raw_err(
                AppReason::VmRequestFailed,
                "http request to victoria metrics failed",
            )
            .with_context(&ctx)?;

        let resp_body = resp
            .text()
            .await
            .source_raw_err(
                AppReason::VmResponseInvalid,
                "read vm instant query response body failed",
            )
            .with_context(&ctx)?;
        let data: VmQueryResp = serde_json::from_str(&resp_body).source_raw_err(
            AppReason::VmResponseInvalid,
            format!(
                "parse vm instant query response failed, body: {}",
                &resp_body[..resp_body.len().min(500)]
            ),
        )?;
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
    ) -> Result<Vec<VmRangeSeries>, AppError> {
        let url = format!("{}/api/v1/query_range", self.base_url);
        let ctx = OperationContext::doing("range_query")
            .with_field("url", url.clone())
            .with_field("promql", promql.to_string());
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
            .source_raw_err(
                AppReason::VmRequestFailed,
                "vm range query http request failed",
            )
            .with_context(&ctx)?;

        let resp_body = resp
            .text()
            .await
            .source_raw_err(
                AppReason::VmResponseInvalid,
                "read vm range query response body failed",
            )
            .with_context(&ctx)?;
        let data: VmRangeResp = serde_json::from_str(&resp_body).source_raw_err(
            AppReason::VmResponseInvalid,
            format!(
                "parse vm range query response failed, body: {}",
                &resp_body[..resp_body.len().min(500)]
            ),
        )?;
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
                        value: Self::parse_optional_value(vv[1].as_str().unwrap_or("")),
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
                .filter_map(|p| p.value)
                .fold(f64::NEG_INFINITY, f64::max);
            let b_max = b
                .values
                .iter()
                .filter_map(|p| p.value)
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
                        value: p.value.map(|v| v.max(0.0)),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    }

    async fn fetch_scope_timeseries_internal<F>(
        &self,
        query: &TimeRangeQuery,
        max_data_points: Option<usize>,
        query_prom: String,
        metric_mode: TimeSeriesMetricMode,
        node_id_builder: F,
    ) -> Result<Vec<NodeTimeSeries>, AppError>
    where
        F: Fn(&HashMap<String, String>) -> String,
    {
        let (step, rate_window, step_secs) = Self::auto_step_for_timeseries(query, max_data_points);
        let rate_window_secs = rate_window
            .trim_end_matches('s')
            .parse::<i64>()
            .unwrap_or(0);
        let Some((start, end)) = Self::effective_query_range(query) else {
            return Ok(Vec::new());
        };

        debug!(
            start_time = %query.start_time,
            end_time = %query.end_time,
            effective_end_unix = end,
            safe_lag_secs = Self::SAFE_LAG_SECS,
            step = %step,
            max_data_points = max_data_points.unwrap_or(0),
            "vm_repository.scope_timeseries.start"
        );

        let series = self.range_query(&query_prom, start, end, &step).await?;
        // 数量曲线暂不区分“无事件”和“采样缺失”，网格空点按 0 展示，避免曲线断裂。
        let fill_value = matches!(&metric_mode, TimeSeriesMetricMode::Count).then_some(0.0);
        let mut out = Vec::with_capacity(series.len());
        for s in series {
            let node_id = node_id_builder(&s.metric);
            let points = align_points_to_grid(
                start,
                end,
                step_secs,
                Self::vm_points_to_time_points(&s.values),
                fill_value,
            );
            let (log_rate_eps, log_count) = match metric_mode {
                TimeSeriesMetricMode::Rate => (points, Vec::new()),
                TimeSeriesMetricMode::Count => (Vec::new(), points),
            };
            out.push(NodeTimeSeries {
                node_id,
                log_rate_eps,
                log_count,
                step_secs,
                rate_window_secs,
            });
        }
        Ok(out)
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
        filters: Option<Vec<PackageFilter>>,
    ) -> Result<VmSnapshotData, AppError> {
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
            r#"sum by (source_type, source_name) ({})"#,
            Self::counter_increase_expr("wparse_receive_data", &window)
        );

        let parse_count_q = if let Some(filters) = filters {
            let subqueries: Vec<String> = filters
                .iter()
                .map(|f| {
                    let rule_regex = if f.rule_names.is_empty() {
                        ".*".to_string()
                    } else {
                        f.rule_names
                            .iter()
                            .map(|r| escape_regex_chars(r))
                            .collect::<Vec<_>>()
                            .join("|")
                    };
                    let selector = format!(
                        r#"wparse_parse_all{{package_name="{}", rule_name=~"^{}$"}}"#,
                        f.package_name, rule_regex
                    );
                    format!(
                        r#"sum by (package_name, rule_name) ({})"#,
                        Self::counter_increase_expr(&selector, &window)
                    )
                })
                .collect();
            if subqueries.is_empty() {
                format!(
                    r#"sum by (package_name, rule_name) ({})"#,
                    Self::counter_increase_expr("wparse_parse_all", &window)
                )
            } else {
                subqueries.join(" or ")
            }
        } else {
            format!(
                r#"sum by (package_name, rule_name) ({})"#,
                Self::counter_increase_expr("wparse_parse_all", &window)
            )
        };

        let sink_group_count_q = format!(
            r#"sum by (sink_group) ({})"#,
            Self::counter_increase_expr(
                r#"wparse_send_to_sink{sink_group!~"monitor|default|miss|residue|error"}"#,
                &window,
            )
        );
        let sink_count_q = format!(
            r#"sum by (sink_group, sink_name) ({})"#,
            Self::counter_increase_expr(
                r#"wparse_send_to_sink{sink_group!~"monitor|default|miss|residue|error"}"#,
                &window,
            )
        );

        let (source_count, parse_count, sink_group_count, sink_count) = tokio::try_join!(
            self.instant_query(&source_count_q, at_end),
            self.instant_query(&parse_count_q, at_end),
            self.instant_query(&sink_group_count_q, at_end),
            self.instant_query(&sink_count_q, at_end),
        )?;

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
        )?;

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

    /// 查询单节点时间序列：
    /// 1. 根据 node_id 解析节点类型和标签；
    /// 2. 直接使用 rate() 进行区间查询，返回每秒速率；
    /// 3. 统一做非负兜底，避免极端边界出现负值噪声。
    async fn fetch_node_timeseries(
        &self,
        node_id: &str,
        query: &TimeRangeQuery,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<NodeTimeSeries, AppError> {
        let (step, rate_window, step_secs, resolved_max_points) =
            if let Some(points) = max_data_points {
                let (step, rate_window, step_secs) =
                    Self::auto_step_for_timeseries(query, Some(points));
                (step, rate_window, step_secs, points)
            } else {
                Self::detail_step_for_timeseries(query)
            };
        let rate_window_secs = rate_window
            .trim_end_matches('s')
            .parse::<i64>()
            .unwrap_or(0);

        let Some((start, end)) = Self::effective_query_range(query) else {
            debug!(
                node_id = node_id,
                start_time = %query.start_time,
                end_time = %query.end_time,
                safe_lag_secs = Self::SAFE_LAG_SECS,
                "vm_repository.node_timeseries.empty_due_to_realtime_boundary"
            );
            return Ok(NodeTimeSeries {
                node_id: node_id.to_string(),
                log_rate_eps: Vec::new(),
                log_count: Vec::new(),
                step_secs,
                rate_window_secs,
            });
        };
        debug!(
            node_id = node_id,
            start_time = %query.start_time,
            end_time = %query.end_time,
            effective_end_unix = end,
            safe_lag_secs = Self::SAFE_LAG_SECS,
            step = %step,
            max_data_points = resolved_max_points,
            "vm_repository.node_timeseries.start"
        );
        let (kind, parts) = Self::parse_node_id(node_id);

        let range_secs = (end - start).max(1);
        let use_bucket_aggregation = range_secs >= 48 * 3600;
        // 未识别节点类型时返回 0 序列，保证接口语义稳定且不报错。
        // 同时查询两条序列：
        // 1) 平均线：按动态窗口 rate；
        // 2) 数量线：按 step 粒度统计当前桶内的增量数量。
        let selector = match kind {
            "source" if parts.len() >= 2 => {
                let source_type = parts[0];
                let source_name = parts[1];
                let source_type = Self::escape_promql_string(source_type);
                let source_name = Self::escape_promql_string(source_name);
                Some(format!(
                    r#"wparse_receive_data{{source_type="{}",source_name="{}"}}"#,
                    source_type, source_name
                ))
            }
            "log" if parts.len() >= 2 => {
                let package = parts[0];
                let rule = parts[1];
                let package = Self::escape_promql_string(package);
                let rule = Self::escape_promql_string(rule);
                Some(format!(
                    r#"wparse_parse_all{{package_name="{}",rule_name="{}"}}"#,
                    package, rule
                ))
            }
            "group" if !parts.is_empty() => {
                let g = parts[0];
                let g = Self::escape_promql_string(g);
                Some(format!(
                    r#"wparse_send_to_sink{{sink_group="{}",sink_group!~"monitor|default|miss|residue|error"}}"#,
                    g
                ))
            }
            "sink" if parts.len() >= 2 => {
                let g = parts[0];
                let s = parts[1];
                let g = Self::escape_promql_string(g);
                let s = Self::escape_promql_string(s);
                Some(format!(
                    r#"wparse_send_to_sink{{sink_group="{}",sink_name="{}",sink_group!~"monitor|default|miss|residue|error"}}"#,
                    g, s
                ))
            }
            _ => None,
        };
        if selector.is_none() {
            warn!(
                node_id = node_id,
                "vm_repository.node_timeseries.unknown_node"
            );
        }
        let avg_rate_base_q = selector.as_ref().map_or_else(
            || "vector(0)".to_string(),
            |selector| {
                Self::guard_timeseries_expr(
                    format!(
                        r#"sum({})/{}"#,
                        Self::counter_increase_expr(selector, &rate_window),
                        rate_window_secs
                    ),
                    selector,
                    &rate_window,
                    &[],
                )
            },
        );
        let count_q = selector.as_ref().map_or_else(
            || "vector(0)".to_string(),
            |selector| {
                Self::guard_timeseries_expr(
                    format!(r#"sum({})"#, Self::counter_increase_expr(selector, &step)),
                    selector,
                    &step,
                    &[],
                )
            },
        );
        let rate_q = if use_bucket_aggregation {
            format!(
                "avg_over_time(({})[{}:{}s])",
                avg_rate_base_q,
                step.as_str(),
                30
            )
        } else {
            avg_rate_base_q.clone()
        };
        let query_prom = match metric_mode {
            TimeSeriesMetricMode::Rate => rate_q,
            TimeSeriesMetricMode::Count => count_q,
        };
        let series = self.range_query(&query_prom, start, end, &step).await?;
        // 数量曲线暂不区分“无事件”和“采样缺失”，网格空点按 0 展示，避免曲线断裂。
        let fill_value = matches!(&metric_mode, TimeSeriesMetricMode::Count).then_some(0.0);
        let points = align_points_to_grid(
            start,
            end,
            step_secs,
            Self::series_to_points(&series),
            fill_value,
        );

        debug!(
            node_id = node_id,
            metric_mode = ?metric_mode,
            points = points.len(),
            "vm_repository.node_timeseries.success"
        );

        let (log_rate_eps, log_count) = match metric_mode {
            TimeSeriesMetricMode::Rate => (points, Vec::new()),
            TimeSeriesMetricMode::Count => (Vec::new(), points),
        };

        Ok(NodeTimeSeries {
            node_id: node_id.to_string(),
            log_rate_eps,
            log_count,
            step_secs,
            rate_window_secs,
        })
    }

    /**
     * 获取多个节点的时序数据。
     */
    async fn fetch_parse_timeseries(
        &self,
        query: &TimeRangeQuery,
        package_name: &str,
        rule_names: &str,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        let (step, rate_window, _) = Self::auto_step_for_timeseries(query, max_data_points);
        let rate_window_secs = rate_window
            .trim_end_matches('s')
            .parse::<i64>()
            .unwrap_or(0);
        let package_selector = if package_name == ".*" {
            ".*".to_string()
        } else {
            format!("^{}$", escape_pipe_separated(package_name))
        };
        let rule_selector = if rule_names == ".*" {
            ".*".to_string()
        } else {
            format!("^{}$", escape_pipe_separated(rule_names))
        };
        let base_selector = format!(
            r#"wparse_parse_all{{package_name=~"{}",rule_name=~"{}"}}"#,
            package_selector, rule_selector
        );
        let query_prom = match metric_mode {
            TimeSeriesMetricMode::Rate => Self::guard_timeseries_expr(
                format!(
                    r#"(sum by (package_name, rule_name) ({}))/{}"#,
                    Self::counter_increase_expr(&base_selector, &rate_window),
                    rate_window_secs
                ),
                &base_selector,
                &rate_window,
                &["package_name", "rule_name"],
            ),
            TimeSeriesMetricMode::Count => Self::guard_timeseries_expr(
                format!(
                    r#"sum by (package_name, rule_name) ({})"#,
                    Self::counter_increase_expr(&base_selector, &step),
                ),
                &base_selector,
                &step,
                &["package_name", "rule_name"],
            ),
        };
        self.fetch_scope_timeseries_internal(
            query,
            max_data_points,
            query_prom,
            metric_mode,
            |metric| {
                let package_name = metric
                    .get("package_name")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                let rule_name = metric
                    .get("rule_name")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                format!("{}:{}", package_name, rule_name)
            },
        )
        .await
    }

    /**
     * 获取多个节点的时序数据。package层
     */
    async fn fetch_packages_timeseries(
        &self,
        query: &TimeRangeQuery,
        filters: &[(String, String)],
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        if filters.is_empty() {
            return Ok(Vec::new());
        }
        let (step, rate_window, _) = Self::auto_step_for_timeseries(query, max_data_points);
        let rate_window_secs = rate_window
            .trim_end_matches('s')
            .parse::<i64>()
            .unwrap_or(0);

        // 每个 filter 构建独立的 sum by (package_name) 子查询，用 or 连接，
        // 避免 package_name 和 rule_name 正则跨 package 误匹配。
        let subqueries: Vec<String> = filters
            .iter()
            .map(|(pkg_regex, rule_regex)| {
                let escaped_pkg = escape_regex_chars(pkg_regex);
                let escaped_rule = escape_pipe_separated(rule_regex);
                let selector = format!(
                    r#"wparse_parse_all{{package_name=~"^{}$",rule_name=~"^{}$"}}"#,
                    escaped_pkg, escaped_rule
                );
                match metric_mode {
                    TimeSeriesMetricMode::Rate => Self::guard_timeseries_expr(
                        format!(
                            r#"(sum by (package_name) ({}))/{}"#,
                            Self::counter_increase_expr(&selector, &rate_window),
                            rate_window_secs
                        ),
                        &selector,
                        &rate_window,
                        &["package_name"],
                    ),
                    TimeSeriesMetricMode::Count => Self::guard_timeseries_expr(
                        format!(
                            r#"sum by (package_name) ({})"#,
                            Self::counter_increase_expr(&selector, &step)
                        ),
                        &selector,
                        &step,
                        &["package_name"],
                    ),
                }
            })
            .collect();

        let query_prom = subqueries.join(" or ");
        self.fetch_scope_timeseries_internal(
            query,
            max_data_points,
            query_prom,
            metric_mode,
            |metric| {
                metric
                    .get("package_name")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string())
            },
        )
        .await
    }

    async fn fetch_source_timeseries(
        &self,
        query: &TimeRangeQuery,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        let (step, rate_window, _) = Self::auto_step_for_timeseries(query, max_data_points);
        let rate_window_secs = rate_window
            .trim_end_matches('s')
            .parse::<i64>()
            .unwrap_or(0);
        let query_prom = match metric_mode {
            TimeSeriesMetricMode::Rate => Self::guard_timeseries_expr(
                format!(
                    r#"(sum by (source_type, source_name) ({}))/{}"#,
                    Self::counter_increase_expr("wparse_receive_data", &rate_window),
                    rate_window_secs
                ),
                "wparse_receive_data",
                &rate_window,
                &["source_type", "source_name"],
            ),
            TimeSeriesMetricMode::Count => Self::guard_timeseries_expr(
                format!(
                    r#"sum by (source_type, source_name) ({})"#,
                    Self::counter_increase_expr("wparse_receive_data", &step)
                ),
                "wparse_receive_data",
                &step,
                &["source_type", "source_name"],
            ),
        };
        self.fetch_scope_timeseries_internal(
            query,
            max_data_points,
            query_prom,
            metric_mode,
            |metric| {
                let source_type = metric
                    .get("source_type")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                let source_name = metric
                    .get("source_name")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                format!("source:{}:{}", source_type, source_name)
            },
        )
        .await
    }

    async fn fetch_sink_timeseries(
        &self,
        query: &TimeRangeQuery,
        sink_group: Option<&str>,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        let (step, rate_window, _) = Self::auto_step_for_timeseries(query, max_data_points);
        let rate_window_secs = rate_window
            .trim_end_matches('s')
            .parse::<i64>()
            .unwrap_or(0);
        let group_selector = sink_group
            .map(|g| format!(r#",sink_group=~"^{}$""#, escape_regex_chars(g)))
            .unwrap_or_default();
        let selector = format!(
            r#"wparse_send_to_sink{{sink_group!~"monitor|default|miss|residue|error"{} }}"#,
            group_selector
        );
        let query_prom = match metric_mode {
            TimeSeriesMetricMode::Rate => Self::guard_timeseries_expr(
                format!(
                    r#"(sum by (sink_group, sink_name) ({}))/{}"#,
                    Self::counter_increase_expr(&selector, &rate_window),
                    rate_window_secs
                ),
                &selector,
                &rate_window,
                &["sink_group", "sink_name"],
            ),
            TimeSeriesMetricMode::Count => Self::guard_timeseries_expr(
                format!(
                    r#"sum by (sink_group, sink_name) ({})"#,
                    Self::counter_increase_expr(&selector, &step)
                ),
                &selector,
                &step,
                &["sink_group", "sink_name"],
            ),
        };
        self.fetch_scope_timeseries_internal(
            query,
            max_data_points,
            query_prom,
            metric_mode,
            |metric| {
                let group = metric
                    .get("sink_group")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                let sink = metric
                    .get("sink_name")
                    .cloned()
                    .unwrap_or_else(|| "unknown".to_string());
                format!("sink:{}:{}", group, sink)
            },
        )
        .await
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
    value: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::{VmHttpRepository, VmPoint, VmRangeSeries};
    use std::collections::HashMap;

    #[test]
    fn parse_optional_value_keeps_invalid_range_values_as_none() {
        assert_eq!(
            VmHttpRepository::parse_optional_value("12.345"),
            Some(12.35)
        );
        assert_eq!(VmHttpRepository::parse_optional_value("NaN"), None);
        assert_eq!(VmHttpRepository::parse_optional_value("+Inf"), None);
        assert_eq!(VmHttpRepository::parse_optional_value("bad-value"), None);
    }

    #[test]
    fn vm_points_to_time_points_preserves_nulls_for_invalid_values() {
        let points = VmHttpRepository::vm_points_to_time_points(&[
            VmPoint {
                ts: 1782872640.0,
                value: Some(400.0),
            },
            VmPoint {
                ts: 1782872800.0,
                value: None,
            },
        ]);

        assert_eq!(points.len(), 2);
        assert_eq!(points[0].value, Some(400.0));
        assert_eq!(points[1].value, None);
    }

    #[test]
    fn series_to_points_preserves_nulls_for_invalid_values() {
        let series = vec![VmRangeSeries {
            metric: HashMap::new(),
            values: vec![
                VmPoint {
                    ts: 1782872640.0,
                    value: Some(400.0),
                },
                VmPoint {
                    ts: 1782872800.0,
                    value: None,
                },
            ],
        }];

        let points = VmHttpRepository::series_to_points(&series);
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].value, Some(400.0));
        assert_eq!(points[1].value, None);
    }

    /// 验证低步长速率查询使用平滑窗口，同时保持原有图表步长。
    #[test]
    fn rate_window_secs_for_step_smooths_short_intervals() {
        assert_eq!(VmHttpRepository::rate_window_secs_for_step(0), 3);
        assert_eq!(VmHttpRepository::rate_window_secs_for_step(1), 3);
        assert_eq!(VmHttpRepository::rate_window_secs_for_step(2), 4);
        assert_eq!(VmHttpRepository::rate_window_secs_for_step(5), 5);
        assert_eq!(VmHttpRepository::rate_window_secs_for_step(60), 60);
    }
}
