#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use pacer_foundation::Ctx;
use serde_json::json;
use std::{cell::Cell, collections::HashMap, fs, path::Path};

fn ctx(now: f64) -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    let ctx = Ctx::with(home.clone(), home.join(".pacer"), HashMap::new(), now);
    fs::create_dir_all(ctx.pacer_home.join("state")).unwrap();
    (dir, ctx)
}

fn run(ctx: &Ctx, op: &str, params: Value) -> Result<Value, CoreError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(match op {
            "notifications.test" => notification_test(ctx, params),
            "notifications.ack" => notification_ack(ctx, params),
            "notifications.request" => notification_request(ctx, params),
            "notifications.health" => notification_health(ctx, params),
            _ => unreachable!(),
        })
}

/// Seed `state/clients.json` with one live entry, as `register` would write it.
fn seed(ctx: &Ctx, client_id: &str, fields: Value) {
    let mut entry = json!({
        "client_id": client_id,
        "kind": "desktop",
        "version": "1",
        "notifier": true,
        "registeredAt": ctx.now,
        "heartbeatAt": ctx.now,
    });
    if let Value::Object(map) = fields {
        for (key, value) in map {
            entry[key] = value;
        }
    }
    fs::write(
        ctx.pacer_home.join("state/clients.json"),
        serde_json::to_string(&json!([entry])).unwrap(),
    )
    .unwrap();
}

fn outbox(ctx: &Ctx) -> Vec<Value> {
    let path = ctx.pacer_home.join("link/outbox.jsonl");
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .map(|entry| entry["envelope"].clone())
        .filter(|value| !value.is_null())
        .collect()
}

#[test]
fn test_without_a_desktop_is_unavailable() {
    let (_dir, ctx) = ctx(10.0);
    let error = run(&ctx, "notifications.test", json!({})).unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert_eq!(error.message, "The pacer app isn't open");
    assert_eq!(error.hint.as_deref(), Some("Open the pacer app, then retry."));
}

#[test]
fn test_with_a_denied_non_presenter_names_macos() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({"notifier": false, "notification_permission": "denied"}));
    let error = run(&ctx, "notifications.test", json!({})).unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert_eq!(error.message, "macOS blocks pacer notifications");
    assert_eq!(
        error.hint.as_deref(),
        Some("Turn on Allow notifications for pacer in System Settings › Notifications.")
    );
}

#[test]
fn test_with_an_os_presenter_writes_a_pending_handle_and_publishes() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({}));
    let reply = run(&ctx, "notifications.test", json!({})).unwrap();
    let key = reply["key"].as_str().unwrap();
    assert!(key.starts_with("test:"));
    assert_eq!(reply["client_id"], json!("desktop-1"));
    assert_eq!(reply["sent_at"], json!(10));
    let health: Value = serde_json::from_slice(
        &fs::read(ctx.pacer_home.join("state/notification-health.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(health["key"], json!(key));
    assert_eq!(health["client_id"], json!("desktop-1"));
    assert_eq!(health["sent_at"], json!(10));
    let events = outbox(&ctx);
    let notify = events
        .iter()
        .find(|event| event["data"]["kind"] == "notify")
        .expect("one notify event");
    assert_eq!(notify["data"]["id"], json!(key));
    assert_eq!(notify["data"]["value"]["title"], json!("pacer test notification"));
    assert_eq!(notify["data"]["value"]["recipients"], json!(["desktop-1"]));
}

#[test]
fn ack_from_a_non_desktop_is_refused() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "app-1", json!({"kind": "app"}));
    let error = run(
        &ctx,
        "notifications.ack",
        json!({"client_id": "app-1", "key": "test:1", "delivered": true}),
    )
    .unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(error.message, "notifications.ack requires a live desktop client");
}

#[test]
fn ack_for_a_pending_key_from_another_desktop_is_a_mismatch() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({}));
    run(&ctx, "notifications.test", json!({})).unwrap();
    seed(&ctx, "desktop-2", json!({}));
    // Seed overwrote the registry; restore both desktops so both are live.
    let entries = json!([
        {"client_id":"desktop-1","kind":"desktop","version":"1","notifier":true,"registeredAt":10,"heartbeatAt":10},
        {"client_id":"desktop-2","kind":"desktop","version":"1","notifier":false,"registeredAt":10,"heartbeatAt":10}
    ]);
    fs::write(
        ctx.pacer_home.join("state/clients.json"),
        serde_json::to_string(&entries).unwrap(),
    )
    .unwrap();
    let key = read_health(&ctx)["key"].as_str().unwrap().to_owned();
    let error = run(
        &ctx,
        "notifications.ack",
        json!({"client_id": "desktop-2", "key": key, "delivered": true}),
    )
    .unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(error.message, "notifications.ack client mismatch");
}

#[test]
fn ack_cleans_control_characters_from_the_stored_error() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({}));
    run(&ctx, "notifications.test", json!({})).unwrap();
    let reply = run(
        &ctx,
        "notifications.ack",
        json!({
            "client_id": "desktop-1",
            "key": "unknown",
            "delivered": false,
            "error": "boom\u{1b}[31m x\u{0}y\u{85} tail",
        }),
    )
    .unwrap();
    assert_eq!(reply, json!({"ok": true}));
    let health = read_health(&ctx);
    assert_eq!(health["last_error"]["message"], json!("boom[31m xy tail"));
}

