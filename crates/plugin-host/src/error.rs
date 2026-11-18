//! The capability error shared by the host library and the native capability brokers.
use crate::authority::AuthorityError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BrokerError {
    #[error("Policy hash key cannot be accessed safely")]
    PolicyKey,
    #[error("{0}")]
    PolicyVeto(String),
    #[error(transparent)]
    Authority(#[from] AuthorityError),
    #[error("invalid capability parameters: {0}")]
    Invalid(&'static str),
    #[error("capability deadline passed")]
    Timeout,
    #[error("effect failed: {0}")]
    Effect(String),
    #[error("host lease failed: {0}")]
    HostLease(String),
}

/// Task store failures in the native executor effects deny the call. The orphan rule keeps this
/// impl beside `BrokerError`.
impl From<pacer_store::StoreError> for BrokerError {
    fn from(_: pacer_store::StoreError) -> Self {
        AuthorityError::Denied("executor run owner or source changed".into()).into()
    }
}
