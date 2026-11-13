use crate::shared::error::{AppError, AppReason};
use orion_error::{conversion::ToStructError, prelude::*};
use std::fs;
use std::path::Path;

/// 应用配置结构：
/// - vm_base_url：VictoriaMetrics 地址；
/// - vlog_base_url：VictoriaLogs 地址；
/// - wparse_exclude_labels：普通 wparse 图表查询中需要排除的非空标签；
/// - log_level：日志等级。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct AppConfig {
    pub vm_base_url: String,
    #[serde(default = "default_log_level")]
    pub log_level: String,

    pub vlog_base_url: Option<String>,

    pub miss_file_path: Option<String>,

    /// 普通 wparse source/parse/sink 图表需排除的标签名。
    /// 配置缺省时排除租户指标标签 `tenant_id`。
    #[serde(default = "default_wparse_exclude_labels")]
    pub wparse_exclude_labels: Vec<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            vm_base_url: "http://127.0.0.1:8428".to_string(),
            vlog_base_url: Some("http://127.0.0.1:9428".to_string()),
            log_level: default_log_level(),
            miss_file_path: None,
            wparse_exclude_labels: default_wparse_exclude_labels(),
        }
    }
}

fn default_log_level() -> String {
    "info".to_string()
}

fn default_wparse_exclude_labels() -> Vec<String> {
    vec!["tenant_id".to_string()]
}

fn is_valid_prometheus_label_name(name: &str) -> bool {
    let mut chars = name.bytes();
    matches!(chars.next(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_'))
        && chars.all(|ch| matches!(ch, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

impl AppConfig {
    /// 从 TOML 配置文件加载应用配置。
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, AppError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(AppReason::ConfigNotFound
                .to_err()
                .with_detail(path.display().to_string()));
        }
        let raw =
            fs::read_to_string(path).source_err(AppReason::ConfigReadFailed, "read config file")?;
        let config = toml::from_str::<Self>(&raw)
            .source_raw_err(AppReason::ConfigParseFailed, "parse config toml")?;
        if let Some(label) = config
            .wparse_exclude_labels
            .iter()
            .find(|label| !is_valid_prometheus_label_name(label))
        {
            return Err(AppReason::ConfigParseFailed
                .to_err()
                .with_detail(format!("invalid wparse_exclude_labels label name: {label}")));
        }
        Ok(config)
    }
}