#[test]
fn request_with_wait_zero_publishes_control_and_returns_permission() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({"notification_permission": "not_determined"}));
    let reply = run(&ctx, "notifications.request", json!({"wait_s": 0})).unwrap();
    assert_eq!(reply["client_id"], json!("desktop-1"));
    assert_eq!(reply["permission"], json!("not_determined"));
    let control = outbox(&ctx)
        .into_iter()
        .find(|event| event["data"]["kind"] == "control")
        .expect("control event");
    assert_eq!(control["data"]["id"].as_str().unwrap().split(':').next(), Some("notifications.request"));
    assert_eq!(
        control["data"]["value"],
        json!({"action": "notifications.request", "recipients": ["desktop-1"], "client_id": "desktop-1"})
    );
}

#[test]
fn request_polls_until_the_permission_changes() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({"notification_permission": "not_determined"}));
    let mut changed = false;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let reply = runtime.block_on(async {
        let t = Cell::new(0.0);
        request_authorization_with(
            &ctx,
            Some(2),
            || t.get(),
            |_| {
                t.set(t.get() + 500.0);
                if !changed {
                    changed = true;
                    heartbeat_permission(&ctx, "desktop-1", "authorized");
                }
                async {}
            },
        )
        .await
    });
    let reply = reply.unwrap();
    assert_eq!(reply["client_id"], json!("desktop-1"));
    assert_eq!(reply["permission"], json!("authorized"));
}

#[test]
fn health_with_no_desktop_is_unverified_info() {
    let (_dir, ctx) = ctx(10.0);
    assert_eq!(
        notifications_check(&ctx),
        json!({
            "name": "Notifications",
            "level": "info",
            "detail": "The pacer app isn't open; banners come from the system fallback",
            "evidence": "unverified"
        })
    );
}

#[test]
fn health_with_denied_permission_has_a_settings_remedy() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({"notification_permission": "denied"}));
    assert_eq!(
        notifications_check(&ctx),
        json!({
            "name": "Notifications",
            "level": "warn",
            "detail": "Notifications are blocked in System Settings",
            "remedy": {
                "kind": "user",
                "label": "Open Notification settings",
                "url": "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
                "caption": "Turn on Allow notifications for pacer"
            }
        })
    );
}

#[test]
fn health_with_a_recent_ok_is_tested() {
    let (_dir, ctx) = ctx(10.0);
    seed(
        &ctx,
        "desktop-1",
        json!({"notification_permission": "authorized", "notification_alerts": "banner"}),
    );
    fs::write(
        ctx.pacer_home.join("state/notification-health.json"),
        serde_json::to_string(&json!({
            "key": "test:1", "client_id": "desktop-1", "sent_at": 5,
            "acked_at": 9, "delivered": true, "last_ok_at": 9
        }))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        notifications_check(&ctx),
        json!({
            "name": "Notifications",
            "level": "ok",
            "detail": "Banners allowed · test delivered",
            "evidence": "tested",
            "tested_at": 9
        })
    );
}

#[test]
fn health_respects_the_off_level() {
    let (_dir, ctx) = ctx(10.0);
    fs::write(
        ctx.pacer_home.join("settings.json"),
        r#"{"notifications":"off","other":1}"#,
    )
    .unwrap();
    assert_eq!(
        notifications_check(&ctx),
        json!({"name": "Notifications", "level": "info", "detail": "Notifications are off"})
    );
}

#[test]
fn published_params_are_enforced() {
    let (_dir, ctx) = ctx(10.0);
    for (op, params, message) in [
        (
            "notifications.request",
            json!({"wait_s": 26}),
            "wait_s: Too big: expected number to be <=25",
        ),
        (
            "notifications.ack",
            json!({"client_id": "c", "key": "k", "delivered": true, "error": "x".repeat(513)}),
            "error: Too big: expected string to have <=512 characters",
        ),
        (
            "notifications.test",
            json!([]),
            "params: Invalid input: expected object, received array",
        ),
    ] {
        let error = run(&ctx, op, params).unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(error.message, message);
    }
}

#[test]
fn file_modes_are_private() {
    let (_dir, ctx) = ctx(10.0);
    seed(&ctx, "desktop-1", json!({}));
    run(&ctx, "notifications.test", json!({})).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(health_path(&ctx)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let dir = fs::metadata(ctx.pacer_home.join("state")).unwrap().permissions().mode() & 0o777;
        assert_eq!(dir, 0o700);
    }
}

#[test]
fn clean_error_caps_utf16_units_like_javascript_slice() {
    let cleaned = clean_error(&"😀".repeat(300));
    assert_eq!(cleaned.chars().count(), 256);
    assert_eq!(clean_error("a\u{1b}b\u{0}c"), "abc");
}

#[test]
fn path_helpers_do_not_depend_on_the_host_home() {
    let (_dir, ctx) = ctx(10.0);
    assert!(health_path(&ctx).ends_with("notification-health.json"));
    assert!(Path::new(&settings_path(&ctx)).ends_with("settings.json"));
}
