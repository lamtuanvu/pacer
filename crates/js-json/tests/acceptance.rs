//! Task JSON acceptance (§7 rows 1-29): parse, render and preview through the
//! current public API. Rows the base parser already accepts pin its bytes and
//! preview; rows it rejects state the target acceptance and fail until the AST lands.
#![allow(clippy::unwrap_used)]
mod support;
use pacer_js_json::WireReply;
use serde_json::{Value, json};
use std::fmt::Write;
use support::*;

fn wire(text: &str) -> WireReply {
    WireReply::parse(text).unwrap_or_else(|e| panic!("parse rejected {} bytes: {e}", text.len()))
}

/// Preview of `arrays(n, leaf)`: nodes deeper than LIMIT are withheld as one null.
fn withheld_arrays(n: usize, leaf: Value) -> Value {
    if n <= LIMIT {
        deep_value(n, leaf)
    } else {
        deep_value(LIMIT + 1, Value::Null)
    }
}

fn nested_preview(shape: &str, n: usize, leaf: Value) -> Value {
    let mut value = leaf;
    for i in (0..n).rev() {
        value = match (shape, i % 2) {
            ("arrays", _) | ("mixed", 0) => Value::Array(vec![value]),
            _ => json!({ "a": value }),
        };
    }
    value
}

