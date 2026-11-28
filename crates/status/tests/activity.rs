#![allow(clippy::unwrap_used)]
//! B12-3 golden tests replaying the TypeScript-recorded activity fixtures
//! (`test/fixtures/m3/status/activity.json`) against the Rust pacer-status
//! ports of `buildActivity` / `loadActivity` and their cursor store. Each case
//! replays the same ordered `ops` script the recorder produced (writing logs
//! with pinned mtimes, appending, removing, building and loading) and compares
//! the activity profile, the normalized cursor snapshot, the activity.json
//! cache and the lock state against `expected`. Cursor inodes are
//! machine-specific, so both sides write them as 0; cursor keys are made
//! home-relative (`~`) so a different tempdir still matches.
use pacer_foundation::Ctx;
use pacer_status::activity::{
    ActivityRebuilds, build_activity, load_activity, rebuild_activity, try_activity_lock,
};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::{fs::FileTimes, time::UNIX_EPOCH};

fn cases(text: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(text)
        .unwrap()
        .as_array()
        .unwrap()
        .clone()
}

/// Epoch seconds for the local wall clock the recorder used (TZ pinned to
/// Asia/Ho_Chi_Minh in the fixture env). We pass epoch numbers through as-is,
/// so no local-time reconstruction is needed here.
fn file_path(ctx: &Ctx, rel: &str) -> PathBuf {
    if let Some(rest) = rel.strip_prefix("~/") {
        ctx.home.join(rest)
    } else {
        ctx.pacer_home.join(rel)
    }
}

fn write_file(ctx: &Ctx, rel: &str, content: &str, mtime: Option<f64>) {
    let path = file_path(ctx, rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(&path, content).unwrap();
    if let Some(secs) = mtime {
        set_mtime(&path, secs);
    }
}

fn set_mtime(path: &Path, secs: f64) {
    let t = UNIX_EPOCH + std::time::Duration::from_secs_f64(secs);
    std::fs::set_times(path, FileTimes::new().set_modified(t)).unwrap();
}

/// Rebuild the fake home for `input`: write `input.files` (a `~/`-prefixed
/// key goes under home), set `input.env`. `now` is carried per-op instead.
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
    let ctx = Ctx::with(home.clone(), pacer_home.clone(), env, 0.0);
    if let Some(files) = input.get("files").and_then(Value::as_object) {
        for (rel, spec) in files {
            let content = spec.get("content").and_then(Value::as_str).unwrap_or("");
            let mtime = spec.get("mtime").and_then(Value::as_f64);
            write_file(&ctx, rel, content, mtime);
        }
    }
    (ctx, temp)
}

fn quiet() -> std::sync::Arc<ActivityRebuilds> {
    ActivityRebuilds::quiet()
}

/// The normalized cursor snapshot: every `inode` is 0 and every cursor key
/// under `home` becomes `~`-relative, mirroring the recorder.
fn normalized_cursors(ctx: &Ctx) -> Option<Value> {
    let path = ctx.pacer_home.join("state").join("activity-cursors.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return None;
    };
    let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
        return None;
    };
    Some(normalize(raw, &ctx.home))
}

fn normalize(value: Value, home: &Path) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                if k == "inode" {
                    out.insert(k, json!(0));
                } else {
                    let prefix = format!("{}/", home.display());
                    let key = if let Some(rest) = k.strip_prefix(&prefix) {
                        format!("~/{rest}")
                    } else {
                        k
                    };
                    out.insert(key, normalize(v, home));
                }
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(|v| normalize(v, home)).collect()),
        other => other,
    }
}

fn activity_file(ctx: &Ctx) -> Option<Value> {
    let path = ctx.pacer_home.join("activity.json");
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&text).ok(),
        Err(_) => None,
    }
}

fn lock_present(ctx: &Ctx) -> bool {
    ctx.pacer_home.join("activity.lock").exists()
}

/// Semantic value equality: serde_json separates integer and float
/// representations, so `1791633600` (the golden's int, from TS JSON) and
/// `1791633600.0` (Rust's f64) compare unequal with `assert_eq!`. Both
/// sides intend the same number, so compare numerics by their f64 value.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(an), Value::Number(bn)) => an.as_f64() == bn.as_f64(),
        (Value::Object(am), Value::Object(bm)) => {
            am.len() == bm.len()
                && am
                    .iter()
                    .all(|(k, v)| bm.get(k).is_some_and(|bv| same_json(v, bv)))
        }
        (Value::Array(aa), Value::Array(ba)) => {
            aa.len() == ba.len() && aa.iter().zip(ba.iter()).all(|(av, bv)| same_json(av, bv))
        }
        (Value::Bool(ab), Value::Bool(bb)) => ab == bb,
        (Value::String(astr), Value::String(bstr)) => astr == bstr,
        (Value::Null, Value::Null) => true,
        _ => false,
    }
}

fn env_with_ctx(ctx: &Ctx, now: f64, extra: &HashMap<String, String>) -> Ctx {
    let mut env = ctx.env.clone();
    for (k, v) in extra {
        env.insert(k.clone(), v.clone());
    }
    Ctx::with(ctx.home.clone(), ctx.pacer_home.clone(), env, now)
}

