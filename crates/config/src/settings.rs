//! Pure input handling for settings; no operation is registered here.

/// Trim the ECMAScript WhiteSpace and LineTerminator code points.
pub fn js_trim(value: &str) -> &str {
    pacer_foundation::js_semantics::js_trim(value)
}

/// Parse the string form accepted by config.set for pacing.order.
pub fn parse_pacing_order(value: &str) -> Option<Vec<String>> {
    if value.is_empty() {
        return Some(Vec::new());
    }
    let values: Vec<String> = value.split(',').map(|v| js_trim(v).to_owned()).collect();
    (!values.iter().any(String::is_empty)).then_some(values)
}

use crate::{
    doc::{StrategyDoc, parse_value},
    strategy::StrategyError,
    write::atomic_strategy_write,
};
use serde_json::{Map, Value, json};
use std::{fs, path::Path};

pub const CONFIG_KEYS: &[&str] = &[
    "execution.auto_clean",
    "task_retention_days",
    "execution.local_max_tasks",
    "execution.local_memory_pressure_limit",
    "execution.local_load_limit",
    "execution.launch_mode",
    "execution.backend",
    "planner",
    "pacing.order",
    "pacing.policy",
    "pacing.planner_reserve",
    "pacing.planner_reserve_headroom",
    "pacing.planner_probe",
    "pacing.accounts",
    "pacing.fill_threshold",
    "update_check",
    "terminal.app",
    "terminal.open",
];
const PRESETS: &[&str] = &[
    "ghostty",
    "iterm",
    "terminal-app",
    "wezterm",
    "kitty",
    "alacritty",
    "gnome-terminal",
    "x-terminal-emulator",
    "auto",
];

#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct SettingsError {
    pub code: &'static str,
    pub message: String,
    pub hint: Option<&'static str>,
}
impl SettingsError {
    pub(crate) fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_input",
            message: message.into(),
            hint: None,
        }
    }
}
impl From<StrategyError> for SettingsError {
    fn from(error: StrategyError) -> Self {
        Self::invalid(error.to_string())
    }
}
impl From<crate::doc::EditError> for SettingsError {
    fn from(error: crate::doc::EditError) -> Self {
        Self::invalid(error.to_string())
    }
}
impl From<std::io::Error> for SettingsError {
    fn from(error: std::io::Error) -> Self {
        Self::invalid(error.to_string())
    }
}

