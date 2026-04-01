use crate::interfaces::vlog::handlers::VlogInstantQuery;
use async_trait::async_trait;
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};

/// VM 仓储错误：
/// - Request：网络请求/连接错误；
/// - InvalidResponse：响应 JSON 结构不符合预期。
#[derive(Debug, thiserror::Error)]
pub enum VlogRepoError {
    #[error("vlog request failed: {0}")]
    Request(String),
    #[error("vlog response invalid: {0}")]
    InvalidResponse(String),
}

/// VLOG 单条日志记录。
///
/// 仅解析业务必需字段：
/// - `_time`
/// - `_stream_id`
/// - `_stream`
/// - `_msg`
/// - `raw`
///
/// 其余字段由 serde 默认忽略，确保接口对字段扩展兼容。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VlogRecord {
    #[serde(rename = "_time")]
    pub time: String,
    #[serde(rename = "_stream_id")]
    pub stream_id: String,
    #[serde(rename = "_stream")]
    pub stream: String,
    #[serde(rename = "_msg")]
    pub msg: String,
    pub raw: String,
}

/// VLOG 仓储抽象：
/// - instant_query：查一次“当前时刻”聚合快照；
/// - fetch_node_timeseries：按节点拉区间序列。
#[async_trait]
pub trait VlogRepository: Send + Sync {
    async fn instant_query(
        &self,
        query: VlogInstantQuery,
    ) -> Result<Vec<VlogRecord>, VlogRepoError>;
}

/// 基于 HTTP 协议访问 VLOG 的仓储实现。
pub struct VlogHttpRepository {
    client: Client,
    base_url: String,
}

impl VlogHttpRepository {
    /// 创建仓储实例，自动去掉 base_url 尾部 `/`，避免 URL 拼接重复分隔符。
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::new(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// 执行 instant query（单时刻查询）。
    async fn instant_query(
        &self,
        query: &VlogInstantQuery,
    ) -> Result<Vec<VlogRecord>, VlogRepoError> {
        let url = format!("{}/select/logsql/query", self.base_url);
        let params = &[
            ("start", &query.start.to_rfc3339()),
            ("end", &query.end.to_rfc3339()),
            ("query", &query.query),
            ("limit", &query.limit.to_string()),
        ];
        let resp = self
            .client
            .get(url)
            .query(params)
            .send()
            .await
            .map_err(|e| VlogRepoError::Request(e.to_string()))?;
        let body = resp
            .text()
            .await
            .map_err(|e| VlogRepoError::Request(e.to_string()))?;
        Self::parse_records(&body)
    }

    /// 解析 VLOG 查询响应：
    /// - 支持 JSON 数组：`[{...}, {...}]`
    /// - 支持多个 JSON 对象拼接：`{...}{...}` 或按换行分隔对象
    fn parse_records(body: &str) -> Result<Vec<VlogRecord>, VlogRepoError> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        if trimmed.starts_with('[') {
            return serde_json::from_str::<Vec<VlogRecord>>(trimmed)
                .map_err(|e| VlogRepoError::InvalidResponse(e.to_string()));
        }

        let mut records = Vec::new();
        let iter = serde_json::Deserializer::from_str(trimmed).into_iter::<VlogRecord>();
        for item in iter {
            let record = item.map_err(|e| VlogRepoError::InvalidResponse(e.to_string()))?;
            records.push(record);
        }
        Ok(records)
    }
}

#[async_trait]
impl VlogRepository for VlogHttpRepository {
    async fn instant_query(
        &self,
        query: VlogInstantQuery,
    ) -> Result<Vec<VlogRecord>, VlogRepoError> {
        let vlog_query = VlogInstantQuery {
            query: query.query.clone(),
            limit: query.limit,
            start: query.start.with_timezone(&Utc),
            end: query.end.with_timezone(&Utc),
        };
        self.instant_query(&vlog_query).await
    }
}

#[cfg(test)]
pub mod tests {

    use super::*;

    // #[tokio::test]
    // async fn test_instant_query() {
    //     let repo = VlogHttpRepository::new("http://localhost:9428".to_string());
    //     let vlog_query = VlogInstantQuery {
    //         query: "wp_stage:miss".to_string(),
    //         limit: 100,
    //         start: Utc.with_ymd_and_hms(2026, 3, 31, 23, 0, 0).unwrap(),
    //         end: Utc.with_ymd_and_hms(2026, 4, 1, 11, 1, 0).unwrap(),
    //     };
    //     let resp = repo.instant_query(&vlog_query).await.unwrap();
    //     println!("{:#?}", resp);
    // }

    #[test]
    fn test_parse_concatenated_json_records() {
        let body = r#"{
    "_time": "2026-04-01T02:29:43.680555Z",
    "_stream_id": "0000000000000000e934a84adb05276890d7f7bfcadabe92",
    "_stream": "{}",
    "_msg": "{\"raw\":\"first\"}",
    "raw": "first",
    "extra_field": "ignored"
}{
    "_time": "2026-04-01T02:29:43.641403Z",
    "_stream_id": "0000000000000000e934a84adb05276890d7f7bfcadabe92",
    "_stream": "{}",
    "_msg": "{\"raw\":\"second\"}",
    "raw": "second"
}"#;

        let records = VlogHttpRepository::parse_records(body).unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].raw, "first");
        assert_eq!(records[1].raw, "second");
    }
}
