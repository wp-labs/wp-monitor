use super::vm_utils::{align_points_to_grid, ts_to_rfc3339};
use crate::domain::model::{NodeTimeSeries, TimePoint, TimeRangeQuery};
use crate::domain::wf_repository::{
    WfPipelineReceiver, WfPipelineResponse, WfPipelineRule, WfPipelineWindow, WfRepository,
    WfRuleItem, WfRuleMachineItem, WfSourceItem, WfSourceMachineItem, WfStateMachineItem,
    WfTimeseriesQuery, WfWindowItem, WfWindowMetric,
};
use crate::shared::error::{AppError, AppReason};
use async_trait::async_trait;
use chrono::Utc;
use orion_error::{OperationContext, conversion::ToStructError, prelude::*};
use reqwest::Client;
use serde::Deserialize;
use std::collections::HashMap;
use tracing::debug;

/// VictoriaMetrics HTTP 仓储，负责 wfusion 引擎指标的 PromQL 查询。
pub struct WfVmRepository {
    client: Client,
    base_url: String,
}

// ── VM API 响应类型 ──

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

struct VmSeriesValue {
    metric: HashMap<String, String>,
    value: f64,
    ts: f64, // Unix timestamp of the sample, used for dedup
}
struct VmRangeSeries {
    metric: HashMap<String, String>,
    values: Vec<(i64, f64)>,
}

// ── 实现 ──

impl WfVmRepository {
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    fn parse_value(v: &str) -> f64 {
        v.parse::<f64>().unwrap_or(0.0)
    }

    fn effective_query_range(query: &TimeRangeQuery) -> Option<(i64, i64)> {
        let start = query.start_time.timestamp();
        let end = query.end_time.timestamp();
        (start < end).then_some((start, end))
    }

    /// 子查询失败时 log warn 并降级为空列表，保证部分数据正常展示。
    async fn guard(
        res: impl std::future::Future<Output = Result<Vec<VmSeriesValue>, AppError>>,
    ) -> Vec<VmSeriesValue> {
        res.await.unwrap_or_else(|e| {
            tracing::error!(error = %e, "wf sub-query failed, using default");
            Vec::new()
        })
    }

    fn query_window(start: i64, end: i64) -> String {
        format!("{}s", (end - start).max(1))
    }

    fn auto_step(query: &TimeRangeQuery, max_data_points: Option<usize>) -> (String, String, i64) {
        let total_secs = (query.end_time.timestamp() - query.start_time.timestamp()).max(1);
        let target = max_data_points.unwrap_or(480).clamp(60, 2000) as i64;
        let raw = ((total_secs + target - 1) / target).max(1);
        let step = Self::nice_step(raw);
        let rate_window = step.max(1);
        (format!("{}s", step), format!("{}s", rate_window), step)
    }

