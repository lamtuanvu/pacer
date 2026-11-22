//! Delivery tests for pacer-notify's `notifier.deliver`, ported from
//! `test/plugins-notifier-adapter.test.ts` and
//! `test/plugins-notifier-resources.test.ts`.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_plugin::testing::{Harness, HelloSpec};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type Spawn = Box<dyn Fn(Value) -> Result<Value, (String, String)> + Send + Sync>;

fn note() -> Value {
    json!({
        "key": "task:owned:1",
        "title": "Task done",
        "body": "fix login",
        "url": "/app/#/review/owned"
    })
}

fn ok_spawn(_: Value) -> Result<Value, (String, String)> {
    Ok(json!({ "code": 0, "stdout": "", "stderr": "", "timedOut": false }))
}

/// The config data the host returns, mirroring the TS fixture host: the host
/// chooses the platform and pins the fixed command's executable (the plugin
/// never consults `which`/`binary`).
fn config(platform: Option<&str>) -> Value {
    json!({
        "config": {
            "platform": platform,
            "which": { "osascript": "/untrusted/override" },
            "binary": "/untrusted/override"
        }
    })
}

fn lock(m: &Mutex<Vec<Value>>) -> std::sync::MutexGuard<'_, Vec<Value>> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// Start a harness with a scripted config `platform` and `spawn` answer.
/// Returns the harness plus recorders of spawn params and log calls.
async fn harness(
    platform: Option<&str>,
    spawn: Spawn,
) -> (Harness, Arc<Mutex<Vec<Value>>>, Arc<Mutex<Vec<Value>>>) {
    let mut h = Harness::start(pacer_bundled_notify::plugin(), HelloSpec::default()).await;
    let cfg = config(platform);
    h.on_capability("capability.config.get", move |_| Ok(cfg.clone()));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let logs = Arc::new(Mutex::new(Vec::new()));
    let spawn_calls = calls.clone();
    h.on_capability("capability.process.spawn", move |p| {
        spawn_calls.lock().map(|mut v| v.push(p.clone())).unwrap();
        spawn(p)
    });
    let log_calls = logs.clone();
    h.on_capability("capability.log", move |p| {
        log_calls.lock().map(|mut v| v.push(p)).unwrap();
        Ok(json!({}))
    });
    (h, calls, logs)
}

#[tokio::test]
async fn darwin_preserves_exact_fixed_script_and_literal_arguments() {
    let (mut h, spawn, _logs) = harness(Some("darwin"), Box::new(ok_spawn)).await;
    let title = "Title \"quoted\"\\\n$(touch owned)";
    let body = "Body \"\\\n`echo owned`";
    let r = h
        .call(
            "notifier.deliver",
            json!({ "key": note()["key"], "title": title, "body": body, "url": note()["url"] }),
        )
        .await
        .unwrap();
    assert_eq!(r, json!({ "delivered": true }));
    {
        let calls = lock(&spawn);
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            json!({
                "argv": [
                    "osascript", "-e", "on run argv", "-e",
                    "display notification (item 2 of argv) with title (item 1 of argv)",
                    "-e", "end run", title, body
                ],
                "timeoutMs": 5000
            })
        );
    }
    h.close().await;
}

#[tokio::test]
async fn linux_uses_bare_fixed_tool_with_separator() {
    let (mut h, spawn, _logs) = harness(Some("linux"), Box::new(ok_spawn)).await;
    let r = h
        .call(
            "notifier.deliver",
            json!({ "key": "k", "title": "-title", "body": "--body", "url": "/app/#/" }),
        )
        .await
        .unwrap();
    assert_eq!(r, json!({ "delivered": true }));
    {
        let calls = lock(&spawn);
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0],
            json!({ "argv": ["notify-send", "--", "-title", "--body"], "timeoutMs": 5000 })
        );
    }
    h.close().await;
}

