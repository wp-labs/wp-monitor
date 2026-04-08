use tracing_subscriber::EnvFilter;

/// 统一初始化全局 tracing 日志格式。
///
/// 约定：
/// - 单行紧凑格式，便于终端阅读与日志平台采集；
/// - 固定输出 target + level + 时间戳，减少各模块格式漂移；
/// - 日志级别由配置传入，非法值自动回退到 `info`。
pub fn init_tracing(log_level: &str) {
    let env_filter = EnvFilter::try_new(log_level).unwrap_or_else(|e| {
        eprintln!(
            "invalid log_level '{}': {}, fallback to 'info'",
            log_level, e
        );
        EnvFilter::new("info")
    });

    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_target(true)
        .with_level(true)
        .compact()
        .init();
}
