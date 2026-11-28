#![allow(clippy::unwrap_used)]
//! B12-4: native usage reads, memo/last-good/timeout parity and the refresh
//! coordinator. The spec goldens are recorded by
//! `test/native-usage-read-parity.test.ts`.

use pacer_foundation::{
    Ctx,
    api::{Code, OpFuture},
};
use pacer_plugin_ops::extension::EntriesFuture;
use pacer_plugin_ops::public::Entry;
use pacer_status::usage::{NativeUsage, PluginDoor, ReadMode, UsageReads};
use pacer_status::usage_spec::{UsageCall, usage_call_spec};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

const PLUGIN: &str = "pacer-usage";

enum Reply {
    Value(Value),
    Delayed(Value, Duration),
    Hang,
}

struct Inner {
    entries: Vec<Entry>,
    calls: Vec<(String, String, Value)>,
    replies: VecDeque<Reply>,
}

struct FakeDoor {
    inner: Arc<Mutex<Inner>>,
}

struct FakeCalls {
    inner: Arc<Mutex<Inner>>,
}

impl PluginDoor for FakeDoor {
    fn calls(&self) -> Box<dyn pacer_plugin_ops::extension::ExtensionCalls + '_> {
        Box::new(FakeCalls { inner: self.inner.clone() })
    }
}

impl pacer_plugin_ops::extension::ExtensionCalls for FakeCalls {
    fn entries<'a>(&'a mut self, _: &'a Ctx) -> EntriesFuture<'a> {
        let entries = self.inner.lock().unwrap().entries.clone();
        Box::pin(async move { Ok(entries) })
    }

    fn call<'a>(&'a mut self, _: &'a Ctx, id: &'a str, method: &'a str, params: Value) -> OpFuture<'a> {
        let reply = {
            let mut inner = self.inner.lock().unwrap();
            inner.calls.push((id.to_string(), method.to_string(), params));
            inner.replies.pop_front().unwrap_or_else(|| {
                Reply::Value(json!({"reading": {"windows": [], "capturedAt": null, "stale": false}}))
            })
        };
        Box::pin(async move {
            match reply {
                Reply::Value(value) => Ok(value),
                Reply::Delayed(value, delay) => {
                    tokio::time::sleep(delay).await;
                    Ok(value)
                }
                Reply::Hang => std::future::pending().await,
            }
        })
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

fn harness(replies: Vec<Reply>, entries: Vec<Entry>) -> (Arc<NativeUsage>, Arc<Mutex<Inner>>) {
    let inner = Arc::new(Mutex::new(Inner {
        entries,
        calls: Vec::new(),
        replies: VecDeque::from(replies),
    }));
    let door = Arc::new(FakeDoor { inner: inner.clone() });
    (NativeUsage::new(door), inner)
}

fn ctx(home: &std::path::Path, now: f64) -> Ctx {
    Ctx::with(
        home.to_path_buf(),
        home.join(".pacer"),
        HashMap::from([
            ("HOME".to_string(), home.to_string_lossy().into_owned()),
            ("PATH".to_string(), "/usr/bin:/bin".to_string()),
            ("TMPDIR".to_string(), "/tmp".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
            ("XDG_CONFIG_HOME".to_string(), home.join(".config").to_string_lossy().into_owned()),
        ]),
        now,
    )
}

fn account(kind: &str, name: &str) -> Value {
    json!({
        "name": name, "kind": kind, "source": "default", "home": null, "orcaAccount": null,
        "usage": "quota", "usageSource": "native", "quotaSource": null, "model": null,
        "weeklyUsd": null, "weeklyTokens": null, "allowPaid": false, "cooldownS": 21600,
    })
}

fn reading(at: f64, pct: f64) -> Value {
    json!({
        "windows": [{"name": "7d", "usedPct": pct, "resetsAt": null, "lengthS": 604800, "paced": false}],
        "capturedAt": at, "stale": false, "source": "session-log",
    })
}

fn reply(reading: Value) -> Reply {
    Reply::Value(json!({"reading": reading}))
}

fn tokens(value: &Value, home: &std::path::Path) -> Value {
    let text = serde_json::to_string(value).unwrap()
        .replace("{{PACER_HOME}}", &home.join(".pacer").to_string_lossy())
        .replace("{{HOME}}", &home.to_string_lossy());
    serde_json::from_str(&text).unwrap()
}

#[test]
fn usage_call_spec_matches_typescript_goldens() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/m3/status/usage-spec.json"
    ))
    .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    std::fs::create_dir_all(home.join("orca/codex-accounts/team/home")).unwrap();
    std::fs::create_dir_all(home.join("accounts/team")).unwrap();
    for case in cases {
        let i = &case["input"];
        let env: HashMap<String, String> = i["env"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), tokens(v, home).as_str().unwrap_or("").to_string()))
            .collect();
        let ctx = Ctx::with(
            home.to_path_buf(),
            home.join(".pacer"),
            env,
            i["now"].as_f64().unwrap(),
        );
        let entries: Vec<Entry> = i["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| Entry {
                id: e["id"].as_str().unwrap().to_string(),
                manifest: Some(e["manifest"].clone()),
                bundled: e["bundled"].as_bool().unwrap_or(false),
                grant: json!({}),
                state: e["state"].as_str().unwrap_or("ready").to_string(),
                error: None,
                pid: None,
                served: vec![],
                protocol: None,
                restarts: 0,
            })
            .collect();
        let out = match usage_call_spec(
            &ctx,
            &i["cfg"],
            Some(&i["account"]),
            i["refresh"].as_bool().unwrap_or(false),
            i["readOnly"].as_bool().unwrap_or(false),
            &entries,
        ) {
            UsageCall::Immediate(reading) => reading,
            UsageCall::Plugin { plugin, params, resources, account_home } => json!({
                "plugin": plugin, "params": params, "resources": resources, "accountHome": account_home,
            }),
        };
        assert_eq!(out, tokens(&case["expected"], home), "case {}", case["name"]);
    }
}

