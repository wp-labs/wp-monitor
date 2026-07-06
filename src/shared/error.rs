use actix_web::{HttpResponse, error::ResponseError};
use derive_more::From;
use orion_error::{prelude::*, protocol::DefaultExposurePolicy, reason::UnifiedReason};
use std::fmt::{self, Display};

/// 应用级统一错误原因。
#[derive(Debug, Clone, PartialEq, From, OrionError)]
pub enum AppReason {
    #[orion_error(identity = "conf.not_found")]
    ConfigNotFound,
    #[orion_error(identity = "conf.read_failed")]
    ConfigReadFailed,
    #[orion_error(identity = "conf.parse_failed")]
    ConfigParseFailed,

    #[orion_error(identity = "biz.invalid_time_range")]
    InvalidTimeRange,
    #[orion_error(identity = "biz.invalid_miss_source")]
    InvalidMissSource,

    #[orion_error(identity = "sys.vm_request_failed")]
    VmRequestFailed,
    #[orion_error(identity = "sys.vm_response_invalid")]
    VmResponseInvalid,

    #[orion_error(identity = "sys.vlog_request_failed")]
    VlogRequestFailed,
    #[orion_error(identity = "sys.vlog_response_invalid")]
    VlogResponseInvalid,

    #[orion_error(identity = "sys.file_read_failed")]
    FileReadFailed,

    #[orion_error(transparent)]
    General(UnifiedReason),
}

/// 应用级统一错误载体。
pub type AppError = StructError<AppReason>;

/// actix-web ResponseError 的 newtype 包装，解决 orphan rule。
#[derive(Debug)]
pub struct AppErrorResponse(pub AppError);

impl Display for AppErrorResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        Display::fmt(&self.0, f)
    }
}

impl std::error::Error for AppErrorResponse {}

impl From<AppError> for AppErrorResponse {
    fn from(err: AppError) -> Self {
        AppErrorResponse(err)
    }
}

impl ResponseError for AppErrorResponse {
    fn status_code(&self) -> actix_web::http::StatusCode {
        let policy = DefaultExposurePolicy;
        let proto = self.0.exposure(&policy);
        actix_web::http::StatusCode::from_u16(proto.decision.http_status)
            .unwrap_or(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR)
    }

    fn error_response(&self) -> HttpResponse {
        let policy = DefaultExposurePolicy;
        let proto = self.0.exposure(&policy);
        let body = proto.to_http_error_json().unwrap_or_else(|_| {
            serde_json::json!({
                "status": 500,
                "code": "sys.internal_error",
                "category": "sys",
                "message": "internal error",
                "visibility": "internal",
                "hints": []
            })
        });
        HttpResponse::build(self.status_code()).json(body)
    }
}
