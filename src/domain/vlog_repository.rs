use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// VLOG 查询参数。
#[derive(Debug, Clone)]
pub struct VlogInstantQuery {
    pub query: String,
    pub limit: u32,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
}

/// VLOG 单条日志记录。
///
/// 仅解析业务必需字段：`_time`、`_stream_id`、`_stream`、`_msg`、`raw`。
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
