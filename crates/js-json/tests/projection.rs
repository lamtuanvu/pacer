//! §7 construct/compose (C), opacity (O) and error (E) rows through the current
//! public API: exact bytes, preview and the `into_value` outcome. The
//! `preview_omits` assertions for the same sequences live in `projection_api.rs`.
#![allow(clippy::unwrap_used)]
mod support;
use pacer_js_json::{EditError, Utf16String, WireReply};
use serde_json::{Value, json};
use support::*;

fn wire(text: &str) -> WireReply {
    WireReply::parse(text).unwrap_or_else(|e| panic!("parse rejected {} bytes: {e}", text.len()))
}

/// `{"v":1,"d":<140 arrays around leaf>}`: `/d` is at depth 1, so the array at
/// depth LIMIT+1 (`BOUNDARY`) is the root of the withheld subtree.
fn boundary_doc(leaf: &str) -> String {
    format!(r#"{{"v":1,"d":{}}}"#, arrays(140, leaf))
}
fn boundary() -> String {
    format!("/d{}", zeros(LIMIT))
}
/// The leaf of `boundary_doc`, at depth 141.
fn leaf() -> String {
    format!("/d{}", zeros(140))
}
fn boundary_preview() -> Value {
    json!({"v":1,"d":deep_value(LIMIT, Value::Null)})
}

#[test]
fn c1_parsed_limit_document_composed_to_depth_300_stays_visible() {
    for leaf in ["1", r#""s""#] {
        let mut doc = wire(&arrays(LIMIT, leaf));
        for _ in LIMIT..300 {
            let mut parent = WireReply::new(json!([null]));
            parent.put("/0", doc).unwrap();
            doc = parent;
        }
        let expected = deep_value(300, serde_json::from_str(leaf).unwrap());
        assert_eq!(doc.to_json().unwrap(), arrays(300, leaf));
        assert_eq!(doc.preview(), &expected);
        let value = doc.into_value().unwrap();
        assert_eq!(serde_json::to_string(&value).unwrap(), arrays(300, leaf));
        assert_eq!(value, expected);
    }
}

#[test]
fn c2_constructed_depth_300_value_is_its_own_preview_and_converts() {
    let value = deep_value(300, json!("x"));
    let reply = WireReply::new(value.clone());
    assert_eq!(reply.preview(), &value);
    assert_eq!(
        reply.to_json().unwrap(),
        serde_json::to_string(&value).unwrap()
    );
    assert_eq!(reply.clone().into_value().unwrap(), value);
}

fn c2_deep_body() {
    let reply = WireReply::new(deep_value(20_000, json!(1)));
    let copy = reply.clone();
    drop(copy);
    assert_eq!(reply.to_json().unwrap(), arrays(20_000, "1"));
    let value = reply.into_value().unwrap();
    let mut depth = 0;
    let mut cursor = &value;
    while let Value::Array(items) = cursor {
        cursor = &items[0];
        depth += 1;
    }
    assert_eq!((depth, cursor), (20_000, &json!(1)));
    dispose(value);
}

/// C2 at depth 20,000: construction, clone, drop and rendering on a 2 MiB stack.
#[test]
fn c2_constructed_depth_20000_value_clones_renders_and_drops_without_recursion() {
    isolated(
        "c2_constructed_depth_20000_value_clones_renders_and_drops_without_recursion",
        c2_deep_body,
    );
}

#[test]
fn c3_constructed_subtree_copy_and_splice_beyond_128_keep_base_results() {
    let reply = WireReply::new(deep_value(300, json!("x")));
    let sub = reply.subtree(&zeros(200)).unwrap();
    assert_eq!(sub.to_json().unwrap(), arrays(100, r#""x""#));
    assert_eq!(sub.preview(), &deep_value(100, json!("x")));
    assert!(sub.into_value().is_ok());

    let mut copied = reply.clone();
    copied.copy(&zeros(250), &zeros(10)).unwrap();
    assert_eq!(copied.to_json().unwrap(), arrays(60, r#""x""#));
    assert_eq!(copied.preview(), &deep_value(60, json!("x")));

    let mut spliced = reply;
    spliced
        .splice(&zeros(200), 1, 0, vec![WireReply::new(json!(2))])
        .unwrap();
    let expected = format!(
        "{}{},2{}",
        "[".repeat(201),
        arrays(99, r#""x""#),
        "]".repeat(201)
    );
    assert_eq!(spliced.to_json().unwrap(), expected);
    let preview = spliced.preview().clone();
    let value = spliced.into_value().unwrap();
    assert_eq!(value, preview);
    assert_eq!(serde_json::to_string(&value).unwrap(), expected);
}

#[test]
fn c4_constructed_number_identity_is_unchanged() {
    let reply = WireReply::new(json!({
        "u": u64::MAX, "i": i64::MIN, "f": 1.5, "one": 1.0, "nz": -0.0, "zero": 0
    }));
    let preview = reply.preview();
    assert!(preview["u"].is_u64());
    assert!(preview["i"].is_i64());
    assert!(preview["one"].is_f64());
    assert!(preview["nz"].as_f64().unwrap().is_sign_negative());
    assert!(preview["zero"].is_u64());
    assert_eq!(
        reply.to_json().unwrap(),
        r#"{"u":18446744073709551615,"i":-9223372036854775808,"f":1.5,"one":1.0,"nz":-0.0,"zero":0}"#
    );
}

#[test]
fn c5_root_put_replaces_hidden_content_and_its_projection() {
    let mut reply = wire(&format!(r#"{{"\ud800":1,"d":{}}}"#, arrays(140, "1")));
    reply.put("", WireReply::new(json!({"a":1}))).unwrap();
    assert_eq!(reply.to_json().unwrap(), r#"{"a":1}"#);
    assert_eq!(reply.preview(), &json!({"a":1}));
    assert_eq!(reply.into_value().unwrap(), json!({"a":1}));
}

#[test]
fn o1_parsed_hidden_parent_subtree_is_null_at_its_boundary() {
    let text = boundary_doc(r#"{"s":"x"}"#);
    let reply = wire(&text);
    assert_eq!(reply.to_json().unwrap(), text);
    assert_eq!(reply.preview(), &boundary_preview());
    assert!(reply.into_value().is_err());
}

#[test]
fn o2_subtree_below_the_boundary_inherits_effective_suppression() {
    let reply = wire(&boundary_doc(r#"{"s":"x"}"#));
    let sub = reply
        .subtree(&format!("{}{}", boundary(), zeros(5)))
        .unwrap();
    assert_eq!(sub.to_json().unwrap(), arrays(7, r#"{"s":"x"}"#));
    assert_eq!(sub.preview(), &Value::Null);
    assert!(sub.into_value().is_err());
}

#[test]
fn o3_copy_from_a_hidden_descendant_to_a_visible_member_stays_withheld() {
    let mut reply = wire(&boundary_doc(r#"{"s":"x"}"#));
    reply
        .copy(&format!("{}{}", boundary(), zeros(5)), "/v")
        .unwrap();
    assert_eq!(
        reply.subtree("/v").unwrap().to_json().unwrap(),
        arrays(7, r#"{"s":"x"}"#)
    );
    assert_eq!(reply.preview()["v"], Value::Null);
    assert_eq!(reply.preview()["d"], boundary_preview()["d"]);
    assert!(reply.into_value().is_err());
}

#[test]
fn o4_visible_edits_beneath_a_hidden_ancestor_change_bytes_not_projection() {
    let mut reply = wire(&boundary_doc(r#"{"s":"x","n":1}"#));
    reply
        .set_string(&format!("{}/s", leaf()), Utf16String::slice("y", 0, 1))
        .unwrap();
    reply
        .put(&format!("{}/n", leaf()), WireReply::new(json!(2)))
        .unwrap();
    assert_eq!(reply.to_json().unwrap(), boundary_doc(r#"{"s":"y","n":2}"#));
    assert_eq!(reply.preview(), &boundary_preview());
    assert!(reply.into_value().is_err());
}

#[test]
fn o5_replacing_or_removing_the_final_boundary_restores_conversion() {
    let mut replaced = wire(&boundary_doc("1"));
    replaced.put(&boundary(), WireReply::new(json!(1))).unwrap();
    let expected = json!({"v":1,"d":deep_value(LIMIT, json!(1))});
    assert_eq!(
        replaced.to_json().unwrap(),
        format!(r#"{{"v":1,"d":{}}}"#, arrays(LIMIT, "1"))
    );
    assert_eq!(replaced.preview(), &expected);
    assert_eq!(replaced.into_value().unwrap(), expected);

    let mut removed = wire(&boundary_doc("1"));
    removed.remove(&boundary()).unwrap();
    let expected = json!({"v":1,"d":deep_value(LIMIT - 1, json!([]))});
    assert_eq!(removed.preview(), &expected);
    assert_eq!(removed.into_value().unwrap(), expected);
}

#[test]
fn o6_overlapping_copies_snapshot_content_and_metadata_follows_it() {
    let leaf = r#"{"s":"x"}"#;
    // The source contains the destination.
    let mut outer = wire(&boundary_doc(leaf));
    outer.copy("/d", &format!("{}/0", boundary())).unwrap();
    assert_eq!(
        outer.to_json().unwrap(),
        format!(r#"{{"v":1,"d":{}}}"#, arrays(129 + 140, leaf))
    );
    assert_eq!(outer.preview(), &boundary_preview());
    assert!(outer.into_value().is_err());
    // The destination contains the source.
    let mut inner = wire(&boundary_doc(leaf));
    inner
        .copy(&format!("{}{}", boundary(), zeros(3)), "/d")
        .unwrap();
    assert_eq!(
        inner.to_json().unwrap(),
        format!(r#"{{"v":1,"d":{}}}"#, arrays(9, leaf))
    );
    assert_eq!(inner.preview(), &json!({"v":1,"d":null}));
    assert!(inner.into_value().is_err());
}

#[test]
fn o7_splice_moves_opaque_elements_and_hidden_key_objects_with_their_content() {
    let deep = arrays(140, "1");
    let text = format!(r#"{{"a":[{deep},{{"\ud800":1,"k":2}},3]}}"#);
    let mut shifted = wire(&text);
    shifted
        .splice("/a", 0, 0, vec![WireReply::new(json!("n"))])
        .unwrap();
    assert_eq!(
        shifted.to_json().unwrap(),
        format!(r#"{{"a":["n",{deep},{{"\ud800":1,"k":2}},3]}}"#)
    );
    assert_eq!(
        shifted.preview(),
        &json!({"a":["n", deep_value(LIMIT - 1, Value::Null), {"k":2}, 3]})
    );
    assert!(shifted.into_value().is_err());

    let mut reply = wire(&text);
    assert_eq!(
        reply.preview(),
        &json!({"a":[deep_value(LIMIT - 1, Value::Null), {"k":2}, 3]})
    );
    reply.splice("/a", 0, 1, vec![]).unwrap();
    assert_eq!(reply.to_json().unwrap(), r#"{"a":[{"\ud800":1,"k":2},3]}"#);
    assert_eq!(reply.preview(), &json!({"a":[{"k":2},3]}));
    assert!(reply.clone().into_value().is_err());
    reply
        .splice("/a", 0, 0, vec![WireReply::new(json!(0))])
        .unwrap();
    assert_eq!(reply.preview(), &json!({"a":[0,{"k":2},3]}));
    reply.remove("/a/1").unwrap();
    assert_eq!(reply.to_json().unwrap(), r#"{"a":[0,3]}"#);
    assert_eq!(reply.into_value().unwrap(), json!({"a":[0,3]}));
}

#[test]
fn o8_equal_content_with_different_projection_histories() {
    let parsed = wire(&format!(r#"{{"d":{}}}"#, arrays(140, "1")));
    let mut composed = wire(&arrays(LIMIT, "1"));
    for _ in LIMIT..140 {
        let mut parent = WireReply::new(json!([null]));
        parent.put("/0", composed).unwrap();
        composed = parent;
    }
    let mut root = WireReply::new(json!({}));
    root.put("/d", composed).unwrap();
    assert_eq!(parsed.to_json().unwrap(), root.to_json().unwrap());
    assert_eq!(parsed.preview()["d"], deep_value(LIMIT, Value::Null));
    assert_eq!(root.preview()["d"], deep_value(140, json!(1)));
    assert!(parsed.into_value().is_err());
    assert!(root.into_value().is_ok());
}

#[test]
fn o9_opaque_null_or_overflow_boundary_loses_nothing() {
    for (leaf, bytes) in [("null", "null"), ("1e400", "null"), ("-1e400", "null")] {
        let reply = wire(&arrays(LIMIT + 1, leaf));
        assert_eq!(reply.to_json().unwrap(), arrays(LIMIT + 1, bytes));
        assert_eq!(reply.preview(), &deep_value(LIMIT + 1, Value::Null));
        assert_eq!(
            reply.into_value().unwrap(),
            deep_value(LIMIT + 1, Value::Null)
        );
    }
}

#[test]
fn o10_opaque_empty_containers_are_withheld() {
    for leaf in ["[]", "{}"] {
        let reply = wire(&arrays(LIMIT + 1, leaf));
        assert_eq!(reply.to_json().unwrap(), arrays(LIMIT + 1, leaf));
        assert_eq!(reply.preview(), &deep_value(LIMIT + 1, Value::Null));
        assert!(reply.into_value().is_err());
    }
}

#[test]
fn o11_hidden_key_omission_clears_only_after_the_last_hidden_member_goes() {
    let mut reply = wire(r#"{"p":{"\ud800":1,"ok":2},"q":{"\ud801":3}}"#);
    assert_eq!(reply.preview(), &json!({"p":{"ok":2},"q":{}}));
    assert!(reply.clone().into_value().is_err());
    reply.put("/p", WireReply::new(json!({"ok":2}))).unwrap();
    assert_eq!(
        reply.to_json().unwrap(),
        r#"{"p":{"ok":2},"q":{"\ud801":3}}"#
    );
    assert!(reply.clone().into_value().is_err());
    reply.remove("/q").unwrap();
    assert_eq!(reply.into_value().unwrap(), json!({"p":{"ok":2}}));
}

#[test]
fn o12_lookups_below_an_opaque_boundary_use_the_exact_document() {
    let mut reply = wire(&boundary_doc(r#"{"s":"\ud800","n":null}"#));
    let s = format!("{}/s", leaf());
    assert_eq!(reply.string_at(&s).unwrap().units(), &[0xd800]);
    assert_eq!(
        reply.string_at(&format!("{}/n", leaf())).err(),
        Some(EditError::WrongType)
    );
    assert_eq!(
        reply.string_at(&format!("{}/missing", leaf())).err(),
        Some(EditError::NotFound)
    );
    assert_eq!(
        reply.string_at(&format!("{}/1", boundary())).err(),
        Some(EditError::OutOfBounds)
    );
    assert_eq!(
        reply.string_at(&format!("{}/01", boundary())).err(),
        Some(EditError::InvalidPointer)
    );
    reply.replace(&s, Utf16String::slice("z", 0, 1));
    assert_eq!(
        reply.to_json().unwrap(),
        boundary_doc(r#"{"s":"z","n":null}"#)
    );
    // replace keeps its silent no-op for a non-string target.
    reply.replace(&format!("{}/n", leaf()), Utf16String::slice("q", 0, 1));
    assert_eq!(
        reply.to_json().unwrap(),
        boundary_doc(r#"{"s":"z","n":null}"#)
    );
    reply
        .set_string(&s, Utf16String::from_units(vec![0xdc00]))
        .unwrap();
    assert_eq!(
        reply.to_json().unwrap(),
        boundary_doc(r#"{"s":"\udc00","n":null}"#)
    );
}

#[test]
fn replace_keeps_its_serde_pointer_grammar_and_root_target() {
    let mut root = wire(r#""old""#);
    root.replace("", Utf16String::from_units(vec![0xd800]));
    assert_eq!(root.to_json().unwrap(), r#""\ud800""#);
    let text = r#"{"a/b":"x","~":"y","l":["p","q"]}"#;
    let mut reply = wire(text);
    for pointer in ["a~1b", "/l/01", "/l/+1", "/l/2", "/missing", "/~2"] {
        reply.replace(pointer, Utf16String::slice("Z", 0, 1));
        assert_eq!(reply.to_json().unwrap(), text, "{pointer}");
    }
    reply.replace("/a~1b", Utf16String::slice("1", 0, 1));
    reply.replace("/~0", Utf16String::slice("2", 0, 1));
    reply.replace("/l/1", Utf16String::slice("3", 0, 1));
    assert_eq!(
        reply.to_json().unwrap(),
        r#"{"a/b":"1","~":"2","l":["p","3"]}"#
    );
}

/// Expected base error for each failing edit; content and preview stay unchanged.
fn assert_failed_edits_leave_the_reply_unchanged(
    reply: &mut WireReply,
    cases: &[(&str, EditError)],
) {
    let bytes = reply.to_json().unwrap();
    let preview = reply.preview().clone();
    for (case, expected) in cases {
        let (op, path) = case.split_once(' ').unwrap();
        let result = match op {
            "put" => reply.put(path, WireReply::new(json!("v"))),
            "remove" => reply.remove(path),
            "set" => reply.set_string(path, Utf16String::slice("v", 0, 1)),
            "splice0" => reply.splice(path, 0, 0, vec![]),
            "splice9" => reply.splice(path, 9, 0, vec![]),
            "copy-from" => reply.copy(path, "/new"),
            "copy-to" => reply.copy("/v", path),
            "subtree" => reply.subtree(path).map(drop),
            "string" => reply.string_at(path).map(drop),
            _ => unreachable!(),
        };
        assert_eq!(result.err(), Some(*expected), "{case}");
        assert_eq!(reply.to_json().unwrap(), bytes, "{case}");
        assert_eq!(reply.preview(), &preview, "{case}");
    }
}

#[test]
fn e1_old_domain_failed_edits_keep_their_base_errors_and_leave_everything_unchanged() {
    use EditError::*;
    let mut reply = wire(r#"{"v":"\ud800","items":["\ud801","x"],"number":4,"obj":{"k":"v"}}"#);
    assert_failed_edits_leave_the_reply_unchanged(
        &mut reply,
        &[
            ("put items", InvalidPointer),
            ("put /~", InvalidPointer),
            ("put /~2", InvalidPointer),
            ("put /items/01", InvalidPointer),
            ("put /items/+1", InvalidPointer),
            ("put /items/-", InvalidPointer),
            ("put /items/9", OutOfBounds),
            ("put /absent/x", NotFound),
            ("put /number/x", WrongType),
            ("remove ", RootRemoval),
            ("remove /absent", NotFound),
            ("remove /obj/zz", NotFound),
            ("remove /items/2", OutOfBounds),
            ("remove /number/x", WrongType),
            ("set /number", WrongType),
            ("set /absent", NotFound),
            ("set /items/5", OutOfBounds),
            ("splice9 /items", OutOfBounds),
            ("splice0 /number", WrongType),
            ("splice0 /absent", NotFound),
            ("copy-from /absent", NotFound),
            ("copy-to /number/x", WrongType),
            ("copy-to /items/7", OutOfBounds),
            ("subtree /items/2", OutOfBounds),
            ("string /number", WrongType),
            ("string /items/00", InvalidPointer),
        ],
    );
}

#[test]
fn e1_failed_edits_below_an_opaque_boundary_leave_bytes_and_projection_unchanged() {
    use EditError::*;
    let mut reply = wire(&boundary_doc(r#"{"s":"x","n":4}"#));
    let b = boundary();
    let l = leaf();
    let cases = [
        format!("put {b}/9"),
        format!("put {l}/s/x"),
        format!("put {b}/0/zz"),
        format!("remove {l}/absent"),
        format!("set {l}/n"),
        format!("splice9 {b}"),
        format!("splice0 {l}/n"),
        format!("copy-from {l}/absent"),
        format!("copy-to {l}/s/x"),
        format!("string {l}/n"),
    ];
    let expected = [
        OutOfBounds,
        WrongType,
        InvalidPointer,
        NotFound,
        WrongType,
        OutOfBounds,
        WrongType,
        NotFound,
        WrongType,
        WrongType,
    ];
    let cases: Vec<_> = cases.iter().map(String::as_str).zip(expected).collect();
    assert_failed_edits_leave_the_reply_unchanged(&mut reply, &cases);
}

fn e2_body() {
    let reply = WireReply::new(deep_value(20_000, json!(1)));
    let mut copy = reply.clone();
    let error = copy
        .put(&format!("{}/x", zeros(20_000)), WireReply::new(json!(2)))
        .err();
    assert_eq!(error, Some(EditError::WrongType));
    drop(copy);
    dispose(reply.into_value().unwrap());
}

/// E2: a deep clone, then a failing edit on it, on a 2 MiB stack.
#[test]
fn e2_deep_clone_then_failing_edit_drops_without_recursion() {
    isolated(
        "e2_deep_clone_then_failing_edit_drops_without_recursion",
        e2_body,
    );
}
