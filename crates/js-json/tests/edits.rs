#![allow(clippy::unwrap_used)]
use pacer_js_json::{EditError, Utf16String, WireReply};
use serde_json::json;

fn wire(text: &str) -> WireReply {
    WireReply::parse(text).unwrap()
}

fn exact(value: &WireReply, expected: &str) {
    let encoded = value.to_json().unwrap();
    assert_eq!(encoded, wire(expected).to_json().unwrap());
    assert_eq!(encoded, wire(&encoded).to_json().unwrap());
}

#[test]
fn metadata_and_explicit_replacement_keep_the_intended_utf16_units() {
    let mut value = wire(r#"{"title":"\ud800","goal":"\udc01","rev":1}"#);
    value.put("/rev", WireReply::new(json!(2))).unwrap();
    exact(&value, r#"{"title":"\ud800","goal":"\udc01","rev":2}"#);
    value
        .set_string("/title", Utf16String::slice("\u{fffd}", 0, 1))
        .unwrap();
    exact(&value, r#"{"title":"�","goal":"\udc01","rev":2}"#);
    value.put("/goal", wire(r#""�""#)).unwrap();
    exact(&value, r#"{"title":"�","goal":"�","rev":2}"#);
}

#[test]
fn subtree_and_copy_rebase_exact_strings_with_escaped_keys() {
    let mut value = wire(
        r#"{"src":{"a/b~":{"items":["\ud800","\ud801"]}},"dst":{"old":"\udfff"},"sibling":"\ud802"}"#,
    );
    let subtree = value.subtree("/src/a~1b~0").unwrap();
    exact(&subtree, r#"{"items":["\ud800","\ud801"]}"#);
    value.put("/dst", subtree).unwrap();
    value.copy("/src", "/copied").unwrap();
    value.remove("/src/a~1b~0/items/0").unwrap();
    exact(
        &value,
        r#"{"src":{"a/b~":{"items":["\ud801"]}},"dst":{"items":["\ud800","\ud801"]},"sibling":"\ud802","copied":{"a/b~":{"items":["\ud800","\ud801"]}}}"#,
    );
    value.copy("/sibling", "/copy").unwrap();
    exact(&value.subtree("/copy").unwrap(), r#""\ud802""#);
}

#[test]
fn array_removal_and_splice_follow_values_with_equal_previews() {
    let mut value = wire(r#"["\ud800","\ud801"]"#);
    value.remove("/0").unwrap();
    exact(&value, r#"["\ud801"]"#);
    value.splice("", 0, 0, vec![wire(r#""\ud802""#)]).unwrap();
    exact(&value, r#"["\ud802","\ud801"]"#);
    value
        .splice("", 1, 1, vec![wire(r#"{"x":["\ud803"]}"#)])
        .unwrap();
    exact(&value, r#"["\ud802",{"x":["\ud803"]}]"#);
    value.splice("", 2, 0, vec![wire("null")]).unwrap();
    exact(&value, r#"["\ud802",{"x":["\ud803"]},null]"#);
}

#[test]
fn array_indices_one_and_ten_are_distinct_pointer_components() {
    let mut value = wire(
        r#"{"a/b":["\ud800","\ud801","\ud802","\ud803","\ud804","\ud805","\ud806","\ud807","\ud808","\ud809","\ud80a","\ud80b"],"a/bb":"\udfff"}"#,
    );
    value.remove("/a~1b/1").unwrap();
    exact(&value.subtree("/a~1b/1").unwrap(), r#""\ud802""#);
    exact(&value.subtree("/a~1b/9").unwrap(), r#""\ud80a""#);
    value
        .splice("/a~1b", 1, 2, vec![wire(r#"["\ud900"]"#)])
        .unwrap();
    exact(
        &value,
        r#"{"a/b":["\ud800",["\ud900"],"\ud804","\ud805","\ud806","\ud807","\ud808","\ud809","\ud80a","\ud80b"],"a/bb":"\udfff"}"#,
    );
}

#[test]
fn replacing_or_removing_subtrees_does_not_leave_stale_overlays() {
    let mut value = wire(r#"{"a":{"x":"\ud800"},"ab":"\ud801","items":[{"x":"\ud802"}]}"#);
    value.put("/a", wire("42")).unwrap();
    value.put("/items/0", wire(r#""plain""#)).unwrap();
    exact(&value, r#"{"a":42,"ab":"\ud801","items":["plain"]}"#);
    value.remove("/ab").unwrap();
    exact(&value, r#"{"a":42,"items":["plain"]}"#);
}

#[test]
fn root_edits_and_overlapping_copies_snapshot_the_exact_source() {
    let mut value = wire(r#"{"a":"\ud800"}"#);
    value.copy("", "/saved").unwrap();
    exact(&value, r#"{"a":"\ud800","saved":{"a":"\ud800"}}"#);
    value.copy("/saved/a", "").unwrap();
    exact(&value, r#""\ud800""#);
    assert_eq!(value.remove(""), Err(EditError::RootRemoval));
    exact(&value, r#""\ud800""#);
    value
        .set_string("", Utf16String::slice("💡", 1, 2))
        .unwrap();
    exact(&value, r#""\udca1""#);
    value.put("", wire(r#"{"new":true}"#)).unwrap();
    exact(&value, r#"{"new":true}"#);
}

#[test]
fn invalid_edits_leave_the_exact_document_unchanged() {
    let mut value = wire(r#"{"items":["\ud800","\ud801"],"number":4}"#);
    let original = value.to_json().unwrap();
    for pointer in [
        "items",
        "/~",
        "/~2",
        "/items/01",
        "/items/+1",
        "/items/-",
        "/items/9",
        "/absent/x",
        "/number/x",
    ] {
        assert!(
            value.put(pointer, wire(r#""\udfff""#)).is_err(),
            "{pointer}"
        );
        assert_eq!(value.to_json().unwrap(), original);
        assert!(value.remove(pointer).is_err(), "{pointer}");
        assert_eq!(value.to_json().unwrap(), original);
    }
    assert!(value.copy("/items", "/number/x").is_err());
    assert!(value.copy("/absent", "/new").is_err());
    assert!(
        value
            .set_string("/number", Utf16String::slice("x", 0, 1))
            .is_err()
    );
    assert!(value.splice("/items", 3, 0, vec![]).is_err());
    assert!(value.splice("/items", 1, 2, vec![]).is_err());
    assert!(value.splice("/items", usize::MAX, 1, vec![]).is_err());
    assert!(value.splice("/number", 0, 0, vec![]).is_err());
    assert_eq!(value.to_json().unwrap(), original);
}

#[test]
fn numeric_object_keys_and_escaped_tilde_are_not_array_indices() {
    let mut value = wire(r#"{"01":"\ud800","-":"\ud801","~1":"\ud802","":"\ud803"}"#);
    value.copy("/~01", "/copy").unwrap();
    exact(&value.subtree("/copy").unwrap(), r#""\ud802""#);
    value.put("/01", wire("true")).unwrap();
    value.remove("/-").unwrap();
    exact(&value.subtree("/").unwrap(), r#""\ud803""#);
    exact(
        &value,
        r#"{"01":true,"~1":"\ud802","":"\ud803","copy":"\ud802"}"#,
    );
}

#[test]
fn duplicate_winners_remain_exact_through_subsequent_edits() {
    let mut value = wire(r#"{"a":"\ud800","a":"KEEP","b":{"x":"\ud801"},"b":{"x":"\ud802"}}"#);
    value.copy("/b/x", "/a").unwrap();
    exact(&value, r#"{"a":"\ud802","b":{"x":"\ud802"}}"#);
}