#[tokio::test]
async fn spawn_failure_reports_undelivered() {
    for (code, timed_out) in [(127i64, false), (1, false), (124, true), (0, true)] {
        let spawn = Box::new(move |_| Ok(json!({ "code": code, "timedOut": timed_out })));
        let (mut h, spawns, _logs) = harness(Some("linux"), spawn).await;
        let r = h.call("notifier.deliver", note()).await.unwrap();
        assert_eq!(r, json!({ "delivered": false }));
        assert_eq!(lock(&spawns).len(), 1);
        h.close().await;
    }
}

#[tokio::test]
async fn spawn_error_logs_only_safe_fixed_warning_and_never_escapes() {
    let (mut h, _spawn, logs) = harness(
        Some("darwin"),
        Box::new(|_| Err(("plugin_timeout".into(), "private fixture detail".into()))),
    )
    .await;
    let r = h.call("notifier.deliver", note()).await.unwrap();
    assert_eq!(r, json!({ "delivered": false }));
    assert_eq!(
        lock(&logs).clone(),
        vec![json!({ "level": "warn", "message": "OS notification delivery failed" })]
    );
    h.close().await;

    // A failing log must not change the outcome: still {delivered:false}.
    let mut h2 = Harness::start(pacer_bundled_notify::plugin(), HelloSpec::default()).await;
    h2.on_capability("capability.config.get", |_| Ok(config(Some("darwin"))));
    h2.on_capability("capability.process.spawn", |_| {
        Err(("plugin_timeout".into(), "detail".into()))
    });
    h2.on_capability("capability.log", |_| {
        Err(("capability_denied".into(), "logging unavailable".into()))
    });
    let r = h2.call("notifier.deliver", note()).await.unwrap();
    assert_eq!(r, json!({ "delivered": false }));
    h2.close().await;
}

#[tokio::test]
async fn unsupported_platform_emits_no_spawn() {
    for platform in [Some("win32"), Some("other"), None] {
        let (mut h, spawns, _logs) = harness(platform, Box::new(ok_spawn)).await;
        let r = h.call("notifier.deliver", note()).await.unwrap();
        assert_eq!(r, json!({ "delivered": false }));
        assert!(lock(&spawns).is_empty());
        h.close().await;
    }
}

#[tokio::test]
async fn already_cancelled_emits_no_spawn() {
    // Cancel the owning call while the handler is parked on config, mirroring the
    // TS test where the signal is aborted before delivery starts. Because the
    // owning call is scoped, the wire drops the reply to plugin_unavailable even
    // though the handler wanted to return {delivered:false}. No spawn happens.
    let go = Arc::new(tokio::sync::Notify::new());
    let mut h = Harness::start(pacer_bundled_notify::plugin(), HelloSpec::default()).await;
    let release = go.clone();
    h.on_capability_async("capability.config.get", move |_| {
        let release = release.clone();
        async move {
            release.notified().await;
            Ok(config(Some("darwin")))
        }
    });
    h.on_capability("capability.process.spawn", |_| {
        Err(("should not spawn".into(), String::new()))
    });
    let id = h.start_call("notifier.deliver", note()).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.cancel(&id);
    go.notify_one();
    wait_for(|| !h.replies().is_empty()).await;
    let replies = h.replies();
    let reply = replies.last().unwrap();
    assert!(!reply["ok"].as_bool().unwrap());
    assert_eq!(reply["error"]["code"], "plugin_unavailable");
    assert_eq!(reply["error"]["message"], "owning plugin call ended");
    // The plugin must never reach spawn while cancelled.
    assert!(
        !h.capability_calls()
            .iter()
            .any(|(m, _)| m == "capability.process.spawn")
    );
    h.close().await;
}

