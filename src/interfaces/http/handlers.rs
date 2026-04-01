use crate::application::layer_service::LayerService;
use crate::domain::model::TimeRangeQuery;
use crate::shared::api::{ApiResponse, ReadyResponse};
use actix_web::{
    HttpResponse, Result,
    error::{ErrorBadRequest, ErrorInternalServerError},
    get,
    web,
};

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

/// HTTP 查询参数：节点时序请求（支持 step 可选覆盖）。
#[derive(Debug, serde::Deserialize)]
pub struct TimeSeriesRequest {
    pub start_time: String,
    pub end_time: String,
    pub step: Option<String>,
}

/// 获取全量分层快照。
#[get("/layers/snapshot")]
pub async fn get_layers_snapshot(
    svc: web::Data<LayerService>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time)
        .map_err(|e| ErrorBadRequest(e.to_string()))?;
    let data = svc
        .get_layers_snapshot(query)
        .await
        .map_err(|e| ErrorInternalServerError(e.to_string()))?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取分层指标快照（可按 node_ids 过滤）。
#[get("/layers/metrics")]
pub async fn get_layers_metrics(
    svc: web::Data<LayerService>,
    req: web::Query<MetricsRequest>,
) -> Result<HttpResponse> {
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time)
        .map_err(|e| ErrorBadRequest(e.to_string()))?;
    let node_ids = req
        .node_ids
        .as_ref()
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>());

    let data = svc
        .get_layers_metrics(query, node_ids)
        .await
        .map_err(|e| ErrorInternalServerError(e.to_string()))?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取单节点详情。
#[get("/nodes/{node_id}/detail")]
pub async fn get_node_detail(
    svc: web::Data<LayerService>,
    path: web::Path<String>,
    req: web::Query<TimeRangeRequest>,
) -> Result<HttpResponse> {
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time)
        .map_err(|e| ErrorBadRequest(e.to_string()))?;
    let data = svc
        .get_node_detail(path.as_str(), query)
        .await
        .map_err(|e| ErrorInternalServerError(e.to_string()))?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取单节点时间序列。
#[get("/nodes/{node_id}/timeseries")]
pub async fn get_node_timeseries(
    svc: web::Data<LayerService>,
    path: web::Path<String>,
    req: web::Query<TimeSeriesRequest>,
) -> Result<HttpResponse> {
    let query = TimeRangeQuery::new(&req.start_time, &req.end_time)
        .map_err(|e| ErrorBadRequest(e.to_string()))?;
    let data = svc
        .get_node_timeseries(path.as_str(), query, req.step.clone())
        .await
        .map_err(|e| ErrorInternalServerError(e.to_string()))?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 获取前端初始化配置。
#[get("/meta/config")]
pub async fn get_meta_config(svc: web::Data<LayerService>) -> Result<HttpResponse> {
    let data = svc.get_meta_config().await;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}

/// 就绪探针。
#[get("/health/ready")]
pub async fn get_health_ready() -> Result<HttpResponse> {
    Ok(HttpResponse::Ok().json(ApiResponse::ok(ReadyResponse {
        status: "ready".to_string(),
    })))
}
