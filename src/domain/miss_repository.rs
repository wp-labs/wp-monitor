use crate::shared::error::AppError;
use async_trait::async_trait;
use chrono::{DateTime, Utc};

/// Miss 日志记录（领域实体）。
#[derive(Debug, Clone)]
pub struct MissRecord {
    pub content: String,
}

/// Miss 查询参数（领域概念）。
#[derive(Debug, Clone)]
pub struct MissQuery {
    pub limit: usize,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub query: Option<String>,
}

/// Miss 数据仓储抽象（领域层定义，基础设施层实现）。
#[async_trait]
pub trait MissRepository: Send + Sync {
    /// 获取 miss 记录。
    async fn fetch_records(&self, query: MissQuery) -> Result<Vec<MissRecord>, AppError>;
    /// 获取 miss 数据总量。
    async fn count_total(&self) -> Result<u64, AppError>;
    /// 清空miss数据
    async fn clear_miss_data(&self, query: &str) -> Result<(), AppError>;
}