    fn nice_step(raw: i64) -> i64 {
        let raw = (raw.max(1)) as f64;
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

    fn count_series(series: &[VmSeriesValue]) -> u32 {
        series.len() as u32
    }

    fn pick_metric_value(series: &[VmSeriesValue]) -> f64 {
        series.first().map(|s| s.value).unwrap_or(0.0)
    }

    /// 按 window_name 分组，每组取时间戳最新的那条的 value。
    fn pick_latest_by_window_name(series: &[VmSeriesValue]) -> HashMap<&str, f64> {
        let mut map: HashMap<&str, (f64, f64)> = HashMap::new();
        for s in series {
            let name = match s.metric.get("window_name") {
                Some(n) => n.as_str(),
                None => continue,
            };
            let entry = map.entry(name).or_default();
            if s.ts > entry.0 {
                *entry = (s.ts, s.value);
            }
        }
        map.into_iter().map(|(k, (_, v))| (k, v)).collect()
    }

    fn range_to_time_points(values: &[(i64, f64)]) -> Vec<TimePoint> {
        values
            .iter()
            .map(|(ts, val)| TimePoint {
                ts: ts_to_rfc3339(*ts),
                value: Some(val.max(0.0)),
            })
            .collect()
    }

    // ── VM API ──

    async fn instant_query(
        &self,
        promql: &str,
        at_unix: i64,
    ) -> Result<Vec<VmSeriesValue>, AppError> {
        let url = format!("{}/api/v1/query", self.base_url);
        let ctx = OperationContext::doing("wf_instant_query")
            .with_field("url", url.clone())
            .with_field("promql", promql.to_string());
        let resp = self
            .client
            .get(&url)
            .query(&[("query", promql), ("time", &at_unix.to_string())])
            .send()
            .await
            .source_raw_err(AppReason::VmRequestFailed, "wf vm instant query failed")
            .with_context(&ctx)?;
        let resp_body = resp
            .text()
            .await
            .source_raw_err(
                AppReason::VmResponseInvalid,
                "read wf vm instant query response body failed",
            )
            .with_context(&ctx)?;
        let data: VmQueryResp = serde_json::from_str(&resp_body).source_raw_err(
            AppReason::VmResponseInvalid,
            format!(
                "parse wf vm instant query response failed, body: {}",
                &resp_body[..resp_body.len().min(500)]
            ),
        )?;
        debug!(
            result_size = data.data.result.len(),
            "wf_repository.instant_query.success"
        );
        Ok(data
            .data
            .result
            .into_iter()
            .map(|item| VmSeriesValue {
                metric: item.metric,
                value: Self::parse_value(item.value[1].as_str().unwrap_or("0")),
                ts: item.value[0].as_f64().unwrap_or(0.0),
            })
            .collect())
    }

    async fn range_query(
        &self,
        promql: &str,
        start_unix: i64,
        end_unix: i64,
        step: &str,
    ) -> Result<Vec<VmRangeSeries>, AppError> {
        let url = format!("{}/api/v1/query_range", self.base_url);
        let ctx = OperationContext::doing("wf_range_query")
            .with_field("url", url.clone())
            .with_field("promql", promql.to_string());
        let resp = self
            .client
            .get(&url)
            .query(&[
                ("query", promql),
                ("start", &start_unix.to_string()),
                ("end", &end_unix.to_string()),
                ("step", step),
            ])
            .send()
            .await
            .source_raw_err(AppReason::VmRequestFailed, "wf vm range query failed")
            .with_context(&ctx)?;
        let resp_body = resp
            .text()
            .await
            .source_raw_err(
                AppReason::VmResponseInvalid,
                "read wf vm range query response body failed",
            )
            .with_context(&ctx)?;
        let data: VmRangeResp = serde_json::from_str(&resp_body).source_raw_err(
            AppReason::VmResponseInvalid,
            format!(
                "parse wf vm range query response failed, body: {}",
                &resp_body[..resp_body.len().min(500)]
            ),
        )?;
        debug!(
            series_size = data.data.result.len(),
            "wf_repository.range_query.success"
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
                    .map(|v| {
                        (
                            v[0].as_f64().unwrap_or(0.0) as i64,
                            Self::parse_value(v[1].as_str().unwrap_or("0")),
                        )
                    })
                    .collect(),
            })
            .collect())
    }
}

// ── WfRepository trait 实现 ──
//
// 以下方法将领域查询映射为 PromQL，通过 VictoriaMetrics HTTP API 执行。
// instant_query 用于快照数据（/api/v1/query），range_query 用于时序数据（/api/v1/query_range）。

#[async_trait]
impl WfRepository for WfVmRepository {
    // ── 流水线概览 ──

