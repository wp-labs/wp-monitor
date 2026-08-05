use crate::domain::vlog_repository::{VlogInstantQuery, VlogRecord};
use crate::shared::error::{AppError, AppReason};
use orion_error::{OperationContext, prelude::*};
use reqwest::Client;
use tracing::debug;

/// 基于 HTTP 协议访问 VLOG 的仓储实现。
#[derive(Clone)]
pub struct VlogHttpRepository {
    client: Client,
    base_url: String,
}

impl VlogHttpRepository {
    /// 创建仓储实例，自动去掉 base_url 尾部 `/`，避免 URL 拼接重复分隔符。
    pub fn new(base_url: impl Into<String>) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .expect("reqwest client build"),
            base_url: base_url.into().trim_end_matches('/').to_string(),
        }
    }

    /// 执行 instant query（单时刻查询）。
    pub async fn instant_query(
        &self,
        query: &VlogInstantQuery,
    ) -> Result<Vec<VlogRecord>, AppError> {
        let url = format!("{}/select/logsql/query", self.base_url);
        let ctx = OperationContext::doing("log instance query")
            .with_field("url", url.clone())
            .with_field("query sql", query.query.clone());
        let params = &[
            ("start", &query.start.to_rfc3339()),
            ("end", &query.end.to_rfc3339()),
            ("query", &query.query),
            ("limit", &query.limit.to_string()),
        ];
        debug!(
            start_time = %query.start,
            end_time = %query.end,
            limit = query.limit,
            "vlog_repository.instant_query.start"
        );
        let resp = self
            .client
            .get(url)
            .query(params)
            .send()
            .await
            .source_raw_err(
                AppReason::VlogRequestFailed,
                "vlog instant query http request failed",
            )
            .with_context(&ctx)?;
        let body = resp
            .text()
            .await
            .source_raw_err(
                AppReason::VlogRequestFailed,
                "vlog instant query response body read failed",
            )
            .with_context(&ctx)?;
        let records = Self::parse_records(&body)?;
        debug!(
            record_count = records.len(),
            "vlog_repository.instant_query.success"
        );
        Ok(records)
    }

    /// 查询 miss 数据总量。
    pub async fn count_hits(&self, query: &str) -> Result<u64, AppError> {
        let url = format!("{}/select/logsql/hits", self.base_url);
        let ctx = OperationContext::doing("log hits query")
            .with_field("url", url.clone())
            .with_field("query", query.to_string());
        let resp = self
            .client
            .get(&url)
            .query(&[("query", query), ("step", "100y")])
            .send()
            .await
            .source_raw_err(
                AppReason::VlogRequestFailed,
                "vlog hits query http request failed",
            )
            .with_context(&ctx)?;
        let body = resp
            .text()
            .await
            .source_raw_err(
                AppReason::VlogRequestFailed,
                "vlog hits query response body read failed",
            )
            .with_context(&ctx)?;
        let parsed: serde_json::Value = serde_json::from_str(&body)
            .source_raw_err(AppReason::VlogResponseInvalid, "parse vlog hits response")?;
        let total = parsed["hits"][0]["total"].as_u64().unwrap_or(0);
        debug!(total = total, "vlog_repository.count_hits.success");
        Ok(total)
    }

    /// 解析 VLOG 查询响应：
    /// - 支持 JSON 数组：`[{...}, {...}]`
    /// - 支持多个 JSON 对象拼接：`{...}{...}` 或按换行分隔对象
    fn parse_records(body: &str) -> Result<Vec<VlogRecord>, AppError> {
        let trimmed = body.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        if trimmed.starts_with('[') {
            return serde_json::from_str::<Vec<VlogRecord>>(trimmed).source_err(
                AppReason::VlogResponseInvalid,
                "vlog json array response parsing failed",
            );
        }

        let mut records = Vec::new();
        let iter = serde_json::Deserializer::from_str(trimmed).into_iter::<VlogRecord>();
        for item in iter {
            let record = item.source_err(
                AppReason::VlogResponseInvalid,
                "vlog json record parsing failed",
            )?;
            records.push(record);
        }
        Ok(records)
    }

    pub async fn clear_miss_data(&self, query: &str) -> Result<(), AppError> {
        let url = format!("{}/delete/run_task", self.base_url);

        let ctx = OperationContext::doing("clear miss data").with_field("url", url.clone());
        let resp = self
            .client
            .post(&url)
            .query(&[("filter", query)])
            .send()
            .await
            .source_raw_err(
                AppReason::VlogRequestFailed,
                "vlog clear miss data http request failed",
            )
            .with_context(&ctx)?;
        if !resp.status().is_success() {
            return Err(AppError::new(
                AppReason::VlogRequestFailed,
                format!(
                    "vlog clear miss data request failed with status: {}",
                    resp.status()
                )
                .into(),
                None,
                Vec::new(),
            ));
        }
        debug!("vlog_repository.clear_miss_data.success");
        Ok(())
    }
}

#[cfg(test)]
pub mod tests {

    use super::*;

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
