use pacer_plugin_protocol::Manifest;
use serde_json::Value;
use std::{collections::HashSet, ops::Deref};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ManifestError {
    #[error("invalid plugin manifest: {0}")]
    Invalid(String),
    #[error("plugin host range does not include this host")]
    IncompatibleHost,
}

/// Generated wire type plus source-key presence. The generated schema represents
/// optional contribution maps as empty maps, which otherwise loses `{ "usage": {} }`.
#[derive(Clone, Debug)]
pub struct ParsedManifest {
    pub wire: Manifest,
    pub declared_points: HashSet<String>,
}

impl Deref for ParsedManifest {
    type Target = Manifest;
    fn deref(&self) -> &Self::Target {
        &self.wire
    }
}

fn version(value: &str) -> Option<semver::Version> {
    semver::Version::parse(value).ok()
}

/// Match the deliberately small range grammar in `src/plugins/manifest.ts`.
pub fn host_range_accepts(range: &str, host: &str) -> bool {
    let Some(actual) = version(host) else {
        return false;
    };
    if range == "*" {
        return true;
    }
    let (operator, floor) = if let Some(value) = range.strip_prefix(">=") {
        (">=", value)
    } else if let Some(value) = range.strip_prefix('^') {
        ("^", value)
    } else if let Some(value) = range.strip_prefix('~') {
        ("~", value)
    } else {
        ("=", range)
    };
    let parts: Vec<_> = floor.split('.').collect();
    if parts.is_empty()
        || parts.len() > 3
        || parts
            .iter()
            .any(|part| part.is_empty() || (part.len() > 1 && part.starts_with('0')))
    {
        return false;
    }
    let mut minimum = [0; 3];
    for (index, part) in parts.iter().enumerate() {
        let Ok(number) = part.parse::<u64>() else {
            return false;
        };
        minimum[index] = number;
    }
    let floor = semver::Version::new(minimum[0], minimum[1], minimum[2]);
    match operator {
        "=" => actual == floor,
        ">=" => actual >= floor,
        "^" => actual >= floor && actual.major == floor.major,
        "~" => actual >= floor && actual.major == floor.major && actual.minor == floor.minor,
        _ => false,
    }
}

