#![allow(clippy::unwrap_used)]
use pacer_js_json::quoted;
#[test]
fn javascript_strings_are_lossless_and_collision_free() {
    for wire in [
        r#""a\ud800b""#,
        r#""\udfff""#,
        r#""\ud800\udfff""#,
        r#""\ufdd0\ue000\ufdd0""#,
        r#"{"\ud800":"\udfff","real":"﷐"}"#,
    ] {
        let value = quoted::parse(wire.as_bytes()).unwrap();
        let output = quoted::stringify(&value);
        assert_eq!(quoted::parse(output.as_bytes()).unwrap(), value, "{wire}");
        let script = "const [a,b]=Bun.argv.slice(-2).map(JSON.parse); console.log(JSON.stringify(a)===JSON.stringify(b))";
        let result = std::process::Command::new("bun")
            .args(["-e", script, wire, &output])
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8(result.stdout).unwrap().trim(),
            "true",
            "{output}"
        );
    }
    let s = quoted::parse(br#""a\ud800b""#).unwrap();
    assert_eq!(quoted::utf16(s.as_str().unwrap()).len(), 3);
}
#[test]
fn malformed_json_is_still_rejected_and_every_lone_unit_roundtrips() {
    for raw in [
        r#""\u123""#,
        r#""\x20""#,
        "\"\n\"",
        "[1,]",
        "{}{}",
        "01",
        "{\"x\":1,}",
        "{\"x\" 1}",
    ] {
        assert!(quoted::parse(raw.as_bytes()).is_err(), "{raw}");
    }
    for unit in 0xd800..=0xdfff {
        let wire = format!(r#""\u{unit:04x}""#);
        let parsed = quoted::parse(wire.as_bytes()).unwrap();
        assert_eq!(quoted::utf16(parsed.as_str().unwrap()).len(), 1);
        assert_eq!(quoted::stringify(&parsed), wire);
    }
}
