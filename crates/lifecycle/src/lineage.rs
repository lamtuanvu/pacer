use crate::{AdmissionError, schema};
use serde_json::{Value, json};

/// Build a work node after the caller has loaded the task and its ancestors in
/// the same write transaction. `ancestors` starts with the immediate parent;
/// counts are the existing descendant counts for those ancestors.
pub fn work_node(
    id: &str,
    task: &Value,
    requested: &Value,
    ancestors: &[(Value, Value, usize)],
    root_descendants: usize,
) -> Result<Value, AdmissionError> {
    let normalized = crate::brief::js_numbers(requested);
    let requested = &normalized;
    let mut options = schema::dispatch(requested)?;
    if ancestors.is_empty() {
        if options["delegationEnforcement"] != "strict" {
            return Err(AdmissionError(
                "New managed work requires strict delegation enforcement".into(),
            ));
        }
        return Ok(
            json!({"taskId":id,"parentId":null,"rootId":id,"depth":0,"options":options,"dependencies":[]}),
        );
    }
    let (parent, parent_task, _) = &ancestors[0];
    let (root, _, _) = &ancestors[ancestors.len() - 1];
    let p = &parent["options"];
    if p["delegationEnforcement"] == "strict" && options["delegationEnforcement"] != "strict" {
        return Err(AdmissionError(
            "Child cannot weaken strict delegation enforcement".into(),
        ));
    }
    if root["options"]["allowDelegation"] != true || parent_task["state"] != "running" {
        return Err(AdmissionError("Parent cannot delegate".into()));
    }
    if task.pointer("/brief/repo") != parent_task.pointer("/brief/repo") {
        return Err(AdmissionError(
            "Child repository must match its parent".into(),
        ));
    }
    let depth = parent["depth"]
        .as_u64()
        .ok_or_else(|| AdmissionError("Invalid parent depth".into()))?
        + 1;
    if depth > p["maxDepth"].as_u64().unwrap_or(0) {
        return Err(AdmissionError("Delegation depth limit reached".into()));
    }
    if root_descendants >= root["options"]["maxDescendants"].as_u64().unwrap_or(0) as usize {
        return Err(AdmissionError("Descendant limit reached".into()));
    }
    for (ancestor, _, count) in ancestors {
        if *count >= ancestor["options"]["maxDescendants"].as_u64().unwrap_or(0) as usize {
            return Err(AdmissionError("Ancestor descendant limit reached".into()));
        }
    }
    let inherited = &p["requirements"];
    let child = &options["requirements"];
    if inherited.get("tools").is_some()
        && child.get("tools").is_some()
        && inherited["tools"] != child["tools"]
    {
        return Err(AdmissionError(
            "Cannot relax inherited tools requirement".into(),
        ));
    }
    let tier = |v: &Value| match v.as_str() {
        Some("small") => 0,
        Some("medium") => 1,
        Some("frontier") => 2,
        _ => -1,
    };
    if child.get("minTier").is_some()
        && inherited.get("minTier").is_some()
        && tier(&child["minTier"]) < tier(&inherited["minTier"])
    {
        return Err(AdmissionError("Cannot lower inherited model tier".into()));
    }
    let mut requirements = child.as_object().cloned().unwrap_or_default();
    if let Some(map) = inherited.as_object() {
        requirements.extend(map.clone());
    }
    if let Some(value) = child.get("minTier").or_else(|| inherited.get("minTier")) {
        requirements.insert("minTier".into(), value.clone());
    }
    let context = inherited["context"]
        .as_f64()
        .unwrap_or(0.0)
        .max(child["context"].as_f64().unwrap_or(0.0));
    if context > 0.0 {
        requirements.insert("context".into(), json!(context));
    }
    options["requirements"] = Value::Object(requirements);
    options["allowDelegation"] = json!(
        p["allowDelegation"] == true
            && requested
                .get("allowDelegation")
                .unwrap_or(&p["allowDelegation"])
                == true
    );
    for key in ["maxDepth", "maxDescendants", "maxConcurrent", "maxAttempts"] {
        let parent_value = p[key].as_u64().unwrap_or(0);
        options[key] = json!(parent_value.min(requested[key].as_u64().unwrap_or(parent_value)));
    }
    let expiry = options["expiresAt"]
        .as_f64()
        .unwrap_or(f64::INFINITY)
        .min(p["expiresAt"].as_f64().unwrap_or(f64::INFINITY));
    if expiry.is_finite() {
        options["expiresAt"] = json!(expiry);
    } else if let Some(map) = options.as_object_mut() {
        map.remove("expiresAt");
    }
    Ok(
        json!({"taskId":id,"parentId":parent["taskId"],"rootId":parent["rootId"],"depth":depth,"options":options,"dependencies":[]}),
    )
}
