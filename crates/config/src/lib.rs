//! Byte-preserving strategy YAML edits. No public operation is registered here.

pub mod config_writes;
pub mod doc;
pub mod executor_settings;
pub mod host;
mod js_semantics;
mod notification_json;
pub mod notifications;
mod sections;
pub mod strategy;
pub mod strategy_write;
mod temp_file;
pub mod write;

pub use js_semantics::normalize_json;
pub mod settings;
mod settings_execution;

mod strategy_validation;
mod yaml_value;
