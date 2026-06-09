use crate::domain::miss_repository::{MissQuery, MissRecord, MissRepository};
use crate::shared::error::AppError;
use std::sync::Arc;

/// Miss 数据源类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MissSource {
    File,
    Vlog,
}

/// Miss 数据查询应用服务。
pub struct MissService {
    repository: Arc<dyn MissRepository>,
    pub source: MissSource,
}

impl MissService {
    pub fn new(repository: Arc<dyn MissRepository>, source: MissSource) -> Self {
        Self { repository, source }
    }

    pub async fn fetch_records(&self, query: MissQuery) -> Result<Vec<MissRecord>, AppError> {
        self.repository.fetch_records(query).await
    }

    pub async fn count_total(&self) -> Result<u64, AppError> {
        self.repository.count_total().await
    }
}