/// ECMAScript String(number), including IEEE-754 rounding of JSON integers.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => {
            let number = n.as_f64().unwrap_or(f64::NAN);
            ryu_js::Buffer::new().format(number).to_owned()
        }
        Value::Array(values) => values
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}
fn decimal(value: &str, fraction: bool) -> bool {
    let parts: Vec<_> = value.split('.').collect();
    (parts.len() == 1 || (fraction && parts.len() == 2))
        && parts
            .iter()
            .all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
fn number(value: &str) -> Value {
    let n = value.parse::<f64>().unwrap_or(f64::NAN);
    if n.is_finite() && n.fract() == 0. && n.abs() <= 9007199254740991. {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// Input-only validation. Whole-strategy validation happens before any write.
/// Planner and backend operations remain forwarded; neither is performed here.
fn parse_setting(
    key: &str,
    input: &Value,
    terminal_presets_only: bool,
) -> Result<Value, SettingsError> {
    if !CONFIG_KEYS.contains(&key) {
        return Err(SettingsError::invalid(format!("unknown config key: {key}")));
    }
    if input.is_array() && key != "pacing.order" {
        return Err(SettingsError {
            code: "invalid_input",
            message: format!("{key} requires a scalar value"),
            hint: Some("Use a list only for pacing.order"),
        });
    }
    if !(input.is_string()
        || input.is_number()
        || input.is_boolean()
        || input
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string)))
    {
        return Err(SettingsError::invalid(
            "config value must be a scalar or string list",
        ));
    }
    let v = js_string(input);
    let s = v.as_str();
    if key == "terminal.open" && terminal_presets_only && !PRESETS.contains(&s) {
        return Err(SettingsError { code: "invalid_input", message: "terminal.open requires a preset for app and link callers; use pacer config set terminal.open for custom templates".into(), hint: Some("Use pacer config set terminal.open to configure a custom template.") });
    }
    let fail = |message: &str| Err(SettingsError::invalid(message));
    match key {
        "task_retention_days" | "execution.local_max_tasks" => {
            if key == "execution.local_max_tasks" && s == "unlimited" {
                return Ok(json!(s));
            }
            let n = s.parse::<f64>().unwrap_or(f64::NAN);
            let min = if key == "task_retention_days" { 0. } else { 1. };
            if !decimal(s, false) || !n.is_finite() || n > 9007199254740991. || n < min {
                return fail(if key == "task_retention_days" {
                    "task_retention_days must be a non-negative integer"
                } else {
                    "execution.local_max_tasks must be a whole number of at least 1, or unlimited"
                });
            }
            Ok(number(s))
        }
        "execution.local_load_limit" => {
            if s == "off" {
                return Ok(json!(s));
            }
            let n = s.parse::<f64>().unwrap_or(f64::NAN);
            if !decimal(s, true) || !n.is_finite() || n <= 0. {
                return fail(
                    "execution.local_load_limit must be a positive number (load per CPU core) or off",
                );
            }
            Ok(number(s))
        }
        "execution.local_memory_pressure_limit" if !["critical", "warning", "off"].contains(&s) => {
            fail("execution.local_memory_pressure_limit must be critical, warning or off")
        }
        "execution.launch_mode" if !["interactive", "headless"].contains(&s) => {
            fail("execution.launch_mode must be interactive or headless")
        }
        "execution.backend" if !["orca", "direct"].contains(&s) => {
            fail("execution.backend must be orca or direct")
        }
        "terminal.app" if !["Terminal", "iTerm", "Ghostty"].contains(&s) => {
            fail("terminal.app must be Terminal, iTerm or Ghostty")
        }
        "pacing.order" => parse_pacing_order(s).map(|a| json!(a)).ok_or_else(|| {
            SettingsError::invalid("pacing.order requires comma-separated runner ids")
        }),
        "update_check" | "execution.auto_clean" => {
            if !["true", "false"].contains(&s) {
                return Err(SettingsError::invalid(format!(
                    "{key} must be true or false"
                )));
            }
            Ok(json!(s == "true"))
        }
        "pacing.planner_reserve" | "pacing.planner_reserve_headroom" | "pacing.fill_threshold" => {
            if !decimal(s, true) {
                return Err(SettingsError::invalid(format!(
                    "{key} requires a finite number"
                )));
            }
            // Infinity is represented in YAML as .inf, then rejected by strategy validation.
            if !s.parse::<f64>().unwrap_or(f64::NAN).is_finite() {
                return Ok(json!(".inf"));
            }
            Ok(number(s))
        }
        _ => Ok(json!(v)),
    }
}

fn raw_at<'a>(raw: &'a Value, key: &str) -> Option<&'a Value> {
    key.split('.').try_fold(raw, |v, k| v.get(k))
}
fn fallback(value: Option<&Value>, default: Value) -> Value {
    value.filter(|v| !v.is_null()).cloned().unwrap_or(default)
}
fn planner_id(s: &Value) -> String {
    let agent = s["planner"]["agent"].as_str().unwrap_or("");
    let account = s["planner"]["account"].as_str().unwrap_or("");
    let kind = match agent {
        "claude-code" => "claude",
        "opencode" => "endpoint",
        "agy" => "antigravity",
        other => other,
    };
    let defaults: Vec<_> = s["accounts"]
        .as_object()
        .into_iter()
        .flat_map(|a| a.values())
        .filter(|a| a["kind"] == kind && a["home"].is_null() && a["orcaAccount"].is_null())
        .collect();
    if agent != "opencode" && defaults.len() == 1 && defaults[0]["name"] == account {
        agent.into()
    } else {
        format!("{agent}#{account}")
    }
}
fn effective(s: &Value, raw: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, field, default) in [
        ("execution.auto_clean", "auto_clean", json!(true)),
        (
            "execution.local_max_tasks",
            "local_max_tasks",
            json!("unlimited"),
        ),
        (
            "execution.local_memory_pressure_limit",
            "local_memory_pressure_limit",
            json!("critical"),
        ),
        (
            "execution.local_load_limit",
            "local_load_limit",
            json!("off"),
        ),
        ("execution.launch_mode", "launch_mode", json!("interactive")),
    ] {
        out.insert(key.into(), fallback(s["execution"].get(field), default));
    }
    out.insert(
        "execution.backend".into(),
        json!(if js_string(&s["execution"]["backend"]) == "orca" {
            "orca"
        } else {
            "direct"
        }),
    );
    out.insert("task_retention_days".into(), s["taskRetentionDays"].clone());
    out.insert("planner".into(), json!(planner_id(s)));
    out.insert(
        "terminal.open".into(),
        fallback(s["terminal"].get("open"), json!("")),
    );
    for (key, field) in [
        ("order", "order"),
        ("policy", "policy"),
        ("planner_reserve", "plannerReserve"),
        ("planner_reserve_headroom", "plannerReserveHeadroom"),
        ("planner_probe", "plannerProbe"),
        ("accounts", "accounts"),
        ("fill_threshold", "fillThreshold"),
    ] {
        out.insert(format!("pacing.{key}"), s["pacing"][field].clone());
    }
    out.insert(
        "update_check".into(),
        fallback(raw.get("update_check"), json!(true)),
    );
    out.insert(
        "terminal.app".into(),
        fallback(raw_at(raw, "terminal.app"), json!("Terminal")),
    );
    for value in out.values_mut() {
        canonical_numbers(value);
    }
    out
}

