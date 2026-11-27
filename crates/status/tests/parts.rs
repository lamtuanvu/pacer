#![allow(clippy::unwrap_used)]
//! B12-6: native `statusBrokerPartsFor`. The three modes and the shared
//! readings map are exercised against a fake plugin door.

use pacer_foundation::{Ctx, api::Code};
use pacer_plugin_ops::{extension::EntriesFuture, public::Entry};
use pacer_status::{
    compute::{ActivityRebuilds, LoginPaths, StatusRuntime},
    parts::testing::{broker_parts, parse_params, type_name},
    usage::{NativeUsage, PluginDoor},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const PLUGIN: &str = "pacer-usage";
const NOW: f64 = 1_790_000_000.0;

const STRATEGY: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\nrunners:\n  claude-code: {}\n  codex: {}\npacing: {policy: priority, order: [claude-code, codex]}\n";
const WIDE: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\n  codex: {kind: codex}\n  cursor: {kind: cursor}\nrunners:\n  claude-code: {}\n  codex: {}\n  cursor: {}\npacing: {policy: priority, order: [claude-code, codex, cursor]}\n";

struct Inner {
    entries: Vec<Entry>,
    calls: Vec<String>,
    replies: VecDeque<Value>,
}

struct FakeDoor {
    inner: Arc<Mutex<Inner>>,
}

struct FakeCalls {
    inner: Arc<Mutex<Inner>>,
}

impl PluginDoor for FakeDoor {
    fn calls(&self) -> Box<dyn pacer_plugin_ops::extension::ExtensionCalls + '_> {
        Box::new(FakeCalls {
            inner: self.inner.clone(),
        })
    }
}

impl pacer_plugin_ops::extension::ExtensionCalls for FakeCalls {
    fn entries<'a>(&'a mut self, _: &'a Ctx) -> EntriesFuture<'a> {
        let entries = self.inner.lock().unwrap().entries.clone();
        Box::pin(async move { Ok(entries) })
    }

    fn call<'a>(
        &'a mut self,
        _: &'a Ctx,
        _: &'a str,
        _: &'a str,
        params: Value,
    ) -> pacer_foundation::api::OpFuture<'a> {
        let (name, reply) = {
            let mut inner = self.inner.lock().unwrap();
            let name = params["account"].as_str().unwrap_or("").to_string();
            inner.calls.push(name.clone());
            (name, inner.replies.pop_front().unwrap_or_else(|| reading()))
        };
        let _ = name;
        Box::pin(async move { Ok(json!({"reading": reply})) })
    }
}

fn usage_plugin() -> Entry {
    Entry {
        id: PLUGIN.to_string(),
        manifest: Some(json!({"contributes": {"usage": {
            "providers": ["claude-code", "codex", "arkcli", "metered"]
        }}})),
        bundled: true,
        grant: json!({}),
        state: "ready".to_string(),
        error: None,
        pid: None,
        served: vec![],
        protocol: None,
        restarts: 0,
    }
}

fn reading() -> Value {
    json!({
        "windows": [{"lengthS": 18000, "usedPct": 20, "resetsAt": NOW + 7200.0}],
        "capturedAt": NOW,
        "stale": false,
        "source": "claude-code",
    })
}

struct Harness {
    rt: StatusRuntime,
    calls: Arc<Mutex<Inner>>,
    home: PathBuf,
}

fn harness() -> Harness {
    let home = tempfile::tempdir().unwrap().keep();
    let pacer = home.join(".pacer");
    fs::create_dir_all(pacer.join("strategies")).unwrap();
    fs::write(pacer.join("strategy.yaml"), STRATEGY).unwrap();
    fs::write(pacer.join("strategies").join("wide.yaml"), WIDE).unwrap();
    let inner = Arc::new(Mutex::new(Inner {
        entries: vec![usage_plugin()],
        calls: Vec::new(),
        replies: VecDeque::from(vec![reading(), reading(), reading(), reading()]),
    }));
    let door = Arc::new(FakeDoor {
        inner: inner.clone(),
    });
    let rt = StatusRuntime {
        usage: NativeUsage::new(door.clone()),
        door,
        login: Arc::new(LoginPaths::default()),
        activity: Arc::new(ActivityRebuilds::default()),
    };
    Harness {
        rt,
        calls: inner,
        home,
    }
}

