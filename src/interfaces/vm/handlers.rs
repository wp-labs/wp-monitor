use crate::application::miss_service::MissSource;
use crate::domain::model::TimeRangeQuery;
use crate::domain::vm_repository::{PackageFilter, TimeSeriesMetricMode};
use crate::shared::api::{ApiResponse, ReadyResponse, VersionResponse};
use crate::shared::error::AppErrorResponse;
use crate::state::AppState;
use actix_web::{HttpResponse, Result, get, post, web};
use serde::Deserialize;
use std::str::FromStr;
use tracing::{debug, error};

/// HTTP 查询参数：通用时间窗口。

#[derive(Debug, serde::Deserialize)]
pub struct TimeRangeRequest {
    pub start_time: String,
    pub end_time: String,
    pub miss_source: Option<String>,
}

/// HTTP 查询参数：指标增量刷新请求。
#[derive(Debug, serde::Deserialize)]
pub struct MetricsRequest {
    pub start_time: String,
    pub end_time: String,
    pub node_ids: Option<String>,
    pub filters: Option<Vec<PackageFilter>>,
    pub miss_source: Option<String>,
}

/// HTTP 查询参数：节点时序请求。
/// 说明：`step` 字段仅为兼容旧前端，当前版本由后端自动计算步长。
#[derive(Debug, serde::Deserialize)]
pub struct TimeSeriesRequest {
    pub start_time: String,
    pub end_time: String,
    #[allow(dead_code)]
    pub step: Option<String>,
    pub max_data_points: Option<usize>,
    pub metric_mode: Option<TimeSeriesMetricMode>,
}

fn parse_miss_source(raw: &Option<String>) -> MissSource {
    raw.as_ref()
        .and_then(|s| MissSource::from_str(s).ok())
        .unwrap_or(MissSource::Vlog)
}

/// 获取全量分层快照。
#[get("/layers/snapshot")]
pub async fn get_layers_snapshot(
    state: web::Data<AppState>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(
        start_time = %req.start_time,
        end_time = %req.end_time,
        "vm.handlers.layers_snapshot.request"
    );
    let miss_source = parse_miss_source(&req.miss_source);
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.layers_snapshot.invalid_params"
        );
        AppErrorResponse::from(e)
    })?;
    let data = state
        .layer
        .get_layers_snapshot(query, None, miss_source)
        .await
        .map_err(|e| {
            error!(error = %e, "vm.handlers.layers_snapshot.failed");
            AppErrorResponse::from(e)
        })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取分层指标快照（可按 node_ids 过滤）。
#[post("/layers/metrics")]
pub async fn get_layers_metrics(
    state: web::Data<AppState>,
    req: web::Json<MetricsRequest>,
) -> Result<HttpResponse> {
    let req = req.into_inner();
    debug!(
        start_time = %req.start_time,
        end_time = %req.end_time,
        has_node_ids = req.node_ids.is_some(),
        "vm.handlers.layers_metrics.request"
    );
    let miss_source = parse_miss_source(&req.miss_source);
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.layers_metrics.invalid_params"
        );
        AppErrorResponse::from(e)
    })?;
    let node_ids = req.node_ids.as_ref().map(|s| {
        s.split(',')
            .map(|x| x.trim().to_string())
            .collect::<Vec<_>>()
    });

    let data = state
        .layer
        .get_layers_metrics(query, node_ids, req.filters, miss_source)
        .await
        .map_err(|e| {
            error!(error = %e, "vm.handlers.layers_metrics.failed");
            AppErrorResponse::from(e)
        })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取单节点详情。
#[get("/nodes/{node_id}/detail")]
pub async fn get_node_detail(
    state: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    let node_id = path.as_str();
    debug!(
        node_id = %node_id,
        start_time = %req.start_time,
        end_time = %req.end_time,
        "vm.handlers.node_detail.request"
    );
    let miss_source = parse_miss_source(&req.miss_source);
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            node_id = %node_id,
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.node_detail.invalid_params"
        );
        AppErrorResponse::from(e)
    })?;
    let data = state
        .layer
        .get_node_detail(node_id, query, miss_source)
        .await
        .map_err(|e| {
            error!(node_id = %node_id, error = %e, "vm.handlers.node_detail.failed");
            AppErrorResponse::from(e)
        })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取单节点时间序列。
#[get("/nodes/{node_id}/timeseries")]
pub async fn get_node_timeseries(
    state: web::Data<AppState>,
    path: web::Path<String>,
    req: web::Query<TimeSeriesRequest>,
) -> Result<HttpResponse> {
    let node_id = path.as_str();
    debug!(
        node_id = %node_id,
        start_time = %req.start_time,
        end_time = %req.end_time,
        max_data_points = req.max_data_points.unwrap_or(0),
        "vm.handlers.node_timeseries.request"
    );
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            node_id = %node_id,
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.node_timeseries.invalid_params"
        );
        AppErrorResponse::from(e)
    })?;
    let data = state
        .layer
        .get_node_timeseries(
            node_id,
            query,
            req.max_data_points,
            req.metric_mode.unwrap_or(TimeSeriesMetricMode::Rate),
        )
        .await
        .map_err(|e| {
            error!(
                node_id = %node_id,
                error = %e,
                "vm.handlers.node_timeseries.failed"
            );
            AppErrorResponse::from(e)
        })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取多个节点的时间序列。
