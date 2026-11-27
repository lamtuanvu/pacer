//! Port of `test/client-control.test.ts` and the broker cases of the B6-1 brief.
use super::*;

fn broker(now: f64) -> (Arc<std::sync::atomic::AtomicU64>, ClientControl) {
    let clock = Arc::new(std::sync::atomic::AtomicU64::new(now.to_bits()));
    let reader = Arc::clone(&clock);
    let control = ClientControl::new(move || {
        f64::from_bits(reader.load(std::sync::atomic::Ordering::SeqCst))
    });
    (clock, control)
}

fn advance(clock: &std::sync::atomic::AtomicU64, now: f64) {
    clock.store(now.to_bits(), std::sync::atomic::Ordering::SeqCst);
}

fn code(error: &CoreError) -> pacer_foundation::api::Code {
    error.code
}

#[test]
fn enroll_returns_a_credential_targets_never_expose() {
    let (_clock, mut control) = broker(1000.0);
    let worker = control.enroll("desktop", "main").unwrap();
    assert!(worker["client_id"].as_str().is_some_and(|id| uuid_shape(id)));
    assert!(worker["worker_token"]
        .as_str()
        .is_some_and(|token| token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit())));
    assert_eq!(
        control.targets(),
        json!([{"client_id": worker["client_id"], "kind": "desktop", "window": "main"}])
    );
    assert!(!control.targets().to_string().contains(worker["worker_token"].as_str().unwrap()));
}

fn uuid_shape(id: &str) -> bool {
    let parts: Vec<&str> = id.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && part.bytes().all(|b| b.is_ascii_hexdigit()))
        && parts[2].starts_with('4')
        && matches!(parts[3].as_bytes()[0], b'8' | b'9' | b'a' | b'b')
}

#[test]
fn the_sixty_fifth_worker_is_a_conflict() {
    let (_clock, mut control) = broker(0.0);
    for _ in 0..64 {
        control.enroll("app", "main").unwrap();
    }
    let error = control.enroll("app", "main").unwrap_err();
    assert_eq!(code(&error), Code::Conflict);
    assert_eq!(error.message, "Too many client control workers");
}

#[test]
fn tray_navigation_requires_a_main_page_target() {
    let (_clock, mut control) = broker(0.0);
    let tray = control.enroll("desktop", "tray").unwrap();
    let error = control
        .request(
            tray["client_id"].as_str().unwrap(),
            json!({"type": "navigate", "route": "/settings"}),
        )
        .unwrap_err();
    assert_eq!(code(&error), Code::NotAllowed);
    assert_eq!(error.message, "Navigation requires a main page target");
    assert_eq!(
        error.hint.as_deref(),
        Some("Select a main target to preserve unsaved-form confirmation; use pacer open to launch a screen.")
    );
}

#[test]
fn native_window_actions_require_a_desktop_client() {
    let (_clock, mut control) = broker(0.0);
    let app = control.enroll("app", "main").unwrap();
    let error = control
        .request(app["client_id"].as_str().unwrap(), json!({"type": "quit"}))
        .unwrap_err();
    assert_eq!(code(&error), Code::NotAllowed);
    assert_eq!(error.message, "A native desktop client is required");
    // The same action is allowed for a desktop worker.
    let desktop = control.enroll("desktop", "main").unwrap();
    control
        .request(desktop["client_id"].as_str().unwrap(), json!({"type": "quit"}))
        .unwrap();
}

#[test]
fn an_unknown_client_and_a_second_pending_action_are_refused() {
    let (_clock, mut control) = broker(0.0);
    let error = control
        .request(&uuid_v4(), json!({"type": "theme.get"}))
        .unwrap_err();
    assert_eq!(code(&error), Code::NotFound);
    assert_eq!(error.message, "Client is unavailable");
    assert_eq!(
        error.hint.as_deref(),
        Some("Use client.control.targets to choose a connected client.")
    );
    let app = control.enroll("app", "main").unwrap();
    let id = app["client_id"].as_str().unwrap();
    control.request(id, json!({"type": "theme.get"})).unwrap();
    let error = control
        .request(id, json!({"type": "theme.set", "value": "dark"}))
        .unwrap_err();
    assert_eq!(code(&error), Code::Conflict);
    assert_eq!(error.message, "Client has an outstanding action");
}

#[test]
fn claim_renews_the_lease_and_accepts_only_the_worker_credential() {
    let (clock, mut control) = broker(0.0);
    let app = control.enroll("app", "main").unwrap();
    let id = app["client_id"].as_str().unwrap();
    let token = app["worker_token"].as_str().unwrap();
    let request = control.request(id, json!({"type": "theme.get"})).unwrap();
    let request_id = request["request_id"].as_str().unwrap();

    let wrong = control.claim(id, "a".repeat(64).as_str()).unwrap_err();
    assert_eq!(code(&wrong), Code::NotAllowed);
    assert_eq!(wrong.message, "Client control credential rejected");
    let short = control.claim(id, &token[..63]).unwrap_err();
    assert_eq!(code(&short), Code::NotAllowed);

    let claimed = control.claim(id, token).unwrap();
    assert_eq!(claimed["status"], "claimed");
    assert_eq!(claimed["request_id"], request["request_id"]);
    assert_eq!(control.claim(id, token).unwrap(), Value::Null);

    // A claim renews the worker's 60-second lease (not the request deadline).
    advance(&clock, 59_000.0);
    control.claim(id, token).unwrap();
    advance(&clock, 60_001.0);
    assert_eq!(control.targets()[0]["client_id"], request["client_id"]);
    assert_eq!(control.result(request_id).unwrap()["status"], "failed");
    assert_eq!(control.result(request_id).unwrap()["error"], "client_timeout");
}

