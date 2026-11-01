//! Byte-preserving strategy YAML edits. No public operation is registered here.

pub mod doc;
pub mod host;
mod sections;
pub mod strategy;
pub mod strategy_write;
pub mod write;

pub(crate) fn js_integer(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && n.fract() == 0.)
}

pub(crate) fn js_safe_integer(value: &serde_json::Value) -> Option<f64> {
    js_integer(value).filter(|n| n.abs() <= 9_007_199_254_740_991.)
}
