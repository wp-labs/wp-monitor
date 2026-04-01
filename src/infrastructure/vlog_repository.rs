#[derive(Debug, thiserror::Error)]
pub enum VlogRepoError {
    #[error("vlog request failed: {0}")]
    Request(String),
    #[error("vlog response invalid: {0}")]
    InvalidResponse(String),
}