fn canonical_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if let Some(n) = n
                .as_f64()
                .filter(|n| n.fract() == 0. && n.abs() <= 9007199254740991.)
            {
                *value = json!(n as i64);
            }
        }
        Value::Array(values) => {
            for value in values {
                canonical_numbers(value);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                canonical_numbers(value);
            }
        }
        _ => {}
    }
}

/// Pure config.get read model. The caller supplies host-dependent fields unchanged:
/// terminal availability, current machine guard/slots and planner candidates.
pub fn get_settings(
    path: &Path,
    name: &str,
    backend_env: Option<&str>,
    host_fields: &Value,
) -> Result<Value, SettingsError> {
    let before = fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            SettingsError::invalid(format!("no strategy found at {}", path.display()))
        } else {
            error.into()
        }
    })?;
    let raw = parse_value(&before)?;
    let strategy = crate::strategy::validate_yaml_strategy(
        &crate::doc::parse_yaml_value(&before)?,
        path,
        name,
    )?;
    crate::settings_execution::validate(&crate::doc::parse_yaml_value(&before)?["execution"])?;
    let values = effective(&strategy, &raw);
    let mut keys = Map::new();
    for key in CONFIG_KEYS {
        let entry = if *key == "execution.backend" && backend_env.is_some_and(|s| !s.is_empty()) {
            json!({"value":if backend_env == Some("orca") {"orca"} else {"direct"}, "source":"env PACER_BACKEND"})
        } else {
            json!({"value":values[*key], "source":if raw_at(&raw, key).is_some() {path.to_string_lossy().into_owned()} else {"default".into()}})
        };
        keys.insert((*key).into(), entry);
    }
    let mut result = host_fields.as_object().cloned().unwrap_or_default();
    result.insert("keys".into(), Value::Object(keys));
    Ok(Value::Object(result))
}

