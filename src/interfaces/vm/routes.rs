use crate::interfaces::vm::handlers;
use actix_web::web;

/// 注册 VM 相关 HTTP 子路由（由上层统一挂载到 /api/v1/wp-monitor）。
pub fn register_vm_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handlers::get_layers_snapshot)
        .service(handlers::get_layers_metrics)
        .service(handlers::get_node_detail)
        .service(handlers::get_node_timeseries)
        .service(handlers::get_meta_config)
        .service(handlers::get_nodes_timeseries)
        .service(handlers::get_health_ready);
}
