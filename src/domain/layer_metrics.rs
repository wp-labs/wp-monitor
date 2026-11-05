#[derive(Debug, Clone, Copy, serde::Deserialize, serde::Serialize)]
pub struct LayerMetrics {
    /// 今日截至当前日志总量
    pub today_log_total: u64,
    /// 最近 1 分钟增量
    pub last_minute_increment: u64,
    /// 今日分析量
    pub today_analyzed_total: u64,
}
