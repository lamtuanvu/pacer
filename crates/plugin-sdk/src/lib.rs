//! Rust plugin SDK for pacer.

mod error;
mod host;
mod serve;
pub mod wire;

pub use error::PluginError;
pub use host::Host;
pub use pacer_plugin_protocol as types;
pub use serve::{Ctx, HandlerResult, Manifest, Plugin, Progress};
pub use tokio_util::sync::CancellationToken;
