//! Native `discovery.set` and `discovery.respond` (`src/api/ops-discovery.ts`,
//! `src/discovery/state.ts`). Both are locked read-modify-writes of
//! `discovery/state.json` followed by a `discovery` config publication.
//!
//! Reads and `discovery.network.*` need the current-network probe, and
//! `respond` `pair` hands over to a pairing plugin; those stay forwarded. So
//! does a state file that Rust cannot rewrite with `JSON.stringify` bytes and
//! semantics: unreadable or unparsable text, non-integer or unsafe numbers,
//! array-index or `__proto__` keys, or fields of a type the handlers would
//! coerce.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    ctx::unix_now,
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use serde_json::{Map, Value, json};
use std::path::PathBuf;

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const SILENCE_LATER_S: i64 = 7 * 24 * 3600;
const ACTIONS: &[&str] = &["pair", "later", "ignore", "mute-network"];
/// Names an `Object.prototype` member, so `networks[name]` is truthy without an entry.
const PROTOTYPE: &[&str] = &[
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

fn path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("discovery").join("state.json")
}

/// `readState`: the merged document and whether the file failed closed.
struct State {
    doc: Map<String, Value>,
    corrupt: bool,
}

impl State {
    fn empty() -> Map<String, Value> {
        let Value::Object(doc) = json!({"rev":0,"networksRev":0,"enabled":true,"networks":{},"silenced":{},"seen":{},"prompts":[]})
        else {
            unreachable!("object literal")
        };
        doc
    }

    fn object(&self, key: &str) -> Option<&Map<String, Value>> {
        self.doc.get(key).and_then(Value::as_object)
    }

    fn settings(&self) -> String {
        serde_json::to_string(&json!([self.doc["enabled"], self.doc["networks"]]))
            .unwrap_or_default()
    }
}

/// An array index key is ordered first by JavaScript objects.
fn array_index(key: &str) -> bool {
    key.parse::<u32>()
        .is_ok_and(|n| n != u32::MAX && n.to_string() == key)
}

/// Whether `JSON.stringify(JSON.parse(text))` equals serde's rendering of the value.
fn canonical(value: &Value) -> bool {
    match value {
        Value::Number(n) => n
            .as_i64()
            .map(|n| n as f64)
            .or_else(|| n.as_u64().map(|n| n as f64))
            .is_some_and(|n| n.abs() <= MAX_SAFE),
        Value::Array(items) => items.iter().all(canonical),
        Value::Object(map) => canonical_members(map),
        _ => true,
    }
}

fn canonical_members(map: &Map<String, Value>) -> bool {
    map.iter()
        .all(|(k, v)| k != "__proto__" && !array_index(k) && canonical(v))
}

/// `readState`, or None when this state must stay with TypeScript.
fn read_state(ctx: &Ctx) -> Option<State> {
    let bytes = match std::fs::read(path(ctx)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Some(State {
                doc: State::empty(),
                corrupt: false,
            });
        }
        Err(_) => return None,
    };
    let raw: Value = serde_json::from_slice(&bytes).ok()?;
    let Value::Object(raw) = raw else {
        let mut doc = State::empty();
        doc.insert("enabled".into(), json!(false));
        return Some(State { doc, corrupt: true });
    };
    let typed = |key: &str, ok: fn(&Value) -> bool| raw.get(key).is_none_or(ok);
    if !canonical_members(&raw)
        || !typed("rev", Value::is_number)
        || !typed("networksRev", Value::is_number)
        || !["networks", "silenced", "seen"]
            .iter()
            .all(|key| typed(key, Value::is_object))
    {
        return None;
    }
    let mut doc = State::empty();
    for (key, value) in &raw {
        if key != "corrupt" {
            doc.insert(key.clone(), value.clone());
        }
    }
    let enabled = raw.get("enabled") != Some(&Value::Bool(false));
    doc.insert("enabled".into(), json!(enabled));
    Some(State {
        doc,
        corrupt: false,
    })
}

/// The `mute-network` target: the found machine's network names an entry key
/// that is absent, falsy or an object.
fn mute_target_native(state: &State, seen: &Map<String, Value>) -> bool {
    let Some(Value::String(network)) = seen.get("network") else {
        return false;
    };
    !PROTOTYPE.contains(&network.as_str())
        && state
            .object("networks")
            .and_then(|networks| networks.get(network))
            .is_none_or(|entry| entry.is_object() || !truthy(entry))
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn discovery_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "discovery.set" => read_state(ctx).is_none(),
        "discovery.respond" => {
            let action = params.get("action").and_then(Value::as_str);
            if action == Some("pair") {
                return true;
            }
            let Some(state) = read_state(ctx) else {
                return true;
            };
            let id = params.get("discoveryId").and_then(Value::as_str);
            match id.and_then(|id| state.object("seen")?.get(id)) {
                None => false,
                Some(Value::Object(seen)) => {
                    action == Some("mute-network") && !mute_target_native(&state, seen)
                }
                Some(_) => true,
            }
        }
        _ => false,
    }
}

