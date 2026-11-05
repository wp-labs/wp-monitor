use crate::domain::model::{NodeTimeSeries, TimeRangeQuery};
use crate::shared::error::AppError;
use async_trait::async_trait;
use serde::Deserialize;

// ── Pipeline ──

/// 接收阶段聚合指标。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfPipelineReceiver {
    pub total_rows: f64,
    pub rate_rows_per_sec: f64,
    pub route_errors: f64,
    pub source_count: u32,
}

/// 窗口阶段聚合指标。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfPipelineWindow {
    pub window_count: u32,
    pub total_rows: f64,
    pub total_memory_bytes: f64,
    pub late_dropped: f64,
}

/// 规则与告警阶段聚合指标。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfPipelineRule {
    pub rule_count: u32,
    pub total_state_machines: f64,
    pub hit_rate_pct: f64,
    pub total_emitted: f64,
    pub send_failed: f64,
    pub e2e_p99_ms: f64,
}

/// 流水线概览（管道图第一行三阶段卡片）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfPipelineResponse {
    pub generated_at: String,
    pub receiver: WfPipelineReceiver,
    pub window: WfPipelineWindow,
    pub rule: WfPipelineRule,
}

// ── Source ──

/// 来源列表项（来源详情表）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfSourceItem {
    pub name: String,
    /// source 类型：tcp / file / kafka 等，取自 `source_type` 标签。
    #[serde(rename = "type")]
    pub source_type: String,
    pub rows: f64,
    pub route_errors: f64,
    /// kafka 消费积压（gauge），非 kafka 来源返回 0。
    pub consumer_lag: f64,
    /// 关联的设备标识，取自 `machine_name` 标签。
    pub machines: Vec<String>,
}

/// 设备维度来源聚合（来源详情切到"设备"时使用）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfSourceMachineItem {
    pub machine: String,
    pub rows: f64,
    pub route_errors: f64,
    pub source_count: u32,
}

// ── Window ──

/// 窗口列表项（窗口详情表）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfWindowItem {
    pub name: String,
    pub rows: f64,
    pub memory_bytes: f64,
    pub capacity_bytes: f64,
    pub late_dropped: f64,
}

// ── Rule ──

/// 规则列表项（告警详情表）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfRuleItem {
    pub name: String,
    pub matched: f64,
    pub emitted: f64,
    pub instances: f64,
    /// scope_key 维度的告警分布，随规则列表一起返回，保证数据对齐。
    /// 活跃规则包含各 scope 的 emitted 数量；静默规则为空。
    #[serde(default)]
    pub state_machines: Vec<WfStateMachineItem>,
}

/// 状态机实例告警分布（hover popover 数据）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfStateMachineItem {
    pub scope_key: String,
    pub emitted: f64,
}

/// 设备维度告警聚合（告警详情切到"设备"时使用）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct WfRuleMachineItem {
    pub machine: String,
    pub emitted: f64,
    pub rule_count: u32,
}

// ── Timeseries query params ──

/// 窗口曲线指标类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WfWindowMetric {
    #[default]
    Rows,
    Memory,
    Late,
}

/// 时序查询参数，由应用层组装后传入仓储。
#[derive(Debug, Clone)]
pub struct WfTimeseriesQuery {
    pub query: TimeRangeQuery,
    pub group_by: String,
    pub metric: Option<WfWindowMetric>,
    pub alert_metric: Option<WfAlertMetrics>,
    pub max_data_points: Option<usize>,
}

/// 告警趋势指标类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WfAlertMetrics {
    #[default]
    AlertCount,
    AlertMatched,
}

// ── Repository trait ──

/// wfusion 引擎监控仓储抽象。
///
/// 所有即时查询使用 VictoriaMetrics `/api/v1/query`，
/// 时序查询使用 `/api/v1/query_range`。
#[async_trait]
pub trait WfRepository: Send + Sync {
    /// 流水线概览：三阶段聚合指标 + 实体计数。
    async fn fetch_pipeline(&self, query: &TimeRangeQuery) -> Result<WfPipelineResponse, AppError>;

    /// 来源列表（全量，含 per-source 指标和设备列表）。
    async fn fetch_sources(&self, query: &TimeRangeQuery) -> Result<Vec<WfSourceItem>, AppError>;

    /// 设备维度来源聚合：按 `machine_name` 分组统计。
    async fn fetch_source_machines(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<Vec<WfSourceMachineItem>, AppError>;

    /// 窗口列表（全量，含内存占用与容量）。
    async fn fetch_windows(&self, query: &TimeRangeQuery) -> Result<Vec<WfWindowItem>, AppError>;

    /// 规则列表（全量，含告警产出与状态机实例数）。
    async fn fetch_rules(&self, query: &TimeRangeQuery) -> Result<Vec<WfRuleItem>, AppError>;

    /// 某规则的状态机实例告警分布：
    /// 查询 `wf_alert_emitted_total{alert_name="<rule>",scope_key!="-"}`
    /// 按 `scope_key` 分组。
    async fn fetch_state_machines(
        &self,
        query: &TimeRangeQuery,
        rule_name: &str,
    ) -> Result<Vec<WfStateMachineItem>, AppError>;

    /// 设备维度告警聚合：按 `machine_name` 分组统计。
    async fn fetch_rule_machines(
        &self,
        query: &TimeRangeQuery,
    ) -> Result<Vec<WfRuleMachineItem>, AppError>;

    /// 数据流入吞吐量时序：按 source 或 machine 维度。
    async fn fetch_timeseries_throughput(
        &self,
        ts: &WfTimeseriesQuery,
    ) -> Result<Vec<NodeTimeSeries>, AppError>;

    /// 窗口曲线时序：支持 rows / memory / late 三种指标切换。
    async fn fetch_timeseries_windows(
        &self,
        ts: &WfTimeseriesQuery,
    ) -> Result<Vec<NodeTimeSeries>, AppError>;

    /// 告警趋势时序：按 rule 或 machine 维度。
    async fn fetch_timeseries_alerts(
        &self,
        ts: &WfTimeseriesQuery,
    ) -> Result<Vec<NodeTimeSeries>, AppError>;
}
