//! `observationSchema` (`src/dispatch/types.ts`) and `storedObservations`
//! (`src/dispatch/refresh.ts`).
use rusqlite::{Connection, types::ValueRef};
use serde_json::{Value, json};

use crate::js::{Object, at, num, number};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const TIERS: &[&str] = &["small", "medium", "frontier", "unknown"];
/// `observationMethodSchema`, in the order `collectObservations` asks for them.
pub const METHODS: &[&str] = &["models", "capabilities", "usage", "health", "actual-model"];
const STATES: &[&str] = &["known", "unknown", "unsupported", "error"];

/// `z.string().min(1).max(256)`.
fn name(value: Option<&Value>) -> Option<Value> {
    let text = value?.as_str()?;
    (1..=256)
        .contains(&text.chars().count())
        .then(|| json!(text))
}

/// A `.strict()` object: unknown keys fail.
fn strict<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a Object> {
    let map = value.as_object()?;
    map.keys()
        .all(|key| keys.contains(&key.as_str()))
        .then_some(map)
}

fn boolean(value: &Value) -> Option<Value> {
    value.is_boolean().then(|| value.clone())
}

/// `z.number().int().positive()`.
fn positive_int(value: &Value) -> Option<Value> {
    let n = number(Some(value))?;
    (n.fract() == 0.0 && n > 0.0 && n <= MAX_SAFE).then(|| num(n))
}

/// Copies an optional key through `check`; `None` when the value fails it.
fn optional(
    map: &Object,
    key: &str,
    out: &mut Object,
    check: impl Fn(&Value) -> Option<Value>,
) -> Option<()> {
    if let Some(value) = map.get(key) {
        out.insert(key.into(), check(value)?);
    }
    Some(())
}

fn list(value: &Value, max: usize, item: impl Fn(&Value) -> Option<Value>) -> Option<Value> {
    let items = value.as_array().filter(|items| items.len() <= max)?;
    items
        .iter()
        .map(item)
        .collect::<Option<_>>()
        .map(Value::Array)
}

fn binding(value: &Value) -> Option<Value> {
    match value.get("kind")?.as_str()? {
        "exact" => {
            let map = strict(value, &["kind", "id"])?;
            Some(json!({"kind": "exact", "id": name(map.get("id"))?}))
        }
        "executor-default" => strict(value, &["kind"]).map(|_| json!({"kind": "executor-default"})),
        _ => None,
    }
}

/// `modelDeclarationSchema`, with its `tier` and `strengths` defaults.
fn declaration(value: &Value) -> Option<Value> {
    let map = strict(value, &["id", "tier", "strengths", "tools", "context"])?;
    let mut out = Object::new();
    out.insert("id".into(), name(map.get("id"))?);
    let tier = match map.get("tier") {
        None => "unknown",
        Some(tier) => tier.as_str().filter(|tier| TIERS.contains(tier))?,
    };
    out.insert("tier".into(), json!(tier));
    let strengths = match map.get("strengths") {
        None => json!([]),
        Some(strengths) => list(strengths, 64, |s| name(Some(s)))?,
    };
    out.insert("strengths".into(), strengths);
    optional(map, "tools", &mut out, boolean)?;
    optional(map, "context", &mut out, positive_int)?;
    Some(Value::Object(out))
}

fn window(value: &Value) -> Option<Value> {
    let map = strict(value, &["pool", "usedPct", "hoursLeft"])?;
    let used = number(map.get("usedPct")).filter(|n| (0.0..=100.0).contains(n))?;
    let mut out = Object::new();
    out.insert("pool".into(), name(map.get("pool"))?);
    out.insert("usedPct".into(), num(used));
    optional(map, "hoursLeft", &mut out, |v| {
        number(Some(v)).filter(|n| *n > 0.0).map(num)
    })?;
    Some(Value::Object(out))
}

fn observation_value(value: &Value) -> Option<Value> {
    let keys = [
        "models",
        "tools",
        "context",
        "model",
        "healthy",
        "unmetered",
        "windows",
        "cost",
    ];
    let map = strict(value, &keys)?;
    let mut out = Object::new();
    optional(map, "models", &mut out, |v| list(v, 512, declaration))?;
    optional(map, "tools", &mut out, boolean)?;
    optional(map, "context", &mut out, positive_int)?;
    optional(map, "model", &mut out, |v| name(Some(v)))?;
    optional(map, "healthy", &mut out, boolean)?;
    optional(map, "unmetered", &mut out, boolean)?;
    optional(map, "windows", &mut out, |v| list(v, 64, window))?;
    optional(map, "cost", &mut out, |v| {
        number(Some(v)).filter(|n| *n >= 0.0).map(num)
    })?;
    Some(Value::Object(out))
}

/// `observationSchema.safeParse`: the parsed observation in schema key order.
pub fn parse_observation(value: &Value) -> Option<Object> {
    let keys = [
        "source",
        "scope",
        "method",
        "state",
        "observedAt",
        "expiresAt",
        "value",
    ];
    let map = strict(value, &keys)?;
    let scope = strict(map.get("scope")?, &["runner", "account", "binding"])?;
    let mut parsed_scope = Object::new();
    parsed_scope.insert("runner".into(), name(scope.get("runner"))?);
    parsed_scope.insert("account".into(), name(scope.get("account"))?);
    optional(scope, "binding", &mut parsed_scope, binding)?;
    let pick = |key: &str, options: &[&str]| {
        let text = map.get(key)?.as_str()?;
        options.contains(&text).then(|| json!(text))
    };
    let mut out = Object::new();
    out.insert("source".into(), name(map.get("source"))?);
    out.insert("scope".into(), Value::Object(parsed_scope));
    out.insert("method".into(), pick("method", METHODS)?);
    out.insert("state".into(), pick("state", STATES)?);
    for key in ["observedAt", "expiresAt"] {
        out.insert(key.into(), num(number(map.get(key))?));
    }
    optional(map, "value", &mut out, observation_value)?;
    Some(out)
}

/// One `work_observations.data` cell that parses and has not expired.
pub(crate) fn stored_row(data: ValueRef<'_>, now: f64) -> Option<Object> {
    let ValueRef::Text(data) = data else {
        return None;
    };
    serde_json::from_slice::<Value>(data)
        .ok()
        .and_then(|value| parse_observation(&value))
        .filter(|o| at(o, "expiresAt") > now)
}

/// `storedObservations`: the newest 2,048 rows that parse and have not expired.
pub fn stored_observations(db: &Connection, now: f64) -> rusqlite::Result<Vec<Object>> {
    let mut stmt = db.prepare("SELECT data FROM work_observations ORDER BY at DESC LIMIT 2048")?;
    let mut rows = stmt.query([])?;
    let mut out = Vec::new();
    while let Some(row) = rows.next()? {
        out.extend(stored_row(row.get_ref(0)?, now));
    }
    Ok(out)
}

/// A `known` observation whose window covers `now`.
pub(crate) fn live(observation: &Object, now: f64) -> bool {
    observation.get("state") == Some(&json!("known"))
        && at(observation, "observedAt") <= now
        && at(observation, "expiresAt") > now
}
