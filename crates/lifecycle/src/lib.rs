//! Unactivated P6e lifecycle decisions. Callers supply snapshots, clocks, IDs and
//! effect results; this crate performs no filesystem, process or plugin work.
pub mod attention;
pub mod clients;
mod diagnostics;
pub mod hosts;
pub mod jobs;
mod js;
pub mod notify;
pub mod runner_check;
pub use js::Text as JsText;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Debug, Deserialize, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Error {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}
impl Error {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            hint: None,
        }
    }
    pub fn value(&self) -> Value {
        json!({"error":self})
    }
}
pub(crate) fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub(crate) fn n(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
pub(crate) fn a(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
pub(crate) fn truth(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(_) => n(v) != 0.0,
        _ => true,
    }
}
pub(crate) fn now(c: &Value) -> f64 {
    c["now"].as_f64().unwrap_or(100.0)
}
pub(crate) fn event(events: &mut Vec<Value>, kind: &str, name: &str, detail: Option<&str>) {
    let mut e = json!({"type":kind,"name":name});
    if let Some(d) = detail {
        e["detail"] = d.into();
    }
    events.push(e);
}
