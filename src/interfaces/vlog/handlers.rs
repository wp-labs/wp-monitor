use actix_web::{
    HttpResponse, Result,
    error::ErrorInternalServerError,
    http::header,
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

#[derive(Debug, serde::Deserialize)]
pub struct VlogMissedPageQuery {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub query: Option<String>,
    pub page: Option<u32>,
    pub page_size: Option<u32>,
}

#[derive(Debug, serde::Serialize)]
pub struct VlogMissedPageData {
    pub start: String,
    pub end: String,
    pub query: String,
    pub page: u32,
    pub page_size: u32,
    pub has_more: bool,
    pub items: Vec<crate::infrastructure::vlog_repository::VlogRecord>,
}

#[derive(Debug, serde::Deserialize)]
pub struct VlogMissedExportQuery {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub query: Option<String>,
}

const DEFAULT_MISS_QUERY: &str = "wp_stage:miss";
const DEFAULT_PAGE_SIZE: u32 = 10;
const MAX_PAGE_SIZE: u32 = 100;
const MAX_FETCH_ROWS: u32 = 5000;

fn normalize_page(page: Option<u32>) -> u32 {
    page.unwrap_or(1).max(1)
}

fn normalize_page_size(page_size: Option<u32>) -> u32 {
    page_size.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, MAX_PAGE_SIZE)
}

fn normalize_query(query: &Option<String>) -> String {
    query
        .as_ref()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
        .unwrap_or_else(|| DEFAULT_MISS_QUERY.to_string())
}

/// 获取缺失数据。
#[get("/vlog/missed")]
pub async fn get_missed_data(
    vlog_repository: web::Data<VlogHttpRepository>,
    req: web::Query<VlogMissedPageQuery>,
) -> Result<HttpResponse> {
    let req = req.into_inner();
    let query = normalize_query(&req.query);
    let page = normalize_page(req.page);
    let page_size = normalize_page_size(req.page_size);
    let offset = (page - 1).saturating_mul(page_size);
    let fetch_limit = page_size.saturating_add(1).min(MAX_PAGE_SIZE + 1);
    let paged_query = format!(
        "{} | sort by (_time) asc | offset {} | limit {}",
        query, offset, fetch_limit
    );

    let data = vlog_repository
        .instant_query(VlogInstantQuery {
            query: paged_query,
            limit: fetch_limit,
            start: req.start,
            end: req.end,
        })
        .await
        .map_err(|e| ErrorInternalServerError(e.to_string()))?;
    let has_more = data.len() > page_size as usize;
    let items = data.into_iter().take(page_size as usize).collect::<Vec<_>>();

    Ok(HttpResponse::Ok().json(ApiResponse::ok(VlogMissedPageData {
        start: req.start.to_rfc3339(),
        end: req.end.to_rfc3339(),
        query,
        page,
        page_size,
        has_more,
        items,
    })))
}

/// 导出缺失数据（DAT，仅 raw 字段）。
#[get("/vlog/missed/export")]
pub async fn export_missed_data(
    vlog_repository: web::Data<VlogHttpRepository>,
    req: web::Query<VlogMissedExportQuery>,
) -> Result<HttpResponse> {
    let req = req.into_inner();
    let query = normalize_query(&req.query);
    let export_query = format!("{} | sort by (_time) asc | limit {}", query, MAX_FETCH_ROWS);
    let data = vlog_repository
        .instant_query(VlogInstantQuery {
            query: export_query,
            limit: MAX_FETCH_ROWS,
            start: req.start,
            end: req.end,
        })
        .await
        .map_err(|e| ErrorInternalServerError(e.to_string()))?;

    let mut content = String::new();
    for row in data {
        content.push_str(&row.raw);
        if !row.raw.ends_with('\n') {
            content.push('\n');
        }
    }

    let filename = format!(
        "miss-{}-{}.dat",
        req.start.format("%Y%m%d%H%M%S"),
        req.end.format("%Y%m%d%H%M%S")
    );
    Ok(HttpResponse::Ok()
        .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
        .insert_header((
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename),
        ))
        .body(content))
}
