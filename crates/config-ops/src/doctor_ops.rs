//! `setup.check`, `doctor.run` and `setup.health`: Rust validates the params, applies
//! the checklist rules, owns the gate and writes the doctor report and the gate's last
//! pass. Core supplies only what it alone can read over the setup bridges: the doctor
//! checks (planner and plugin checks read its in-process plugin registry, the Claude
//! handler probes run the TypeScript hook handlers, the status checks need
//! `computeStatus`) and the checklist facts (the in-process status cache and readings).
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
};
use serde_json::{Map, Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use crate::host_read_ops::invalid;
use crate::repo_registry_ops::params_object;
use crate::setup_checklist::checklist;
use crate::setup_gate::{GateInput, aggregate, fingerprint, should_skip_full_window};

const TRIGGERS: [&str; 3] = ["startup", "update", "manual"];

pub fn needs_setup_doctor_bridge(op: &str) -> bool {
    matches!(op, "setup.health" | "doctor.run")
}

fn bridge_unavailable() -> OpFuture<'static> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "setup doctor bridge unavailable",
        ))
    })
}

pub fn setup_health_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    bridge_unavailable()
}

pub fn doctor_run_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    bridge_unavailable()
}

/// `trigger: z.enum(["startup", "update", "manual"]).optional()`; other keys are stripped.
fn setup_health_params(params: &Value) -> Result<Map<String, Value>, CoreError> {
    let map = params_object(params)?;
    let mut parsed = Map::new();
    if let Some(trigger) = map.get("trigger") {
        match trigger.as_str() {
            Some(name) if TRIGGERS.contains(&name) => {
                parsed.insert("trigger".into(), name.into());
            }
            _ => {
                return Err(invalid(
                    r#"trigger: Invalid option: expected one of "startup"|"update"|"manual""#,
                ));
            }
        }
    }
    Ok(parsed)
}

/// The Core request: the op and its parsed params.
pub fn bridge_params(op: &str, params: &Value) -> Result<Value, CoreError> {
    let parsed = match op {
        "doctor.run" => {
            params_object(params)?;
            Map::new()
        }
        "setup.health" => setup_health_params(params)?,
        _ => return Err(invalid("unknown core bridge op")),
    };
    Ok(json!({ "op": op, "params": parsed }))
}

/// A number as `JSON.stringify` writes it: whole values have no fraction.
fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

/// `toCoreError` of a filesystem failure: the message, as invalid input.
fn io_error(error: impl std::fmt::Display) -> CoreError {
    invalid(error.to_string())
}

/// `saveDoctorReport`: stamps the report and stores it as compact JSON, mode 0600.
/// Residual: TypeScript skips the write entirely under `ctx.readOnly` (`saveDoctorReport`
/// in `src/core/doctor-fix.ts`); Rust has no read-only flag so it always writes.
fn store_doctor_report(ctx: &Ctx, parts: &Value) -> Result<Value, CoreError> {
    let mut report = Map::new();
    report.insert("checkedAt".into(), js_number(ctx.now));
    report.insert("checks".into(), parts["checks"].clone());
    for key in ["planner", "repairAvailable"] {
        if let Some(value) = parts.get(key) {
            report.insert(key.into(), value.clone());
        }
    }
    let report = Value::Object(report);
    let path = ctx.pacer_home.join("diagnostics/doctor-latest.json");
    write_private(&path, pacer_js_json::stringify(&report).as_bytes()).map_err(io_error)?;
    Ok(report)
}

/// `checkParents` of `src/install/atomic.ts`: no redirected parent, apart from the macOS root aliases.
fn check_parents(path: &Path) -> Result<(), String> {
    for parent in path.ancestors().skip(1) {
        if parent.parent().is_none() {
            break;
        }
        match fs::symlink_metadata(parent) {
            Ok(meta)
                if meta.file_type().is_symlink()
                    && !["/var", "/tmp", "/etc"].contains(&parent.to_string_lossy().as_ref()) =>
            {
                return Err(format!(
                    "unsafe integration directory: {}",
                    parent.display()
                ));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string());
            }
            _ => {}
        }
    }
    Ok(())
}

/// `readInstallFile`: only a missing file is `None`.
fn read_install_file(path: &Path) -> Result<Option<String>, String> {
    check_parents(path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(meta) if !meta.is_file() => {
            return Err(format!("unsafe integration file: {}", path.display()));
        }
        Ok(_) => {}
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// `JSON.stringify(value, null, 2)`.
fn pretty(value: &Value, depth: usize, out: &mut String) {
    let pad = "  ".repeat(depth + 1);
    let close = "  ".repeat(depth);
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            for (index, item) in items.iter().enumerate() {
                out.push_str(if index == 0 { "" } else { ",\n" });
                out.push_str(&pad);
                pretty(item, depth + 1, out);
            }
            out.push_str(&format!("\n{close}]"));
        }
        Value::Object(map) if !map.is_empty() => {
            out.push_str("{\n");
            for (index, (key, item)) in map.iter().enumerate() {
                out.push_str(if index == 0 { "" } else { ",\n" });
                out.push_str(&pad);
                out.push_str(&pacer_js_json::stringify(&Value::String(key.clone())));
                out.push_str(": ");
                pretty(item, depth + 1, out);
            }
            out.push_str(&format!("\n{close}}}"));
        }
        other => out.push_str(&pacer_js_json::stringify(other)),
    }
}

