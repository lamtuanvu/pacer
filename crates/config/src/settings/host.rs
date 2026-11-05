//! Host-field bridge for `config.get`.
//!
//! `get_settings` owns the pure key/source map. The three remaining result
//! fields (`terminalChoices`, `machine`, `planners`) are host-dependent: the
//! caller probes terminals, samples machine signals / slot use, and discovers
//! planner candidates, then feeds the results here. This module never probes
//! the filesystem, PATH, sysctl or the task store.

use serde_json::{Map, Value, json};

/// Platform catalogue for Settings terminal choices (before host filtering).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminalPlatform {
    Darwin,
    Other,
}

/// Injected machine sample. Missing signals keep the guard open (TS parity).
#[derive(Debug, Clone, PartialEq)]
pub struct MachineSignals {
    pub memory_pressure: Option<String>,
    pub load_per_core: Option<f64>,
}

impl MachineSignals {
    pub fn unavailable() -> Self {
        Self {
            memory_pressure: None,
            load_per_core: None,
        }
    }
}

/// Execution guard limits already resolved from the strategy (`validateExecution`).
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionGuardLimits {
    /// `critical` | `warning` | `off`; TS defaults to `critical`.
    pub memory_pressure_limit: String,
    /// `null` when the load ceiling is off.
    pub load_limit: Option<f64>,
}

impl Default for ExecutionGuardLimits {
    fn default() -> Self {
        Self {
            memory_pressure_limit: "critical".into(),
            load_limit: None,
        }
    }
}

