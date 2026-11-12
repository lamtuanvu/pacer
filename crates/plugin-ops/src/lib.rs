//! Native plugin UI/settings reads and X3 mutation handlers (HTTP-wired in P4d-3).
pub mod config;
pub use pacer_js_json::quoted as json;
pub mod mutations;
mod private;
pub mod public;
pub mod settings;
pub mod ui;
pub use config::read_config as public_config;