/// `writeInstallFile` with owner mode 0600: unlike the private JSON store, it leaves the
/// mode of an existing parent directory alone. When no `owner_mode` is given it mirrors
/// TypeScript: keep an existing file's owner bits, else 0600.
fn write_install_file(path: &Path, text: &str, owner_mode: Option<u32>) -> Result<(), CoreError> {
    use std::io::Write;
    let exists = read_install_file(path).map_err(invalid)?.is_some();
    let mode = owner_mode
        .or_else(|| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                exists.then(|| {
                    fs::symlink_metadata(path)
                        .map(|meta| meta.mode() & 0o700)
                        .unwrap_or(0o600)
                })
            }
            #[cfg(not(unix))]
            {
                let _ = exists;
                None
            }
        })
        .unwrap_or(0o600);
    let parent = path.parent().unwrap_or(Path::new("."));
    let mut folder = fs::DirBuilder::new();
    folder.recursive(true);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
        folder.mode(0o700);
        options.mode(mode);
    }
    folder.create(parent).map_err(io_error)?;
    let nonce = hex::encode(rand::random::<[u8; 16]>());
    let tmp = PathBuf::from(format!("{}.pacer-{nonce}.tmp", path.display()));
    let written = options
        .open(&tmp)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .and_then(|()| fs::rename(&tmp, path));
    if written.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    written.map_err(io_error)
}

/// The stored fingerprint of a well-formed `setup-health.json`; anything else is no pass.
fn parse_last_pass(text: &str) -> Option<Value> {
    let data: Value = serde_json::from_str(text).ok()?;
    let schema_one = |value: &Value| value["schema"].as_f64() == Some(1.0);
    if !data.is_object() || !schema_one(&data) {
        return None;
    }
    if !matches!(
        data["trigger"].as_str(),
        Some("startup" | "update" | "manual")
    ) || !matches!(
        data["outcome"].as_str(),
        Some("ok" | "warnings" | "hard_fail")
    ) || data.get("durationSeconds").is_some_and(|d| !d.is_number())
    {
        return None;
    }
    let print = data.get("fingerprint").filter(|print| schema_one(print))?;
    let verdict = |id: &str| {
        matches!(
            print["stepVerdicts"][id].as_str(),
            Some(
                "waiting"
                    | "running"
                    | "passed"
                    | "skipped"
                    | "needs_attention"
                    | "failed"
                    | "timed_out"
                    | "not_checked"
            )
        )
    };
    let valid = print["appVersion"].is_string()
        && print["serviceVersion"].is_string()
        && print["attentionCount"].is_number()
        && print["checkedAt"].is_number()
        && print["integrationHashes"]
            .as_object()
            .is_some_and(|hashes| hashes.values().all(Value::is_string))
        && [
            "service",
            "detect_agents",
            "integrations",
            "usage_eligibility",
            "notifications",
            "ready",
        ]
        .into_iter()
        .all(verdict);
    valid.then(|| print.clone())
}

fn unix_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// A gate input Core could not produce, as the error the gate reports.
fn core_failure(failure: &Value) -> CoreError {
    let code = match failure["code"].as_str().unwrap_or("") {
        "not_allowed" => Code::NotAllowed,
        "conflict" => Code::Conflict,
        "not_found" => Code::NotFound,
        "unavailable" => Code::Unavailable,
        "internal" => Code::Internal,
        _ => Code::InvalidInput,
    };
    let mut error = CoreError::new(code, failure["message"].as_str().unwrap_or("setup failed"));
    error.hint = failure["hint"].as_str().map(str::to_owned);
    error
}

fn notifications_skipped(home: &Path) -> bool {
    pacer_foundation::fsutil::read_json::<Value>(&home.join("settings.json"))
        .is_some_and(|settings| settings["setup"]["notifications_skipped"] == json!(true))
}

