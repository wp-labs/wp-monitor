use chrono::{DateTime, FixedOffset};

/// 单个节点在某一时刻的指标快照。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MetricsSnapshot {
    /// 日志速率（events per second）。
    pub log_rate_eps: f64,
    /// 时间窗口累计数量（由 increase 聚合得到）。
    pub log_count: u64,
    /// 指标采集时间（RFC3339）。
    pub collected_at: String,
}

/// 来源层节点。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SourceNode {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub metrics: MetricsSnapshot,
}

/// Parse 下的日志类型节点。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LogTypeNode {
    pub id: String,
    pub name: String,
    pub metrics: MetricsSnapshot,
}

/// Parse 的 package 容器节点。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ParseNode {
    pub id: String,
    pub package_name: String,
    pub metrics: MetricsSnapshot,
    pub logs: Vec<LogTypeNode>,
}

/// Sink 叶子节点（sink_group + sink_name）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SinkLeafNode {
    pub id: String,
    pub sink_group: String,
    pub sink_name: String,
    pub metrics: MetricsSnapshot,
}

/// Sink 分组节点（sink_group）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SinkGroupNode {
    pub id: String,
    pub sink_group: String,
    pub metrics: MetricsSnapshot,
    pub sinks: Vec<SinkLeafNode>,
}

/// MISS 节点（当前版本固定数据）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MissNode {
    pub id: String,
    pub name: String,
    pub fixed: bool,
    pub metrics: MetricsSnapshot,
}

/// 各层结构版本（由稳定哈希生成）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayerVersions {
    pub source_version: String,
    pub parse_version: String,
    pub sink_version: String,
}

/// 快照元信息。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SnapshotMeta {
    pub generated_at: String,
    pub layer_versions: LayerVersions,
    pub start_time: String,
    pub end_time: String,
}

/// 首页分层快照响应主体。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayerSnapshot {
    pub meta: SnapshotMeta,
    pub sources: Vec<SourceNode>,
    pub parses: Vec<ParseNode>,
    pub sinks: Vec<SinkGroupNode>,
    pub miss: MissNode,
    pub sys_metrics: SysMetrics,
}

/// 系统资源指标。
#[derive(Debug, Clone, serde::Serialize)]
pub struct SysMetrics {
    pub cpu_usage_pct: f64,
    pub memory_used_mb: u64,
}

/// 单节点指标项（用于增量刷新接口）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeMetricsItem {
    pub node_id: String,
    pub metrics: MetricsSnapshot,
}

/// 指标增量刷新响应。
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayersMetricsResponse {
    pub generated_at: String,
    pub items: Vec<NodeMetricsItem>,
}

/// 节点详情响应。
#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeDetail {
    pub id: String,
    pub name: String,
    pub node_type: String,
    pub package_name: Option<String>,
    pub metrics: MetricsSnapshot,
}

/// 时间序列中的单个点。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TimePoint {
    pub ts: String,
    pub value: f64,
}

/// 节点时间序列响应。
#[derive(Debug, Clone, serde::Serialize)]
pub struct NodeTimeSeries {
    pub node_id: String,
    pub log_rate_eps: Vec<TimePoint>,
    pub log_count: Vec<TimePoint>,
}

/// 标准化时间窗口查询对象。
#[derive(Debug, Clone)]
pub struct TimeRangeQuery {
    pub start_time: DateTime<FixedOffset>,
    pub end_time: DateTime<FixedOffset>,
}

/// 时间窗口解析错误。
#[derive(Debug, thiserror::Error)]
pub enum QueryParseError {
    #[error("invalid start_time format")]
    InvalidStart,
    #[error("invalid end_time format")]
    InvalidEnd,
    #[error("start_time must be earlier than end_time")]
    InvalidRange,
}

impl TimeRangeQuery {
    /// 从 RFC3339 字符串构造时间窗口，并校验 start < end。
    pub fn new(start_time: &str, end_time: &str) -> Result<Self, QueryParseError> {
        let start = DateTime::parse_from_rfc3339(start_time).map_err(|_| QueryParseError::InvalidStart)?;
        let end = DateTime::parse_from_rfc3339(end_time).map_err(|_| QueryParseError::InvalidEnd)?;
        if start >= end {
            return Err(QueryParseError::InvalidRange);
        }
        Ok(Self {
            start_time: start,
            end_time: end,
        })
    }
}
