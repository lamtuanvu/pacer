//! Frame validation tests, transcribed from the desktop's `requestSchema`
//! and `helloSchema` (`src/update/desktop/native-provider.ts`).
#![allow(clippy::unwrap_used)]
use super::super::frames::{
    FrameKind, Request, RequestError, client_instance, is_hex_64, is_identifier, parse_hello,
};
use serde_json::json;

#[test]
fn request_schema_discriminates() {
    // A valid op request parses with its fields preserved.
    let value = json!({
        "schema": 1, "kind": "op", "sessionId": "ses-1",
        "sequence": 3, "op": "device.registry", "params": {"a": 1},
    });
    let request = Request::parse(&value).unwrap();
    assert_eq!(request.kind, FrameKind::Op);
    assert_eq!(request.session_id, "ses-1");
    assert_eq!(request.sequence, 3);
    assert_eq!(request.op, Some("device.registry".to_owned()));
    assert_eq!(request.params, Some(json!({"a": 1})));

    // Schema must be exactly 1.
    let mut bad = value.clone();
    bad["schema"] = json!(2);
    assert!(Request::parse(&bad).is_err());

    // Sequence must be present and positive.
    let mut zero = value.clone();
    zero["sequence"] = json!(0);
    assert!(Request::parse(&zero).is_err());

    // sessionId must be a bounded identifier.
    let mut bad_id = value.clone();
    bad_id["sessionId"] = json!("a/b c");
    assert!(Request::parse(&bad_id).is_err());

    // Unknown kinds still parse (decision is left to dispatch).
    let unknown = json!({"schema": 1, "kind": "mystery", "sessionId": "s", "sequence": 1});
    let request = Request::parse(&unknown).unwrap();
    assert_eq!(request.kind, FrameKind::Unknown);
}

#[test]
fn frame_kind_parse_is_exact() {
    assert_eq!(FrameKind::parse("heartbeat"), FrameKind::Heartbeat);
    assert_eq!(FrameKind::parse("snapshot"), FrameKind::Snapshot);
    assert_eq!(
        FrameKind::parse("subscribe-events"),
        FrameKind::SubscribeEvents
    );
    assert_eq!(FrameKind::parse("desktop-ready"), FrameKind::DesktopReady);
    assert_eq!(
        FrameKind::parse("query-readiness"),
        FrameKind::QueryReadiness
    );
    assert_eq!(FrameKind::parse("observe-launch"), FrameKind::ObserveLaunch);
    assert_eq!(FrameKind::parse("effect-ack"), FrameKind::EffectAck);
    assert_eq!(FrameKind::parse("helper-context"), FrameKind::Helper);
    assert_eq!(FrameKind::parse("adoption-context"), FrameKind::Adoption);
    assert_eq!(FrameKind::parse("bogus"), FrameKind::Unknown);
}

#[test]
fn hello_schema_accepts_desktop_and_helper() {
    let good_desktop = json!({
        "schema": 1, "kind": "hello", "role": "desktop", "version": "1.2.3",
        "nonce": "a".repeat(64), "challenge": "b".repeat(64), "clientId": "cli",
    });
    let hello = parse_hello(&good_desktop).unwrap();
    assert_eq!(hello.role, "desktop");
    assert_eq!(hello.version, "1.2.3");
    assert_eq!(hello.client_id, "cli");

    let good_helper = json!({
        "schema": 1, "kind": "hello", "role": "helper", "version": "2.0",
        "nonce": "a".repeat(64), "challenge": "b".repeat(64),
    });
    assert_eq!(parse_hello(&good_helper).unwrap().role, "helper");

    // Unknown role is rejected.
    let bad_role = json!({
        "schema": 1, "kind": "hello", "role": "cli", "version": "1",
        "nonce": "a".repeat(64), "challenge": "b".repeat(64),
    });
    assert!(parse_hello(&bad_role).is_err());

    // nonce and challenge must be 64 hex chars.
    let bad_nonce = json!({
        "schema": 1, "kind": "hello", "role": "desktop", "version": "1",
        "nonce": "not-hex", "challenge": "b".repeat(64),
    });
    assert!(parse_hello(&bad_nonce).is_err());
}

#[test]
fn session_id_and_hex_helpers() {
    assert!(is_identifier("ses-1_ok"));
    assert!(!is_identifier(""));
    assert!(!is_identifier("has space"));
    assert!(!is_identifier(&"x".repeat(129)));

    assert!(is_hex_64(&"a".repeat(64)));
    assert!(!is_hex_64(&"a".repeat(63)));
    assert!(!is_hex_64("zz"));

    // client_instance echoes the session id for the synthesized post.
    assert_eq!(client_instance("ses-1"), "ses-1");
}

#[test]
fn request_error_is_marker() {
    let _: RequestError = RequestError;
}