#[test]
fn limit_every_shape_at_the_pinned_depth_keeps_its_bytes_and_full_preview() {
    type Builder = fn(usize, &str) -> String;
    let builders: [(&str, Builder); 3] =
        [("arrays", arrays), ("objects", objects), ("mixed", mixed)];
    for (shape, build) in builders {
        for (leaf, preview) in [
            ("1", json!(1)),
            ("null", Value::Null),
            ("[]", json!([])),
            ("{}", json!({})),
            // A lone surrogate forces the base fallback parser rather than serde's fast path.
            (r#""\ud800""#, json!("\u{fffd}")),
        ] {
            let text = build(LIMIT, leaf);
            let reply = wire(&text);
            assert_eq!(reply.to_json().unwrap(), text, "{shape} {leaf}");
            assert_eq!(
                reply.preview(),
                &nested_preview(shape, LIMIT, preview),
                "{shape} {leaf}"
            );
        }
    }
}

#[test]
fn limit_plus_one_is_newly_accepted_with_a_withheld_boundary() {
    // Base: rejected with "JSON recursion limit exceeded". Target: accepted;
    // the node at depth LIMIT+1 previews as null and the bytes are exact.
    for leaf in ["1", "[]", r#""\ud800""#] {
        let text = arrays(LIMIT + 1, leaf);
        let reply = wire(&text);
        assert_eq!(reply.to_json().unwrap(), text, "{leaf}");
        assert_eq!(reply.preview(), &withheld_arrays(LIMIT + 1, json!(1)));
    }
}

#[test]
fn row01_control_record_bytes_are_unchanged() {
    let text = r#"{"id":"t-20261103-070000-0001","rev":1,"state":"queued","createdAt":1.0,"brief":{"repo":"/tmp/repo"},"attempts":[]}"#;
    let reply = wire(text);
    assert_eq!(reply.to_json().unwrap(), text);
    assert_eq!(reply.preview()["createdAt"], json!(1.0));
    assert!(reply.into_value().is_ok());
}

#[test]
fn row02_lone_surrogate_value_in_an_array_keeps_bytes_and_conversion_error() {
    let text = r#"{"title":["\ud800"]}"#;
    let reply = wire(text);
    assert_eq!(reply.to_json().unwrap(), text);
    assert_eq!(reply.preview(), &json!({"title":["\u{fffd}"]}));
    assert!(reply.into_value().is_err());
}

#[test]
fn row03_lone_surrogate_key_is_retained_and_omitted_from_the_preview() {
    let text = r#"{"\ud800":1,"k":2}"#;
    let reply = wire(text);
    assert_eq!(reply.to_json().unwrap(), text);
    assert_eq!(js_canonical(&reply.to_json().unwrap()), js_canonical(text));
    assert_eq!(reply.preview(), &json!({"k":2}));
    assert!(reply.into_value().is_err());
}

#[test]
fn row04_lone_surrogate_and_replacement_keys_stay_distinct() {
    let text = "{\"\\ud800\":1,\"\u{fffd}\":2}";
    let reply = wire(text);
    assert_eq!(reply.to_json().unwrap(), text);
    assert_eq!(js_canonical(&reply.to_json().unwrap()), js_canonical(text));
    assert_eq!(reply.preview(), &json!({"\u{fffd}":2}));
    assert!(reply.into_value().is_err());
}

#[test]
fn row05_duplicate_lone_surrogate_keys_keep_the_last_value_at_the_first_position() {
    let text = r#"{"\ud800":1,"x":0,"\ud800":2}"#;
    let reply = wire(text);
    assert_eq!(reply.to_json().unwrap(), r#"{"\ud800":2,"x":0}"#);
    assert_eq!(js_canonical(&reply.to_json().unwrap()), js_canonical(text));
    assert_eq!(reply.preview(), &json!({"x":0}));
}

#[test]
fn row06_depth_140_is_accepted_with_exact_bytes_and_a_withheld_boundary() {
    let text = arrays(140, "1");
    let reply = wire(&text);
    assert_eq!(reply.to_json().unwrap(), text);
    assert_eq!(js_canonical(&reply.to_json().unwrap()), js_canonical(&text));
    assert_eq!(reply.preview(), &withheld_arrays(140, json!(1)));
    assert!(reply.into_value().is_err());
}

fn row07_body() {
    let text = arrays(20_000, "1");
    let reply = wire(&text);
    let copy = reply.clone();
    drop(copy);
    assert_eq!(reply.to_json().unwrap(), text);
    let preview = reply.preview().clone();
    assert_eq!(preview, withheld_arrays(20_000, json!(1)));
    dispose(preview);
    assert!(reply.into_value().is_err());
}

#[test]
fn row07_depth_20000_parses_renders_projects_clones_and_drops_on_a_2mib_stack() {
    isolated(
        "row07_depth_20000_parses_renders_projects_clones_and_drops_on_a_2mib_stack",
        row07_body,
    );
}

fn row08_body() {
    let text = arrays(200_000, "1");
    let reply = wire(&text);
    assert_eq!(reply.to_json().unwrap(), text);
}

/// Unsupported comparison: TS breaks the home at this depth (RangeError). This
/// pins only that native acceptance is resource-safe; no TS parity is claimed.
#[test]
fn row08_depth_200000_is_accepted_as_an_unsupported_comparison() {
    isolated(
        "row08_depth_200000_is_accepted_as_an_unsupported_comparison",
        row08_body,
    );
}

#[test]
fn row10_overflow_numbers_render_and_preview_as_null() {
    let reply = wire(r#"{"x":1e400,"y":-1e400}"#);
    assert_eq!(reply.to_json().unwrap(), r#"{"x":null,"y":null}"#);
    assert_eq!(reply.preview(), &json!({"x":null,"y":null}));
    assert_eq!(reply.into_value().unwrap(), json!({"x":null,"y":null}));
}

#[test]
fn row11_finite_number_forms_keep_the_base_bytes() {
    // Captured from the base parser (.work/reviews/task-json-t1/base-capture-js-json.txt).
    let reply = wire("[1e-400,-0,1.0,1e21,1e-7,0.1,5e-324,1E2]");
    assert_eq!(
        reply.to_json().unwrap(),
        "[0.0,-0.0,1.0,1e+21,1e-7,0.1,5e-324,100.0]"
    );
    let reply = wire(
        "[-0.0,1.5e300,18446744073709551615,18446744073709551616,-9223372036854775808,9007199254740993]",
    );
    assert_eq!(
        reply.to_json().unwrap(),
        "[-0.0,1.5e+300,18446744073709551615,1.8446744073709552e+19,-9223372036854775808,9007199254740993]"
    );
    assert!(reply.preview()[2].is_u64());
    assert!(reply.preview()[4].is_i64());
    assert!(reply.preview()[0].is_f64());
}

#[test]
fn row11_overflow_beside_finite_forms_is_accepted_with_the_base_finite_bytes() {
    let text = "[-1e400,1e-400,-0,1.0,1e21,1e-7,0.1,5e-324,1E2]";
    let reply = wire(text);
    assert_eq!(
        reply.to_json().unwrap(),
        "[null,0.0,-0.0,1.0,1e+21,1e-7,0.1,5e-324,100.0]"
    );
    assert_eq!(js_canonical(&reply.to_json().unwrap()), js_canonical(text));
}

#[test]
fn rows18_to_22_accepted_forms_keep_the_base_bytes_and_are_js_equivalent() {
    // (input, base Rust bytes) captured from the base parser.
    for (input, bytes) in [
        (r#"{"b":1,"1":2,"0":3}"#, r#"{"b":1,"1":2,"0":3}"#),
        (
            r#"{"title":"a","note":1,"title":"b"}"#,
            r#"{"title":"b","note":1}"#,
        ),
        (r#"{"rev":1.0e0}"#, r#"{"rev":1.0}"#),
        (r#"{"__proto__":{"x":1}}"#, r#"{"__proto__":{"x":1}}"#),
        (
            "{\"s\":\"\\u0001\\u0008\\u001f\u{fffd}\\/\"}",
            "{\"s\":\"\\u0001\\b\\u001f\u{fffd}/\"}",
        ),
        (
            r#"{"s":"\ud800\u0001\b","k":["\udc00"]}"#,
            r#"{"s":"\ud800\u0001\u0008","k":["\udc00"]}"#,
        ),
    ] {
        let reply = wire(input);
        assert_eq!(reply.to_json().unwrap(), bytes, "{input}");
        assert_eq!(js_canonical(bytes), js_canonical(input), "{input}");
    }
}

#[test]
fn row23_grammar_rejections_keep_their_error_class() {
    use serde_json::error::Category::{Eof, Syntax};
    for (input, class) in [
        ("\u{feff}{}".to_owned(), Syntax),
        ("{} x".to_owned(), Syntax),
        (r#"{"s":"\x"}"#.to_owned(), Syntax),
        ("\"a\u{1}\"".to_owned(), Syntax),
        ("{\"a\":".to_owned(), Eof),
        ("[1,]".to_owned(), Syntax),
        ("01".to_owned(), Syntax),
        ("NaN".to_owned(), Syntax),
        ("{\"a\":1,}".to_owned(), Syntax),
        // Deep documents are still rejected for grammar, not accepted by depth.
        (arrays(140, "1") + "x", Syntax),
        (arrays(140, r#""\x""#), Syntax),
        (arrays(140, "\"\u{1}\""), Syntax),
        (arrays(140, "1")[..280].to_owned(), Eof),
        (format!("\u{feff}{}", arrays(140, "1")), Syntax),
    ] {
        let error = WireReply::parse(&input).err().unwrap_or_else(|| {
            panic!("accepted invalid input of {} bytes", input.len());
        });
        assert_eq!(error.classify(), class, "{error}");
    }
}

fn e3_body() {
    use serde_json::error::Category::{Eof, Syntax};
    for (input, class) in [
        (arrays(20_000, r#""\x""#), Syntax),
        (arrays(20_000, "1") + "x", Syntax),
        (arrays(20_000, "1")[..39_999].to_owned(), Eof),
    ] {
        let error = WireReply::parse(&input).err().unwrap();
        assert_eq!(error.classify(), class, "{error}");
    }
}

/// E3: a failure late in a deep document unwinds without recursion.
#[test]
fn e3_late_failure_in_a_depth_20000_document_keeps_its_error_class() {
    isolated(
        "e3_late_failure_in_a_depth_20000_document_keeps_its_error_class",
        e3_body,
    );
}

fn e4_body() {
    let text = format!(r#"{{"a":{},"a":1}}"#, arrays(20_000, r#""\ud800""#));
    let reply = wire(&text);
    assert_eq!(reply.to_json().unwrap(), r#"{"a":1}"#);
    assert_eq!(reply.preview(), &json!({"a":1}));
}

/// E4: replacing a deep duplicate value disposes the old value iteratively.
#[test]
fn e4_duplicate_replacement_of_a_depth_20000_value() {
    isolated("e4_duplicate_replacement_of_a_depth_20000_value", e4_body);
}

/// Row 28 (ignored; not a CI timing gate): 200k members with descending numeric
/// keys, interleaved duplicates and hidden keys. n against 4n stays near linear.
#[test]
#[ignore = "resource pin; run explicitly"]
fn row28_wide_object_parse_render_and_projection_stay_linear() {
    fn doc(n: usize) -> String {
        let mut out = String::from("{");
        for i in (0..n).rev() {
            write!(out, r#""{i}":{i},"\ud800{i}":"\udc00","{i}":"dup","#).unwrap();
        }
        out.push_str(r#""end":true}"#);
        out
    }
    let mut elapsed = vec![];
    for n in [50_000, 200_000] {
        let text = doc(n);
        let start = std::time::Instant::now();
        let reply = wire(&text);
        let bytes = reply.to_json().unwrap();
        let members = reply.preview().as_object().unwrap().len();
        elapsed.push(start.elapsed());
        assert_eq!(members, n + 1);
        assert!(bytes.len() < text.len());
    }
    assert!(
        elapsed[1] < elapsed[0] * 16,
        "4n took {:?} against n {:?}",
        elapsed[1],
        elapsed[0]
    );
}

/// Deterministic generator for the row 29 corpus: 15bb/base-accepted documents
/// including depth LIMIT-1..LIMIT spines, duplicates and lone surrogates.
struct Corpus(u64);
impl Corpus {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn pick<'a>(&mut self, items: &[&'a str]) -> &'a str {
        items[self.next() as usize % items.len()]
    }
    fn value(&mut self, depth: usize, out: &mut String) {
        let scalar = [
            "null",
            "true",
            "false",
            "0",
            "-0",
            "1",
            "1.0",
            "-7",
            "1e21",
            "1E2",
            "1e-7",
            "0.1",
            "5e-324",
            "1e-400",
            "18446744073709551615",
            "18446744073709551616",
            "-9223372036854775808",
            "9007199254740993",
            r#""""#,
            r#""plain""#,
            r#""\ud800""#,
            r#""\udc00x""#,
            r#""\ud83d\ude00""#,
            "\"\u{fffd}\"",
            r#""\u0001\b\/""#,
            r#""a\"b\\c""#,
        ];
        match if depth >= 4 { 0 } else { self.next() % 4 } {
            0 | 1 => out.push_str(self.pick(&scalar)),
            2 => {
                out.push('[');
                for i in 0..self.next() % 4 {
                    if i > 0 {
                        out.push(',');
                    }
                    self.value(depth + 1, out);
                }
                out.push(']');
            }
            _ => {
                out.push('{');
                let keys = ["a", "b", "", "a/b", "~", "0", "1", "\u{fffd}", "__proto__"];
                for i in 0..self.next() % 5 {
                    if i > 0 {
                        out.push(',');
                    }
                    write!(out, "{}:", serde_json::to_string(self.pick(&keys)).unwrap()).unwrap();
                    self.value(depth + 1, out);
                }
                out.push('}');
            }
        }
    }
    fn document(&mut self, index: usize) -> String {
        let mut body = String::new();
        self.value(0, &mut body);
        match index % 5 {
            // Duplicate members: the last value wins at the first position.
            2 => {
                let mut other = String::new();
                self.value(1, &mut other);
                format!(r#"{{"a":{body},"k":"\ud800","a":{other},"k":[{body}]}}"#)
            }
            // Spines put the generated value at node depth LIMIT-1 or LIMIT.
            3 => mixed(
                LIMIT - 1,
                if body.starts_with(['[', '{']) {
                    "1"
                } else {
                    &body
                },
            ),
            4 => arrays(
                LIMIT,
                if body.starts_with(['[', '{']) {
                    "[]"
                } else {
                    &body
                },
            ),
            _ => body,
        }
    }
}

const CORPUS: &str = include_str!("fixtures/base-corpus.jsonl");

#[test]
fn row29_base_accepted_corpus_keeps_the_base_bytes_and_preview() {
    let mut corpus = Corpus(0x7a5c_0001);
    let mut generated = String::new();
    for index in 0..400 {
        let text = corpus.document(index);
        let reply = wire(&text);
        let line = json!([
            text,
            reply.to_json().unwrap(),
            serde_json::to_string(reply.preview()).unwrap()
        ]);
        writeln!(generated, "{line}").unwrap();
    }
    if std::env::var_os("PACER_JS_JSON_BLESS_BASE_CORPUS").is_some() {
        std::fs::write(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/base-corpus.jsonl"
            ),
            &generated,
        )
        .unwrap();
        return;
    }
    for (index, (actual, expected)) in generated.lines().zip(CORPUS.lines()).enumerate() {
        assert_eq!(actual, expected, "corpus document {index}");
    }
    assert_eq!(generated.lines().count(), CORPUS.lines().count());
}
