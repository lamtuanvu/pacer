//! Native plugin UI/settings reads and X3 mutation handlers, wired on HTTP (P4d-3) and stdio
//! (wave 3); [`ipc`] is the private Core channel both doors share.
pub mod config;
pub mod ipc;
pub use pacer_js_json::quoted as json;
pub mod mutations;
mod private;
pub mod public;
pub mod settings;
pub mod ui;
pub use config::read_config as public_config;
