#![allow(clippy::unwrap_used)]
use pacer_js_json::WireReply;
use std::process::Command;

#[test]
fn duplicate_values_discard_losing_utf16_overlays() {
    for input in [
        r#"{"a":"\ud800","a":"KEEP","z":"\ud801"}"#,
        r#"{"a":{"x":"\ud800"},"a":{"x":"KEEP"},"z":"\ud801"}"#,
        r#"{"a":{"x":"\ud800"},"a":42,"z":"\ud801"}"#,
        r#"{"a/b~c":["\ud800"],"a/b~c":["KEEP"],"z":"\ud801"}"#,
        r#"[{"x":"\ud800","x":false},{"x":"\ud801"}]"#,
    ] {
        let oracle = Command::new("bun")
            .args([
                "-e",
                "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))",
                input,
            ])
            .output()
            .unwrap();
        assert!(oracle.status.success());
        assert_eq!(
            WireReply::parse(input).unwrap().to_json().unwrap(),
            String::from_utf8(oracle.stdout).unwrap(),
            "{input}"
        );
    }
}
