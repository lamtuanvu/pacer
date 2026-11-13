//! Client protocol transports and native operation dispatch.
pub use pacer_mcp as mcp;
mod core_process;
pub mod native;
mod stdio_plugins;
mod stdio_proxy;
pub use pacer_read_model::v2_compat;
pub use stdio_proxy::{run_stdio, run_stdio_blocking};
pub mod serve;

pub use serve::{run_serve, run_serve_blocking};
