#![allow(clippy::unwrap_used)]
//! B12-2 golden tests replaying the TypeScript-recorded account-input fixtures
//! (`test/fixtures/m3/status/`) against the Rust pacer-status ports: auth
//! marks, local sign-in, cached remote usage and endpoint rows. Each case
//! rebuilds a deterministic fake pacer home from `input.files` / `input.env` /
//! `input.now` and compares against `input.expected`, mirroring the recorder
//! in `test/native-status-goldens.test.ts`.
use pacer_foundation::Ctx;
use pacer_status::{endpoint, marks, remote_usage, signin};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::{fs::FileTimes, time::UNIX_EPOCH};

const NOW: f64 = 1_000_000.0;

fn cases(text: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(text)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

/// Rebuild the fake home for `input`: write `input.files` (a `~/`-prefixed
/// key goes under home, otherwise under pacerHome), set `input.env` and
/// `input.now`, and return the ctx (with the kept-alive tempdir).
fn setup(input: &Value) -> (Ctx, tempfile::TempDir) {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().to_path_buf();
    let pacer_home = home.join(".pacer");
    let env: HashMap<String, String> = input
        .get("env")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
                .collect()
        })
        .unwrap_or_default();
    let now = input.get("now").and_then(Value::as_f64).unwrap_or(NOW);
    let ctx = Ctx::with(home.clone(), pacer_home.clone(), env, now);
    write_files(&ctx, input.get("files"));
    (ctx, temp)
}

fn write_files(ctx: &Ctx, files: Option<&Value>) {
    let Some(files) = files.and_then(Value::as_object) else {
        return;
    };
    for (rel, spec) in files {
        let content = spec.get("content").and_then(Value::as_str).unwrap_or("");
        let path = file_path(ctx, rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(&path, content).unwrap();
        if let Some(secs) = spec.get("mtime").and_then(Value::as_f64) {
            set_mtime(&path, secs);
        }
    }
}

fn file_path(ctx: &Ctx, rel: &str) -> PathBuf {
    if let Some(rest) = rel.strip_prefix("~/") {
        ctx.home.join(rest)
    } else {
        ctx.pacer_home.join(rel)
    }
}

fn file_bytes(ctx: &Ctx, rel: &str) -> Value {
    let path = file_path(ctx, rel);
    match std::fs::read_to_string(path) {
        Ok(text) => json!(text),
        Err(_) => Value::Null,
    }
}

fn set_mtime(path: &Path, secs: f64) {
    let t = UNIX_EPOCH + std::time::Duration::from_secs_f64(secs);
    std::fs::set_times(path, FileTimes::new().set_modified(t)).unwrap();
}

/// A JSON number in TypeScript's spelling (integral values stay integers).
fn js_number(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 {
        Value::Number(serde_json::Number::from(v as i64))
    } else {
        Value::from(v)
    }
}

#[test]
fn marks_match_typescript() {
    for case in cases(include_str!("../../../test/fixtures/m3/status/marks.json")) {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let out = match name {
            "auth-observation-ok" | "auth-observation-mismatch" | "auth-observation-retired" => {
                let (ctx, _tmp) = setup(i);
                match marks::auth_observation(&ctx, &i["scope"]) {
                    Some((at, scope)) => json!({ "at": js_number(at), "scope": scope }),
                    None => Value::Null,
                }
            }
            "record-auth-reading-error"
            | "record-auth-reading-clear"
            | "record-auth-reading-stale" => {
                let (ctx, _tmp) = setup(i);
                let account = i["account"].as_str().unwrap();
                let scope = i.get("scope").cloned();
                marks::record_auth_reading(&ctx, account, &i["reading"], scope.as_ref(), false)
                    .unwrap();
                json!({ "authFailed": file_bytes(&ctx, "state/auth-failed.json") })
            }
            "active-limit-observations" => {
                let (ctx, _tmp) = setup(i);
                json!(
                    marks::active_limit_observations(&ctx)
                        .iter()
                        .map(|o| json!({ "key": o.key, "observation": o.observation }))
                        .collect::<Vec<_>>()
                )
            }
            _ => panic!("unhandled marks golden case: {name}"),
        };
        assert_eq!(out, case["expected"], "{name}");
    }
}

#[test]
fn signin_matches_typescript() {
    for case in cases(include_str!("../../../test/fixtures/m3/status/signin.json")) {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let (ctx, _tmp) = setup(i);
        let out = signin::account_sign_in(&ctx, &i["account"], &i["scope"]);
        assert_eq!(out, case["expected"], "{name}");
    }
}

#[test]
fn remote_usage_matches_typescript() {
    for case in cases(include_str!(
        "../../../test/fixtures/m3/status/remote-usage.json"
    )) {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let (ctx, _tmp) = setup(i);
        let out = match remote_usage::cached_remote_usage(&ctx, &i["account"], Some(&i["hosts"])) {
            Some(v) => v,
            None => Value::Null,
        };
        assert_eq!(out, case["expected"], "{name}");
    }
}

#[test]
fn endpoint_matches_typescript() {
    for case in cases(include_str!(
        "../../../test/fixtures/m3/status/endpoint.json"
    )) {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let (ctx, _tmp) = setup(i);
        let out = futures::executor::block_on(endpoint::endpoint_cell(&ctx, &i["account"], false));
        assert_eq!(out, case["expected"], "{name}");
    }
}

/// SEC-1: the Keychain probe is presence-only — it asks `security` for the item
/// without requesting the stored secret (`-w`). The fake `security` on the
/// child's PATH records its argv and answers by exit status.
#[test]
fn has_key_keychain_uses_presence_only() {
    let temp = tempfile::tempdir().unwrap();
    let bin = temp.path().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = bin.join("security");
    let log = bin.join("argv.log");
    // Log argv to `argv.log` next to the script (via an env var the child
    // inherits — the script can be reached by PATH only), then answer "present".
    std::fs::write(
        &script,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$PACER_FAKE_SECURITY_LOG\"\nexit 0\n",
    )
    .unwrap();
    std::fs::set_permissions(&script, PermissionsExt::from_mode(0o755)).unwrap();
    // PATH and the log location are set only on the child: they are present
    // only in the ctx env that `has_key` applies to the child
    // (`Command::env`), not the parent.
    let mut env = HashMap::new();
    env.insert("PATH".to_string(), bin.display().to_string());
    env.insert(
        "PACER_FAKE_SECURITY_LOG".to_string(),
        log.display().to_string(),
    );
    let home = temp.path().to_path_buf();
    let ctx = Ctx::with(home.clone(), home.join(".pacer"), env, NOW);
    let rt = tokio::runtime::Runtime::new().unwrap();
    let present = rt.block_on(endpoint::has_key(&ctx, "demo", "keychain"));
    assert!(present, "a zero-exit `security` means the key is present");
    let args = std::fs::read_to_string(&log).unwrap();
    let tokens: Vec<&str> = args.trim().lines().collect();
    assert_eq!(
        tokens,
        vec![
            "find-generic-password",
            "-s",
            "pacer",
            "-a",
            "endpoint/demo"
        ],
        "the presence probe must use the exact argv (one arg per line)"
    );
    assert!(
        !tokens.contains(&"-w"),
        "the probe must not request the secret"
    );
}
