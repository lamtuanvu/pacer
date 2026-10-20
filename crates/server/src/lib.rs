//! Client protocol transports and native operation dispatch.
pub mod native;
mod stdio_proxy;
pub use stdio_proxy::{run_stdio, run_stdio_blocking};
pub mod serve;

pub use serve::{run_serve, run_serve_blocking};
