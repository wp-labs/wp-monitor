use crate::domain::model::{NodeTimeSeries, TimeRangeQuery};
use crate::domain::wf_repository::{
    WfPipelineResponse, WfRepository, WfRuleItem, WfRuleMachineItem, WfSourceItem,
    WfSourceMachineItem, WfStateMachineItem, WfTimeseriesQuery, WfWindowItem, WfWindowMetric,
};
use crate::shared::error::AppError;
use std::sync::Arc;

/// wfusion 引擎监控应用服务。
///
/// 编排层，负责从仓储获取数据并透传至接口层。
/// 当前无额外聚合逻辑，预留缓存、异常检测等扩展点。
pub struct WfService {
    repo: Arc<dyn WfRepository>,
}

impl WfService {
    pub fn new(repo: Arc<dyn WfRepository>) -> Self {
        Self { repo }
    }

    pub async fn get_pipeline(
        &self,
        query: TimeRangeQuery,
    ) -> Result<WfPipelineResponse, AppError> {
        self.repo.fetch_pipeline(&query).await
    }
    pub async fn get_sources(&self, query: TimeRangeQuery) -> Result<Vec<WfSourceItem>, AppError> {
        self.repo.fetch_sources(&query).await
    }
    pub async fn get_source_machines(
        &self,
        query: TimeRangeQuery,
    ) -> Result<Vec<WfSourceMachineItem>, AppError> {
        self.repo.fetch_source_machines(&query).await
    }
    pub async fn get_windows(&self, query: TimeRangeQuery) -> Result<Vec<WfWindowItem>, AppError> {
        self.repo.fetch_windows(&query).await
    }
    pub async fn get_rules(&self, query: TimeRangeQuery) -> Result<Vec<WfRuleItem>, AppError> {
        self.repo.fetch_rules(&query).await
    }
    pub async fn get_state_machines(
        &self,
        query: TimeRangeQuery,
        rule_name: &str,
    ) -> Result<Vec<WfStateMachineItem>, AppError> {
        self.repo.fetch_state_machines(&query, rule_name).await
    }
    pub async fn get_rule_machines(
        &self,
        query: TimeRangeQuery,
    ) -> Result<Vec<WfRuleMachineItem>, AppError> {
        self.repo.fetch_rule_machines(&query).await
    }
    pub async fn get_timeseries_throughput(
        &self,
        query: TimeRangeQuery,
        group_by: &str,
        max_data_points: Option<usize>,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        self.repo
            .fetch_timeseries_throughput(&WfTimeseriesQuery {
                query,
                group_by: group_by.to_string(),
                metric: None,
                max_data_points,
            })
            .await
    }
    pub async fn get_timeseries_windows(
        &self,
        query: TimeRangeQuery,
        metric: WfWindowMetric,
        max_data_points: Option<usize>,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        self.repo
            .fetch_timeseries_windows(&WfTimeseriesQuery {
                query,
                group_by: String::new(),
                metric: Some(metric),
                max_data_points,
            })
            .await
    }
    pub async fn get_timeseries_alerts(
        &self,
        query: TimeRangeQuery,
        group_by: &str,
        max_data_points: Option<usize>,
    ) -> Result<Vec<NodeTimeSeries>, AppError> {
        self.repo
            .fetch_timeseries_alerts(&WfTimeseriesQuery {
                query,
                group_by: group_by.to_string(),
                metric: None,
                max_data_points,
            })
            .await
    }
}
