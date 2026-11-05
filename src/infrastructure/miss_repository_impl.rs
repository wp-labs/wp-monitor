use crate::domain::miss_repository::{MissQuery, MissRecord, MissRepository};
use crate::domain::vlog_repository::VlogInstantQuery;
use crate::infrastructure::file_repository::FileRepository;
use crate::infrastructure::vlog_repository::VlogHttpRepository;
use crate::shared::error::{AppError, AppReason};
use async_trait::async_trait;
use orion_error::conversion::{SourceRawErr, ToStructError};
use std::sync::Arc;
use tokio::sync::RwLock;

const DEFAULT_MISS_QUERY: &str = "wp_stage:miss";
const MAX_EXPORT_ROWS: u32 = 5000;

/// 基于文件的 Miss 仓储实现。
pub struct FileMissRepository {
    file: Arc<FileRepository>,
    lock: RwLock<()>,
}

impl FileMissRepository {
    pub fn new(file_path: &str) -> Result<Self, AppError> {
        let file = FileRepository::new(file_path)?;
        Ok(Self {
            file: Arc::new(file),
            lock: RwLock::new(()),
        })
    }
}

#[async_trait]
impl MissRepository for FileMissRepository {
    async fn fetch_records(&self, query: MissQuery) -> Result<Vec<MissRecord>, AppError> {
        let _lock = self.lock.read().await; // Acquire read lock to ensure thread safety
        let file = Arc::clone(&self.file);
        let limit = query.limit;
        let records = tokio::task::spawn_blocking(move || file.tail_records(limit))
            .await
            .map_err(|e| {
                AppReason::FileReadFailed
                    .to_err()
                    .with_detail(format!("spawn_blocking failed: {e}"))
            })??;

        Ok(records
            .into_iter()
            .map(|r| MissRecord {
                content: r.lines().nth(1).unwrap_or("").to_string(),
            })
            .collect())
    }

    async fn count_total(&self) -> Result<u64, AppError> {
        let file = Arc::clone(&self.file);
        tokio::task::spawn_blocking(move || file.count_records().map(|c| c as u64))
            .await
            .map_err(|e| {
                AppReason::FileReadFailed
                    .to_err()
                    .with_detail(format!("count_records spawn_blocking failed: {e}"))
            })?
    }

    async fn clear_miss_data(&self, _query: &str) -> Result<(), AppError> {
        let _lock = self.lock.write().await; // Acquire write lock to ensure thread safety
        let file = Arc::clone(&self.file);
        tokio::task::spawn_blocking(move || {
            // 清空文件内容
            std::fs::write(&file.file_path, "")
                .source_raw_err(AppReason::FileReadFailed, "clear miss data failed")?;
            Ok(())
        })
        .await
        .map_err(|e| {
            AppReason::FileReadFailed
                .to_err()
                .with_detail(format!("clear_miss_data spawn_blocking failed: {e}"))
        })?
    }
}

/// 基于 VictoriaLogs 的 Miss 仓储实现。
#[derive(Clone)]
pub struct VlogMissRepository {
    vlog: VlogHttpRepository,
}

impl VlogMissRepository {
    pub fn new(vlog: VlogHttpRepository) -> Self {
        Self { vlog }
    }
}

#[async_trait]
impl MissRepository for VlogMissRepository {
    async fn fetch_records(&self, query: MissQuery) -> Result<Vec<MissRecord>, AppError> {
        let logsql = match query.query {
            Some(ref q) if q.contains('|') => q.clone(),
            Some(q) => format!(
                "{} | sort by (_time) desc | limit {}",
                q,
                query.limit.min(MAX_EXPORT_ROWS as usize)
            ),
            None => format!(
                "{} | sort by (_time) desc | limit {}",
                DEFAULT_MISS_QUERY,
                query.limit.min(MAX_EXPORT_ROWS as usize)
            ),
        };
        let vq = VlogInstantQuery {
            query: logsql,
            limit: query.limit as u32,
            start: query.start,
            end: query.end,
        };
        let records = self.vlog.instant_query(&vq).await?;
        Ok(records
            .into_iter()
            .map(|r| {
                let content = r.raw.lines().nth(1).unwrap_or("").to_string();
                MissRecord { content }
            })
            .collect())
    }

    async fn count_total(&self) -> Result<u64, AppError> {
        self.vlog.count_hits(DEFAULT_MISS_QUERY).await
    }

    async fn clear_miss_data(&self, query: &str) -> Result<(), AppError> {
        self.vlog.clear_miss_data(query).await
    }
}
