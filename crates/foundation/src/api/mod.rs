//! Pure native-operation contracts; transports and implementations live above foundation.
mod error;
mod registry;
pub use error::{Code, CoreError};
pub use registry::{NativeOp, OpFuture, Registry, params};