fn run_ops(ctx: &Ctx, ops: &Value, rt: &tokio::runtime::Runtime) -> Value {
    let mut profile: Option<Value> = None;
    for op in ops.as_array().unwrap() {
        if let Some(w) = op.get("write") {
            let path = w.get("path").and_then(Value::as_str).unwrap();
            let content = w.get("content").and_then(Value::as_str).unwrap_or("");
            let mtime = w.get("mtime").and_then(Value::as_f64);
            write_file(ctx, path, content, mtime);
        } else if let Some(a) = op.get("append") {
            let path = a.get("path").and_then(Value::as_str).unwrap();
            let content = a.get("content").and_then(Value::as_str).unwrap_or("");
            let mtime = a.get("mtime").and_then(Value::as_f64);
            let p = file_path(ctx, path);
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
            f.write_all(content.as_bytes()).unwrap();
            drop(f);
            if let Some(secs) = mtime {
                set_mtime(&p, secs);
            }
        } else if let Some(r) = op.get("remove") {
            let path = r.get("path").and_then(Value::as_str).unwrap();
            std::fs::remove_file(file_path(ctx, path)).unwrap();
        } else if let Some(b) = op.get("build") {
            let now = b.get("now").and_then(Value::as_f64).unwrap();
            let lookback = b
                .get("lookbackDays")
                .and_then(Value::as_f64)
                .unwrap_or(28.0);
            let threshold = b.get("threshold").and_then(Value::as_f64).unwrap_or(0.2);
            let c = Ctx::with(
                ctx.home.clone(),
                ctx.pacer_home.clone(),
                ctx.env.clone(),
                now,
            );
            profile = Some(
                rt.block_on(build_activity(&c, lookback, threshold))
                    .unwrap(),
            );
        } else if let Some(l) = op.get("load") {
            let now = l.get("now").and_then(Value::as_f64).unwrap();
            let read_only = l.get("readOnly").and_then(Value::as_bool).unwrap_or(false);
            let token = l
                .get("lockToken")
                .and_then(Value::as_str)
                .map(str::to_string);
            let mut extra = HashMap::new();
            if let Some(t) = token {
                extra.insert("PACER_ACTIVITY_LOCK_TOKEN".to_string(), t);
            }
            let c = env_with_ctx(ctx, now, &extra);
            profile = rt.block_on(load_activity(&c, read_only, &quiet())).unwrap();
        }
    }
    json!({
        "profile": profile.unwrap_or(Value::Null),
        "cursors": normalized_cursors(ctx),
        "activityJson": activity_file(ctx),
        "lock": lock_present(ctx),
    })
}

#[test]
fn activity_matches_typescript() {
    for case in cases(include_str!(
        "../../../test/fixtures/m3/status/activity.json"
    )) {
        let name = case["name"].as_str().unwrap();
        let i = &case["input"];
        let (ctx, _tmp) = setup(i);
        let rt = tokio::runtime::Runtime::new().unwrap();
        let out = run_ops(&ctx, &i["ops"], &rt);
        let exp = &case["expected"];
        assert!(
            same_json(&out["profile"], &exp["profile"]),
            "{name} profile\nexpected profile:\n{}\ngot profile:\n{}\nexpected cursors:\n{}\ngot cursors:\n{}",
            serde_json::to_string_pretty(&exp["profile"]).unwrap(),
            serde_json::to_string_pretty(&out["profile"]).unwrap(),
            serde_json::to_string_pretty(&exp["cursors"]).unwrap(),
            serde_json::to_string_pretty(&out["cursors"]).unwrap()
        );
        assert!(
            same_json(&out["cursors"], &exp["cursors"]),
            "{name} cursors"
        );
        // Compare parsed JSON for the cache (js_stringify == JSON.stringify
        // byte-for-byte, but semantic equality keeps the golden stable).
        let exp_activity = exp
            .get("activityJson")
            .and_then(Value::as_str)
            .map(|s| serde_json::from_str::<Value>(s).unwrap());
        let actual_activity = out
            .get("activityJson")
            .and_then(Value::as_object)
            .map(|_| out["activityJson"].clone());
        let same_activity = match (&actual_activity, &exp_activity) {
            (Some(a), Some(b)) => same_json(a, b),
            (None, None) => true,
            _ => false,
        };
        assert!(same_activity, "{name} activityJson");
        assert_eq!(out["lock"], exp["lock"], "{name} lock");
        assert_eq!(out["lock"], exp["lock"], "{name} lock");
    }
}

/// Rebuilding writes the cache and releases the lock this process holds.
#[test]
fn rebuild_releases_the_lock_and_writes_activity_json() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().to_path_buf();
    let mut env = HashMap::new();
    env.insert("TZ".to_string(), "UTC".to_string());
    let home_now = 1_000_000.0;
    let ctx = Ctx::with(home.clone(), home.join(".pacer"), env, home_now);
    write_file(
        &ctx,
        "~/.claude/projects/-p/one.jsonl",
        "{\"type\":\"user\",\"timestamp\":\"1970-01-13T05:46:40.000Z\"}",
        Some(home_now - 60.0),
    );
    assert!(try_activity_lock(&ctx), "a fresh lock should be acquired");
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(rebuild_activity(&ctx)).unwrap();
    assert!(
        ctx.pacer_home.join("activity.json").exists(),
        "rebuild writes the cache"
    );
    assert!(
        !ctx.pacer_home.join("activity.lock").exists(),
        "rebuild releases the held lock"
    );
}

