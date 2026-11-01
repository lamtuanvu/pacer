use pacer_plugin_protocol::Manifest;
use serde_json::Value;
use std::{collections::HashSet, ops::Deref};
use thiserror::Error;
use unicode_normalization::UnicodeNormalization;

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

/// Match `ui-schema.ts`'s `plain` transform before checking display lengths.
fn clean_ui_text(text: &str) -> String {
    text.nfc()
        .filter(|ch| {
            !matches!(
                *ch as u32,
                0x00..=0x1f | 0x7f..=0x9f | 0x200b..=0x200f | 0x202a..=0x202e
                    | 0x2060..=0x2064 | 0x2066..=0x2069 | 0xfeff
            )
        })
        .collect()
}

fn clean_field(object: &mut serde_json::Map<String, Value>, key: &str) {
    if let Some(Value::String(text)) = object.get_mut(key) {
        *text = clean_ui_text(text);
    }
}

fn normalize_ui(ui: &mut Value) {
    let Some(points) = ui.as_object_mut() else {
        return;
    };
    for kind in ["activity", "panelTabs", "settings", "status"] {
        let Some(items) = points.get_mut(kind).and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items {
            let Some(item) = item.as_object_mut() else {
                continue;
            };
            clean_field(item, "title");
            if kind != "settings" {
                continue;
            }
            let Some(fields) = item
                .get_mut("schema")
                .and_then(|schema| schema.get_mut("fields"))
                .and_then(Value::as_object_mut)
            else {
                continue;
            };
            for field in fields.values_mut() {
                let Some(field) = field.as_object_mut() else {
                    continue;
                };
                clean_field(field, "title");
                clean_field(field, "description");
                if let Some(values) = field.get_mut("enum").and_then(Value::as_array_mut) {
                    for value in values {
                        if let Value::String(text) = value {
                            *text = clean_ui_text(text);
                        }
                    }
                }
            }
        }
    }
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

// Zod v4's string min/max checks count Unicode code points (even though
// JavaScript's ordinary string.length counts UTF-16 code units).
fn valid_ui(ui: &Value) -> bool {
    let Some(points) = ui.as_object() else {
        return false;
    };
    if points
        .keys()
        .any(|key| !["activity", "panelTabs", "settings", "status"].contains(&key.as_str()))
    {
        return false;
    }
    for (kind, limit) in [
        ("activity", 2),
        ("panelTabs", 3),
        ("settings", 1),
        ("status", 1),
    ] {
        let Some(items) = points.get(kind) else {
            continue;
        };
        let Some(items) = items.as_array() else {
            return false;
        };
        if items.len() > limit {
            return false;
        }
        let mut ids = HashSet::new();
        for item in items {
            let Some(item) = item.as_object() else {
                return false;
            };
            let allowed: &[&str] = match kind {
                "activity" => &["id", "title", "icon", "view"],
                "panelTabs" => &["id", "title", "icon", "view", "context"],
                "settings" => &["id", "title", "schema"],
                _ => &["id", "title", "view"],
            };
            if item.keys().any(|key| !allowed.contains(&key.as_str())) {
                return false;
            }
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                return false;
            };
            if id.is_empty()
                || id.len() > 32
                || !id
                    .bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                || !ids.insert(id)
            {
                return false;
            }
            let Some(title) = item.get("title").and_then(Value::as_str) else {
                return false;
            };
            if title.is_empty() || title.chars().count() > 40 {
                return false;
            }
            if kind == "settings" {
                if !valid_settings(item.get("schema")) {
                    return false;
                }
            } else {
                let Some(view) = item.get("view").and_then(Value::as_str) else {
                    return false;
                };
                if view.is_empty() || view.chars().count() > 64 {
                    return false;
                }
            }
            if (kind == "activity" || kind == "panelTabs")
                && !item
                    .get("icon")
                    .and_then(Value::as_str)
                    .is_some_and(|icon| {
                        [
                            "check-square",
                            "list",
                            "bell",
                            "chart",
                            "clock",
                            "cog",
                            "file",
                            "folder",
                            "git-branch",
                            "key",
                            "link",
                            "shield",
                            "tag",
                            "terminal",
                            "users",
                            "zap",
                            "plugin",
                        ]
                        .contains(&icon)
                    })
            {
                return false;
            }
            if kind == "panelTabs"
                && item.get("context").is_some_and(|context| {
                    context
                        .as_str()
                        .is_none_or(|value| value != "global" && value != "task")
                })
            {
                return false;
            }
        }
    }
    true
}