#[tokio::test]
async fn two_reads_within_the_memo_window_make_one_call() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, inner) = harness(
        vec![reply(reading(1000.0, 20.0)), reply(reading(1000.0, 20.0))],
        vec![usage_plugin()],
    );
    let a = account("claude", "claude");
    let c = ctx(dir.path(), 1000.0);
    let first = usage.read_account_usage(&c, &a, &[], &json!({}), ReadMode::default()).await.unwrap();
    let later = ctx(dir.path(), 1059.0);
    let second = usage.read_account_usage(&later, &a, &[], &json!({}), ReadMode::default()).await.unwrap();
    assert_eq!(first, second);
    assert_eq!(inner.lock().unwrap().calls.len(), 1);
}

#[tokio::test]
async fn refresh_while_a_read_is_pending_waits_then_calls_again() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, inner) = harness(
        vec![
            Reply::Delayed(json!({"reading": reading(1000.0, 20.0)}), Duration::from_millis(150)),
            reply(reading(1100.0, 30.0)),
        ],
        vec![usage_plugin()],
    );
    let a = account("claude", "claude");
    let c = ctx(dir.path(), 1000.0);
    let usage2 = usage.clone();
    let first_account = a.clone();
    let first = tokio::spawn(async move {
        usage2.read_account_usage(&c, &first_account, &[], &json!({}), ReadMode::default()).await
    });
    tokio::task::yield_now().await;
    let current = usage
        .read_account_usage(&ctx(dir.path(), 1000.0), &a, &[], &json!({}), ReadMode { refresh: true, ..ReadMode::default() })
        .await
        .unwrap();
    let first = first.await.unwrap().unwrap();
    assert_eq!(first["windows"][0]["usedPct"], 20.0);
    assert_eq!(current["windows"][0]["usedPct"], 30.0);
    assert_eq!(inner.lock().unwrap().calls.len(), 2);
}

