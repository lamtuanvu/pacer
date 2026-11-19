//! Core-bridge param validation for `desktop.update.*`
//! (`src/api/ops-desktop-update.ts`). The desktop update runtime is an
//! in-memory service registration only the TypeScript process owns, so Rust
//! validates each strict param set with Zod-order issue text, then the sealed
//! bridge runs the real handler, keeping effectful install/restart in Core.
#![allow(clippy::result_large_err)]
use pacer_foundation::api::CoreError;
use serde_json::{Map, Value, json};

use crate::host_read_ops::{invalid, type_name};

const IDENTIFIER: &str = "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";
const VERSION: &str = r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$";
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

const UPDATE_OPS: [&str; 8] = [
    "desktop.update.status",
    "desktop.update.check",
    "desktop.update.download",
    "desktop.update.restart",
    "desktop.update.cancel",
    "desktop.update.adopt",
    "desktop.update.adoptCancel",
    "desktop.update.configure",
];

pub fn needs_update_bridge(op: &str) -> bool {
    UPDATE_OPS.contains(&op)
}

fn is_identifier(text: &str) -> bool {
    let bytes = text.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

/// `z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)`.
fn identifier_issue(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) if is_identifier(text) => {}
        Some(Value::String(_)) => issues.push(format!(
            "{name}: Invalid string: must match pattern /{IDENTIFIER}/"
        )),
        other => issues.push(format!(
            "{name}: Invalid input: expected string, received {}",
            other.map_or("undefined", type_name)
        )),
    }
}

/// `z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)`, mirroring the
/// desktop.reconcile revision check exactly.
fn revision_issue(value: Option<&Value>, issues: &mut Vec<String>) {
    let Some(n) = value.and_then(Value::as_f64) else {
        issues.push(format!(
            "expectRevision: Invalid input: expected number, received {}",
            value.map_or("undefined", type_name)
        ));
        return;
    };
    if n.fract() != 0.0 {
        issues.push("expectRevision: Invalid input: expected int, received number".into());
        return;
    }
    if n > MAX_SAFE {
        issues.push("expectRevision: Too big: expected int to be <=9007199254740991".into());
    }
    if n < -MAX_SAFE {
        issues.push("expectRevision: Too small: expected int to be >=-9007199254740991".into());
    }
    if n < 0.0 {
        issues.push("expectRevision: Too small: expected number to be >=0".into());
    }
    if n > MAX_SAFE {
        issues.push("expectRevision: Too big: expected number to be <=9007199254740991".into());
    }
}

/// Semver for `desktop.update.restart` version.
fn version_issue(value: Option<&Value>, issues: &mut Vec<String>) {
    match value {
        Some(Value::String(text)) if is_semver(text) => {}
        Some(Value::String(_)) => {
            issues.push(format!(
                "version: Invalid string: must match pattern /{VERSION}/"
            ));
        }
        other => {
            issues.push(format!(
                "version: Invalid input: expected string, received {}",
                other.map_or("undefined", type_name)
            ));
        }
    }
}

/// A minimal semver matcher for the bounded restart pattern: major.minor.patch,
/// optional pre-release and build metadata of `[0-9A-Za-z.-]` segments.
fn is_semver(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.is_empty() || bytes.iter().any(|b| !b.is_ascii() || b.is_ascii_control()) {
        return false;
    }
    let mut parts = text.splitn(3, '.');
    let (Some(major), Some(minor)) = (parts.next(), parts.next()) else {
        return false;
    };
    let rest = parts.next().unwrap_or("");
    if major.is_empty() || minor.is_empty() {
        return false;
    }
    if rest.is_empty() {
        return false;
    }
    let (core, tail) = match rest.find(['-', '+']) {
        Some(sep) => rest.split_at(sep),
        None => (rest, ""),
    };
    if core.is_empty() {
        return false;
    }
    let numeric = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !numeric(major) || !numeric(minor) || !numeric(core) {
        return false;
    }
    if tail.is_empty() {
        return true;
    }
    let allowed = |s: &str| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    };
    // Pre-release vs build mark and segment legality.
    let (_, body) = tail.split_at(1);
    allowed(body)
}

/// `desktop.update.*` use strict objects, so unknown keys are reported last.
fn unknown_keys(map: &Map<String, Value>, known: &[&str], issues: &mut Vec<String>) {
    let unknown: Vec<String> = map
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("params: Unrecognized key: {}", unknown[0])),
        _ => issues.push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
    }
}