fn valid_settings(schema: Option<&Value>) -> bool {
    let Some(schema) = schema.and_then(Value::as_object) else {
        return false;
    };
    if schema.len() != 1 {
        return false;
    }
    let Some(fields) = schema.get("fields").and_then(Value::as_object) else {
        return false;
    };
    if fields.len() > 30 {
        return false;
    }
    for (name, field) in fields {
        if name.is_empty()
            || name.len() > 32
            || !name.bytes().next().is_some_and(|b| b.is_ascii_alphabetic())
            || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return false;
        }
        let Some(field) = field.as_object() else {
            return false;
        };
        let Some(kind) = field.get("type").and_then(Value::as_str) else {
            return false;
        };
        let allowed: &[&str] = match kind {
            "boolean" => &["type", "title", "description", "default"],
            "string" => &[
                "type",
                "title",
                "description",
                "enum",
                "maxLength",
                "default",
            ],
            "secretRef" => &["type", "title", "description"],
            "integer" => &[
                "type",
                "title",
                "description",
                "minimum",
                "maximum",
                "default",
            ],
            "array" => &["type", "title", "description", "items", "maxItems"],
            "repos" => &["type", "title", "description", "maxItems"],
            _ => return false,
        };
        if field.keys().any(|key| !allowed.contains(&key.as_str())) {
            return false;
        }
        let Some(title) = field.get("title").and_then(Value::as_str) else {
            return false;
        };
        if title.is_empty() || title.chars().count() > 80 {
            return false;
        }
        if field
            .get("description")
            .is_some_and(|value| value.as_str().is_none_or(|text| text.chars().count() > 200))
        {
            return false;
        }
        if !["boolean", "integer", "secretRef"].contains(&kind)
            && [name.as_str(), title].iter().any(|text| {
                let lower = text.to_ascii_lowercase();
                [
                    "key", "token", "secret", "pass", "pwd", "cred", "auth", "bearer", "private",
                    "cookie", "session",
                ]
                .iter()
                .any(|term| lower.contains(term))
            })
        {
            return false;
        }
        if kind == "integer"
            && field
                .get("minimum")
                .and_then(Value::as_i64)
                .zip(field.get("maximum").and_then(Value::as_i64))
                .is_none_or(|(min, max)| min > max)
        {
            return false;
        }
        if kind == "integer"
            && field
                .get("default")
                .is_some_and(|value| value.as_i64().is_none())
        {
            return false;
        }
        if kind == "boolean"
            && field
                .get("default")
                .is_some_and(|value| value.as_bool().is_none())
        {
            return false;
        }
        if kind == "string" {
            if field.get("default").is_some_and(|value| {
                value
                    .as_str()
                    .is_none_or(|text| text.chars().count() > 2000)
            }) {
                return false;
            }
            if field.get("maxLength").is_some_and(|value| {
                value
                    .as_u64()
                    .is_none_or(|length| !(1..=2000).contains(&length))
            }) {
                return false;
            }
            if field.get("enum").is_some_and(|value| {
                value.as_array().is_none_or(|items| {
                    items.is_empty()
                        || items.len() > 20
                        || items.iter().any(|item| {
                            item.as_str()
                                .is_none_or(|text| text.is_empty() || text.chars().count() > 80)
                        })
                })
            }) {
                return false;
            }
        }
        if kind == "array" && field.get("items") != Some(&serde_json::json!({"type":"string"})) {
            return false;
        }
        if (kind == "array" || kind == "repos")
            && field.get("maxItems").is_some_and(|value| {
                value
                    .as_u64()
                    .is_none_or(|count| !(1..=100).contains(&count))
            })
        {
            return false;
        }
    }
    true
}

/// Use generated 1.10.0 wire types; preserve the TypeScript schema's defaults.
pub fn parse_manifest(raw: Value) -> Result<ParsedManifest, ManifestError> {
    let mut raw = raw;
    let object = raw
        .as_object_mut()
        .ok_or_else(|| ManifestError::Invalid("manifest must be an object".into()))?;
    // Zod's manifest object strips unknown top-level properties.
    object.retain(|key, _| {
        [
            "id",
            "version",
            "publisher",
            "host",
            "contributes",
            "capabilities",
            "entry",
            "reentrant",
            "tier",
        ]
        .contains(&key.as_str())
    });
    if let Some(ui) = object
        .get_mut("contributes")
        .and_then(|contributes| contributes.get_mut("ui"))
    {
        normalize_ui(ui);
    }
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
    if let Some(items) = capabilities {
        for item in items
            .iter()
            .filter(|item| item.get("name").and_then(Value::as_str) == Some("identity.sign"))
        {
            if let Some(scopes) = item.get("scopes").and_then(Value::as_array) {
                for scope in scopes {
                    if let Some(scope) = scope.as_str() {
                        let valid = (2..=64).contains(&scope.len())
                            && scope.bytes().all(|byte| {
                                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                            })
                            && scope.bytes().next().is_some_and(|byte| {
                                byte.is_ascii_lowercase() || byte.is_ascii_digit()
                            });
                        if !valid {
                            return Err(ManifestError::Invalid("identity.sign scopes are signing purposes: 2-64 lowercase letters, digits and hyphens".into()));
                        }
                    }
                }
            }
        }
    }
    if let Some(ui) = contributes.and_then(|points| points.get("ui")) {
        if !valid_ui(ui) {
            return Err(ManifestError::Invalid("invalid contributes.ui".into()));
        }
        if !floor_at_least([1, 2, 0]) {
            return Err(ManifestError::Invalid(
                "contributes.ui requires host >=1.2.0".into(),
            ));
        }
        if ui
            .get("settings")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
            && !has_capability("config.get")
        {
            return Err(ManifestError::Invalid(
                "a plugin with a settings page declares the config.get capability".into(),
            ));
        }
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

    #[test]
    fn shared_typescript_manifest_matrix() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/plugin-manifest-parity.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let parsed = parse_manifest(case["manifest"].clone());
            let actual = parsed.is_ok();
            assert_eq!(
                actual,
                case["accepted"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if let Ok(manifest) = parsed {
                let wire = serde_json::to_value(&manifest.wire).unwrap();
                if let Some(title) = case["normalizedTitle"].as_str() {
                    assert_eq!(
                        wire["contributes"]["ui"]["status"][0]["title"], title,
                        "{}",
                        case["name"]
                    );
                }
                if let Some(key) = case["strippedTopLevel"].as_str() {
                    assert!(wire.get(key).is_none(), "{}", case["name"]);
                }
            }
        }
    }
}
