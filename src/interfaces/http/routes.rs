use crate::interfaces::http::handlers;
use actix_web::web;

/// 注册 HTTP 路由：统一挂在 /api/v1/wp-monitor 下。
pub fn register_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1/wp-monitor")
            .service(handlers::get_layers_snapshot)
            .service(handlers::get_layers_metrics)
            .service(handlers::get_node_detail)
            .service(handlers::get_node_timeseries)
            .service(handlers::get_meta_config)
            .service(handlers::get_health_ready),
    );
}
