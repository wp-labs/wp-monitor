mod application;
mod domain;
mod infrastructure;
mod interfaces;
mod shared;

use actix_web::{App, HttpServer, web};
use infrastructure::vm_repository::{VmHttpRepository, VmRepository};
use interfaces::vm::routes::register_vm_routes;
use interfaces::vm::static_assets::register_static_assets;
use shared::config::AppConfig;
use shared::logging::init_tracing;
use std::sync::Arc;
use tracing::info;

use infrastructure::vlog_repository::VlogHttpRepository;

use crate::interfaces::vlog::routers::register_vlog_routes;

/// 后端启动入口：
/// 1. 初始化日志；
/// 2. 创建 VictoriaMetrics 仓储实现；
/// 3. 创建 VLOG 仓储实现；
/// 4. 组装应用服务并注入到 Actix；
/// 5. 注册 HTTP 路由并监听端口。
#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // CI 需要可执行文件支持 `--version` 并立即退出。
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    // 从配置文件加载应用配置（默认路径：config/app.toml）。
    let cfg_path =
        std::env::var("APP_CONFIG_PATH").unwrap_or_else(|_| "./config/app.toml".to_string());
    let app_cfg = AppConfig::load_from_file(&cfg_path)
        .map_err(|e| std::io::Error::other(format!("load config failed: {}", e)))?;

    // 统一日志格式初始化。
    init_tracing(&app_cfg.log_level);
    info!(
        service = "wp_monitor",
        version = env!("CARGO_PKG_VERSION"),
        log_level = %app_cfg.log_level,
        "service.startup"
    );

    let vm_base = app_cfg.vm_base_url.clone();
    let vm_repo: Arc<dyn VmRepository> = Arc::new(VmHttpRepository::new(vm_base));

    let vlog_http_repo = web::Data::new(VlogHttpRepository::new(app_cfg.vlog_base_url.clone()));

    let app_service = web::Data::new(application::layer_service::LayerService::new(
        vm_repo, app_cfg,
    ));

    HttpServer::new(move || {
        App::new()
            .app_data(app_service.clone())
            .app_data(vlog_http_repo.clone())
            .service(
                web::scope("/api/v1/wp-monitor")
                    .configure(register_vm_routes)
                    .configure(register_vlog_routes),
            )
            .configure(register_static_assets)
    })
    .bind(("0.0.0.0", 18080))?
    .run()
    .await
}
