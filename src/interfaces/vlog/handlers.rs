use actix_web::{HttpResponse, Result, get, http::header, web};
use chrono::{DateTime, Utc};
use serde::Serialize;
use tracing::{debug, error, info};

use crate::{
    application::miss_service::MissSource,
    domain::miss_repository::{MissQuery, MissRecord},
    shared::api::ApiResponse,
    shared::error::AppErrorResponse,
    state::AppState,
};
use std::str::FromStr;

#[derive(Debug, serde::Deserialize)]
pub struct VlogMissedPageQuery {
    pub query: Option<String>,
    pub source: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct MissedLogItem {
    pub content: String,
}

impl From<MissRecord> for MissedLogItem {
    fn from(r: MissRecord) -> Self {
        Self { content: r.content }
    }
}

/// 统一的 miss 数据响应格式。
#[derive(Debug, Serialize)]
pub struct MissedPageData {
    pub source: String,
    pub total: u64,
    pub items: Vec<MissedLogItem>,
}

#[derive(Debug, serde::Deserialize)]
pub struct VlogMissedExportQuery {
    pub query: Option<String>,
    pub source: Option<String>,
}

const DEFAULT_MISS_QUERY: &str = "wp_stage:miss";
const MAX_MISS_TOTAL: u32 = 100;

fn parse_miss_source(raw: &Option<String>) -> MissSource {
    raw.as_ref()
        .and_then(|s| MissSource::from_str(s).ok())
        .unwrap_or(MissSource::Vlog)
}

fn normalize_query(query: &Option<String>) -> String {
    query
        .as_ref()
        .map(|q| q.trim().to_string())
        .filter(|q| !q.is_empty())
        .unwrap_or_else(|| DEFAULT_MISS_QUERY.to_string())
}

/// 获取缺失数据（最多返回最近 100 条，分页由前端处理）。
/// - ?source=vlog（默认）：走 logsql 查询最近 100 条
/// - ?source=file：返回文件尾部最多 100 条
#[get("/vlog/missed")]
pub async fn get_missed_data(
    state: web::Data<AppState>,
    req: web::Query<VlogMissedPageQuery>,
) -> Result<HttpResponse> {
    let req = req.into_inner();
    let miss_source = parse_miss_source(&req.source);

    let miss_service = state.resolve_miss(miss_source).map_err(|e| {
        error!(error = %e, "vlog.handlers.missed_page.invalid_source");
        AppErrorResponse::from(e)
    })?;

    match miss_source {
        MissSource::File => {
            debug!("vlog.handlers.missed_page.file_mode");
            let (records, total) = tokio::try_join!(
                miss_service.fetch_records(MissQuery {
                    limit: MAX_MISS_TOTAL as usize,
                    start: DateTime::UNIX_EPOCH,
                    end: Utc::now(),
                    query: None,
                }),
                miss_service.count_total(),
            )
            .map_err(|e| {
                error!(error = %e, "vlog.handlers.missed_page.file_failed");
                AppErrorResponse::from(e)
            })?;
            let items: Vec<MissedLogItem> = records.into_iter().map(MissedLogItem::from).collect();
            Ok(HttpResponse::Ok().json(ApiResponse::ok(MissedPageData {
                source: "file".to_string(),
                total,
                items,
            })))
        }
        MissSource::Vlog => {
            let query = normalize_query(&req.query);
            let paged_query = format!(
                "{} | sort by (_time) desc | limit {} | sort by (_time) asc",
                query, MAX_MISS_TOTAL
            );
            debug!(
                paged_query = &paged_query,
                "vlog.handlers.missed_page.vlog_mode"
            );
            let (records, total) = tokio::try_join!(
                miss_service.fetch_records(MissQuery {
                    limit: MAX_MISS_TOTAL as usize,
                    start: DateTime::UNIX_EPOCH,
                    end: Utc::now(),
                    query: Some(paged_query),
                }),
                miss_service.count_total(),
            )
            .map_err(|e| {
                error!(
                    error = %e,
                    "vlog.handlers.missed_page.failed"
                );
                AppErrorResponse::from(e)
            })?;
            let items: Vec<MissedLogItem> = records.into_iter().map(MissedLogItem::from).collect();
            Ok(HttpResponse::Ok().json(ApiResponse::ok(MissedPageData {
                source: "vlog".to_string(),
                total,
                items,
            })))
        }
    }
}

/// 导出缺失数据（DAT，仅 raw 字段）。
#[get("/vlog/missed/export")]
pub async fn export_missed_data(
    state: web::Data<AppState>,
    req: web::Query<VlogMissedExportQuery>,
) -> Result<HttpResponse> {
    let req = req.into_inner();
    let miss_source = parse_miss_source(&req.source);

    let miss_service = state.resolve_miss(miss_source).map_err(|e| {
        error!(error = %e, "vlog.handlers.missed_export.invalid_source");
        AppErrorResponse::from(e)
    })?;

    match miss_source {
        MissSource::File => {
            info!("vlog.handlers.missed_export.file_mode");
            let records = miss_service
                .fetch_records(MissQuery {
                    limit: MAX_MISS_TOTAL as usize,
                    start: DateTime::UNIX_EPOCH,
                    end: Utc::now(),
                    query: None,
                })
                .await
                .map_err(|e| {
                    error!(error = %e, "vlog.handlers.missed_export.file_failed");
                    AppErrorResponse::from(e)
                })?;
            let content = records
                .into_iter()
                .map(|r| r.content)
                .collect::<Vec<_>>()
                .join("\n");
            let filename = format!("miss-{}.dat", Utc::now().format("%Y%m%d%H%M%S"));
            info!(
                filename = %filename,
                line_count = content.lines().count(),
                "vlog.handlers.missed_export.file_success"
            );
            Ok(HttpResponse::Ok()
                .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
                .insert_header((
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", filename),
                ))
                .body(content))
        }
        MissSource::Vlog => {
            let query = normalize_query(&req.query);
            let export_query = format!(
                "{} | sort by (_time) desc | limit {} | sort by (_time) asc",
                query, MAX_MISS_TOTAL
            );
            info!(
                limit = MAX_MISS_TOTAL,
                "vlog.handlers.missed_export.vlog_mode"
            );
            let records = miss_service
                .fetch_records(MissQuery {
                    limit: MAX_MISS_TOTAL as usize,
                    start: DateTime::UNIX_EPOCH,
                    end: Utc::now(),
                    query: Some(export_query),
                })
                .await
                .map_err(|e| {
                    error!(
                        error = %e,
                        "vlog.handlers.missed_export.failed"
                    );
                    AppErrorResponse::from(e)
                })?;
            let mut content = String::new();
            for r in records {
                content.push_str(&r.content);
                if !r.content.ends_with('\n') {
                    content.push('\n');
                }
            }
            let filename = format!("miss-{}.dat", Utc::now().format("%Y%m%d%H%M%S"));
            info!(
                filename = %filename,
                line_count = content.lines().count(),
                "vlog.handlers.missed_export.success"
            );
            Ok(HttpResponse::Ok()
                .insert_header((header::CONTENT_TYPE, "text/plain; charset=utf-8"))
                .insert_header((
                    header::CONTENT_DISPOSITION,
                    format!("attachment; filename=\"{}\"", filename),
                ))
                .body(content))
        }
    }
}
