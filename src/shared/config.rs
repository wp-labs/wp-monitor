use std::fs;
use std::path::Path;

/// 应用配置结构：
/// - vm_base_url：VictoriaMetrics 地址；
/// - vlog_base_url：VictoriaLogs 地址；
/// - log_level：日志等级。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct AppConfig {
    pub vm_base_url: String,
    #[serde(default = "default_log_level")]
    pub log_level: String,

    pub vlog_base_url: String,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            vm_base_url: "http://127.0.0.1:8428".to_string(),
            vlog_base_url: "http://127.0.0.1:9428".to_string(),
            log_level: default_log_level(),
        }
    }
}

fn default_log_level() -> String {
    "info".to_string()
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("config file not found: {0}")]
    NotFound(String),
    #[error("config file read failed: {0}")]
    ReadFailed(String),
    #[error("config file parse failed: {0}")]
    ParseFailed(String),
}

impl AppConfig {
    /// 从 TOML 配置文件加载应用配置。
    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let path = path.as_ref();
        if !path.exists() {
            return Err(ConfigError::NotFound(path.display().to_string()));
        }
        let raw = fs::read_to_string(path).map_err(|e| ConfigError::ReadFailed(e.to_string()))?;
        toml::from_str::<Self>(&raw).map_err(|e| ConfigError::ParseFailed(e.to_string()))
    }
}
