use actix_web::{
    HttpResponse, Result,
    error::ErrorInternalServerError,
    get, web,
};
use chrono::{DateTime, Utc};

use crate::{infrastructure::vlog_repository::{VlogHttpRepository, VlogRepository}, shared::api::ApiResponse};

#[derive(Debug, serde::Deserialize)]
pub struct VlogInstantQuery {
    pub query: String,
    pub limit: u32,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

/// 获取缺失数据。
#[get("/vlog/missed")]
pub async fn get_missed_data(
    vlog_repository: web::Data<VlogHttpRepository>,
    req: web::Query<VlogInstantQuery>,
) -> Result<HttpResponse> {
     let data = vlog_repository
        .instant_query(req.into_inner())
        .await
        .map_err(|e| ErrorInternalServerError(e.to_string()))?;
    Ok(HttpResponse::Ok().json(ApiResponse::ok(data)))
}