/// Use generated 1.10.0 wire types; preserve the TypeScript schema's defaults.
pub fn parse_manifest(raw: Value) -> Result<ParsedManifest, ManifestError> {
    let mut raw = raw;
    let object = raw
        .as_object_mut()
        .ok_or_else(|| ManifestError::Invalid("manifest must be an object".into()))?;
    let host = object
        .get("host")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let contributes = object.get("contributes").and_then(Value::as_object);
    let declared_points = contributes
        .map(|points| points.keys().cloned().collect())
        .unwrap_or_default();
    let capabilities = object.get("capabilities").and_then(Value::as_array);
    let has_point = |point: &str| contributes.is_some_and(|points| points.contains_key(point));
    let has_capability = |name: &str| {
        capabilities.is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("name").and_then(Value::as_str) == Some(name))
        })
    };
    let floor_at_least = |minimum: [u64; 3]| {
        let range = host
            .strip_prefix(">=")
            .or_else(|| host.strip_prefix('^'))
            .or_else(|| host.strip_prefix('~'))
            .unwrap_or(&host);
        let mut numbers = [0; 3];
        let mut count = 0;
        for part in range.split('.') {
            if count == 3 {
                return false;
            }
            let Ok(number) = part.parse::<u64>() else {
                return false;
            };
            numbers[count] = number;
            count += 1;
        }
        count > 0 && numbers >= minimum
    };
    if ([
        "usage",
        "classifier",
        "notifier",
        "endpoint",
        "planner",
        "policy",
    ]
    .into_iter()
    .any(has_point)
        || ["fs.write", "usage.state"].into_iter().any(has_capability))
        && !floor_at_least([1, 6, 0])
    {
        return Err(ManifestError::Invalid(
            "extracted contributions and capabilities require host >=1.6.0".into(),
        ));
    }
    if (["hostRunner", "remoteCaller", "executor"]
        .into_iter()
        .any(has_point)
        || has_capability("hosts"))
        && !floor_at_least([1, 7, 0])
    {
        return Err(ManifestError::Invalid(
            "host runner contributions and capabilities require host >=1.7.0".into(),
        ));
    }
    if has_capability("worktree") && !floor_at_least([1, 9, 0]) {
        return Err(ManifestError::Invalid(
            "worktree requires host >=1.9.0".into(),
        ));
    }
    let orca_backend = contributes
        .and_then(|points| points.get("executor"))
        .and_then(|value| value.get("backends"))
        .and_then(Value::as_array)
        .and_then(|backends| backends.first())
        .and_then(Value::as_str)
        == Some("orca");
    if (has_capability("orca") || orca_backend) && !floor_at_least([1, 10, 0]) {
        return Err(ManifestError::Invalid("orca requires host >=1.10.0".into()));
    }
    if has_capability("identity.sign") && !floor_at_least([1, 4, 0]) {
        return Err(ManifestError::Invalid(
            "identity.sign requires host >=1.4.0".into(),
        ));
    }
    if has_point("pairing") && (!has_capability("net.p2p") || !floor_at_least([1, 5, 0])) {
        return Err(ManifestError::Invalid(
            "pairing requires net.p2p and host >=1.5.0".into(),
        ));
    }
    object
        .entry("contributes")
        .or_insert_with(|| serde_json::json!({}));
    object
        .entry("capabilities")
        .or_insert_with(|| serde_json::json!([]));
    object
        .entry("reentrant")
        .or_insert_with(|| serde_json::json!(false));
    object
        .entry("tier")
        .or_insert_with(|| serde_json::json!("free"));
    let manifest: Manifest =
        serde_json::from_value(raw).map_err(|error| ManifestError::Invalid(error.to_string()))?;
    if manifest.id.as_str() == "pacer" {
        return Err(ManifestError::Invalid("plugin id pacer is reserved".into()));
    }
    if version(&manifest.version).is_none() {
        return Err(ManifestError::Invalid("version is not semver".into()));
    }
    if !host_range_accepts(manifest.host.as_str(), pacer_plugin_protocol::VERSION) {
        return Err(ManifestError::IncompatibleHost);
    }
    Ok(ParsedManifest {
        wire: manifest,
        declared_points,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn ranges_match_ts_boundary_cases() {
        for (range, host, accepted) in [
            ("*", "1.10.0", true),
            ("^1", "1.10.0", true),
            ("^0", "1.10.0", false),
            ("~1.9", "1.10.0", false),
            (">=1.10.0", "1.10.0", true),
            ("1.10.0", "1.10.0", true),
            ("1.10.1", "1.10.0", false),
            ("^1.10.0 || ^2", "1.10.0", false),
        ] {
            assert_eq!(host_range_accepts(range, host), accepted, "{range}");
        }
    }

    #[test]
    fn generated_manifest_defaults_and_identity() {
        let raw =
            serde_json::json!({"id":"fx-good","version":"1.0.0","publisher":"fixture","host":"^1"});
        let manifest = parse_manifest(raw).unwrap();
        assert_eq!(manifest.id.as_str(), "fx-good");
        assert!(!manifest.reentrant);
    }

    #[test]
    fn conformance_fixture_manifest_cases() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures");
        let good = std::fs::read_to_string(root.join("good/pacer-plugin.json")).unwrap();
        let old = std::fs::read_to_string(root.join("old-protocol/pacer-plugin.json")).unwrap();
        assert!(parse_manifest(serde_json::from_str(&good).unwrap()).is_ok());
        assert!(matches!(
            parse_manifest(serde_json::from_str(&old).unwrap()),
            Err(ManifestError::IncompatibleHost)
        ));
    }
}
