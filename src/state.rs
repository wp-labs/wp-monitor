use crate::application::layer_service::LayerService;
use crate::application::miss_service::{MissService, MissSource};
use crate::application::wf_service::WfService;
use crate::domain::vm_repository::VmRepository;
use crate::domain::wf_repository::WfRepository;
use crate::infrastructure::miss_repository_impl::{FileMissRepository, VlogMissRepository};
use crate::infrastructure::vlog_repository::VlogHttpRepository;
use crate::infrastructure::vm_repository::VmHttpRepository;
use crate::infrastructure::wf_repository::WfVmRepository;
use crate::shared::config::AppConfig;
use crate::shared::error::{AppError, AppReason};
use orion_error::conversion::ToStructError;
use std::sync::Arc;
use tracing::info;

/// 应用全局依赖容器。
///
/// 在组合根 `main.rs` 中一次性构建，注入 Actix 后由各 handler 按需取用。
pub struct AppState {
    pub layer: LayerService,
    pub file_miss: Option<MissService>,
    pub vlog_miss: Option<MissService>,
    pub wf: WfService,
}

impl AppState {
    pub fn build(cfg: &AppConfig) -> Result<Self, AppError> {
        // ── 基础设施层 ──

        let vm_repo: Arc<dyn VmRepository> = Arc::new(VmHttpRepository::new(&cfg.vm_base_url));

        let vlog_repo = VlogHttpRepository::new(cfg.vlog_base_url.clone().unwrap_or_default());

        // 构建 File Miss 仓储（如果配置了 miss_file_path）
        let file_miss: Option<MissService> = match &cfg.miss_file_path {
            Some(path) => match FileMissRepository::new(path) {
                Ok(repo) => {
                    info!(miss_file_path = %path, "miss_repository.file_configured");
                    Some(MissService::new(Arc::new(repo)))
                }
                Err(e) => {
                    info!(
                        miss_file_path = %path,
                        error = %e,
                        "miss_repository.file_open_failed_skip"
                    );
                    None
                }
            },
            None => {
                info!("miss_repository.file_not_configured");
                None
            }
        };

        // 构建 Vlog Miss 仓储（如果配置了 vlog_base_url）
        let vlog_miss: Option<MissService> = match &cfg.vlog_base_url {
            Some(_) => {
                info!("miss_repository.vlog_configured");
                Some(MissService::new(Arc::new(VlogMissRepository::new(
                    vlog_repo.clone(),
                ))))
            }
            None => {
                info!("miss_repository.vlog_not_configured");
                None
            }
        };

        // 至少需要一个数据源
        if file_miss.is_none() && vlog_miss.is_none() {
            return Err(AppReason::ConfigNotFound.to_err().with_detail(
                "at least one of miss_file_path or vlog_base_url must be configured",
            ));
        }

        // ── wfusion 仓储 ──
        let wf_repo: Arc<dyn WfRepository> = Arc::new(WfVmRepository::new(&cfg.vm_base_url));

        // ── 应用层 ──

        let file_miss_repo = file_miss.as_ref().map(|s| s.repository().clone());
        let vlog_miss_repo = vlog_miss.as_ref().map(|s| s.repository().clone());

        Ok(Self {
            layer: LayerService::new(vm_repo, file_miss_repo, vlog_miss_repo, cfg.clone()),
            file_miss,
            vlog_miss,
            wf: WfService::new(wf_repo),
        })
    }

    /// 根据 MissSource 返回对应的 MissService。
    pub fn resolve_miss(&self, source: MissSource) -> Result<&MissService, AppError> {
        match source {
            MissSource::File => self.file_miss.as_ref().ok_or_else(|| {
                AppReason::ConfigNotFound
                    .to_err()
                    .with_detail("file miss source not configured")
            }),
            MissSource::Vlog => self.vlog_miss.as_ref().ok_or_else(|| {
                AppReason::ConfigNotFound
                    .to_err()
                    .with_detail("vlog miss source not configured")
            }),
        }
    }

    /// 返回可用的数据源列表。
    #[allow(dead_code)]
    pub fn available_sources(&self) -> Vec<MissSource> {
        let mut sources = Vec::new();
        if self.file_miss.is_some() {
            sources.push(MissSource::File);
        }
        if self.vlog_miss.is_some() {
            sources.push(MissSource::Vlog);
        }
        sources
    }
}
