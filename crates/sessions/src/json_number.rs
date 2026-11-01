//! JSON.parse represents integral decimal syntax as the same JS number as integer syntax.
use serde::{Deserialize, Deserializer, de::Error};

fn integer<E: Error>(value: serde_json::Value, max: f64) -> Result<u64, E> {
    let n = value
        .as_f64()
        .ok_or_else(|| E::custom("expected JSON number"))?;
    if !n.is_finite() || n < 0.0 || n > max || n.fract() != 0.0 {
        return Err(E::custom("expected nonnegative integral JSON number"));
    }
    Ok(n as u64)
}

pub fn u64_safe<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    integer(
        serde_json::Value::deserialize(deserializer)?,
        9_007_199_254_740_991.0,
    )
}

pub fn u32_value<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    integer(
        serde_json::Value::deserialize(deserializer)?,
        u32::MAX as f64,
    )
    .map(|n| n as u32)
}

pub fn optional_u64_safe<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    value
        .map(|v| integer(v, 9_007_199_254_740_991.0))
        .transpose()
}
