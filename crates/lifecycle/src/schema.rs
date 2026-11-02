use crate::brief::AdmissionError;
use crate::json::{Map, Value};
use serde_json::json;

const SAFE_MAX: f64 = 9_007_199_254_740_991.0;

fn object<'a>(value: &'a Value, fields: &[&str], name: &str) -> Result<&'a Map, AdmissionError> {
    let map = value
        .as_object()
        .ok_or_else(|| AdmissionError(format!("{name}: Expected object")))?;
    if let Some(key) = map
        .keys()
        .find(|key| !key.as_str().is_some_and(|s| fields.contains(&s)))
    {
        return Err(AdmissionError(format!("{name}.{key}: Unrecognized key")));
    }
    Ok(map)
}

fn string(value: &Value, name: &str, min: usize, max: usize) -> Result<(), AdmissionError> {
    let s = value
        .as_js_string()
        .ok_or_else(|| AdmissionError(format!("{name}: Expected string")))?;
    if !(min..=max).contains(&s.codepoint_len()) {
        return Err(AdmissionError(format!("{name}: invalid length")));
    }
    Ok(())
}

fn number(
    value: &Value,
    name: &str,
    min: f64,
    max: f64,
    integer: bool,
) -> Result<(), AdmissionError> {
    let n = value
        .as_f64()
        .ok_or_else(|| AdmissionError(format!("{name}: Expected number")))?;
    if !n.is_finite() || n < min || n > max || (integer && (n.fract() != 0.0 || n.abs() > SAFE_MAX))
    {
        return Err(AdmissionError(format!("{name}: invalid number")));
    }
    Ok(())
}

fn boolean(value: &Value, name: &str) -> Result<(), AdmissionError> {
    if !value.is_boolean() {
        return Err(AdmissionError(format!("{name}: Expected boolean")));
    }
    Ok(())
}

fn one_of(value: &Value, name: &str, options: &[&str]) -> Result<(), AdmissionError> {
    if !value.as_str().is_some_and(|v| options.contains(&v)) {
        return Err(AdmissionError(format!("{name}: Invalid option")));
    }
    Ok(())
}

fn names(value: &Value, name: &str, max: usize) -> Result<(), AdmissionError> {
    let array = value
        .as_array()
        .ok_or_else(|| AdmissionError(format!("{name}: Expected array")))?;
    if array.len() > max {
        return Err(AdmissionError(format!("{name}: Too many items")));
    }
    for item in array {
        string(item, name, 1, 256)?;
    }
    Ok(())
}

fn requirements(value: &Value) -> Result<(), AdmissionError> {
    let map = object(
        value,
        &["minTier", "tools", "context"],
        "dispatch.requirements",
    )?;
    for (key, v) in map {
        let k = key.as_str().unwrap_or("");
        match k {
            "minTier" => one_of(v, k, &["small", "medium", "frontier"])?,
            "tools" => boolean(v, k)?,
            "context" => number(v, k, 1.0, SAFE_MAX, true)?,
            _ => unreachable!(),
        }
    }
    Ok(())
}

fn preferences(value: &Value) -> Result<Value, AdmissionError> {
    let map = object(value, &["models", "strengths"], "dispatch.preferences")?;
    if let Some(v) = map.get("models") {
        names(v, "models", 256)?;
    }
    if let Some(v) = map.get("strengths") {
        names(v, "strengths", 64)?;
    }
    let mut result = map.clone();
    result.entry("models").or_insert_with(|| json!([]).into());
    result
        .entry("strengths")
        .or_insert_with(|| json!([]).into());
    Ok(Value::Object(result))
}

pub(crate) fn dispatch(value: &Value) -> Result<Value, AdmissionError> {
    let fields = [
        "requirements",
        "preferences",
        "model",
        "kind",
        "difficulty",
        "delegationEnforcement",
        "allowDelegation",
        "maxDepth",
        "maxDescendants",
        "maxConcurrent",
        "maxAttempts",
        "priority",
        "expiresAt",
        "estimatePct",
    ];
    let map = object(value, &fields, "dispatch")?;
    let mut result = map.clone();
    for (key, v) in map {
        let k = key.as_str().unwrap_or("");
        match k {
            "requirements" => requirements(v)?,
            "preferences" => {
                result.insert(key.clone(), preferences(v)?);
            }
            "model" => string(v, k, 1, 256)?,
            "kind" => string(v, k, 1, 128)?,
            "difficulty" => one_of(v, k, &["simple", "standard", "complex"])?,
            "delegationEnforcement" => one_of(v, k, &["strict", "cooperative"])?,
            "allowDelegation" => boolean(v, k)?,
            "maxDepth" => number(v, k, 1.0, 10.0, true)?,
            "maxDescendants" => number(v, k, 1.0, 1000.0, true)?,
            "maxConcurrent" => number(v, k, 1.0, 64.0, true)?,
            "maxAttempts" => number(v, k, 1.0, 20.0, true)?,
            "priority" => number(v, k, -100.0, 100.0, true)?,
            "expiresAt" => {
                number(v, k, 0.0, f64::MAX, false)?;
                if v.as_f64() == Some(0.0) {
                    return Err(AdmissionError("expiresAt: invalid number".into()));
                }
            }
            "estimatePct" => number(v, k, 0.0, 100.0, false)?,
            _ => unreachable!(),
        }
    }
    for (k, v) in [
        ("requirements", json!({})),
        ("preferences", json!({"models":[],"strengths":[]})),
        ("difficulty", json!("standard")),
        ("delegationEnforcement", json!("strict")),
        ("allowDelegation", json!(false)),
        ("maxDepth", json!(3)),
        ("maxDescendants", json!(20)),
        ("maxConcurrent", json!(4)),
        ("maxAttempts", json!(3)),
        ("priority", json!(0)),
        ("estimatePct", json!(0)),
    ] {
        result.entry(k).or_insert_with(|| v.into());
    }
    Ok(Value::Object(result))
}