#[tokio::test]
async fn cancellation_during_spawn_cannot_become_delivered() {
    // The spawn answer is in flight when the owning call is cancelled. The
    // SDK rejects an in-flight capability call once its owning call is
    // cancelled (host.rs:114), so the handler's spawn `?` surfaces the
    // error, the catch's `host.log` short-circuits on the fired token, and
    // the wire drops the reply to plugin_unavailable (scoped + cancelled).
    // Delivery never happens despite the tool returning zero.
    let mut h = Harness::start(pacer_bundled_notify::plugin(), HelloSpec::default()).await;
    h.on_capability("capability.config.get", |_| Ok(config(Some("darwin"))));
    h.on_capability_async("capability.process.spawn", |_| async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        Ok(json!({ "code": 0, "timedOut": false }))
    });
    let id = h.start_call("notifier.deliver", note()).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.cancel(&id);
    wait_for(|| !h.replies().is_empty()).await;
    let replies = h.replies();
    let reply = replies.last().unwrap();
    assert!(!reply["ok"].as_bool().unwrap());
    assert_eq!(reply["error"]["code"], "plugin_unavailable");
    assert_eq!(reply["error"]["message"], "owning plugin call ended");
    // The spawn itself was attempted exactly once.
    assert_eq!(
        h.capability_calls()
            .iter()
            .filter(|(m, _)| m == "capability.process.spawn")
            .count(),
        1
    );
    // No log: after cancellation `host.log` short-circuits before emitting a
    // capability request (host.rs), so the handler's warning is never sent.
    assert!(
        !h.capability_calls()
            .iter()
            .any(|(m, _)| m == "capability.log")
    );
    h.close().await;
}

#[tokio::test]
async fn valid_bounds_include_opaque_key_and_exact_title_body_maxima() {
    let (mut h, spawn, _logs) = harness(Some("linux"), Box::new(ok_spawn)).await;
    let r = h
        .call(
            "notifier.deliver",
            json!({
                "key": "", "url": "",
                "title": "x".repeat(256),
                "body": "x".repeat(2048)
            }),
        )
        .await
        .unwrap();
    assert_eq!(r, json!({ "delivered": true }));
    assert_eq!(lock(&spawn).len(), 1);
    h.close().await;
}

#[tokio::test]
async fn invalid_notifier_fields_are_refused_before_config_or_spawning() {
    let invalid = [
        Value::Null,
        json!({}),
        json!({ "key": 1, "title": "t", "body": "b", "url": "/" }),
        json!({ "key": "k", "title": "t", "body": "b", "url": 1 }),
        json!({ "key": "k", "title": "x".repeat(257), "body": "b", "url": "/" }),
        json!({ "key": "k", "title": "t", "body": "x".repeat(2049), "url": "/" }),
    ];
    for input in invalid {
        let mut h = Harness::start(pacer_bundled_notify::plugin(), HelloSpec::default()).await;
        // Refusal must precede any config read or spawn.
        h.on_capability("capability.config.get", |_| {
            panic!("config must not be read")
        });
        h.on_capability("capability.process.spawn", |_| panic!("must not spawn"));
        let err = h.call("notifier.deliver", input).await.unwrap_err();
        assert_eq!(err.code, "invalid_input");
        assert_eq!(err.message, "invalid notifier input");
        assert!(h.capability_calls().is_empty());
        h.close().await;
    }
}

