//! `decisionHash` (`src/dispatch/engines.ts`).
use pacer_js_json::stringify;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::js::js_cmp;

/// `canonical(value)`: object keys sorted by JavaScript `<` (UTF-16 code units),
/// everything else as `JSON.stringify` writes it. TypeScript drops `undefined`
/// members; callers omit those keys.
pub fn canonical(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out);
    out
}

fn write(value: &Value, out: &mut String) {
    match value {
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|(a, _), (b, _)| js_cmp(a, b));
            out.push('{');
            for (i, (key, value)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&stringify(&Value::String(key.clone())));
                out.push(':');
                write(value, out);
            }
            out.push('}');
        }
        other => out.push_str(&stringify(other)),
    }
}

/// `decisionHash(value)`: the lowercase hex SHA-256 of [`canonical`].
pub fn decision_hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonical(value).as_bytes()))
}
