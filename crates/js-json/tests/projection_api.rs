//! `preview_omits` (additive, §4.4) for the §7 rows. A separate target: it does
//! not compile until the method exists, so the runnable rows stay runnable.
#![allow(clippy::unwrap_used)]
mod support;
use pacer_js_json::{Utf16String, WireReply};
use serde_json::json;
use support::*;

fn omits(text: &str) -> bool {
    WireReply::parse(text).unwrap().preview_omits()
}

#[test]
fn old_domain_documents_never_omit() {
    for text in [
        r#"{"title":["\ud800"]}"#,
        r#"{"x":"\ud800","n":null}"#,
        r#"{"b":1,"1":2,"0":3}"#,
        &arrays(LIMIT, "[]"),
        &objects(LIMIT, r#""\ud800""#),
        &mixed(LIMIT, "{}"),
    ] {
        assert!(!omits(text), "{text}");
    }
    for line in include_str!("fixtures/base-corpus.jsonl").lines() {
        let row: (String, String, String) = serde_json::from_str(line).unwrap();
        assert!(!omits(&row.0), "{}", row.0);
    }
}

#[test]
fn newly_accepted_rows_report_their_omissions() {
    assert!(omits(r#"{"\ud800":1,"k":2}"#));
    assert!(omits("{\"\\ud800\":1,\"\u{fffd}\":2}"));
    assert!(omits(&arrays(140, "1")));
    assert!(omits(&arrays(LIMIT + 1, "[]")));
    assert!(omits(&arrays(LIMIT + 1, "{}")));
    // Overflow and opaque null lose nothing beyond the serialized-null contract.
    assert!(!omits(r#"{"x":1e400,"y":-1e400}"#));
    assert!(!omits(&arrays(LIMIT + 1, "null")));
    assert!(!omits(&arrays(LIMIT + 1, "1e400")));
}

#[test]
fn constructed_and_composed_values_never_omit() {
    assert!(!WireReply::new(deep_value(300, json!("x"))).preview_omits());
    let mut doc = WireReply::parse(&arrays(LIMIT, "1")).unwrap();
    for _ in LIMIT..300 {
        let mut parent = WireReply::new(json!([null]));
        parent.put("/0", doc).unwrap();
        doc = parent;
    }
    assert!(!doc.preview_omits());
    let mut root =
        WireReply::parse(&format!(r#"{{"\ud800":1,"d":{}}}"#, arrays(140, "1"))).unwrap();
    assert!(root.preview_omits());
    root.put("", WireReply::new(json!({"a":1}))).unwrap();
    assert!(!root.preview_omits());
}

#[test]
fn opacity_sequences_track_the_current_projection() {
    let doc = format!(r#"{{"v":1,"d":{}}}"#, arrays(140, r#"{"s":"x"}"#));
    let boundary = format!("/d{}", zeros(LIMIT));
    let leaf = format!("/d{}", zeros(140));

    let reply = WireReply::parse(&doc).unwrap();
    assert!(reply.preview_omits());
    let sub = reply.subtree(&format!("{boundary}{}", zeros(5))).unwrap();
    assert!(sub.preview_omits());

    let mut copied = reply.clone();
    copied
        .copy(&format!("{boundary}{}", zeros(5)), "/v")
        .unwrap();
    copied.put(&boundary, WireReply::new(json!(1))).unwrap();
    // The boundary is gone, but the withheld copy at /v still omits.
    assert!(copied.preview_omits());
    copied.remove("/v").unwrap();
    assert!(!copied.preview_omits());

    let mut edited = reply.clone();
    edited
        .set_string(&format!("{leaf}/s"), Utf16String::slice("y", 0, 1))
        .unwrap();
    assert!(edited.preview_omits());
    edited.remove(&boundary).unwrap();
    assert!(!edited.preview_omits());

    let mut keys = WireReply::parse(r#"{"p":{"\ud800":1,"ok":2},"q":{"\ud801":3}}"#).unwrap();
    keys.put("/p", WireReply::new(json!({"ok":2}))).unwrap();
    assert!(keys.preview_omits());
    keys.remove("/q").unwrap();
    assert!(!keys.preview_omits());

    let mut items = WireReply::parse(&format!(
        r#"{{"a":[{},{{"\ud800":1}},3]}}"#,
        arrays(140, "1")
    ))
    .unwrap();
    items.splice("/a", 0, 1, vec![]).unwrap();
    assert!(items.preview_omits());
    items.remove("/a/0").unwrap();
    assert!(!items.preview_omits());
}
