#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn wire_limit_counts_complete_utf8_frame() {
    assert_eq!(
        frame(json!({"jsonrpc":"2.0","id":1,"result":"界"}))
            .unwrap()
            .last(),
        Some(&b'\n')
    );
    assert!(matches!(
        frame(json!({"body":"a".repeat(MAX_LINE_BYTES)})),
        Err(ProcessError::TooLarge)
    ));
    assert!(matches!(parse_frame(b"{bad"), Err(ProcessError::Malformed)));
}

#[test]
fn frame_number_spellings_and_envelope_size_match_javascript() {
    assert_eq!(frame(json!({"n":1.0})).unwrap(), b"{\"n\":1}\n");
    assert_eq!(frame(json!({"n":-0.0})).unwrap(), b"{\"n\":0}\n");
}

/// Expected bytes are `JSON.stringify(JSON.parse(input))` from Bun.
fn frames_like_typescript(input: &str, expected: &str) {
    let value: Value = serde_json::from_str(input).unwrap();
    let framed = String::from_utf8(frame(value).unwrap()).unwrap();
    assert_eq!(framed, format!("{expected}\n"));
}

#[test]
fn frame_keeps_nested_insertion_order_with_index_keys_first() {
    frames_like_typescript(
        r#"{"jsonrpc":"2.0","id":7,"result":{"version":1,"agents":{"claude-code":{"files":[{"path":"rules/pacer.md","sha256":"ab","kind":"rule"}],"installedAt":"2026-11-12T00:00:00.000Z"}},"10":"ten","2":"two","b":{"z":1,"a":[{"y":true,"x":null}]},"a":"last"}}"#,
        r#"{"jsonrpc":"2.0","id":7,"result":{"2":"two","10":"ten","version":1,"agents":{"claude-code":{"files":[{"path":"rules/pacer.md","sha256":"ab","kind":"rule"}],"installedAt":"2026-11-12T00:00:00.000Z"}},"b":{"z":1,"a":[{"y":true,"x":null}]},"a":"last"}}"#,
    );
}

#[test]
fn frame_escapes_unicode_keys_and_strings_like_typescript() {
    frames_like_typescript(
        r#"{"jsonrpc":"2.0","method":"$/event","params":{"😀":"emoji 😀","｡":"halfwidth","é":"e\u0301 and é","Z":"\"quoted\" \\ \b\f\n\r\t","a":"\u0001\u001f\u007f\u2028\u2029</script>"}}"#,
        concat!(
            r#"{"jsonrpc":"2.0","method":"$/event","params":{"😀":"emoji 😀","｡":"halfwidth","é":"#,
            "\"e\u{301} and é\",",
            r#""Z":"\"quoted\" \\ \b\f\n\r\t","a":"\u0001\u001f"#,
            "\u{7f}\u{2028}\u{2029}",
            r#"</script>"}}"#,
        ),
    );
}

#[test]
fn frame_number_spellings_keep_key_order() {
    frames_like_typescript(
        r#"{"jsonrpc":"2.0","id":1,"result":{"z":1e21,"y":1e-7,"x":-0,"w":0.1,"v":123456789012345680000,"u":5e-324,"t":1.7976931348623157e308,"s":-1.5,"r":9007199254740993,"q":100,"p":1.0,"o":-0.0,"n":1e-6,"m":123e-20}}"#,
        r#"{"jsonrpc":"2.0","id":1,"result":{"z":1e+21,"y":1e-7,"x":0,"w":0.1,"v":123456789012345680000,"u":5e-324,"t":1.7976931348623157e+308,"s":-1.5,"r":9007199254740992,"q":100,"p":1,"o":0,"n":0.000001,"m":1.23e-18}}"#,
    );
}