#[test]
fn completion_is_single_shot_and_bound_to_the_owning_worker() {
    let (_clock, mut control) = broker(0.0);
    let app = control.enroll("app", "main").unwrap();
    let desktop = control.enroll("desktop", "main").unwrap();
    let id = app["client_id"].as_str().unwrap();
    let token = app["worker_token"].as_str().unwrap();
    let request = control.request(id, json!({"type": "theme.get"})).unwrap();
    let request_id = request["request_id"].as_str().unwrap();
    control.claim(id, token).unwrap();

    let other = control
        .complete(
            request_id,
            desktop["worker_token"].as_str().unwrap(),
            Some(json!({"ok": true})),
            None,
        )
        .unwrap_err();
    assert_eq!(code(&other), Code::NotAllowed);
    assert_eq!(other.message, "Client control credential rejected");

    let done = control
        .complete(request_id, token, Some(json!({"ok": true})), None)
        .unwrap();
    assert_eq!(done["status"], "complete");
    assert_eq!(done["result"], json!({"ok": true}));
    let error = control
        .complete(request_id, token, Some(json!({})), None)
        .unwrap_err();
    assert_eq!(code(&error), Code::Conflict);
    assert_eq!(error.message, "Client request is not awaiting acknowledgment");
}

#[test]
fn a_bounded_failure_is_reported_as_failed() {
    let (_clock, mut control) = broker(0.0);
    let worker = control.enroll("desktop", "main").unwrap();
    let id = worker["client_id"].as_str().unwrap();
    let token = worker["worker_token"].as_str().unwrap();
    let request = control.request(id, json!({"type": "launch-at-login", "enabled": true})).unwrap();
    control.claim(id, token).unwrap();
    let failed = control
        .complete(
            request["request_id"].as_str().unwrap(),
            token,
            Some(json!("ignored")),
            Some("unsupported".into()),
        )
        .unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(failed["error"], "unsupported");
    assert!(failed.get("result").is_none());
}

#[test]
fn timeouts_fail_then_expire_and_unknown_ids_are_not_found() {
    let (clock, mut control) = broker(0.0);
    let worker = control.enroll("app", "main").unwrap();
    let id = worker["client_id"].as_str().unwrap();
    let request = control.request(id, json!({"type": "theme.get"})).unwrap();
    let request_id = request["request_id"].as_str().unwrap();

    advance(&clock, 30_001.0);
    let result = control.result(request_id).unwrap();
    assert_eq!(result["status"], "failed");
    assert_eq!(result["error"], "client_timeout");
    let error = control
        .complete(request_id, worker["worker_token"].as_str().unwrap(), None, None)
        .unwrap_err();
    assert_eq!(code(&error), Code::Conflict);
    assert_eq!(error.message, "Client request is not awaiting acknowledgment");

    advance(&clock, 90_001.0);
    let error = control.result(request_id).unwrap_err();
    assert_eq!(code(&error), Code::NotFound);
    assert_eq!(error.message, "Client action expired or does not exist");
}

#[test]
fn leases_expire_after_sixty_one_seconds() {
    let (clock, mut control) = broker(1000.0);
    let worker = control.enroll("desktop", "main").unwrap();
    advance(&clock, 61_001.0);
    assert_eq!(control.targets(), json!([]));
    let error = control
        .claim(
            worker["client_id"].as_str().unwrap(),
            worker["worker_token"].as_str().unwrap(),
        )
        .unwrap_err();
    assert_eq!(code(&error), Code::NotAllowed);
}

#[test]
fn a_whole_clock_writes_a_whole_deadline_as_typescript_does() {
    let (_clock, mut control) = broker(0.0);
    let worker = control.enroll("app", "main").unwrap();
    let request = control
        .request(worker["client_id"].as_str().unwrap(), json!({"type": "theme.get"}))
        .unwrap();
    assert_eq!(request["deadline"], json!(30_000));
    assert!(request["deadline"].is_i64());
}

#[test]
fn stored_actions_are_parsed_and_stripped_like_the_zod_union() {
    let (_clock, mut control) = broker(0.0);
    let app = control.enroll("app", "main").unwrap();
    let request = control
        .request(
            app["client_id"].as_str().unwrap(),
            json!({"type": "navigate", "route": "/tasks?q=é", "stripped": 1}),
        )
        .unwrap();
    assert_eq!(
        request["action"],
        json!({"type": "navigate", "route": "/tasks?q=é"})
    );
}
