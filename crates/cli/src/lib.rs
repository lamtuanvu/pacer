//! Native CLI entry and compatibility handoff to the core.
pub mod core_exec;
mod dispatch;
pub mod status_line;
pub use dispatch::main;
