//! wfusion 引擎监控 HTTP 处理器。
//!
//! 每个 handler 遵循统一的三步骤：
//! 1. 解析请求参数并验证时间范围
//! 2. 委托 `AppState.wf` 应用服务执行查询
//! 3. 包装为 `ApiResponse` 返回

use crate::domain::model::TimeRangeQuery;
use crate::domain::wf_repository::WfWindowMetric;
use crate::interfaces::vm::handlers::TimeRangeRequest;
use crate::shared::api::ApiResponse;
use crate::shared::error::AppErrorResponse;
use crate::state::AppState;
use actix_web::{HttpResponse, Result, get, web};
use serde::Deserialize;
use tracing::debug;

// ── 请求 DTO ──
//
// 通用时间窗口复用 vm 模块的 `TimeRangeRequest`。
// 时序接口额外需要 `group_by` / `metric` 参数，因此定义独立 DTO。

#[derive(Debug, Deserialize)]
pub struct WfTimeseriesThroughputRequest {
    pub start_time: String,
    pub end_time: String,
    #[serde(default = "default_group_by_source")]
    pub group_by: String,
    pub max_data_points: Option<usize>,
}

fn default_group_by_source() -> String {
    "source".into()
}

#[derive(Debug, Deserialize)]
pub struct WfTimeseriesWindowsRequest {
    pub start_time: String,
    pub end_time: String,
    #[serde(default)]
    pub metric: WfWindowMetric,
    pub max_data_points: Option<usize>,
}

#[derive(Debug, Deserialize)]
pub struct WfTimeseriesAlertsRequest {
    pub start_time: String,
    pub end_time: String,
    #[serde(default = "default_group_by_rule")]
    pub group_by: String,
    pub max_data_points: Option<usize>,
}

fn default_group_by_rule() -> String {
    "rule".into()
}

fn into_time_range(req: &TimeRangeRequest) -> Result<TimeRangeQuery, AppErrorResponse> {
    TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(AppErrorResponse::from)
}

// ── 流水线概览 ──

/// 管道图第一行：接收/窗口/规则三阶段聚合指标 + 实体计数。
#[get("/wf/pipeline")]
pub async fn get_wf_pipeline(
    state: web::Data<AppState>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, "wf.handlers.pipeline");
    let query = into_time_range(&req)?;
    let data = state
        .wf
        .get_pipeline(query)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

// ── 来源详情 ──

#[get("/wf/sources")]
pub async fn get_wf_sources(
    state: web::Data<AppState>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, "wf.handlers.sources");
    let query = into_time_range(&req)?;
    let data = state
        .wf
        .get_sources(query)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

#[get("/wf/sources/machines")]
pub async fn get_wf_source_machines(
    state: web::Data<AppState>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, "wf.handlers.source_machines");
    let query = into_time_range(&req)?;
    let data = state
        .wf
        .get_source_machines(query)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

// ── 窗口详情 ──

#[get("/wf/windows")]
pub async fn get_wf_windows(
    state: web::Data<AppState>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, "wf.handlers.windows");
    let query = into_time_range(&req)?;
    let data = state
        .wf
        .get_windows(query)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

// ── 告警详情 ──

#[get("/wf/rules")]
pub async fn get_wf_rules(
    state: web::Data<AppState>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, "wf.handlers.rules");
    let query = into_time_range(&req)?;
    let data = state
        .wf
        .get_rules(query)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

#[get("/wf/rules/{rule_name}/state-machines")]
pub async fn get_wf_state_machines(
    state: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    let rule_name = path.into_inner();
    debug!(rule_name = %rule_name, start = %req.start_time, end = %req.end_time, "wf.handlers.state_machines");
    let query = into_time_range(&req)?;
    let data = state
        .wf
        .get_state_machines(query, &rule_name)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

#[get("/wf/rules/machines")]
pub async fn get_wf_rule_machines(
    state: web::Data<AppState>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, "wf.handlers.rule_machines");
    let query = into_time_range(&req)?;
    let data = state
        .wf
        .get_rule_machines(query)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

// ── 时序数据 ──

#[get("/wf/timeseries/throughput")]
pub async fn get_wf_timeseries_throughput(
    state: web::Data<AppState>,
    req: web::Query<WfTimeseriesThroughputRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, group_by = %req.group_by, "wf.handlers.timeseries_throughput");
    let query = into_time_range(&TimeRangeRequest {
        start_time: req.start_time.clone(),
        end_time: req.end_time.clone(),
    })?;
    let data = state
        .wf
        .get_timeseries_throughput(query, &req.group_by, req.max_data_points)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

#[get("/wf/timeseries/windows")]
pub async fn get_wf_timeseries_windows(
    state: web::Data<AppState>,
    req: web::Query<WfTimeseriesWindowsRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, metric = ?req.metric, "wf.handlers.timeseries_windows");
    let query = into_time_range(&TimeRangeRequest {
        start_time: req.start_time.clone(),
        end_time: req.end_time.clone(),
    })?;
    let data = state
        .wf
        .get_timeseries_windows(query, req.metric, req.max_data_points)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

#[get("/wf/timeseries/alerts")]
pub async fn get_wf_timeseries_alerts(
    state: web::Data<AppState>,
    req: web::Query<WfTimeseriesAlertsRequest>,
) -> Result<HttpResponse> {
    debug!(start = %req.start_time, end = %req.end_time, group_by = %req.group_by, "wf.handlers.timeseries_alerts");
    let query = into_time_range(&TimeRangeRequest {
        start_time: req.start_time.clone(),
        end_time: req.end_time.clone(),
    })?;
    let data = state
        .wf
        .get_timeseries_alerts(query, &req.group_by, req.max_data_points)
        .await
        .map_err(AppErrorResponse::from)?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}
