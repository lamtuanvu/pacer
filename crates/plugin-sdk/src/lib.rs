//! Rust plugin SDK for pacer.

mod error;
mod host;
mod serve;
#[cfg(feature = "testing")]
pub mod testing;
pub mod wire;

/// Plugin protocol types, re-exported from the generated protocol crates (CRATE-3 area split).
pub mod types {
    pub use pacer_plugin_agent_session_protocol::*;
    pub use pacer_plugin_decision_protocol::*;
    pub use pacer_plugin_exec_protocol::*;
    pub use pacer_plugin_hosts_protocol::*;
    pub use pacer_plugin_install_protocol::*;
    pub use pacer_plugin_protocol::*;
    // Every protocol crate emits these; the entry crate's definitions take precedence.
    pub use pacer_plugin_protocol::{PacerPluginProtocol170, VERSION, error};
}

pub use error::PluginError;
pub use host::{Host, MachineSignature};
pub use serve::{Ctx, HandlerResult, Manifest, Plugin, Progress};
pub use tokio_util::sync::CancellationToken;
