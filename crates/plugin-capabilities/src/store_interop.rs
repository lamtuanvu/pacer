use crate::{AuthorityError, BrokerError};

fn denied() -> BrokerError {
    AuthorityError::Denied("executor run owner or source changed".into()).into()
}

impl From<pacer_store::StoreError> for BrokerError {
    fn from(_: pacer_store::StoreError) -> Self {
        denied()
    }
}
