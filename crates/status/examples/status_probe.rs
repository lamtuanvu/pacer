//! C3 parity driver for the native status library: one JSON line on stdin
//! (`{"fn","home","now","env","args"}`), one JSON line on stdout.
//!
//! `compute_status` loads the active strategy from the disposable home given in
//! the request, serves the supplied registry entries through a `FakeDoor`, and
//! answers `usage.read` from the supplied readings. `refresh_outcome` and
//! `refresh_capability` expose the pure refresh rules so the older
//! usage-refresh parity suite shares this one driver. Every reply carries the
//! post-call `files` map (relative path -> `<octal mode> <base64 bytes>`) so
//! cross-runtime tests can compare what each side wrote, not just its result.

use pacer_foundation::{Ctx, api::OpFuture};
use pacer_plugin_ops::{
    extension::{EntriesFuture, ExtensionCalls},
    public::Entry,
};
use pacer_status::{
    compute::{Endpoints, Readings, StatusOptions, StatusRuntime, compute_status},
    policy, refresh,
    usage::{NativeUsage, PluginDoor},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

/// The one plugin door of this probe process. All entries come from the TS
/// registry snapshot in the request; the readings double as the private
/// `usage.read` cache (the computation normally finds them before calling the
/// plugin).
struct Door {
    entries: Vec<Entry>,
    readings: Arc<Readings>,
}

struct FakeCalls<'a> {
    door: &'a Door,
}

impl ExtensionCalls for FakeCalls<'_> {
    fn entries<'a>(&'a mut self, _ctx: &'a Ctx) -> EntriesFuture<'a> {
        let entries = self.door.entries.clone();
        Box::pin(async move { Ok(entries) })
    }

    fn call<'a>(
        &'a mut self,
        _ctx: &'a Ctx,
        _id: &'a str,
        method: &'a str,
        params: Value,
    ) -> OpFuture<'a> {
        let name = params["account"].as_str().unwrap_or("").to_string();
        let reading = self.door.readings.lock().unwrap().get(&name).cloned();
        Box::pin(async move {
            if method != "usage.read" {
                return Ok(Value::Null);
            }
            Ok(json!({"reading": reading.unwrap_or(Value::Null)}))
        })
    }
}

impl PluginDoor for Door {
    fn calls(&self) -> Box<dyn ExtensionCalls + '_> {
        Box::new(FakeCalls { door: self })
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (a << 16) | (b << 8) | c;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(unix)]
fn mode_of(path: &Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    format!(
        "{:03o}",
        fs::metadata(path)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0)
    )
}

#[cfg(not(unix))]
fn mode_of(_path: &Path) -> String {
    "600".to_string()
}

/// Every regular file under the home, in sorted relative-path order. Directories
/// are not entries: the TS side compares the same walk.
fn files(root: &Path) -> io::Result<Vec<(String, String)>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) -> io::Result<()> {
        let mut entries: Vec<PathBuf> = fs::read_dir(dir)?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .collect();
        entries.sort();
        for path in entries {
            if path.is_dir() {
                walk(root, &path, out)?;
            } else if path.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                // The plugin registry's per-process orca link token is random, not shared state.
                if relative == ".pacer/orca/link.lock" {
                    continue;
                }
                out.push((
                    relative,
                    format!("{} {}", mode_of(&path), base64(&fs::read(&path)?)),
                ));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    if root.is_dir() {
        walk(root, root, &mut out)?;
    }
    Ok(out)
}

fn options(args: &Value) -> StatusOptions<'_> {
    let o = &args["options"];
    let profile = if let Some(value) = o.get("profile") {
        Some(if value.is_null() {
            None
        } else {
            Some(value.clone())
        })
    } else {
        None
    };
    StatusOptions {
        read_only: o["readOnly"].as_bool().unwrap_or(false),
        include_planner_sign_in: o["includePlannerSignIn"].as_bool().unwrap_or(false),
        cache_only: o["cacheOnly"].as_bool().unwrap_or(false),
        service_path: o["servicePath"].as_bool().unwrap_or(false),
        profile,
        ..StatusOptions::default()
    }
}

