//! The queue no-op comparison: equal iff the admission parser
//! (`lifecycle::json::Value::parse`) of both `to_json()` renderings would compare
//! equal, computed on the exact documents without rendering or reparsing them.
use crate::WireReply;
use crate::ast::{Kind, Node};
use serde_json::Number;
use std::collections::HashMap;

/// The admission parser's canonical numeric form (lifecycle `js_numbers`),
/// restated here so lifecycle stays untouched. serde Number equality is per
/// variant, so `1 == 1.0` and `+0 != -0`.
#[derive(PartialEq)]
enum Canonical {
    Unsigned(u64),
    Signed(i64),
    Float(f64),
}

/// The binary64 of the serde-rendered token, as the old path parsed it.
fn canonical(number: &Number) -> Option<Canonical> {
    let n = serde_json::to_string(number).ok()?.parse::<f64>().ok()?;
    Some(if n == 0.0 && n.is_sign_negative() {
        Canonical::Float(n)
    } else if n.fract() == 0.0 && (0.0..18_446_744_073_709_551_616.0).contains(&n) {
        Canonical::Unsigned(n as u64)
    } else if n.fract() == 0.0 && (-9_223_372_036_854_775_808.0..0.0).contains(&n) {
        Canonical::Signed(n as i64)
    } else {
        Canonical::Float(n)
    })
}

fn equal(left: &Node, right: &Node) -> bool {
    let mut stack = vec![(left, right)];
    while let Some((left, right)) = stack.pop() {
        match (&left.kind, &right.kind) {
            // Overflow renders null, for either sign.
            (Kind::Null | Kind::Overflow { .. }, Kind::Null | Kind::Overflow { .. }) => {}
            (Kind::Bool(a), Kind::Bool(b)) if a == b => {}
            (Kind::Number(a), Kind::Number(b)) => match (canonical(a), canonical(b)) {
                (Some(a), Some(b)) if a == b => {}
                _ => return false,
            },
            (Kind::String(a), Kind::String(b)) if a == b => {}
            (Kind::Array(a), Kind::Array(b)) if a.len() == b.len() => stack.extend(a.iter().zip(b)),
            // Keys are unique per object, so equal counts plus every left key
            // present on the right is a bijection. Order does not matter.
            (Kind::Object(a), Kind::Object(b)) if a.len() == b.len() => {
                let right: HashMap<&[u16], &Node> =
                    b.iter().map(|(key, node)| (key.as_slice(), node)).collect();
                for (key, node) in a {
                    let Some(other) = right.get(key.as_slice()) else {
                        return false;
                    };
                    stack.push((node, other));
                }
            }
            _ => return false,
        }
    }
    true
}

impl WireReply {
    /// Equal iff `lifecycle::json::Value::parse` of both `to_json()` renderings
    /// would compare equal: unordered members, exact UTF-16 keys and strings,
    /// admission binary64 numbers with signed zero distinct, Overflow as null.
    /// Projection metadata never takes part. Deliberately not `PartialEq`.
    pub fn admission_json_eq(&self, other: &Self) -> bool {
        equal(&self.root, &other.root)
    }
}