fn undo_value(value: &Value, yaml_node: bool) -> String {
    // yaml Document.getIn returns collection nodes for these raw settings;
    // their String conversion is compact JSON rather than Array.join.
    let text = if yaml_node && (value.is_array() || value.is_object()) {
        value.to_string()
    } else {
        js_string(value)
    };
    if !text.is_empty()
        && (text
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"#@.,_-".contains(&b))
            || text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_/.:=@%+-".contains(&b)))
    {
        text
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}
fn diff(path: &Path, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let a: Vec<_> = before.split('\n').collect();
    let b: Vec<_> = after.split('\n').collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let mut lines = vec![
        format!("--- {}", path.display()),
        format!("+++ {}", path.display()),
        format!(
            "@@ -{},{} +{},{} @@",
            start + 1,
            end_a - start,
            start + 1,
            end_b - start
        ),
    ];
    lines.extend(a[start..end_a].iter().map(|s| format!("-{s}")));
    lines.extend(b[start..end_b].iter().map(|s| format!("+{s}")));
    lines.join("\n")
}

/// Pure settings file effect, without event publication or host integrations.
/// The caller must serialize shared writers and publish once after success.
/// Planner (including install/uninstall) and backend readiness remain forwarded.
pub fn set_setting(
    path: &Path,
    name: &str,
    key: &str,
    input: &Value,
    terminal_presets_only: bool,
) -> Result<Value, SettingsError> {
    let before = fs::read_to_string(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            SettingsError::invalid(format!("no strategy found at {}", path.display()))
        } else {
            error.into()
        }
    })?;
    let raw = parse_value(&before)?;
    let strategy = crate::strategy::validate_yaml_strategy(
        &crate::doc::parse_yaml_value(&before)?,
        path,
        name,
    )?;
    crate::settings_execution::validate(&crate::doc::parse_yaml_value(&before)?["execution"])?;
    let previous = effective(&strategy, &raw)
        .get(key)
        .cloned()
        .unwrap_or(Value::Null);
    if ["planner", "execution.backend"].contains(&key) {
        return Err(SettingsError {
            code: "unavailable",
            message: format!("{key} requires the forwarded config.set operation"),
            hint: None,
        });
    }
    let value = parse_setting(key, input, terminal_presets_only)?;
    let mut doc = StrategyDoc::new(&before);
    let keys: Vec<_> = key.split('.').map(|s| json!(s)).collect();
    if key == "terminal.open" && doc.get_in(&keys)?.is_some() {
        doc.replace_node(&keys, &json!({"kind":"yaml", "yaml":value.to_string()}))?;
    } else if let Some(list) = value.as_array() {
        doc.set_list(&keys, list)?;
    } else {
        doc.set_in(&keys, &value)?;
    }
    // serde_json cannot carry Infinity. TS emits .inf and strategy validation
    // rejects it with the range error, after the lexical number check succeeds.
    if value == ".inf" && key.starts_with("pacing.") {
        let range = if key == "pacing.fill_threshold" {
            "50 and 100"
        } else {
            "0 and 99"
        };
        return Err(SettingsError::invalid(format!(
            "invalid strategy {}:\n  - {key} must be between {range}",
            path.display()
        )));
    }
    let next_raw = parse_value(doc.as_str())?;
    let next = crate::strategy::validate_yaml_strategy(
        &crate::doc::parse_yaml_value(doc.as_str())?,
        path,
        name,
    )?;
    let after = doc.as_str();
    if fs::read_to_string(path)? != before {
        return Err(SettingsError {
            code: "conflict",
            message: "Strategy changed during edit".into(),
            hint: Some("Refresh and retry."),
        });
    }
    if before != after {
        atomic_strategy_write(path, after)?;
    }
    Ok(
        json!({"key":key, "value":effective(&next,&next_raw)[key], "previous":previous, "diff":diff(path,&before,after), "undo":format!("pacer config set {key} {}",undo_value(&previous, ["update_check", "terminal.app"].contains(&key))), "notes":[]}),
    )
}