/// A fresh foreign lock is held: trying to take it reports false and no
/// rebuild is triggered from a stale load.
#[test]
fn a_fresh_foreign_lock_blocks_rebuild() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().to_path_buf();
    let mut env = HashMap::new();
    env.insert("TZ".to_string(), "UTC".to_string());
    let home_now = 1_000_000.0;
    let ctx = Ctx::with(home.clone(), home.join(".pacer"), env, home_now);
    std::fs::create_dir_all(&ctx.pacer_home).unwrap();
    std::fs::write(
        ctx.pacer_home.join("activity.lock"),
        format!(r#"{{"at":{home_now},"pid":1,"token":"foreign"}}"#),
    )
    .unwrap();
    assert!(
        !try_activity_lock(&ctx),
        "a fresh foreign lock is held and not replaced"
    );
    // A stale foreign lock (beyond the 600 s window) is replaced.
    std::fs::write(
        ctx.pacer_home.join("activity.lock"),
        format!(r#"{{"at":{},"pid":1,"token":"foreign"}}"#, home_now - 601.0),
    )
    .unwrap();
    assert!(try_activity_lock(&ctx), "a stale foreign lock is replaced");
}

/// The lock byte layout is fixed so TypeScript and Rust exclude each other:
/// a TS-written fresh lock blocks the Rust side, and a Rust-written lock
/// blocks the TypeScript side. Skips when `bun` is not on PATH.
#[test]
fn ts_and_rust_never_rebuild_together() {
    let bun = std::process::Command::new("bun").arg("--version").output();
    if bun.is_err() {
        eprintln!("skipping cross-runtime test: bun is not on PATH");
        return;
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .unwrap();

    // 1: TypeScript takes the lock; Rust must see it as held.
    let dt = tempfile::tempdir().unwrap();
    let script = r#"
import {tryActivityLock} from './src/pace/activity.ts';
import {writeFileSync} from 'node:fs';
const c = {home:process.env.TEST_HOME, pacerHome:process.env.TEST_HOME+'/.pacer',
  now:Date.now()/1000, env:{}, run:async()=>({code:127,stdout:'',stderr:''}), which:()=>null};
const mine = tryActivityLock(c);
writeFileSync(process.env.TEST_HOME+'/.pacer/ts-ok', String(mine));
process.exit(mine ? 0 : 1);
"#;
    let result = std::process::Command::new("bun")
        .arg("-e")
        .arg(script)
        .env("TEST_HOME", dt.path())
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "TS lock: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    let mut env = HashMap::new();
    env.insert("TZ".to_string(), "UTC".to_string());
    let ctx = Ctx::with(dt.path().to_path_buf(), dt.path().join(".pacer"), env, 0.0);
    // Bring `now` within the lock's fresh window relative to the TS `at`.
    let at: Value =
        serde_json::from_slice(&std::fs::read(ctx.pacer_home.join("activity.lock")).unwrap())
            .unwrap();
    let now = at.get("at").unwrap().as_f64().unwrap();
    let held = Ctx::with(
        ctx.home.clone(),
        ctx.pacer_home.clone(),
        ctx.env.clone(),
        now + 5.0,
    );
    assert!(
        !try_activity_lock(&held),
        "a fresh TS lock must block the Rust side"
    );

    // 2: Rust takes a fresh lock in a new home; TypeScript must see it held.
    let rt2 = tempfile::tempdir().unwrap();
    let home2 = rt2.path().to_path_buf();
    let ctx2 = Ctx::with(home2.clone(), home2.join(".pacer"), HashMap::new(), 0.0);
    std::fs::create_dir_all(&ctx2.pacer_home).unwrap();
    let now2 = 1_000_000.0;
    let c2 = Ctx::with(
        ctx2.home.clone(),
        ctx2.pacer_home.clone(),
        ctx2.env.clone(),
        now2,
    );
    assert!(try_activity_lock(&c2), "Rust takes a fresh lock");
    let script2 = format!(
        r#"
import {{tryActivityLock}} from './src/pace/activity.ts';
const c = {{home:process.env.TEST_HOME, pacerHome:process.env.TEST_HOME+'/.pacer',
  now:{now2}, env:{{}}, run:async()=>({{code:127,stdout:'',stderr:''}}), which:()=>null}};
process.exit(tryActivityLock(c) ? 0 : 2);
"#
    );
    let result2 = std::process::Command::new("bun")
        .arg("-e")
        .arg(&script2)
        .env("TEST_HOME", rt2.path())
        .current_dir(root)
        .output()
        .unwrap();
    assert_eq!(
        result2.status.code(),
        Some(2),
        "a fresh Rust lock must block the TypeScript side: {}",
        String::from_utf8_lossy(&result2.stderr)
    );
}
