//! Native plugin UI/settings operations and signed plugin distribution content.
pub mod archive;
mod config;
mod js_semantics;
pub mod json;
mod private;
pub mod public;
pub mod publishers;
pub mod settings;
pub mod ui;
pub use config::read_config as public_config;
pub use pacer_plugin_host::{ParsedManifest, parse_manifest};