#[derive(Debug, Deserialize)]
pub enum TimeSeriesScope {
    #[serde(rename = "parse")]
    Parse,
    #[serde(rename = "source")]
    Source,
    #[serde(rename = "sink")]
    Sink,
}

#[derive(Debug, Deserialize)]
pub struct NodesTimeSeriesRequest {
    pub scope: Option<TimeSeriesScope>,
    pub package_name: Vec<String>,
    pub rule_name: Vec<String>,
    pub sink_group: Option<String>,
    pub start_time: String,
    pub end_time: String,
    pub max_data_points: Option<usize>,
    pub metric_mode: Option<TimeSeriesMetricMode>,
}

#[derive(Debug, Deserialize)]
pub struct PackagesTimeSeriesRequest {
    pub start_time: String,
    pub end_time: String,
    pub max_data_points: Option<usize>,
    pub filters: Vec<PackageFilter>,
    pub metric_mode: Option<TimeSeriesMetricMode>,
}

#[post("/packages/timeseries")]
pub async fn get_packages_timeseries(
    state: web::Data<AppState>,
    req: web::Json<PackagesTimeSeriesRequest>,
) -> Result<HttpResponse> {
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.packages_timeseries.invalid_params"
        );
        AppErrorResponse::from(e)
    })?;
    let req = req.into_inner();
    let data = state
        .layer
        .get_packages_timeseries(
            query,
            req.max_data_points,
            req.filters,
            req.metric_mode.unwrap_or(TimeSeriesMetricMode::Rate),
        )
        .await
        .map_err(|e| {
            error!(
                error = %e,
                "vm.handlers.packages_timeseries.failed"
            );
            AppErrorResponse::from(e)
        })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

#[post("/nodes/timeseries")]
pub async fn get_nodes_timeseries(
    state: web::Data<AppState>,
    req: web::Json<NodesTimeSeriesRequest>,
) -> Result<HttpResponse> {
    debug!(
        start_time = %req.start_time,
        end_time = %req.end_time,
        max_data_points = req.max_data_points.unwrap_or(0),
        "vm.handlers.node_timeseries.request"
    );
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.node_timeseries.invalid_params"
        );
        AppErrorResponse::from(e)
    })?;
    let scope = req.scope.as_ref().unwrap_or(&TimeSeriesScope::Parse);
    let metric_mode = req.metric_mode.unwrap_or(TimeSeriesMetricMode::Rate);
    let data = match scope {
        TimeSeriesScope::Source => state
            .layer
            .get_source_timeseries(query, req.max_data_points, metric_mode)
            .await
            .map_err(|e| {
                error!(error = %e, "vm.handlers.source_timeseries.failed");
                AppErrorResponse::from(e)
            })?,
        TimeSeriesScope::Sink => state
            .layer
            .get_sink_timeseries(
                query,
                req.sink_group.clone(),
                req.max_data_points,
                metric_mode,
            )
            .await
            .map_err(|e| {
                error!(error = %e, "vm.handlers.sink_timeseries.failed");
                AppErrorResponse::from(e)
            })?,
        TimeSeriesScope::Parse => state
            .layer
            .get_parse_timeseries(
                query,
                req.package_name.clone(),
                req.rule_name.clone(),
                req.max_data_points,
                metric_mode,
            )
            .await
            .map_err(|e| {
                error!(error = %e, "vm.handlers.parse_timeseries.failed");
                AppErrorResponse::from(e)
            })?,
    };
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取前端初始化配置。
#[get("/meta/config")]
pub async fn get_meta_config(state: web::Data<AppState>) -> Result<HttpResponse> {
    debug!("vm.handlers.meta_config.request");
    let data = state.layer.get_meta_config().await;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取当前项目版本号。
#[get("/meta/version")]
pub async fn get_meta_version() -> Result<HttpResponse> {
    debug!("vm.handlers.meta_version.request");
    Ok(HttpResponse::Ok().json(ApiResponse::ok(VersionResponse {
        version: env!("CARGO_PKG_VERSION").to_string(),
    })))
}

/// 就绪探针。
#[get("/health/ready")]
pub async fn get_health_ready() -> Result<HttpResponse> {
    debug!("vm.handlers.health_ready.request");
    Ok(HttpResponse::Ok().json(ApiResponse::ok(ReadyResponse {
        status: "ready".to_string(),
    })))
}