#[tokio::test]
async fn a_failed_refresh_keeps_the_last_good_reading_stale() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, _) = harness(
        vec![
            reply(reading(1000.0, 20.0)),
            Reply::Value(json!({"thrown": "CoreError: provider offline", "errorCode": null})),
        ],
        vec![usage_plugin()],
    );
    let a = account("claude", "claude");
    usage.read_account_usage(&ctx(dir.path(), 1000.0), &a, &[], &json!({}), ReadMode::default()).await.unwrap();
    let out = usage
        .read_account_usage(&ctx(dir.path(), 1100.0), &a, &[], &json!({}), ReadMode { refresh: true, ..ReadMode::default() })
        .await
        .unwrap();
    assert_eq!(out["stale"], true);
    assert_eq!(out["error"], "CoreError: provider offline");
    assert_eq!(out["windows"][0]["usedPct"], 20.0);
}

#[tokio::test]
async fn authentication_failure_replaces_history() {
    let dir = tempfile::tempdir().unwrap();
    let fresh = json!({
        "windows": [{"name": "7d", "usedPct": 42, "resetsAt": null, "lengthS": 604800, "paced": false}],
        "capturedAt": 1100.0, "stale": false, "source": "session-log",
        "availability": {"reason": "authentication_failed"},
    });
    let (usage, _) = harness(vec![reply(reading(1000.0, 20.0)), reply(fresh.clone())], vec![usage_plugin()]);
    let a = account("claude", "claude");
    usage.read_account_usage(&ctx(dir.path(), 1000.0), &a, &[], &json!({}), ReadMode::default()).await.unwrap();
    let out = usage
        .read_account_usage(&ctx(dir.path(), 1100.0), &a, &[], &json!({}), ReadMode { refresh: true, ..ReadMode::default() })
        .await
        .unwrap();
    assert_eq!(out, fresh);
}

#[tokio::test]
async fn a_regressed_captured_at_keeps_the_previous_reading() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, _) = harness(
        vec![reply(reading(1000.0, 20.0)), reply(reading(900.0, 5.0))],
        vec![usage_plugin()],
    );
    let a = account("claude", "claude");
    let first = usage.read_account_usage(&ctx(dir.path(), 1000.0), &a, &[], &json!({}), ReadMode::default()).await.unwrap();
    let second = usage
        .read_account_usage(&ctx(dir.path(), 1100.0), &a, &[], &json!({}), ReadMode { refresh: true, ..ReadMode::default() })
        .await
        .unwrap();
    assert_eq!(second, first);
}

#[tokio::test(start_paused = true)]
async fn a_call_that_never_answers_times_out_after_ten_seconds() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, _) = harness(vec![Reply::Hang], vec![usage_plugin()]);
    let a = account("codex", "codex");
    let out = usage
        .read_account_usage(&ctx(dir.path(), 1000.0), &a, &[], &json!({}), ReadMode::default())
        .await
        .unwrap();
    assert_eq!(out["error"], "Error: usage source codex timed out");
    assert_eq!(out["stale"], false);
    assert_eq!(out["windows"], json!([]));
}

#[tokio::test]
async fn cache_only_without_a_memo_or_store_makes_no_call() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, inner) = harness(vec![], vec![usage_plugin()]);
    let a = account("claude", "claude");
    let out = usage
        .read_account_usage(&ctx(dir.path(), 1000.0), &a, &[], &json!({}), ReadMode { cache_only: true, ..ReadMode::default() })
        .await
        .unwrap();
    assert_eq!(out, json!({"windows": [], "capturedAt": null, "stale": true}));
    assert_eq!(inner.lock().unwrap().calls.len(), 0);
}

