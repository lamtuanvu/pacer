#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{json, settings};
#[test]
fn javascript_strings_are_lossless_and_collision_free() {
    for wire in [
        r#""a\ud800b""#,
        r#""\udfff""#,
        r#""\ud800\udfff""#,
        r#""\ufdd0\ue000\ufdd0""#,
        r#"{"\ud800":"\udfff","real":"﷐"}"#,
    ] {
        let value = json::parse(wire.as_bytes()).unwrap();
        let output = settings::js_json(&value);
        assert_eq!(json::parse(output.as_bytes()).unwrap(), value, "{wire}");
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
    let s = json::parse(br#""a\ud800b""#).unwrap();
    assert_eq!(settings::js_length(s.as_str().unwrap()), 3);
}
#[test]
fn deeply_nested_ipc_document_decodes_before_ui_validation() {
    let mut wire = r#"{"type":"text","text":"ok"}"#.to_owned();
    for _ in 0..70 {
        wire = format!(r#"{{"type":"stack","gap":"related","children":[{wire}]}}"#);
    }
    let value = json::parse(wire.as_bytes()).unwrap();
    assert_eq!(
        pacer_plugin_host::ui::parse(value, false).unwrap_err(),
        "document is deeper than 8 levels"
    );
}

#[test]
fn each_runtime_reads_the_other_runtimes_store_bytes_without_loss() {
    use pacer_foundation::Ctx;
    use std::{fs, process::Command};
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let ctx = Ctx::with(root.clone(), root, Default::default(), 0.0);
    // TS writes lone units in values, arbitrary unknown plugin records and keys.
    let write = r#"import {saveSettings} from './src/plugins/settings'; const ctx={pacerHome:Bun.argv.at(-1)}; await saveSettings(ctx,'other',JSON.parse('{"name":"a\\ud800b","\\udfff":"﷐"}'),0);"#;
    let output = Command::new("bun")
        .current_dir("../..")
        .args(["-e", write])
        .arg(&ctx.pacer_home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(settings::read(&ctx, "other").unwrap()["rev"], 1);
    let values =
        json::parse(br#"{"text":"a\udfffb","marker":"\ufdd0\ue000","pair":"\ud800\udfff"}"#)
            .unwrap();
    settings::save(&ctx, "fx-ui", values, 0.0).unwrap();
    let read = r#"import {readPluginSettings,saveSettings} from './src/plugins/settings'; const ctx={pacerHome:Bun.argv.at(-1)};const a=readPluginSettings(ctx,'other'), b=readPluginSettings(ctx,'fx-ui');if(a.values.name!=='a\ud800b'||a.values['\udfff']!=='﷐'||b.values.text!=='a\udfffb'||b.values.marker!=='﷐'||b.values.pair!=='\ud800\udfff')throw Error('string changed'); await saveSettings(ctx,'ts-again',{x:'\ud800'},0);"#;
    let output = Command::new("bun")
        .current_dir("../..")
        .args(["-e", read])
        .arg(&ctx.pacer_home)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        settings::js_json(&settings::read(&ctx, "ts-again").unwrap()["values"]),
        r#"{"x":"\ud800"}"#
    );
    assert!(
        !fs::read_dir(&ctx.pacer_home).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("corrupt"))
    );
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
        assert!(json::parse(raw.as_bytes()).is_err(), "{raw}");
    }
    for unit in 0xd800..=0xdfff {
        let wire = format!(r#""\u{unit:04x}""#);
        let parsed = json::parse(wire.as_bytes()).unwrap();
        assert_eq!(settings::js_length(parsed.as_str().unwrap()), 1);
        assert_eq!(settings::js_json(&parsed), wire);
    }
}

#[test]
fn strategy_values_with_literal_quote_characters_remain_unicode() {
    use pacer_foundation::Ctx;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let ctx = Ctx::with(root.clone(), root, Default::default(), 0.0);
    std::fs::write(ctx.pacer_home.join("strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\nplugins:\n  config:\n    fx-ui:\n      text: '﷐'\n").unwrap();
    assert_eq!(
        settings::js_json(&settings::effective_config(&ctx, "fx-ui").unwrap()),
        "{\"text\":\"﷐\"}"
    );
}
