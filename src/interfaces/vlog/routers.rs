use crate::interfaces::vlog::handlers;
use actix_web::web;

/// 注册 VLOG 相关 HTTP 子路由（由上层统一挂载到 /api/v1/wp-monitor）。
pub fn register_vlog_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handlers::get_missed_data);
}