fn rule(value: &Value) -> Result<(), AdmissionError> {
    let fields = [
        "effect",
        "from_kind",
        "to_kind",
        "from_position",
        "relation",
        "kinds",
        "repo",
        "executor",
        "grant",
        "limits",
    ];
    let map = object(value, &fields, "messaging.rules")?;
    let effect = map
        .get("effect")
        .ok_or_else(|| AdmissionError("effect: Required".into()))?;
    one_of(effect, "effect", &["allow", "deny"])?;
    for (key, v) in map {
        let k = key.as_str().unwrap_or("");
        match k {
            "effect" => (),
            "from_kind" | "to_kind" => {
                one_of(v, k, &["human", "external", "launched", "broker", "any"])?
            }
            "from_position" => one_of(v, k, &["top", "child", "any"])?,
            "relation" => {
                if v != "any" {
                    let a = v
                        .as_array()
                        .ok_or_else(|| AdmissionError(format!("{k}: Expected array")))?;
                    if a.is_empty() {
                        return Err(AdmissionError(format!("{k}: Too few items")));
                    }
                    for x in a {
                        one_of(
                            x,
                            k,
                            &[
                                "self",
                                "parent",
                                "child",
                                "sibling",
                                "descendant",
                                "ancestor",
                                "top_peer",
                                "same_tree",
                                "none",
                            ],
                        )?;
                    }
                }
            }
            "kinds" => {
                let a = v
                    .as_array()
                    .ok_or_else(|| AdmissionError(format!("{k}: Expected array")))?;
                if a.is_empty() {
                    return Err(AdmissionError(format!("{k}: Too few items")));
                }
                for x in a {
                    one_of(
                        x,
                        k,
                        &["message", "question", "answer", "report", "nudge", "close"],
                    )?;
                }
            }
            "repo" | "executor" => string(v, k, 1, usize::MAX)?,
            "grant" => one_of(v, k, &["required", "not_required"])?,
            "limits" => {
                let limits = object(v, &["per_minute", "max_bytes", "confirm"], "limits")?;
                for (limit_key, lv) in limits {
                    let lk = limit_key.as_str().unwrap_or("");
                    match lk {
                        "per_minute" => number(lv, lk, 1.0, SAFE_MAX, true)?,
                        "max_bytes" => number(lv, lk, 1.0, 1048576.0, true)?,
                        "confirm" => boolean(lv, lk)?,
                        _ => unreachable!(),
                    }
                }
            }
            _ => unreachable!(),
        }
    }
    Ok(())
}

pub(crate) fn messaging(value: &Value) -> Result<Value, AdmissionError> {
    let map = object(value, &["rules", "max_turns", "liveness"], "messaging")?;
    if let Some(v) = map.get("rules") {
        let rules = v
            .as_array()
            .ok_or_else(|| AdmissionError("rules: Expected array".into()))?;
        if rules.len() > 50 {
            return Err(AdmissionError("rules: Too many items".into()));
        }
        for r in rules {
            rule(r)?;
        }
    }
    if let Some(v) = map.get("max_turns") {
        number(v, "max_turns", 1.0, 10000.0, true)?;
    }
    if let Some(v) = map.get("liveness") {
        let l = object(
            v,
            &["interval_s", "max_nudges", "escalate_after_s"],
            "liveness",
        )?;
        for (key, v) in l {
            let k = key.as_str().unwrap_or("");
            match k {
                "interval_s" | "escalate_after_s" => number(v, k, 10.0, SAFE_MAX, true)?,
                "max_nudges" => number(v, k, 0.0, SAFE_MAX, true)?,
                _ => unreachable!(),
            }
        }
    }
    Ok(value.clone())
}
