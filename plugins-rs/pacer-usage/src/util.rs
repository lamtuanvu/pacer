//! Shared value helpers for pacer-usage readers, port of `plugins/pacer-usage/util.ts`.

use serde_json::Value;
use std::sync::OnceLock;

/// `^-?\d+(\.\d+)?$` — a numeric string exactly (no exponent, no `+` sign),
/// matching the TS regex in `util.ts:8`.
fn numeric_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"^-?\d+(\.\d+)?$")
            .unwrap_or_else(|e| panic!("numeric regex must be valid: {e}"))
    })
}

fn second_to_f64(ts: jiff::Timestamp) -> f64 {
    ts.as_second() as f64 + (ts.subsec_nanosecond() as f64) / 1e9
}

/// Parse an ISO-8601 string to unix seconds. `Z`/explicit-offset strings are
/// exact; a date-time with no offset uses the system (local) time zone; a
/// bare date is UTC midnight. Matches the TS `Date.parse` semantics the plan
/// relies on (`util.ts:12`). Non-ISO strings return `None` (a documented
/// deviation from Bun's lenient `Date.parse`, recorded in the review report).
fn parse_iso(s: &str) -> Option<f64> {
    if let Ok(ts) = s.parse::<jiff::Timestamp>() {
        return Some(second_to_f64(ts));
    }
    if let Ok(dt) = s.parse::<jiff::civil::DateTime>()
        && let Ok(z) = dt.to_zoned(jiff::tz::TimeZone::system())
    {
        return Some(second_to_f64(z.timestamp()));
    }
    if let Ok(d) = s.parse::<jiff::civil::Date>()
        && let Ok(z) = d.to_zoned(jiff::tz::TimeZone::UTC)
    {
        return Some(second_to_f64(z.timestamp()));
    }
    None
}

/// Unix seconds from unix s/ms (number or numeric string) or ISO-8601; `None`
/// when unparseable (`util.ts:1-14`).
pub fn parse_ts(raw: &Value) -> Option<f64> {
    match raw {
        Value::Null => None,
        Value::Number(n) => {
            let v = n.as_f64()?;
            if !v.is_finite() {
                return None;
            }
            Some(if v > 1e12 { v / 1000.0 } else { v })
        }
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                return None;
            }
            if numeric_re().is_match(s) {
                let v: f64 = s.parse().ok()?;
                return Some(if v > 1e12 { v / 1000.0 } else { v });
            }
            parse_iso(s)
        }
        _ => None,
    }
}

/// A finite number, else `None` (`util.ts:16-18`).
pub fn to_num(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => {
            let v = n.as_f64()?;
            if v.is_finite() {
                Some(v)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// A non-null, non-array object (`util.ts:20-22`).
pub fn is_obj(v: &Value) -> bool {
    matches!(v, Value::Object(_))
}