async fn run(input: &Value) -> Result<Value, String> {
    let home = PathBuf::from(input["home"].as_str().ok_or("missing home")?);
    let pacer_home = input
        .get("pacerHome")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".pacer"));
    let mut env = HashMap::new();
    for (key, value) in input["env"].as_object().into_iter().flatten() {
        env.insert(key.clone(), value.as_str().unwrap_or_default().to_string());
    }
    let ctx = Ctx::with(
        home.clone(),
        pacer_home.clone(),
        env,
        input["now"].as_f64().unwrap_or(1_798_000_000.0),
    );
    let args = &input["args"];
    let result = match input["fn"].as_str().unwrap_or("") {
        "compute_status" => {
            let strategy = if args["strategy"].is_object() {
                args["strategy"].clone()
            } else {
                pacer_config::strategy::load_strategy(&pacer_home)
                    .map_err(|e| format!("load strategy: {e}"))?
            };
            let readings: Arc<Readings> = Arc::new(std::sync::Mutex::new(
                args["readings"]
                    .as_object()
                    .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default(),
            ));
            let endpoints: Endpoints = std::sync::Mutex::new(
                args["endpoints"]
                    .as_object()
                    .map(|o| o.iter().map(|(k, v)| (k.clone(), v.clone())).collect())
                    .unwrap_or_default(),
            );
            let entries: Vec<Entry> = serde_json::from_value(args["entries"].clone())
                .map_err(|e| format!("invalid entries: {e}"))?;
            // The policy summary is also served through the one door fetch, so
            // it must agree with the entries the TS registry snapshot supplies.
            let policy = policy::policy_summary(&ctx, &entries).map_err(|e| format!("{e:?}"))?;
            let door = Door {
                entries: entries.clone(),
                readings: readings.clone(),
            };
            let rt = StatusRuntime {
                usage: NativeUsage::new(Arc::new(door)),
                door: Arc::new(Door {
                    entries,
                    readings: readings.clone(),
                }),
                login: Arc::new(pacer_status::compute::LoginPaths::default()),
                activity: Arc::new(pacer_status::compute::ActivityRebuilds::default()),
            };
            let mut opts = options(args);
            opts.readings = Some(&readings);
            opts.endpoints = Some(&endpoints);
            let status = compute_status(&ctx, &strategy, &opts, &rt)
                .await
                .map_err(|e| format!("{e:?}"))?;
            json!({"status": status, "policy": policy})
        }
        "refresh_capability" => json!(refresh::refresh_capability(&args["account"])),
        "refresh_outcome" => json!(refresh::refresh_outcome(
            args["capability"].as_str().unwrap_or(""),
            &args["prior"],
            &args["current"],
        )),
        "automatic_refresh_suppressed" => json!(refresh::automatic_refresh_suppressed(
            args["now"].as_f64().unwrap_or(0.0),
            args["last"].as_f64(),
            args["automatic"].as_bool().unwrap_or(false),
        )),
        other => return Err(format!("unknown fn {other}")),
    };
    Ok(result)
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line?).map_err(io::Error::other)?;
        let output = match run(&input).await {
            Ok(result) => json!({"result": result}),
            Err(error) => json!({"error": error}),
        };
        let mut output = output;
        if input["fn"].as_str() == Some("compute_status") {
            let home = PathBuf::from(input["home"].as_str().unwrap_or(""));
            let snapshot = files(&home)?;
            output["files"] = json!(
                snapshot
                    .into_iter()
                    .map(|(path, value)| (path, Value::from(value)))
                    .collect::<serde_json::Map<_, _>>()
            );
        }
        serde_json::to_writer(&mut stdout, &output)?;
        stdout.write_all(b"\n")?;
    }
    stdout.flush()
}