    /// 14 条 PromQL 并发查询，覆盖接收/窗口/规则三阶段聚合指标与实体计数。
    async fn fetch_pipeline(&self, query: &TimeRangeQuery) -> Result<WfPipelineResponse, AppError> {
        let (start, end) = Self::effective_query_range(query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let w = Self::query_window(start, end);
        let at = end;

        // ── 数据接入卡片（Receiver）──
        let q_receive = format!(
            "sum(increase(wf_receive_total{{source_name!=\"\"}}[{}]))",
            w
        ); // 接收行数（条）
        let q_rate = format!("sum(rate(wf_receive_total{{source_name!=\"\"}}[{}]))", w); // 速率（行/秒），窗口越大值越平滑
        let q_route_errs = format!("sum(increase(wf_route_errors_total[{}]))", w); // 路由错误（次），>0 时前端标黄
        let q_src_count =
            "count by(source_name) (max by(source_name) (wf_receive_total{source_name!=\"\"}))"
                .to_string(); // 活跃来源数，副标题「N 个来源」

        // ── 数据窗口卡片（Window）──
        let q_win_rows = "sum(wf_window_rows_total{window_name!=\"\"})".to_string(); // 数据量（条）
        let q_win_mem = "sum(wf_window_memory_bytes{window_name!=\"\"})".to_string(); // 内存占用（fmtBytes 展示）
        let q_win_late = format!(
            "sum(increase(wf_window_late_total{{window_name!=\"\"}}[{}]))",
            w
        ); // 迟到丢弃（条），>0 时前端标黄
        let q_win_count =
            "count by(window_name) (max by(window_name) (wf_window_rows_total{window_name!=\"\"}))"
                .to_string(); // 窗口数量，副标题「N 个窗口」

        // ── 规则检测与输出卡片（Rule）──
        let q_hit_rate = format!(
            "sum(rate(wf_rule_matches_total{{rule_name!=\"\"}}[{}])) / sum(rate(wf_rule_events_total{{rule_name!=\"\"}}[{}]))",
            w, w
        ); // 命中率（N.N%），副标题展示
        let q_instances = "sum(wf_rule_instances_total{rule_name!=\"\"})".to_string(); // 状态机实例（个）
        let q_emitted = format!(
            "sum(increase(wf_alert_emitted_total{{alert_name!=\"\"}}[{}]))",
            w
        ); // 产出告警（条）
        let q_dispatch = format!("sum(increase(wf_alert_dispatch_failed_total[{}]))", w); // 下发失败（次），>0 时前端标红
        let q_e2e = "wf_event_e2e_latency_second_p99".to_string(); // P99 端到端延迟（当前前端未展示）
        let q_rule_count =
            "count by(rule_name) (max by(rule_name) (wf_rule_instances_total{rule_name!=\"\"}))"
                .to_string(); // 规则数量，副标题「N 条规则」

        let (
            receive_rows,
            rate_rows,
            route_errs,
            win_rows,
            win_mem,
            win_late,
            hit_rate,
            instances,
            emitted,
            dispatch_failed,
            e2e,
            src_count,
            win_count,
            rule_count,
        ) = tokio::join!(
            Self::guard(self.instant_query(&q_receive, at)),
            Self::guard(self.instant_query(&q_rate, at)),
            Self::guard(self.instant_query(&q_route_errs, at)),
            Self::guard(self.instant_query(&q_win_rows, at)),
            Self::guard(self.instant_query(&q_win_mem, at)),
            Self::guard(self.instant_query(&q_win_late, at)),
            Self::guard(self.instant_query(&q_hit_rate, at)),
            Self::guard(self.instant_query(&q_instances, at)),
            Self::guard(self.instant_query(&q_emitted, at)),
            Self::guard(self.instant_query(&q_dispatch, at)),
            Self::guard(self.instant_query(&q_e2e, at)),
            Self::guard(self.instant_query(&q_src_count, at)),
            Self::guard(self.instant_query(&q_win_count, at)),
            Self::guard(self.instant_query(&q_rule_count, at)),
        );

        Ok(WfPipelineResponse {
            generated_at: Utc::now().to_rfc3339(),
            receiver: WfPipelineReceiver {
                total_rows: Self::pick_metric_value(&receive_rows),
                rate_rows_per_sec: (Self::pick_metric_value(&rate_rows) * 100.0).round() / 100.0,
                route_errors: Self::pick_metric_value(&route_errs),
                source_count: Self::count_series(&src_count),
            },
            window: WfPipelineWindow {
                window_count: Self::count_series(&win_count),
                total_rows: Self::pick_metric_value(&win_rows),
                total_memory_bytes: Self::pick_metric_value(&win_mem),
                late_dropped: Self::pick_metric_value(&win_late),
            },
            rule: WfPipelineRule {
                rule_count: Self::count_series(&rule_count),
                total_state_machines: Self::pick_metric_value(&instances),
                hit_rate_pct: (Self::pick_metric_value(&hit_rate) * 10000.0).round() / 100.0,
                total_emitted: Self::pick_metric_value(&emitted),
                send_failed: Self::pick_metric_value(&dispatch_failed),
                e2e_p99_ms: (Self::pick_metric_value(&e2e) * 1000.0 * 100.0).round() / 100.0,
            },
        })
    }

    // ── 来源详情 ──

    /// 按 `source_name` + `source_type` 分组查询，附带各 source 的 `machine_name` 列表。
    async fn fetch_sources(&self, query: &TimeRangeQuery) -> Result<Vec<WfSourceItem>, AppError> {
        let (start, end) = Self::effective_query_range(query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let w = Self::query_window(start, end);
        let at = end;

        let q_rows = format!(
            "sum by (source_name, source_type) (increase(wf_receive_total{{source_name!=\"\"}}[{}]))",
            w
        );
        let q_errs = format!(
            "sum by (source_name) (increase(wf_route_errors_total{{source_name!=\"\"}}[{}]))",
            w
        );
        let q_lag = format!(
            "max_over_time(sum by (source_name) (kafka_consumer_lag{{source_name!=\"\"}})[{}])",
            w
        );
        let (rows_series, errs_series, lag_series) = tokio::join!(
            Self::guard(self.instant_query(&q_rows, at)),
            Self::guard(self.instant_query(&q_errs, at)),
            Self::guard(self.instant_query(&q_lag, at)),
        );

        let err_map: HashMap<&str, f64> = errs_series
            .iter()
            .filter_map(|s| Some((s.metric.get("source_name")?.as_str(), s.value)))
            .collect();

        let lag_map: HashMap<&str, f64> = lag_series
            .iter()
            .filter_map(|s| Some((s.metric.get("source_name")?.as_str(), s.value)))
            .collect();

        let items: Vec<WfSourceItem> = rows_series
            .iter()
            .map(|s| WfSourceItem {
                name: s.metric.get("source_name").cloned().unwrap_or_default(),
                source_type: s.metric.get("source_type").cloned().unwrap_or_default(),
                rows: s.value,
                route_errors: err_map
                    .get(
                        s.metric
                            .get("source_name")
                            .map(|v| v.as_str())
                            .unwrap_or(""),
                    )
                    .copied()
                    .unwrap_or(0.0),
                consumer_lag: lag_map
                    .get(
                        s.metric
                            .get("source_name")
                            .map(|v| v.as_str())
                            .unwrap_or(""),
                    )
                    .copied()
                    .unwrap_or(0.0),
                machines: vec![],
            })
            .collect();

        Ok(items)
    }

    // ── 设备维度 ──

    /// 按 `machine_name` 分组统计来源数据，自动从 label 枚举得到 per-machine source 计数。
    async fn fetch_source_machines(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<Vec<WfSourceMachineItem>, AppError> {
        let (start, end) = Self::effective_query_range(query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let w = Self::query_window(start, end);
        let at = end;

        let q_rows = format!(
            "sum by (machine_name) (increase(wf_receive_total{{source_name!=\"\",machine_name!=\"\"}}[{}]))",
            w
        );
        let q_counts = format!(
            "count by (machine_name) (count by (source_name, machine_name) (increase(wf_receive_total{{source_name!=\"\",machine_name!=\"\"}}[{}])))",
            w
        );
        let (rows, counts) = tokio::join!(
            Self::guard(self.instant_query(&q_rows, at)),
            Self::guard(self.instant_query(&q_counts, at)),
        );

        let count_map: HashMap<&str, u32> = counts
            .iter()
            .filter_map(|s| Some((s.metric.get("machine_name")?.as_str(), s.value as u32)))
            .collect();

        Ok(rows
            .iter()
            .filter_map(|s| {
                let machine = s.metric.get("machine_name")?.clone();
                Some(WfSourceMachineItem {
                    source_count: count_map.get(machine.as_str()).copied().unwrap_or(0),
                    machine,
                    rows: s.value,
                    route_errors: 0.0,
                })
            })
            .collect())
    }

    // ── 窗口详情 ──

    /// 四条查询分别获取 rows / memory / capacity / late，按 `window_name` 分组。
    async fn fetch_windows(&self, query: &TimeRangeQuery) -> Result<Vec<WfWindowItem>, AppError> {
        let (start, end) = Self::effective_query_range(query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let w = Self::query_window(start, end);
        let at = end;

        // 用 last_over_time 取全窗口内的最后值，不聚合，由代码按时间戳去重
        let q_rows = format!("last_over_time(wf_window_rows_total{{window_name!=\"\"}}[{w}])");
        let q_mem = format!("last_over_time(wf_window_memory_bytes{{window_name!=\"\"}}[{w}])");
        let q_cap =
            format!("last_over_time(wf_window_memory_capacity_bytes{{window_name!=\"\"}}[{w}])");
        let q_late = format!(
            "sum by (window_name) (increase(wf_window_late_total{{window_name!=\"\"}}[{}]))",
            w
        );
        let (rows, mem, cap, late) = tokio::join!(
            Self::guard(self.instant_query(&q_rows, at)),
            Self::guard(self.instant_query(&q_mem, at)),
            Self::guard(self.instant_query(&q_cap, at)),
            Self::guard(self.instant_query(&q_late, at)),
        );

        // 按 window_name 分组，取时间戳最新的值，去除重启产生的 stale 时间序列
        let rows_map = Self::pick_latest_by_window_name(&rows);
        let mem_map = Self::pick_latest_by_window_name(&mem);
        let cap_map = Self::pick_latest_by_window_name(&cap);
        let late_map: HashMap<&str, f64> = late
            .iter()
            .filter_map(|s| Some((s.metric.get("window_name")?.as_str(), s.value)))
            .collect();

        // 以 rows 窗口名称为基准（counter 最全），合并其余指标
        Ok(rows_map
            .into_iter()
            .map(|(name, rows_val)| WfWindowItem {
                memory_bytes: mem_map.get(name).copied().unwrap_or(0.0),
                capacity_bytes: cap_map.get(name).copied().unwrap_or(0.0),
                late_dropped: late_map.get(name).copied().unwrap_or(0.0),
                rows: rows_val,
                name: name.to_string(),
            })
            .collect())
    }

    // ── 告警详情 ──

    /// 告警产出（counter）、状态机实例数（gauge）、scope_key 分布，一次返回保证数据对齐。
    async fn fetch_rules(&self, query: &TimeRangeQuery) -> Result<Vec<WfRuleItem>, AppError> {
        let (start, end) = Self::effective_query_range(query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let w = Self::query_window(start, end);
        let at = end;

        let q_matched = format!(
            "sum by (rule_name) (increase(wf_rule_matches_total{{rule_name!=\"\"}}[{}]))",
            w
        );

        let q_emitted = format!(
            "sum by (alert_name) (increase(wf_alert_emitted_total{{alert_name!=\"\"}}[{}]))",
            w
        );
        let q_instances =
            "sum by (rule_name) (wf_rule_instances_total{rule_name!=\"\"})".to_string();
        let q_scopes = format!(
            "sum by (alert_name, scope_key) (increase(wf_alert_emitted_total{{alert_name!=\"\",scope_key!=\"-\"}}[{}]))",
            w
        );
        let (matched, emitted, instances, scopes) = tokio::join!(
            Self::guard(self.instant_query(&q_matched, at)),
            Self::guard(self.instant_query(&q_emitted, at)),
            Self::guard(self.instant_query(&q_instances, at)),
            Self::guard(self.instant_query(&q_scopes, at)),
        );

        let matched_map: HashMap<&str, f64> = matched
            .iter()
            .filter_map(|f| Some((f.metric.get("rule_name")?.as_str(), f.value)))
            .collect();

        let inst_map: HashMap<&str, f64> = instances
            .iter()
            .filter_map(|s| Some((s.metric.get("rule_name")?.as_str(), s.value)))
            .collect();

        // 将 scope_key 数据按 alert_name 分组
        let mut scopes_map: HashMap<&str, Vec<WfStateMachineItem>> = HashMap::new();
        for s in &scopes {
            let alert_name = match s.metric.get("alert_name") {
                Some(n) => n.as_str(),
                None => continue,
            };
            let scope_key = match s.metric.get("scope_key") {
                Some(k) => k.clone(),
                None => continue,
            };
            scopes_map
                .entry(alert_name)
                .or_default()
                .push(WfStateMachineItem {
                    scope_key,
                    emitted: s.value,
                });
        }

        Ok(emitted
            .iter()
            .filter_map(|s| {
                let name = s.metric.get("alert_name")?.clone();
                Some(WfRuleItem {
                    matched: matched_map.get(name.as_str()).copied().unwrap_or(0.0),
                    instances: inst_map.get(name.as_str()).copied().unwrap_or(0.0),
                    emitted: s.value,
                    state_machines: scopes_map.remove(name.as_str()).unwrap_or_default(),
                    name,
                })
            })
            .collect())
    }

    /// 状态机实例告警分布：`scope_key` 分组，用于 hover popover。
    async fn fetch_state_machines(
        &self,
        query: &TimeRangeQuery,
        rule_name: &str,
    ) -> Result<Vec<WfStateMachineItem>, AppError> {
        let (start, end) = Self::effective_query_range(query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let w = Self::query_window(start, end);
        let at = end;
        let q = format!(
            "sum by (scope_key) (increase(wf_alert_emitted_total{{alert_name=\"{rule_name}\",scope_key!=\"-\"}}[{w}]))"
        );
        let series = self.instant_query(&q, at).await?;
        Ok(series
            .iter()
            .filter_map(|s| {
                Some(WfStateMachineItem {
                    scope_key: s.metric.get("scope_key")?.clone(),
                    emitted: s.value,
                })
            })
            .collect())
    }

    /// 设备维度告警聚合：按 `machine_name` 分组。
    async fn fetch_rule_machines(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<Vec<WfRuleMachineItem>, AppError> {
        let (start, end) = Self::effective_query_range(query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let w = Self::query_window(start, end);
        let at = end;

        let q_emitted = format!(
            "sum by (machine_name) (increase(wf_alert_emitted_total{{alert_name!=\"\",machine_name!=\"\"}}[{}]))",
            w
        );
        let q_counts = format!(
            "count by (machine_name) (count by (alert_name, machine_name) (increase(wf_alert_emitted_total{{alert_name!=\"\",machine_name!=\"\"}}[{}])))",
            w
        );
        let (emitted, counts) = tokio::join!(
            Self::guard(self.instant_query(&q_emitted, at)),
            Self::guard(self.instant_query(&q_counts, at)),
        );

        let count_map: HashMap<&str, u32> = counts
            .iter()
            .filter_map(|s| Some((s.metric.get("machine_name")?.as_str(), s.value as u32)))
            .collect();

        Ok(emitted
            .iter()
            .filter_map(|s| {
                let machine = s.metric.get("machine_name")?.clone();
                Some(WfRuleMachineItem {
                    rule_count: count_map.get(machine.as_str()).copied().unwrap_or(0),
                    emitted: s.value,
                    machine,
                })
            })
            .collect())
    }

    // ── 时序数据 ──
    //
    // range_query 通过 `auto_step` 自适应计算步长，rate_window≥4×step 保证 PromQL rate() 不抖动。

    async fn fetch_timeseries_throughput(
        &self,
        ts: &WfTimeseriesQuery,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        let (start, end) = Self::effective_query_range(&ts.query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let (step, rate_window, step_secs) = Self::auto_step(&ts.query, ts.max_data_points);
        let by_labels = if ts.group_by == "machine" {
            "machine_name"
        } else {
            "source_name"
        };
        let promql = format!(
            "sum by ({by_labels}) (rate(wf_receive_total{{source_name!=\"\"}}[{rate_window}]))"
        );
        let series = self.range_query(&promql, start, end, &step).await?;
        Ok(series
            .iter()
            .map(|s| {
                let name = s
                    .metric
                    .get(by_labels)
                    .cloned()
                    .unwrap_or_else(|| "unknown".into());
                let raw = Self::range_to_time_points(&s.values);
                NodeTimeSeries {
                    node_id: name,
                    log_rate_eps: align_points_to_grid(start, end, step_secs, raw, None),
                    log_count: vec![],
                    step_secs,
                    rate_window_secs: rate_window.trim_end_matches('s').parse().unwrap_or(0),
                }
            })
            .collect())
    }

    async fn fetch_timeseries_windows(
        &self,
        ts: &WfTimeseriesQuery,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        let (start, end) = Self::effective_query_range(&ts.query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let (step, rate_window, step_secs) = Self::auto_step(&ts.query, ts.max_data_points);
        let metric = ts.metric.unwrap_or(WfWindowMetric::Rows);
        let promql = match metric {
            WfWindowMetric::Memory => {
                "sum by (window_name) (wf_window_memory_bytes{window_name!=\"\"})".to_string()
            }
            WfWindowMetric::Late => format!(
                "sum by (window_name) (rate(wf_window_late_total{{window_name!=\"\"}}[{rate_window}]))"
            ),
            WfWindowMetric::Rows => {
                "sum by (window_name) (wf_window_rows_total{window_name!=\"\"})".to_string()
            }
        };
        let series = self.range_query(&promql, start, end, &step).await?;
        Ok(series
            .iter()
            .map(|s| {
                let name = s
                    .metric
                    .get("window_name")
                    .cloned()
                    .unwrap_or_else(|| "unknown".into());
                let raw = Self::range_to_time_points(&s.values);
                NodeTimeSeries {
                    node_id: name,
                    log_rate_eps: align_points_to_grid(start, end, step_secs, raw, None),
                    log_count: vec![],
                    step_secs,
                    rate_window_secs: rate_window.trim_end_matches('s').parse().unwrap_or(0),
                }
            })
            .collect())
    }

    async fn fetch_timeseries_alerts(
        &self,
        ts: &WfTimeseriesQuery,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        let (start, end) = Self::effective_query_range(&ts.query).ok_or_else(|| {
            AppReason::InvalidTimeRange
                .to_err()
                .with_detail("invalid time range for wf query")
        })?;
        let (step, rate_window, step_secs) = Self::auto_step(&ts.query, ts.max_data_points);
        let by_labels = if ts.group_by == "machine" {
            "machine_name"
        } else {
            "alert_name"
        };
        // 用 increase / window_secs 手动算速率，替代 rate()，避免 VM 对稀疏 counter 返回全零
        let rw_secs: f64 = rate_window.trim_end_matches('s').parse().unwrap_or(1.0);
        let promql = format!(
            "sum by ({by_labels}) (increase(wf_alert_emitted_total{{alert_name!=\"\"}}[{rate_window}]) / {rw_secs})"
        );
        let series = self.range_query(&promql, start, end, &step).await?;
        Ok(series
            .iter()
            .map(|s| {
                let name = s
                    .metric
                    .get(by_labels)
                    .cloned()
                    .unwrap_or_else(|| "unknown".into());
                let raw = Self::range_to_time_points(&s.values);
                NodeTimeSeries {
                    node_id: name,
                    log_rate_eps: align_points_to_grid(start, end, step_secs, raw, None),
                    log_count: vec![],
                    step_secs,
                    rate_window_secs: rate_window.trim_end_matches('s').parse().unwrap_or(0),
                }
            })
            .collect())
    }
}