async fn setup_health(
    ctx: &Ctx,
    requested: Option<&str>,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    let started = unix_millis();
    let pass_path = ctx.pacer_home.join("setup-health.json");
    let stamp: PathBuf = ctx.pacer_home.join("setup-health.required");
    let previous = read_install_file(&pass_path)
        .ok()
        .flatten()
        .and_then(|text| parse_last_pass(&text));
    let update = requested == Some("update");
    let forced = update || matches!(read_install_file(&stamp), Ok(Some(_)));
    let trigger = if update || (forced && requested != Some("manual")) {
        "update"
    } else {
        requested.unwrap_or("startup")
    };

    let parts = parts.await?;
    let doctor = store_doctor_report(ctx, &parts["doctor"])?;
    if let Some(failure) = parts.get("failure") {
        return Err(core_failure(failure));
    }
    // Removable-volume probes are Diagnostics-only; keep the gate bounded.
    let checks: Vec<Value> = doctor["checks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            !c["name"]
                .as_str()
                .unwrap_or("")
                .starts_with("Removable volume ")
        })
        .cloned()
        .collect();
    let checked_at = js_number(ctx.now);
    let list = checklist(&parts["facts"], checked_at.clone());
    let mut report = aggregate(GateInput {
        checks: &checks,
        checklist: &list,
        trigger,
        checked_at,
        duration_seconds: js_number((unix_millis() - started) / 1000.0),
        notifications_skipped: notifications_skipped(&ctx.pacer_home),
    });
    let (version, hashes) = (&parts["version"], &parts["integrationHashes"]);
    let print = fingerprint(&report, version, hashes);

    let mut stored = print.clone();
    stored["checkedAt"] = js_number(ctx.now.floor());
    let record = json!({
        "schema": 1,
        "fingerprint": stored,
        "trigger": trigger,
        "outcome": report["outcome"],
        "durationSeconds": report["durationSeconds"],
    });
    let mut text = String::new();
    pretty(&record, 0, &mut text);
    text.push('\n');
    write_install_file(&pass_path, &text, Some(0o600))?;
    if matches!(read_install_file(&stamp), Ok(Some(_))) {
        let _ = fs::remove_file(&stamp);
    }

    let skip = !forced
        && should_skip_full_window(previous.as_ref(), version, hashes)
        && report["attentionCount"] == json!(0);
    report.insert("fingerprint".into(), print);
    report.insert("skipFullWindow".into(), skip.into());
    for key in ["planner", "repairAvailable"] {
        if let Some(value) = doctor.get(key) {
            report.insert(key.into(), value.clone());
        }
    }
    Ok(Value::Object(report))
}

/// Answers a validated request from Core's parts; `parsed` is [`bridge_params`]' value.
pub async fn run(
    ctx: &Ctx,
    op: &str,
    parsed: &Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    match op {
        "setup.check" => Ok(checklist(&parts.await?, js_number(ctx.now))),
        "doctor.run" => store_doctor_report(ctx, &parts.await?["doctor"]),
        "setup.health" => setup_health(ctx, parsed["params"]["trigger"].as_str(), parts).await,
        _ => Err(invalid("unknown core bridge op")),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn message(op: &str, params: Value) -> String {
        bridge_params(op, &params).unwrap_err().message
    }

    #[test]
    fn doctor_run_strips_keys_and_reads_null_as_empty() {
        for params in [json!({}), json!(null), json!({"x": 1})] {
            assert_eq!(
                bridge_params("doctor.run", &params).unwrap(),
                json!({"op": "doctor.run", "params": {}})
            );
        }
        assert_eq!(
            message("doctor.run", json!(5)),
            "params: Invalid input: expected object, received number"
        );
        assert_eq!(
            message("doctor.run", json!([])),
            "params: Invalid input: expected object, received array"
        );
    }

    #[test]
    fn setup_health_accepts_only_known_triggers() {
        for trigger in TRIGGERS {
            assert_eq!(
                bridge_params("setup.health", &json!({"trigger": trigger, "y": 2})).unwrap(),
                json!({"op": "setup.health", "params": {"trigger": trigger}})
            );
        }
        assert_eq!(
            bridge_params("setup.health", &json!(null)).unwrap(),
            json!({"op": "setup.health", "params": {}})
        );
        for trigger in [json!("nope"), json!("Startup"), json!(5), json!(null)] {
            let error = bridge_params("setup.health", &json!({ "trigger": trigger })).unwrap_err();
            assert_eq!(error.code, Code::InvalidInput);
            assert_eq!(
                error.message,
                r#"trigger: Invalid option: expected one of "startup"|"update"|"manual""#
            );
        }
        assert_eq!(
            message("setup.health", json!("s")),
            "params: Invalid input: expected object, received string"
        );
    }

    #[tokio::test]
    async fn stubs_report_the_missing_bridge() {
        let ctx = Ctx::with(
            "/nonexistent".into(),
            "/nonexistent".into(),
            Default::default(),
            0.0,
        );
        for stub in [setup_health_stub, doctor_run_stub] {
            let error = stub(&ctx, json!({})).await.unwrap_err();
            assert_eq!(error.code, Code::Unavailable);
        }
    }
}
