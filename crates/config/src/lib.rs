//! Byte-preserving strategy YAML edits. No public operation is registered here.

pub mod config_writes;
pub mod doc;
mod js_semantics;
mod notification_json;
pub mod notifications;
mod sections;
pub mod strategy;
pub mod strategy_write;
pub mod write;

pub use js_semantics::normalize_json;