/// Wait until `pred` holds or ~2 s elapse; panics otherwise.
async fn wait_for(pred: impl Fn() -> bool) {
    for _ in 0..400 {
        if pred() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("condition not met within timeout");
}

// TS: test/plugins-notifier-adapter.test.ts:20 "manifest names precise
// notifier contribution and only required tool scopes"
#[test]
fn manifest_names_precise_notifier_contribution_and_only_required_tool_scopes() {
    let m: Value = serde_json::from_str(pacer_bundled_notify::MANIFEST).unwrap();
    assert_eq!(m["host"], "^1.6");
    assert_eq!(m["contributes"]["notifier"]["kinds"], json!(["os"]));
    assert_eq!(
        m["capabilities"],
        json!([
            { "name": "process.spawn", "scopes": ["osascript", "notify-send"] },
            { "name": "config.get" },
            { "name": "log" }
        ])
    );
}

// TS: test/plugins-notifier-adapter.test.ts:75 "throwing timeout remains safe"
#[tokio::test]
async fn throwing_timeout_remains_safe() {
    let (mut h, _spawn, logs) = harness(
        Some("linux"),
        Box::new(|_| {
            Err((
                "plugin_timeout".into(),
                "private fixture timeout detail".into(),
            ))
        }),
    )
    .await;
    let r = h.call("notifier.deliver", note()).await.unwrap();
    assert_eq!(r, json!({ "delivered": false }));
    assert_eq!(
        lock(&logs).clone(),
        vec![json!({ "level": "warn", "message": "OS notification delivery failed" })]
    );
    h.close().await;
}

// TS: test/plugins-notifier-adapter.test.ts:79 "config cancellation emits no spawn"
#[tokio::test]
async fn config_cancellation_emits_no_spawn() {
    // Park the config answer until the owning call is cancelled, then release
    // it: the handler sees the flag and returns {delivered:false}, the reply
    // becomes plugin_unavailable at the wire (scoped + cancelled), and no
    // spawn occurred.
    let go = Arc::new(tokio::sync::Notify::new());
    let mut h = Harness::start(pacer_bundled_notify::plugin(), HelloSpec::default()).await;
    let release = go.clone();
    h.on_capability_async("capability.config.get", move |_| {
        let release = release.clone();
        async move {
            release.notified().await;
            Ok(config(Some("darwin")))
        }
    });
    h.on_capability("capability.process.spawn", |_| {
        Ok(json!({ "code": 0, "timedOut": false }))
    });
    let id = h.start_call("notifier.deliver", note()).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    h.cancel(&id);
    go.notify_one();
    wait_for(|| !h.replies().is_empty()).await;
    let replies = h.replies();
    let reply = replies.last().unwrap();
    assert!(!reply["ok"].as_bool().unwrap());
    assert_eq!(reply["error"]["code"], "plugin_unavailable");
    assert_eq!(reply["error"]["message"], "owning plugin call ended");
    // Only config.get was answered; no spawn happened.
    assert!(
        !h.capability_calls()
            .iter()
            .any(|(m, _)| m == "capability.process.spawn")
    );
    h.close().await;
}

// TS: test/plugins-notifier-adapter.test.ts:84 "plugin never resolves tools
// through ambient Bun.which" — the bare argv names are asserted directly and the
// deliver.rs source is checked to contain no `std::env` (no `which`/`PATH`).
#[test]
fn plugin_never_resolves_tools_through_path() {
    assert_eq!(
        pacer_bundled_notify::argv("linux", "a", "b").unwrap()[0],
        "notify-send"
    );
    assert_eq!(
        pacer_bundled_notify::argv("darwin", "a", "b").unwrap()[0],
        "osascript"
    );
    let source = include_str!("../src/deliver.rs");
    assert!(
        !source.contains("std::env"),
        "deliver.rs must not consult PATH (std::env)"
    );
}

// TS: test/plugins-notifier-resources.test.ts:5 "host authorizes precisely the
// plugin notification vector with literal user arguments"
#[tokio::test]
async fn host_resource_vector_is_literal_for_every_platform() {
    let title = "--title \" & $(nope)";
    let body = "line one\nline two \"";
    for (platform, delivered, expected) in [
        (
            Some("darwin"),
            true,
            json!({
                "argv": [
                    "osascript", "-e", "on run argv", "-e",
                    "display notification (item 2 of argv) with title (item 1 of argv)",
                    "-e", "end run", title, body
                ],
                "timeoutMs": 5000
            }),
        ),
        (
            Some("linux"),
            true,
            json!({ "argv": ["notify-send", "--", title, body], "timeoutMs": 5000 }),
        ),
        (Some("win32"), false, Value::Null),
    ] {
        let (mut h, spawns, _logs) = harness(platform, Box::new(ok_spawn)).await;
        let r = h
            .call(
                "notifier.deliver",
                json!({ "key": "k", "title": title, "body": body, "url": "/app/#/" }),
            )
            .await
            .unwrap();
        assert_eq!(r, json!({ "delivered": delivered }));
        {
            let calls = lock(&spawns);
            if delivered {
                assert_eq!(calls.len(), 1);
                assert_eq!(calls[0], expected);
            } else {
                assert!(calls.is_empty());
            }
        }
        h.close().await;
    }
}