#[tokio::test]
async fn read_only_leaves_no_store_file_or_auth_mark() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, _) = harness(
        vec![Reply::Value(json!({"reading": {
            "windows": [], "capturedAt": null, "stale": false,
            "error": "not logged in", "source": "status-line",
        }}))],
        vec![usage_plugin()],
    );
    let a = account("claude", "claude");
    usage
        .read_account_usage(&ctx(dir.path(), 1000.0), &a, &[], &json!({}), ReadMode { read_only: true, ..ReadMode::default() })
        .await
        .unwrap();
    assert!(!dir.path().join(".pacer/state/usage").exists());
    assert!(!dir.path().join(".pacer/state/auth-failed.json").exists());
}

#[tokio::test]
async fn metered_readings_aggregate_per_model() {
    let dir = tempfile::tempdir().unwrap();
    let (usage, inner) = harness(
        vec![
            reply(json!({"windows": [{"name": "7d", "usedPct": 20, "resetsAt": null, "lengthS": 604800, "paced": false}],
                "capturedAt": 1000.0, "stale": false, "spendUsd": 1.0, "source": "metered"})),
            reply(json!({"windows": [{"name": "7d", "usedPct": 30, "resetsAt": null, "lengthS": 604800, "paced": false}],
                "capturedAt": 900.0, "stale": false, "spendUsd": 2.0, "source": "metered"})),
        ],
        vec![usage_plugin()],
    );
    let a = json!({
        "name": "api", "kind": "endpoint", "source": "opencode", "home": null, "orcaAccount": null,
        "usage": "metered", "usageSource": "metered", "quotaSource": null, "model": null,
        "weeklyUsd": null, "weeklyTokens": null, "allowPaid": false, "cooldownS": 0,
    });
    let runners = vec![json!({"model": "public/a"}), json!({"model": "public/b"})];
    let out = usage
        .read_account_usage(&ctx(dir.path(), 1000.0), &a, &runners, &json!({}), ReadMode::default())
        .await
        .unwrap();
    assert_eq!(inner.lock().unwrap().calls.len(), 2);
    assert_eq!(out["windows"][0]["usedPct"], 50.0);
    assert_eq!(out["spendUsd"], 3.0);
    assert_eq!(out["capturedAt"], 900.0);
}

#[tokio::test]
async fn a_newer_cached_remote_reading_comes_first_with_local_alternative() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(dir.path(), 1000.0);
    let a = account("codex", "codex");
    let remote = reading(1200.0, 70.0);
    let hosts = json!({"remote": {"alias": "remote", "ssh": null, "accounts": {"codex": {"home": null}}}});
    let mut remote_with_host = remote.clone();
    remote_with_host["remoteHost"] = Value::from("remote");
    let identity = pacer_config::evidence::evidence_identity(&a, &json!({}));
    let source_identity = pacer_js_json::stringify(&json!(["remote", null, null]));
    std::fs::create_dir_all(c.pacer_home.join("cache/remote-usage")).unwrap();
    std::fs::write(
        c.pacer_home.join("cache/remote-usage/codex.json"),
        pacer_js_json::stringify(&json!({"version": 3, "identity": identity, "sourceIdentity": source_identity, "reading": remote_with_host})),
    )
    .unwrap();
    let (usage, inner) = harness(vec![reply(reading(1000.0, 20.0))], vec![usage_plugin()]);
    let out = usage
        .read_account_usage(&c, &a, &[], &hosts, ReadMode::default())
        .await
        .unwrap();
    assert_eq!(inner.lock().unwrap().calls.len(), 1);
    assert_eq!(out["capturedAt"], 1200.0);
    // The cached reading in the fixture has no remoteHost, so it is the stale
    // copy; the local sitrep is still carried as an alternative.
    assert!(out["alternatives"].as_array().is_some_and(|a| !a.is_empty()));
}