impl Harness {
    fn ctx(&self) -> Ctx {
        Ctx::with(
            self.home.clone(),
            self.home.join(".pacer"),
            HashMap::from([
                ("HOME".into(), self.home.to_string_lossy().into_owned()),
                ("PATH".into(), "/usr/bin:/bin".into()),
                ("TMPDIR".into(), self.home.to_string_lossy().into_owned()),
                ("LANG".into(), "en_US.UTF-8".into()),
            ]),
            NOW,
        )
    }
}

/// Every file under PACER_HOME with its mode and bytes.
fn files(root: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                let meta = entry.metadata().unwrap();
                let mode = meta.permissions().mode() & 0o777;
                out.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    format!("{mode:o} {}", base64(&fs::read(&path).unwrap())),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

fn base64(bytes: &[u8]) -> String {
    const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = ((chunk[0] as u32) << 16)
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
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

#[tokio::test]
async fn full_parts_have_the_status_key_order_and_the_strategy_snapshot() {
    let h = harness();
    let reply = broker_parts(&h.ctx(), json!({}), &h.rt).await.unwrap();
    assert_eq!(
        reply
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec![
            "accounts",
            "providers",
            "policy",
            "calendarPace",
            "strategy"
        ]
    );
    assert_eq!(reply["strategy"]["text"], STRATEGY);
    assert_eq!(reply["strategy"]["name"], "default");
    assert!(
        reply["strategy"]["path"]
            .as_str()
            .unwrap()
            .ends_with("strategy.yaml")
    );
}

#[tokio::test]
async fn cache_only_parts_write_nothing() {
    let h = harness();
    let before = files(&h.home);
    let reply = broker_parts(&h.ctx(), json!({"cacheOnly": true}), &h.rt)
        .await
        .unwrap();
    assert!(reply["accounts"].as_array().is_some());
    assert_eq!(files(&h.home), before);
}

#[tokio::test]
async fn draft_statuses_share_one_readings_map() {
    let h = harness();
    let reply = broker_parts(&h.ctx(), json!({"draft": {"from": "wide"}}), &h.rt)
        .await
        .unwrap();
    assert_eq!(
        reply
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["current", "draft"]
    );
    let calls = h.calls.lock().unwrap().calls.clone();
    assert_eq!(calls.iter().filter(|name| *name == "claude").count(), 1);
    assert_eq!(calls.iter().filter(|name| *name == "codex").count(), 1);
}

#[tokio::test]
async fn an_invalid_draft_becomes_errors() {
    let h = harness();
    let reply = broker_parts(
        &h.ctx(),
        json!({"draft": {"from": "default", "set": {"pacing.policy": "nope"}}}),
        &h.rt,
    )
    .await
    .unwrap();
    assert_eq!(
        reply
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>(),
        vec!["current", "errors"]
    );
    assert!(
        reply["errors"]
            .as_array()
            .is_some_and(|errors| !errors.is_empty())
    );
}

#[tokio::test]
async fn unknown_params_use_zods_text() {
    let error = parse_params(&json!({"x": 1})).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(error.message, "params: Unrecognized key: \"x\"");
}

#[tokio::test]
async fn a_wrong_cache_only_type_uses_zods_text() {
    let error = parse_params(&json!({"cacheOnly": "yes"})).unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(
        error.message,
        "cacheOnly: Invalid input: expected boolean, received string"
    );
    assert_eq!(type_name(&Value::Null), "null");
}
