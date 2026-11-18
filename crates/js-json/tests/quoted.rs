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
fn string_and_number_conversions_match_javascript() {
    let cases = [
        "null",
        "true",
        "false",
        "0",
        "-0",
        "1.0",
        "1.5",
        "1e21",
        "1e-7",
        "9007199254740993",
        "1e400",
        "-1e400",
        r#""""#,
        r#"" 12 ""#,
        r#""\ufeff3\t""#,
        r#""0x10""#,
        r#""0b11""#,
        r#""0o17""#,
        r#""-0x10""#,
        r#""0x""#,
        r#""1e400""#,
        r#""Infinity""#,
        r#""-Infinity""#,
        r#""infinity""#,
        r#""inf""#,
        r#""NaN""#,
        r#""1.e5""#,
        r#""+.5""#,
        r#""1_000""#,
        r#""010""#,
        r#""x""#,
        r#""\ufdd0""#,
        "[]",
        "[7]",
        "[[9]]",
        "[1,2]",
        "[null]",
        "[null,1,[2,[3]],true]",
        r#"["5"]"#,
        "[1e400]",
        "{}",
        r#"{"a":1}"#,
        r#"{"valueOf":1}"#,
        r#"[{"a":1}]"#,
        r#"{"toString":1}"#,
        r#"[{"toString":"x"}]"#,
        r#"{"toString":{}}"#,
    ];
    let script = "const out=JSON.parse(Bun.argv.at(-1)).map(t=>{const v=JSON.parse(t);let s=null,n=null;try{s=String(v)}catch{}try{n=String(Number(v))}catch{}return [s,n]});console.log(JSON.stringify(out))";
    let out = std::process::Command::new("bun")
        .args(["-e", script, &serde_json::to_string(&cases[..]).unwrap()])
        .output()
        .unwrap();
    assert!(out.status.success());
    let expected: Vec<(Option<String>, Option<String>)> =
        serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(expected.len(), cases.len());
    for (text, (string, number)) in cases.iter().zip(expected) {
        let value = quoted::parse(text.as_bytes()).unwrap();
        let actual =
            quoted::js_string(&value).map(|s| String::from_utf16_lossy(&quoted::utf16(&s)));
        assert_eq!(actual, string, "String({text})");
        let actual = quoted::js_number(&value).map(|n| match n {
            n if n.is_nan() => "NaN".to_owned(),
            n if n.is_infinite() => if n > 0.0 { "Infinity" } else { "-Infinity" }.to_owned(),
            n => pacer_js_json::number_string(n),
        });
        assert_eq!(actual, number, "Number({text})");
    }
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
