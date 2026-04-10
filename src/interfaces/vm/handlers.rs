use crate::application::layer_service::LayerService;
use crate::domain::model::TimeRangeQuery;
use crate::shared::api::{ApiResponse, ReadyResponse};
use actix_web::{
    HttpResponse, Result,
    error::{ErrorBadRequest, ErrorInternalServerError},
    get, web,
};
use tracing::{debug, error};

/// HTTP 查询参数：通用时间窗口。

#[derive(Debug, serde::Deserialize)]
pub struct TimeRangeRequest {
    pub start_time: String,
    pub end_time: String,
}

/// HTTP 查询参数：指标增量刷新请求。
#[derive(Debug, serde::Deserialize)]
pub struct MetricsRequest {
    pub start_time: String,
    pub end_time: String,
    pub node_ids: Option<String>,
}

/// HTTP 查询参数：节点时序请求。
/// 说明：`step` 字段仅为兼容旧前端，当前版本由后端自动计算步长。
#[derive(Debug, serde::Deserialize)]
pub struct TimeSeriesRequest {
    pub start_time: String,
    pub end_time: String,
    #[allow(dead_code)]
    pub step: Option<String>,
}

/// 获取全量分层快照。
#[get("/layers/snapshot")]
pub async fn get_layers_snapshot(
    svc: web::Data<LayerService>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    debug!(
        start_time = %req.start_time,
        end_time = %req.end_time,
        "vm.handlers.layers_snapshot.request"
    );
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.layers_snapshot.invalid_params"
        );
        ErrorBadRequest(e.to_string())
    })?;
    let data = svc.get_layers_snapshot(query).await.map_err(|e| {
        error!(error = %e, "vm.handlers.layers_snapshot.failed");
        ErrorInternalServerError(e.to_string())
    })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取分层指标快照（可按 node_ids 过滤）。
#[get("/layers/metrics")]
pub async fn get_layers_metrics(
    svc: web::Data<LayerService>,
    req: web::Query<MetricsRequest>,
) -> Result<HttpResponse> {
    debug!(
        start_time = %req.start_time,
        end_time = %req.end_time,
        has_node_ids = req.node_ids.is_some(),
        "vm.handlers.layers_metrics.request"
    );
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.layers_metrics.invalid_params"
        );
        ErrorBadRequest(e.to_string())
    })?;
    let node_ids = req.node_ids.as_ref().map(|s| {
        s.split(',')
            .map(|x| x.trim().to_string())
            .collect::<Vec<_>>()
    });

    let data = svc.get_layers_metrics(query, node_ids).await.map_err(|e| {
        error!(error = %e, "vm.handlers.layers_metrics.failed");
        ErrorInternalServerError(e.to_string())
    })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取单节点详情。
#[get("/nodes/{node_id}/detail")]
pub async fn get_node_detail(
    svc: web::Data<LayerService>,
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
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time).map_err(|e| {
        error!(
            node_id = %node_id,
            start_time = %req.start_time,
            end_time = %req.end_time,
            error = %e,
            "vm.handlers.node_detail.invalid_params"
        );
        ErrorBadRequest(e.to_string())
    })?;
    let data = svc.get_node_detail(node_id, query).await.map_err(|e| {
        error!(node_id = %node_id, error = %e, "vm.handlers.node_detail.failed");
        ErrorInternalServerError(e.to_string())
    })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取单节点时间序列。
#[get("/nodes/{node_id}/timeseries")]
pub async fn get_node_timeseries(
    svc: web::Data<LayerService>,
    path: web::Path<String>,
    req: web::Query<TimeSeriesRequest>,
) -> Result<HttpResponse> {
    let node_id = path.as_str();
    debug!(
        node_id = %node_id,
        start_time = %req.start_time,
        end_time = %req.end_time,
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
        ErrorBadRequest(e.to_string())
    })?;
    let data = svc.get_node_timeseries(node_id, query).await.map_err(|e| {
        error!(
            node_id = %node_id,
            error = %e,
            "vm.handlers.node_timeseries.failed"
        );
        ErrorInternalServerError(e.to_string())
    })?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取前端初始化配置。
#[get("/meta/config")]
pub async fn get_meta_config(svc: web::Data<LayerService>) -> Result<HttpResponse> {
    debug!("vm.handlers.meta_config.request");
    let data = svc.get_meta_config().await;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 就绪探针。
#[get("/health/ready")]
pub async fn get_health_ready() -> Result<HttpResponse> {
    debug!("vm.handlers.health_ready.request");
    Ok(HttpResponse::Ok().json(ApiResponse::ok(ReadyResponse {
        status: "ready".to_string(),
    })))
}
