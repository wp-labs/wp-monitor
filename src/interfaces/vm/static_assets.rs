use actix_web::web::{Path, ServiceConfig};
use actix_web::{HttpResponse, Responder, get, http};
use rust_embed::{Embed, RustEmbed};
use tracing::warn;

#[derive(RustEmbed)]
#[folder = "./frontend/dist/"]
struct FrontendAssets;

/// 注册前端静态资源路由（含 SPA 回退）。
pub fn register_static_assets(cfg: &mut ServiceConfig) {
    cfg.service(index).service(static_files);
}

/// 根路径返回前端入口页。
#[get("/")]
async fn index() -> impl Responder {
    serve_embedded_file("index.html")
}

/// 处理静态资源与 SPA 子路由。
#[get("/{path:.*}")]
async fn static_files(path: Path<String>) -> impl Responder {
    let path = path.into_inner();
    if path.starts_with("api/") {
        return HttpResponse::NotFound().finish();
    }

    if let Some(resp) = try_serve_asset(&path) {
        return resp;
    }

    match <FrontendAssets as Embed>::get("index.html") {
        Some(content) => HttpResponse::Ok()
            .content_type("text/html; charset=utf-8")
            .body(content.data.into_owned()),
        None => {
            warn!("前端入口文件缺失: index.html");
            HttpResponse::NotFound().finish()
        }
    }
}

fn serve_embedded_file(path: &str) -> HttpResponse {
    match try_serve_asset(path) {
        Some(resp) => resp,
        None => {
            warn!("静态资源不存在: {}", path);
            HttpResponse::NotFound().finish()
        }
    }
}

fn try_serve_asset(path: &str) -> Option<HttpResponse> {
    <FrontendAssets as Embed>::get(path).map(|content| {
        let mime = mime_guess::from_path(path)
            .first_or_octet_stream()
            .as_ref()
            .to_string();
        HttpResponse::build(http::StatusCode::OK)
            .content_type(mime)
            .body(content.data.into_owned())
    })
}
