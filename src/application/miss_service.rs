use crate::domain::miss_repository::{MissQuery, MissRecord, MissRepository};
use crate::shared::error::{AppError, AppReason};
use orion_error::conversion::ToStructError;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use std::sync::Arc;

/// Miss 数据源类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MissSource {
    File,
    Vlog,
}

impl FromStr for MissSource {
    type Err = AppError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "file" => Ok(MissSource::File),
            "vlog" => Ok(MissSource::Vlog),
            _ => Err(AppReason::InvalidMissSource
                .to_err()
                .with_detail(format!("invalid miss source '{}'", s))),
        }
    }
}

/// Miss 数据查询应用服务。
pub struct MissService {
    repository: Arc<dyn MissRepository>,
}

impl MissService {
    pub fn new(repository: Arc<dyn MissRepository>) -> Self {
        Self { repository }
    }

    pub fn repository(&self) -> &Arc<dyn MissRepository> {
        &self.repository
    }

    pub async fn fetch_records(&self, query: MissQuery) -> Result<Vec<MissRecord>, AppError> {
        self.repository.fetch_records(query).await
    }

    pub async fn count_total(&self) -> Result<u64, AppError> {
        self.repository.count_total().await
    }
}