fn strategy(dir: &std::path::Path, accounts: Value, runners: Value) {
    let mut all = json!({"claude": {"kind": "claude"}});
    if let Some(extra) = accounts.as_object() {
        for (name, value) in extra {
            all[name.as_str()] = value.clone();
        }
    }
    let mut all_runners = json!({"claude-code": {"agent": "claude-code", "account": "claude"}});
    if let Some(extra) = runners.as_object() {
        for (name, value) in extra {
            all_runners[name.as_str()] = value.clone();
        }
    }
    std::fs::create_dir_all(dir.join(".pacer")).unwrap();
    std::fs::write(
        dir.join(".pacer/strategy.yaml"),
        pacer_js_json::stringify(&json!({
            "planner": {"agent": "claude-code", "account": "claude"},
            "accounts": all,
            "runners": all_runners,
            "routing": [],
        })),
    )
    .unwrap();
}

#[tokio::test]
async fn refresh_rejects_an_unknown_account_with_a_hint() {
    let dir = tempfile::tempdir().unwrap();
    strategy(dir.path(), json!({}), json!({}));
    let (usage, inner) = harness(vec![], vec![usage_plugin()]);
    let error = usage
        .refresh_account_usage(&ctx(dir.path(), 1000.0), "x", false)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::InvalidInput);
    assert_eq!(error.message, "Unknown account x");
    assert_eq!(error.hint.as_deref(), Some("Run pacer account list to see configured accounts."));
    assert_eq!(inner.lock().unwrap().calls.len(), 0);
}

#[tokio::test]
async fn refresh_of_an_unavailable_capability_makes_no_call() {
    let dir = tempfile::tempdir().unwrap();
    strategy(dir.path(), json!({"idle": {"name": "idle", "kind": "cursor", "usage": "reactive", "source": "default"}}), json!({}));
    let (usage, inner) = harness(vec![], vec![usage_plugin()]);
    let out = usage
        .refresh_account_usage(&ctx(dir.path(), 1000.0), "idle", false)
        .await
        .unwrap();
    assert_eq!(out["outcome"], "unsupported");
    assert_eq!(out["capability"], "unavailable");
    assert_eq!(inner.lock().unwrap().calls.len(), 0);
}

#[tokio::test]
async fn automatic_refresh_twice_within_fifteen_minutes_is_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    strategy(
        dir.path(),
        json!({"claude": {"name": "claude", "kind": "claude", "source": "default", "usage": "quota", "usageSource": "native"}}),
        json!({}),
    );
    let (usage, inner) = harness(
        vec![
            reply(reading(1100.0, 30.0)), // cache-only prior (never called)
            reply(reading(1100.0, 30.0)), // first refresh
            reply(reading(1200.0, 40.0)), // second refresh, suppressed
        ],
        vec![usage_plugin()],
    );
    let first = usage.refresh_account_usage(&ctx(dir.path(), 1000.0), "claude", true).await.unwrap();
    let second = usage.refresh_account_usage(&ctx(dir.path(), 1060.0), "claude", true).await.unwrap();
    assert_eq!(first["outcome"], "updated");
    assert_eq!(second["outcome"], "unchanged");
    assert_eq!(inner.lock().unwrap().calls.len(), 1);
}

#[tokio::test]
async fn two_concurrent_refreshes_share_one_job() {
    let dir = tempfile::tempdir().unwrap();
    strategy(
        dir.path(),
        json!({"claude": {"name": "claude", "kind": "claude", "source": "default", "usage": "quota", "usageSource": "native"}}),
        json!({}),
    );
    let (usage, inner) = harness(
        vec![
            Reply::Delayed(json!({"reading": {"windows": [], "capturedAt": null, "stale": true}}), Duration::from_millis(150)),
            reply(reading(1100.0, 30.0)),
        ],
        vec![usage_plugin()],
    );
    let c = ctx(dir.path(), 1000.0);
    let one = usage.clone();
    let first = tokio::spawn(async move { one.refresh_account_usage(&c, "claude", false).await });
    tokio::task::yield_now().await;
    let second = usage.refresh_account_usage(&ctx(dir.path(), 1000.0), "claude", false).await.unwrap();
    let first = first.await.unwrap().unwrap();
    assert_eq!(first, second);
    assert_eq!(inner.lock().unwrap().calls.len(), 1);
}
