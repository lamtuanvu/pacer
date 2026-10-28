//! Platforms without the descriptor-relative checks of `open_file.rs` offer no
//! file hand-off (ADR 0011); the page then renders neither action.
use serde_json::{json, Value};
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Open,
    Reveal,
}
impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "open" => Some(Self::Open),
            "reveal" => Some(Self::Reveal),
            _ => None,
        }
    }
}

pub fn host_actions(_home: &Path) -> Value {
    json!({"open": false, "reason": null, "reveal": false, "revealLabel": null})
}

pub fn hand_off(_resolution: &Value, _action: Action, _home: &Path) -> Result<(), String> {
    Err("Opening files is not supported on this platform".into())
}
