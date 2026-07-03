mod application;
mod domain;
mod infrastructure;
mod interfaces;
mod shared;
mod state;

use actix_web::{App, HttpServer, web};
use interfaces::vm::routes::register_vm_routes;
use interfaces::vm::static_assets::register_static_assets;
use interfaces::wf::routes::register_wf_routes;
use shared::config::AppConfig;
use shared::logging::init_tracing;
use state::AppState;
use tracing::info;

use crate::interfaces::vlog::routers::register_vlog_routes;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    let cfg_path =
        std::env::var("APP_CONFIG_PATH").unwrap_or_else(|_| "./config/app.toml".to_string());
    let app_cfg = AppConfig::load_from_file(&cfg_path)
        .map_err(|e| std::io::Error::other(format!("load config: {e}")))?;

    init_tracing(&app_cfg.log_level);
    info!(
        service = "wp_monitor",
        version = env!("CARGO_PKG_VERSION"),
        log_level = %app_cfg.log_level,
        "service.startup"
    );

    let state = web::Data::new(
        AppState::build(&app_cfg).map_err(|e| std::io::Error::other(format!("init deps: {e}")))?,
    );

    HttpServer::new(move || {
        App::new()
            .app_data(state.clone())
            .service(
                web::scope("/api/v1/wp-monitor")
                    .configure(register_vm_routes)
                    .configure(register_vlog_routes)
                    .configure(register_wf_routes),
            )
            .configure(register_static_assets)
    })
    .bind(("0.0.0.0", 18080))?
    .run()
    .await
}
