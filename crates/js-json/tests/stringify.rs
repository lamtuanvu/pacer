#![allow(clippy::unwrap_used)]
use pacer_js_json::{WireReply, number_string, quoted, stringify};
use serde_json::{Value, json};

fn bun_stringify(wire: &str) -> String {
    let script = "console.log(JSON.stringify(JSON.parse(Bun.argv.at(-1))))";
    let result = std::process::Command::new("bun")
        .args(["-e", script, wire])
        .output()
        .unwrap();
    String::from_utf8(result.stdout)
        .unwrap()
        .trim_end()
        .to_owned()
}

#[test]
fn plain_values_stringify_like_javascript() {
    for wire in [
        r#"{"b":1,"10":2,"2":3,"4294967295":4,"4294967294":5,"01":6,"-1":7,"a":{"1":0,"z":1,"0":2}}"#,
        r#"[1e21,1e-7,0.1,-0.0,5e-324,1.7976931348623157e308,123456789012345680000,-1.5e-9]"#,
        r#"{"path":"/tmp/a\"b\\c\n\u0001\u001f\u007f\u2028\ufdd0😀","lastUsed":1762857600.123}"#,
        r#"[null,true,false,"",[],{}]"#,
    ] {
        let value: Value = serde_json::from_str(wire).unwrap();
        assert_eq!(stringify(&value), bun_stringify(wire), "{wire}");
    }
}

#[test]
fn plain_strings_escape_like_serde() {
    let chars = (0..=0x7f)
        .filter_map(char::from_u32)
        .chain(['\u{2028}', '\u{fdd0}', '\u{feff}', '😀']);
    for c in chars {
        let value = json!({ c.to_string(): c.to_string() });
        assert_eq!(stringify(&value), serde_json::to_string(&value).unwrap());
    }
}

#[test]
fn numbers_use_ecmascript_text() {
    assert_eq!(number_string(-0.0), "0");
    assert_eq!(number_string(1e21), "1e+21");
    assert_eq!(number_string(1e-7), "1e-7");
    assert_eq!(
        number_string(123456789012345680000.0),
        "123456789012345680000"
    );
}

/// The plain and quoted stringifiers read strings differently: a quoted value
/// reserves U+FDD0 for lone surrogates and signed Infinity.
#[test]
fn plain_and_quoted_representations_differ_on_reserved_text() {
    let sentinel = quoted::parse(b"1e400").unwrap();
    assert_eq!(quoted::stringify(&sentinel), "null");
    assert_eq!(quoted::stringify_ipc(&sentinel), "1e400");
    assert_eq!(stringify(&sentinel), "\"\u{fdd0}+Infinity\"");

    let lone = quoted::parse(br#""\ud800""#).unwrap();
    assert_eq!(quoted::stringify(&lone), r#""\ud800""#);
    assert_ne!(stringify(&lone), r#""\ud800""#);

    let text = json!("\u{fdd0}x");
    assert_eq!(stringify(&text), "\"\u{fdd0}x\"");
    assert_eq!(
        quoted::stringify(&quoted::from_utf8(text.clone())),
        stringify(&text)
    );
}

/// Two parsers with different depth contracts: `quoted::parse` signals the
/// TypeScript fallback beyond 512 levels; `WireReply::parse` keeps any depth and
/// withholds nodes deeper than 128 from its preview.
#[test]
fn quoted_and_wire_parsers_have_distinct_depth_limits() {
    let nest = |n: usize| format!("{}0{}", "[".repeat(n), "]".repeat(n));
    let shallow = nest(200);
    assert!(quoted::parse(shallow.as_bytes()).is_ok());
    let reply = WireReply::parse(&shallow).unwrap();
    assert!(reply.preview_omits());

    let deep = nest(600);
    assert_eq!(
        quoted::parse(deep.as_bytes()).unwrap_err(),
        quoted::NESTING_FALLBACK
    );
    let reply = WireReply::parse(&deep).unwrap();
    assert_eq!(reply.to_json().unwrap(), deep);
}