/// `updateState`: locked read-modify-write with the networksRev check.
fn update_state(
    ctx: &Ctx,
    expect: Option<i64>,
    recover: bool,
    change: impl FnOnce(&mut State) -> Result<(), CoreError>,
) -> Result<State, CoreError> {
    with_lock(ctx, "discovery", LockOptions::default(), || {
        let mut state = read_state(ctx).ok_or_else(|| {
            CoreError::new(
                Code::Unavailable,
                "The discovery state file changed while it was being updated",
            )
            .hint("Try again.")
        })?;
        if state.corrupt && !recover {
            return Err(CoreError::new(
                Code::Conflict,
                "The discovery state file could not be read",
            )
            .hint("Turn discovery on again to start over."));
        }
        let actual = state.doc["networksRev"].as_i64().unwrap_or(0);
        if let Some(expected) = expect
            && actual != expected
        {
            let mut data = Map::new();
            data.insert("expected".into(), json!(expected));
            data.insert("actual".into(), json!(actual));
            return Err(CoreError::new(
                Code::Conflict,
                "Discovery settings changed in another client",
            )
            .hint("Reload and try again.")
            .data(data));
        }
        let before = state.settings();
        change(&mut state)?;
        state.corrupt = false;
        let rev = state.doc["rev"].as_i64().unwrap_or(0);
        state.doc.insert("rev".into(), json!(rev + 1));
        if state.settings() != before {
            state.doc.insert("networksRev".into(), json!(actual + 1));
        }
        let mut bytes = serde_json::to_vec_pretty(&state.doc)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        bytes.push(b'\n');
        write_private(&path(ctx), &bytes)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        Ok(state)
    })
    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
}

/// `z.number().int().nonnegative().safe()`
fn expect_rev(value: &Value, issues: &mut Vec<String>) -> Option<i64> {
    let Some(n) = value.as_f64() else {
        issues.push(format!(
            "expect_rev: Invalid input: expected number, received {}",
            type_name(value)
        ));
        return None;
    };
    if n.fract() != 0.0 {
        issues.push("expect_rev: Invalid input: expected int, received number".into());
        return None;
    }
    let before = issues.len();
    let safe = |issues: &mut Vec<String>| {
        if n > MAX_SAFE {
            issues.push("expect_rev: Too big: expected int to be <=9007199254740991".into());
        }
        if n < -MAX_SAFE {
            issues.push("expect_rev: Too small: expected int to be >=-9007199254740991".into());
        }
    };
    safe(issues);
    if n < 0.0 {
        issues.push("expect_rev: Too small: expected number to be >=0".into());
    }
    safe(issues);
    (issues.len() == before).then_some(n as i64)
}

fn object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(other)
        ))),
    }
}

fn authorize(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

fn done(issues: Vec<String>) -> Result<(), CoreError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(invalid(issues.join("; ")))
    }
}

pub fn discovery_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = object(&params)?;
        let mut issues = Vec::new();
        let enabled = match p.get("enabled") {
            Some(Value::Bool(b)) => Some(*b),
            other => {
                issues.push(format!(
                    "enabled: Invalid input: expected boolean, received {}",
                    other.map_or("undefined", type_name)
                ));
                None
            }
        };
        let expect = p.get("expect_rev").and_then(|v| expect_rev(v, &mut issues));
        done(issues)?;
        let enabled = enabled.unwrap_or_default();
        let state = update_state(ctx, expect, true, |s| {
            s.doc.insert("enabled".into(), json!(enabled));
            Ok(())
        })?;
        Ok(json!({
            "enabled": state.doc["enabled"],
            "rev": state.doc["rev"],
            "networksRev": state.doc["networksRev"],
        }))
    })
}

/// `later`, `ignore` and `mute-network`; `pair` stays forwarded.
pub fn discovery_respond(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = object(&params)?;
        let mut issues = Vec::new();
        let id = match p.get("discoveryId") {
            Some(Value::String(id))
                if id.len() == 26
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b)) =>
            {
                Some(id.clone())
            }
            Some(Value::String(_)) => {
                issues.push(
                    "discoveryId: Invalid string: must match pattern /^[a-z2-7]{26}$/".into(),
                );
                None
            }
            other => {
                issues.push(format!(
                    "discoveryId: Invalid input: expected string, received {}",
                    other.map_or("undefined", type_name)
                ));
                None
            }
        };
        let action = match p.get("action").and_then(Value::as_str) {
            Some(action) if ACTIONS.contains(&action) => Some(action.to_owned()),
            _ => {
                issues.push(
                    "action: Invalid option: expected one of \"pair\"|\"later\"|\"ignore\"|\"mute-network\""
                        .into(),
                );
                None
            }
        };
        done(issues)?;
        let (id, action) = (id.unwrap_or_default(), action.unwrap_or_default());
        let unusable = || {
            CoreError::new(
                Code::Unavailable,
                "The discovery state file changed while it was being updated",
            )
            .hint("Try again.")
        };
        let state = read_state(ctx).ok_or_else(unusable)?;
        let seen = match state.object("seen").and_then(|seen| seen.get(&id)) {
            Some(Value::Object(seen)) => seen.clone(),
            None => {
                return Err(CoreError::new(
                    Code::NotFound,
                    "That machine is no longer in the list.",
                ));
            }
            Some(_) => return Err(unusable()),
        };
        if action == "pair" {
            return Err(CoreError::new(
                Code::Unavailable,
                "pairing hand-over requires the forwarded discovery.respond operation",
            ));
        }
        let now = unix_now().floor() as i64;
        update_state(ctx, None, false, |s| {
            match action.as_str() {
                "later" | "ignore" => {
                    let value = if action == "later" {
                        json!(now + SILENCE_LATER_S)
                    } else {
                        json!("forever")
                    };
                    s.doc
                        .get_mut("silenced")
                        .and_then(Value::as_object_mut)
                        .ok_or_else(unusable)?
                        .insert(id.clone(), value);
                }
                _ => {
                    if !mute_target_native(s, &seen) {
                        return Err(unusable());
                    }
                    let network = seen["network"].as_str().unwrap_or_default();
                    if let Some(Value::Object(entry)) = s
                        .doc
                        .get_mut("networks")
                        .and_then(|networks| networks.get_mut(network))
                    {
                        entry.insert("muted".into(), json!(true));
                    }
                }
            }
            Ok(())
        })?;
        Ok(json!({"ok": true}))
    })
}

#[cfg(test)]
mod tests;
