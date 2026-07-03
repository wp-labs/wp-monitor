use crate::interfaces::wf::handlers;
use actix_web::web;

pub fn register_wf_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(handlers::get_wf_pipeline)
        .service(handlers::get_wf_sources)
        .service(handlers::get_wf_source_machines)
        .service(handlers::get_wf_windows)
        .service(handlers::get_wf_rules)
        .service(handlers::get_wf_state_machines)
        .service(handlers::get_wf_rule_machines)
        .service(handlers::get_wf_timeseries_throughput)
        .service(handlers::get_wf_timeseries_windows)
        .service(handlers::get_wf_timeseries_alerts);
}
