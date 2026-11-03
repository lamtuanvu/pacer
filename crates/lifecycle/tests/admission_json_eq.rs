//! `WireReply::admission_json_eq` (additive, §4.8) against the existing queue
//! comparator (Q1-Q3) and its declared extension (Q4, deep and hidden-key
//! pairs). A separate target: it does not compile until the method exists.
#![allow(clippy::unwrap_used)]
#[path = "support/queue_pairs.rs"]
mod pairs;
use pacer_js_json::WireReply;
use pairs::*;

fn wire(text: &str) -> WireReply {
    WireReply::parse(text).unwrap()
}

fn eq(a: &str, b: &str) -> bool {
    let (a, b) = (wire(a), wire(b));
    assert_eq!(a.admission_json_eq(&b), b.admission_json_eq(&a));
    a.admission_json_eq(&b)
}

#[test]
fn q1_q2_match_the_existing_comparator() {
    for (a, b, _) in NUMBER_PAIRS.iter().chain(STRUCTURE_PAIRS) {
        assert_eq!(eq(a, b), old_equal(a, b), "{a} vs {b}");
    }
    for (a, b, _) in KEY_PAIRS {
        assert_eq!(eq(a, b), admission_equal(a, b), "{a} vs {b}");
    }
}

/// Q3: generated old-domain queues, compared pairwise against the old rule.
#[test]
fn q3_generated_old_domain_queues_match_the_existing_comparator() {
    let atoms = [
        "0",
        "-0",
        "1",
        "1.0",
        "2",
        "9007199254740993",
        "9007199254740992",
        "1e21",
        "5e-324",
        "0.1",
        "null",
        "true",
        r#""a""#,
        r#""\ud800""#,
        "\"\u{fffd}\"",
        "[]",
        "{}",
    ];
    let mut queues = vec![];
    for (i, a) in atoms.iter().enumerate() {
        let b = atoms[(i * 7 + 3) % atoms.len()];
        queues.push(format!(
            r#"{{"reason":"no_slot","since":{a},"position":{b}}}"#
        ));
        queues.push(format!(
            r#"{{"position":{b},"since":{a},"reason":"no_slot"}}"#
        ));
        queues.push(format!(r#"{{"since":[{a},{b}],"m":{{"x":{a}}}}}"#));
        queues.push(format!(r#"{{"since":[{b},{a}],"m":{{"x":{b}}}}}"#));
    }
    for a in &queues {
        for b in &queues {
            assert_eq!(eq(a, b), old_equal(a, b), "{a} vs {b}");
        }
    }
}

#[test]
fn q4_overflow_compares_as_serialized_null() {
    assert!(eq("1e400", "null"));
    assert!(eq("1e400", "-1e400"));
    assert!(eq(r#"{"x":-1e400}"#, r#"{"x":null}"#));
    assert!(!eq("1e400", "0"));
}

#[test]
fn deep_and_hidden_key_queues_compare_exactly() {
    let deep = |leaf: &str| {
        format!(
            r#"{{"since":{}}}"#,
            "[".repeat(140) + leaf + &"]".repeat(140)
        )
    };
    assert!(eq(&deep("1"), &deep("1.0")));
    assert!(!eq(&deep("1"), &deep("2")));
    assert!(!eq(&deep("0"), &deep("-0")));
    // Previews coincide ({}), exact keys differ.
    assert!(!eq(r#"{"\ud800":1}"#, r#"{"\ud801":1}"#));
    assert!(!eq(r#"{"\ud800":1}"#, "{}"));
    assert!(eq(r#"{"\ud800":1,"a":2}"#, r#"{"a":2.0,"\ud800":1}"#));
}

#[test]
fn equal_content_with_different_projection_histories_is_equal() {
    let text = format!(r#"{{"d":{}}}"#, "[".repeat(140) + "1" + &"]".repeat(140));
    let parsed = wire(&text);
    let mut composed = wire(&("[".repeat(128) + "1" + &"]".repeat(128)));
    for _ in 128..140 {
        let mut parent = WireReply::new(serde_json::json!([null]));
        parent.put("/0", composed).unwrap();
        composed = parent;
    }
    let mut root = WireReply::new(serde_json::json!({}));
    root.put("/d", composed).unwrap();
    assert!(parsed.admission_json_eq(&root));
}

/// F2: two parsed deep queues that differ only below the preview boundary.
/// Their previews coincide, so only the comparator can tell them apart.
#[test]
fn deep_leaf_change_behind_equal_previews_is_unequal() {
    let deep = |leaf: &str| {
        format!(
            r#"{{"reason":"machine_load","detail":{}}}"#,
            "[".repeat(140) + leaf + &"]".repeat(140)
        )
    };
    let (a, b) = (wire(&deep("1")), wire(&deep("2")));
    assert_eq!(a.preview(), b.preview(), "previews coincide");
    assert_ne!(a.to_json().unwrap(), b.to_json().unwrap());
    assert!(!a.admission_json_eq(&b));
    assert!(!b.admission_json_eq(&a));
    assert!(a.admission_json_eq(&wire(&deep("1.0"))));
}
