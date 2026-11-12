#![allow(clippy::unwrap_used)]
use super::*;
use serde_json::json;
use std::sync::Mutex;

struct Fake {
    reply: Mutex<Option<Result<Vec<u8>, Failure>>>,
    sent: Mutex<Vec<String>>,
}

impl Fake {
    fn new(reply: Result<&[u8], Failure>) -> Self {
        Self {
            reply: Mutex::new(Some(reply.map(<[u8]>::to_vec))),
            sent: Mutex::new(vec![]),
        }
    }
}

impl CoreIpc for Fake {
    fn exchange(&self, body: String) -> Exchange<'_> {
        self.sent.lock().unwrap().push(body);
        let reply = self.reply.lock().unwrap().take().unwrap();
        Box::pin(async move { reply })
    }
}

fn deep(levels: usize) -> Vec<u8> {
    let mut text = String::from("{\"value\":");
    text.push_str(&"[".repeat(levels));
    text.push_str(&"]".repeat(levels));
    text.push_str(",\"entries\":[]}");
    text.into_bytes()
}

#[tokio::test]
async fn value_and_entries_round_trip_through_ipc_json() {
    let fake = Fake::new(Ok(br#"{"value":{"a":"\ud800"},"entries":[{"id":"fx"}]}"#));
    let mut entries = vec![];
    let body = json!({"kind":"prepare", "op":"plugin.list", "params":{"x":"\u{fdd0}+Infinity"}});
    let value = request(&fake, &body, &mut entries).await.unwrap();
    assert_eq!(entries, vec![json!({"id":"fx"})]);
    // The lone surrogate stays in the quoted form, not U+FFFD.
    assert_eq!(crate::json::stringify(&value), r#"{"a":"\ud800"}"#);
    // Private IPC keeps Infinity recoverable by JSON.parse.
    assert_eq!(
        fake.sent.lock().unwrap()[0],
        r#"{"kind":"prepare","op":"plugin.list","params":{"x":1e400}}"#
    );
}

#[tokio::test]
async fn error_envelopes_keep_the_snapshot_and_decode_the_error() {
    let fake = Fake::new(Ok(
        br#"{"error":{"code":"conflict","message":"busy","hint":"Retry shortly."},"entries":[{"id":"fx"}]}"#,
    ));
    let mut entries = vec![];
    let error = request(&fake, &json!({"kind":"stop", "id":"fx"}), &mut entries)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::Conflict);
    assert_eq!(error.hint.as_deref(), Some("Retry shortly."));
    assert_eq!(entries.len(), 1);
}

#[tokio::test]
async fn carrier_failures_map_like_the_http_door() {
    for (failure, kind, code, message) in [
        (
            Failure::Unavailable,
            "stop",
            Code::Unavailable,
            "plugin process owner is unavailable",
        ),
        (
            Failure::Refused,
            "stop",
            Code::Unavailable,
            "plugin process owner refused private request",
        ),
        (
            Failure::Body("length limit exceeded".into()),
            "prepare",
            Code::Unavailable,
            crate::json::NESTING_FALLBACK,
        ),
        (
            Failure::Body("length limit exceeded".into()),
            "stop",
            Code::Internal,
            "length limit exceeded",
        ),
    ] {
        let fake = Fake::new(Err(failure));
        let error = request(&fake, &json!({"kind":kind}), &mut vec![])
            .await
            .unwrap_err();
        assert_eq!((error.code, error.message.as_str()), (code, message));
    }
}

#[tokio::test]
async fn nesting_selects_fallback_for_prepare_and_refuses_deep_renders() {
    let body = deep(600);
    let prepare = request(
        &Fake::new(Ok(&body)),
        &json!({"kind":"prepare"}),
        &mut vec![],
    )
    .await
    .unwrap_err();
    assert_eq!(prepare.message, crate::json::NESTING_FALLBACK);
    for kind in ["call", "relay"] {
        let render = request(
            &Fake::new(Ok(&body)),
            &json!({"kind":kind, "method":"ui.render"}),
            &mut vec![],
        )
        .await
        .unwrap_err();
        assert_eq!(render.code, Code::InvalidInput);
        assert_eq!(render.message, "This plugin's view couldn't be shown");
    }
    let shallow = request(
        &Fake::new(Ok(&deep(500))),
        &json!({"kind":"prepare"}),
        &mut vec![],
    )
    .await;
    assert!(shallow.is_ok());
}

#[tokio::test]
async fn a_silent_carrier_times_out() {
    struct Silent;
    impl CoreIpc for Silent {
        fn exchange(&self, _: String) -> Exchange<'_> {
            Box::pin(std::future::pending())
        }
    }
    let error = request_within(
        &Silent,
        &json!({"kind":"stop"}),
        &mut vec![],
        Duration::from_millis(10),
    )
    .await
    .unwrap_err();
    assert_eq!(error.code, Code::PluginTimeout);
}
