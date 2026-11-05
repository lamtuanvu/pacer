#![allow(clippy::unwrap_used)]
use pacer_config::settings::{CONFIG_KEYS, get_settings, set_setting};
use serde_json::{Value, json};
use std::fs;

#[test]
fn all_pure_settings_match_typescript_results_errors_and_edits() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/config-settings/settings.json"
    ))
    .unwrap();
    let mut exercised = std::collections::HashSet::new();
    let mut failures = Vec::new();
    for c in cases["cases"].as_array().unwrap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("strategy.yaml");
        let before = c.get("before").unwrap_or(&cases["base"]).as_str().unwrap();
        fs::write(&path, before).unwrap();
        let key = c["key"].as_str().unwrap();
        exercised.insert(key.to_owned());
        let mut actual =
            match set_setting(&path, "default", key, &c["input"], c["presetsOnly"] == true) {
                Ok(result) => json!({"result":result}),
                Err(e) => {
                    let mut err = json!({"code":e.code,"message":e.message});
                    if let Some(hint) = e.hint {
                        err["hint"] = json!(hint);
                    }
                    json!({"error":err})
                }
            };
        let after = fs::read_to_string(&path).unwrap();
        if after != before {
            actual["after"] = json!(after);
        }
        match get_settings(&path, "default", None, &json!({})) {
            Ok(result) => actual["keys"] = result["keys"].clone(),
            Err(e) => actual["getError"] = json!({"code":e.code,"message":e.message}),
        }
        let normalize = |v: Value| -> Value {
            serde_json::from_str(
                &serde_json::to_string(&v)
                    .unwrap()
                    .replace(path.to_str().unwrap(), "strategy.yaml"),
            )
            .unwrap()
        };
        let actual = normalize(actual);
        let mut expected = c["expected"].clone();
        if let Some(index) = expected.get("keys").and_then(Value::as_u64) {
            expected["keys"] = cases["views"][index as usize].clone();
        }
        if actual != expected {
            failures.push(format!(
                "{}\nactual: {actual}\nexpected: {}",
                c["name"], expected
            ));
        }
    }
    for key in CONFIG_KEYS
        .iter()
        .filter(|k| !["planner", "execution.backend"].contains(k))
    {
        assert!(exercised.contains(*key), "missing {key}");
    }
    assert!(
        failures.is_empty(),
        "{} cases failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn read_dependencies_and_backend_override_are_explicit() {
    use pacer_config::settings::{
        ExecutionGuardLimits, MachineSignals, TerminalPlatform, compose_host_fields,
        host_fields_from_parts,
    };
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/config-settings/settings.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    fs::write(&path, fixture["base"].as_str().unwrap()).unwrap();
    let host = compose_host_fields(&host_fields_from_parts(
        TerminalPlatform::Other,
        &[],
        3,
        &MachineSignals {
            memory_pressure: Some("normal".into()),
            load_per_core: Some(0.2),
        },
        &ExecutionGuardLimits::default(),
        &["codex".into()],
    ));
    assert_eq!(
        host["terminalChoices"],
        json!([{"value":"auto","label":"Automatic"}])
    );
    assert_eq!(host["machine"]["used"], json!(3));
    assert_eq!(host["planners"], json!(["codex"]));
    for (env, value, source) in [
        (None, "direct", "default"),
        (Some(""), "direct", "default"),
        (Some("orca"), "orca", "env PACER_BACKEND"),
        (Some("other"), "direct", "env PACER_BACKEND"),
    ] {
        let result = get_settings(&path, "default", env, &host).unwrap();
        for key in ["terminalChoices", "machine", "planners"] {
            assert_eq!(result[key], host[key]);
        }
        assert_eq!(
            result["keys"]["execution.backend"],
            json!({"value":value,"source":source})
        );
        assert_eq!(result["keys"].as_object().unwrap().len(), CONFIG_KEYS.len());
    }
    for key in ["planner", "execution.backend"] {
        let before = fs::read_to_string(&path).unwrap();
        assert_eq!(
            set_setting(&path, "default", key, &json!("codex"), false)
                .unwrap_err()
                .code,
            "unavailable"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), before);
    }
}

#[cfg(unix)]
#[test]
fn settings_writes_are_private_atomic_and_leave_no_temp_files() {
    use std::os::unix::fs::PermissionsExt;
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/config-settings/settings.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    fs::write(&path, fixture["base"].as_str().unwrap()).unwrap();
    fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
    set_setting(&path, "default", "update_check", &json!(false), false).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    let bytes = fs::read(&path).unwrap();
    let result = set_setting(&path, "default", "update_check", &json!(false), false).unwrap();
    assert_eq!(result["diff"], "");
    assert_eq!(fs::read(&path).unwrap(), bytes);
}

#[test]
fn missing_strategy_matches_typescript_error() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("missing.yaml");
    let expected = format!("no strategy found at {}", path.display());
    assert_eq!(
        get_settings(&path, "default", None, &json!({}))
            .unwrap_err()
            .message,
        expected
    );
    assert_eq!(
        set_setting(&path, "default", "update_check", &json!(false), false)
            .unwrap_err()
            .message,
        expected
    );
    assert!(!path.exists());
}