pub fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    let map = params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })?;
    let mut parsed = Map::new();
    let mut issues = Vec::new();
    let known = match op {
        "desktop.update.status" => &["installationId"][..],
        "desktop.update.restart" => {
            &["installationId", "requestId", "expectRevision", "version"][..]
        }
        "desktop.update.configure" => &[
            "installationId",
            "requestId",
            "expectRevision",
            "autoDownload",
        ][..],
        _ => &["installationId", "requestId", "expectRevision"][..],
    };
    // Shared request fields relevant to this op, in schema order.
    for field in known {
        match *field {
            "installationId" => {
                identifier_issue("installationId", map.get("installationId"), &mut issues)
            }
            "requestId" => identifier_issue("requestId", map.get("requestId"), &mut issues),
            "expectRevision" => revision_issue(map.get("expectRevision"), &mut issues),
            _ => {}
        }
    }
    match op {
        "desktop.update.restart" => version_issue(map.get("version"), &mut issues),
        "desktop.update.configure" => match map.get("autoDownload") {
            Some(Value::Bool(b)) => {
                parsed.insert("autoDownload".into(), (*b).into());
            }
            other => {
                issues.push(format!(
                    "autoDownload: Invalid input: expected boolean, received {}",
                    other.map_or("undefined", type_name)
                ));
            }
        },
        _ => {}
    }
    unknown_keys(map, known, &mut issues);
    if !issues.is_empty() {
        return Err(invalid(issues.join("; ")));
    }
    // Rebuild the strict shape (only installed ids remain).
    if map.get("installationId").is_some() {
        parsed.insert("installationId".into(), map["installationId"].clone());
    }
    if map.get("requestId").is_some() {
        parsed.insert("requestId".into(), map["requestId"].clone());
    }
    if map.get("expectRevision").is_some() {
        parsed.insert("expectRevision".into(), map["expectRevision"].clone());
    }
    if op == "desktop.update.restart" && map.get("version").is_some() {
        parsed.insert("version".into(), map["version"].clone());
    }
    Ok(json!({ "op": op, "params": parsed }))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn message(op: &str, params: Value) -> String {
        bridge_params(op, &params).unwrap_err().message
    }

    fn valid(op: &str) -> Value {
        bridge_params(
            op,
            &json!({"installationId": "abc", "requestId": "req1", "expectRevision": 0}),
        )
        .unwrap()
    }

    #[test]
    fn status_takes_only_installation_id() {
        assert_eq!(
            bridge_params("desktop.update.status", &json!({"installationId": "abc"})).unwrap(),
            json!({"op": "desktop.update.status", "params": {"installationId": "abc"}})
        );
        assert_eq!(
            message(
                "desktop.update.status",
                json!({"installationId": "abc", "x": 1})
            ),
            "params: Unrecognized key: \"x\""
        );
        assert_eq!(
            message("desktop.update.status", json!({})),
            "installationId: Invalid input: expected string, received undefined"
        );
    }

    #[test]
    fn request_ops_validate_shared_fields_and_reject_unknown() {
        assert_eq!(
            valid("desktop.update.check").get("op").unwrap(),
            "desktop.update.check"
        );
        assert_eq!(
            message(
                "desktop.update.check",
                json!({"installationId": "-", "requestId": 5, "expectRevision": 1e300, "z": 1})
            ),
            "installationId: Invalid string: must match pattern /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/; requestId: Invalid input: expected string, received number; expectRevision: Too big: expected int to be <=9007199254740991; expectRevision: Too big: expected number to be <=9007199254740991; params: Unrecognized key: \"z\""
        );
        assert_eq!(
            message(
                "desktop.update.download",
                json!({"installationId": "a", "requestId": "b", "expectRevision": -1.5})
            ),
            "expectRevision: Invalid input: expected int, received number"
        );
    }

    #[test]
    fn restart_requires_a_valid_semver_version() {
        let parsed = bridge_params(
            "desktop.update.restart",
            &json!({"installationId": "a", "requestId": "b", "expectRevision": 0, "version": "1.2.3-build.4"}),
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({"op": "desktop.update.restart", "params": {"installationId": "a", "requestId": "b", "expectRevision": 0, "version": "1.2.3-build.4"}})
        );
        assert_eq!(
            message(
                "desktop.update.restart",
                json!({"installationId": "a", "requestId": "b", "expectRevision": 0, "version": "nope"})
            ),
            "version: Invalid string: must match pattern /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/"
        );
        assert!(is_semver("0.0.0"));
        assert!(is_semver("1.2.3-rc.1+sha.abc"));
        assert!(!is_semver("1.2"));
        assert!(!is_semver("v1.2.3"));
        assert!(!is_semver("1.2.3 "));
    }

    #[test]
    fn configure_requires_a_boolean_auto_download() {
        let parsed = bridge_params(
            "desktop.update.configure",
            &json!({"installationId": "a", "requestId": "b", "expectRevision": 0, "autoDownload": true}),
        )
        .unwrap();
        assert!(
            parsed
                .get("params")
                .unwrap()
                .get("autoDownload")
                .unwrap()
                .as_bool()
                .unwrap()
        );
        assert_eq!(
            message(
                "desktop.update.configure",
                json!({"installationId": "a", "requestId": "b", "expectRevision": 0, "autoDownload": "yes"})
            ),
            "autoDownload: Invalid input: expected boolean, received string"
        );
    }

    #[test]
    fn adopt_and_cancel_share_the_request_shape() {
        for op in [
            "desktop.update.adopt",
            "desktop.update.adoptCancel",
            "desktop.update.cancel",
        ] {
            assert_eq!(valid(op).get("op").unwrap().as_str().unwrap(), op);
        }
        assert_eq!(
            message(
                "desktop.update.adopt",
                json!({"installationId": "a", "requestId": "b", "expectRevision": 0, "x": 1})
            ),
            "params: Unrecognized key: \"x\""
        );
    }
}