/// All host-injected fields the pure settings read model accepts unchanged.
#[derive(Debug, Clone, PartialEq)]
pub struct ConfigHostFields {
    pub terminal_choices: Vec<TerminalChoice>,
    pub machine: Value,
    pub planners: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalChoice {
    pub value: String,
    pub label: String,
}

const DARWIN_TERMINALS: &[(&str, &str)] = &[
    ("auto", "Automatic"),
    ("terminal-app", "Terminal"),
    ("iterm", "iTerm"),
    ("ghostty", "Ghostty"),
];

const OTHER_TERMINALS: &[(&str, &str)] = &[
    ("auto", "Automatic"),
    ("ghostty", "Ghostty"),
    ("wezterm", "WezTerm"),
    ("kitty", "Kitty"),
    ("alacritty", "Alacritty"),
    ("gnome-terminal", "GNOME Terminal"),
    ("x-terminal-emulator", "System terminal"),
];

/// Full platform catalogue before the host filters to detected apps/binaries.
pub fn terminal_catalogue(platform: TerminalPlatform) -> Vec<TerminalChoice> {
    let rows = match platform {
        TerminalPlatform::Darwin => DARWIN_TERMINALS,
        TerminalPlatform::Other => OTHER_TERMINALS,
    };
    rows.iter()
        .map(|(value, label)| TerminalChoice {
            value: (*value).into(),
            label: (*label).into(),
        })
        .collect()
}

/// Keep `auto` plus every catalogue entry the host reports as detected.
///
/// Matches the TypeScript op wrapper: darwin checks `.app` roots; others use
/// `ctx.which`. Detection itself stays outside this crate.
pub fn filter_terminal_choices(
    catalogue: &[TerminalChoice],
    detected: &[&str],
) -> Vec<TerminalChoice> {
    catalogue
        .iter()
        .filter(|choice| choice.value == "auto" || detected.iter().any(|id| *id == choice.value))
        .cloned()
        .collect()
}

fn pressure_rank(value: &str) -> i32 {
    match value {
        "normal" => 0,
        "warning" => 1,
        "critical" => 2,
        _ => -1,
    }
}

fn format_load(n: f64) -> String {
    let rounded = (n * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{rounded:.0}")
    } else {
        // Match ECMAScript String(Math.round(n*10)/10) for one-decimal values.
        let text = format!("{rounded}");
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    }
}

/// Settings machine row: local slot use plus `machineGuardState` (no probing).
pub fn machine_host_fields(
    used_local_slots: u64,
    signals: &MachineSignals,
    limits: &ExecutionGuardLimits,
) -> Value {
    let pressure_limit = if limits.memory_pressure_limit.is_empty() {
        "critical"
    } else {
        limits.memory_pressure_limit.as_str()
    };
    let pressure = signals.memory_pressure.as_deref();
    let load = signals.load_per_core;
    let load_limit = limits.load_limit;

    let mut guard: Option<(String, String)> = None;
    if pressure_limit != "off"
        && let Some(pressure) = pressure
        && pressure_rank(pressure) >= 0
        && pressure_rank(pressure) >= pressure_rank(pressure_limit)
    {
        guard = Some((
            "machine_memory_pressure".into(),
            format!("memory pressure {pressure}"),
        ));
    } else if let (Some(load), Some(max)) = (load, load_limit)
        && load > max
    {
        guard = Some((
            "machine_load".into(),
            format!(
                "load {}/core over limit {}",
                format_load(load),
                format_load(max)
            ),
        ));
    }

    let mut machine = Map::new();
    machine.insert("used".into(), json!(used_local_slots));
    machine.insert("memoryPressure".into(), json!(pressure));
    machine.insert("memoryPressureLimit".into(), json!(pressure_limit));
    machine.insert("loadPerCore".into(), json!(load));
    machine.insert("loadLimit".into(), json!(load_limit));
    machine.insert("open".into(), json!(guard.is_none()));
    match guard {
        Some((reason, detail)) => {
            machine.insert("reason".into(), json!(reason));
            machine.insert("detail".into(), json!(detail));
        }
        None if pressure.is_none() && pressure_limit != "off" => {
            machine.insert("detail".into(), json!("memory pressure signal unavailable"));
        }
        None => {}
    }
    Value::Object(machine)
}

/// Compose the three host fields as a JSON object for [`super::get_settings`].
pub fn compose_host_fields(fields: &ConfigHostFields) -> Value {
    let terminal_choices: Vec<Value> = fields
        .terminal_choices
        .iter()
        .map(|c| json!({"value": c.value, "label": c.label}))
        .collect();
    json!({
        "terminalChoices": terminal_choices,
        "machine": fields.machine,
        "planners": fields.planners,
    })
}

/// Build host fields from injected detections / samples (no probing).
pub fn host_fields_from_parts(
    platform: TerminalPlatform,
    detected_terminals: &[&str],
    used_local_slots: u64,
    signals: &MachineSignals,
    limits: &ExecutionGuardLimits,
    planners: &[String],
) -> ConfigHostFields {
    let catalogue = terminal_catalogue(platform);
    ConfigHostFields {
        terminal_choices: filter_terminal_choices(&catalogue, detected_terminals),
        machine: machine_host_fields(used_local_slots, signals, limits),
        planners: planners.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_filter_keeps_auto_and_detected_only() {
        let catalogue = terminal_catalogue(TerminalPlatform::Other);
        let filtered = filter_terminal_choices(&catalogue, &["ghostty", "kitty"]);
        assert_eq!(
            filtered
                .iter()
                .map(|c| c.value.as_str())
                .collect::<Vec<_>>(),
            ["auto", "ghostty", "kitty"]
        );
    }

    #[test]
    fn darwin_catalogue_matches_typescript() {
        let values: Vec<_> = terminal_catalogue(TerminalPlatform::Darwin)
            .into_iter()
            .map(|c| c.value)
            .collect();
        assert_eq!(values, ["auto", "terminal-app", "iterm", "ghostty"]);
    }

    #[test]
    fn machine_unavailable_detail_when_pressure_limit_active() {
        let machine = machine_host_fields(
            2,
            &MachineSignals::unavailable(),
            &ExecutionGuardLimits::default(),
        );
        assert_eq!(
            machine,
            json!({
                "used": 2,
                "memoryPressure": null,
                "memoryPressureLimit": "critical",
                "loadPerCore": null,
                "loadLimit": null,
                "open": true,
                "detail": "memory pressure signal unavailable",
            })
        );
    }

    #[test]
    fn machine_pressure_guard_closes_when_limit_reached() {
        let signals = MachineSignals {
            memory_pressure: Some("critical".into()),
            load_per_core: Some(0.1),
        };
        let limits = ExecutionGuardLimits {
            memory_pressure_limit: "warning".into(),
            load_limit: Some(3.0),
        };
        let machine = machine_host_fields(0, &signals, &limits);
        assert_eq!(machine["open"], json!(false));
        assert_eq!(machine["reason"], json!("machine_memory_pressure"));
        assert_eq!(machine["detail"], json!("memory pressure critical"));
    }

    #[test]
    fn machine_load_guard_formats_like_typescript() {
        let signals = MachineSignals {
            memory_pressure: Some("normal".into()),
            load_per_core: Some(2.46),
        };
        let limits = ExecutionGuardLimits {
            memory_pressure_limit: "critical".into(),
            load_limit: Some(1.5),
        };
        let machine = machine_host_fields(1, &signals, &limits);
        assert_eq!(machine["open"], json!(false));
        assert_eq!(machine["reason"], json!("machine_load"));
        assert_eq!(machine["detail"], json!("load 2.5/core over limit 1.5"));
    }

    #[test]
    fn compose_passes_through_for_get_settings() {
        let fields = host_fields_from_parts(
            TerminalPlatform::Darwin,
            &["ghostty"],
            0,
            &MachineSignals::unavailable(),
            &ExecutionGuardLimits {
                memory_pressure_limit: "off".into(),
                load_limit: None,
            },
            &["claude-code".into(), "codex".into()],
        );
        let host = compose_host_fields(&fields);
        assert_eq!(
            host["terminalChoices"],
            json!([
                {"value":"auto","label":"Automatic"},
                {"value":"ghostty","label":"Ghostty"},
            ])
        );
        assert_eq!(host["planners"], json!(["claude-code", "codex"]));
        assert_eq!(host["machine"]["used"], json!(0));
        assert_eq!(host["machine"]["open"], json!(true));
        assert!(host["machine"].get("detail").is_none());
    }
}
