/// 统一 API 响应包装。
#[derive(Debug, serde::Serialize)]
pub struct ApiResponse<T> {
    pub code: i32,
    pub message: String,
    pub data: T,
}

impl<T> ApiResponse<T> {
    /// 成功响应快捷构造。
    pub fn ok(data: T) -> Self {
        Self {
            code: 0,
            message: "ok".to_string(),
            data,
        }
    }
}

/// 就绪探针返回结构。
#[derive(Debug, serde::Serialize)]
pub struct ReadyResponse {
    pub status: String,
}
