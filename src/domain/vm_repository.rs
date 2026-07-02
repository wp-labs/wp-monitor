use crate::domain::model::{
    NodeTimeSeries, ParseNode, SinkGroupNode, SourceNode, SysMetrics, TimeRangeQuery,
};
use crate::shared::error::AppError;
use async_trait::async_trait;

#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub enum TimeSeriesMetricMode {
    #[serde(rename = "rate")]
    Rate,
    #[serde(rename = "count")]
    Count,
}

/// 查询过滤条件（领域概念，非 HTTP DTO）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PackageFilter {
    pub package_name: String,
    pub rule_names: Vec<String>,
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
/// - fetch_snapshot_data：查一次"当前时刻"聚合快照；
/// - fetch_node_timeseries：按节点拉区间序列。
#[async_trait]
pub trait VmRepository: Send + Sync {
    async fn fetch_snapshot_data(
        &self,
        query: &TimeRangeQuery,
        filters: Option<Vec<PackageFilter>>,
    ) -> Result<VmSnapshotData, AppError>;

    async fn fetch_node_timeseries(
        &self,
        node_id: &str,
        query: &TimeRangeQuery,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<NodeTimeSeries, AppError>;

    async fn fetch_parse_timeseries(
        &self,
        query: &TimeRangeQuery,
        package_name: &str,
        rule_names: &str,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError>;

    async fn fetch_packages_timeseries(
        &self,
        query: &TimeRangeQuery,
        filters: &[(String, String)],
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError>;

    async fn fetch_source_timeseries(
        &self,
        query: &TimeRangeQuery,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError>;

    async fn fetch_sink_timeseries(
        &self,
        query: &TimeRangeQuery,
        sink_group: Option<&str>,
        max_data_points: Option<usize>,
        metric_mode: TimeSeriesMetricMode,
    ) -> Result<Vec<NodeTimeSeries>, AppError>;
}
