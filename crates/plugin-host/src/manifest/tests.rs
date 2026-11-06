#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn ranges_match_ts_boundary_cases() {
    for (range, host, accepted) in [
        ("*", "1.10.0", true),
        ("^1", "1.10.0", true),
        ("^0", "1.10.0", false),
        ("~1.9", "1.10.0", false),
        (">=1.10.0", "1.10.0", true),
        ("1.10.0", "1.10.0", true),
        ("1.10.1", "1.10.0", false),
        ("^1.10.0 || ^2", "1.10.0", false),
    ] {
        assert_eq!(host_range_accepts(range, host), accepted, "{range}");
    }
}

#[test]
fn generated_manifest_defaults_and_identity() {
    let raw =
        serde_json::json!({"id":"fx-good","version":"1.0.0","publisher":"fixture","host":"^1"});
    let manifest = parse_manifest(raw).unwrap();
    assert_eq!(manifest.id.as_str(), "fx-good");
    assert!(!manifest.reentrant);
}

#[test]
fn conformance_fixture_manifest_cases() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/fixtures");
    let good = std::fs::read_to_string(root.join("good/pacer-plugin.json")).unwrap();
    let old = std::fs::read_to_string(root.join("old-protocol/pacer-plugin.json")).unwrap();
    assert!(parse_manifest(serde_json::from_str(&good).unwrap()).is_ok());
    assert!(matches!(
        parse_manifest(serde_json::from_str(&old).unwrap()),
        Err(ManifestError::IncompatibleHost)
    ));
}

#[test]
fn shared_typescript_manifest_matrix() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../test/fixtures/plugin-manifest-parity.json"
    ))
    .unwrap();
    for case in cases.as_array().unwrap() {
        let parsed = parse_manifest(case["manifest"].clone());
        let actual = parsed.is_ok();
        assert_eq!(
            actual,
            case["accepted"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
        if let Ok(manifest) = parsed {
            let wire = serde_json::to_value(&manifest.wire).unwrap();
            if let Some(title) = case["normalizedTitle"].as_str() {
                assert_eq!(
                    wire["contributes"]["ui"]["status"][0]["title"], title,
                    "{}",
                    case["name"]
                );
            }
            if let Some(key) = case["strippedTopLevel"].as_str() {
                assert!(wire.get(key).is_none(), "{}", case["name"]);
            }
        }
    }
}

#[test]
fn settings_numeric_and_string_fields_match_typescript_parser() {
    use std::process::Command;
    let base = serde_json::json!({"id":"fx-test","version":"1.0.0","publisher":"fixture",
        "host":">=1.6.0","capabilities":[{"name":"config.get"}],
        "contributes":{"ui":{"settings":[{"id":"settings","title":"Settings",
            "schema":{"fields":{"Budget":{"type":"integer","title":"Budget","minimum":0,"maximum":100}}}}]}}});
    let mut cases = Vec::new();
    for (field, spellings) in [
        ("minimum", ["1.0", "1e2", "1.5", "9007199254740992"]),
        ("maximum", ["1.0", "1e2", "1.5", "9007199254740992"]),
        ("default", ["1.0", "1e2", "1.5", "9007199254740992"]),
    ] {
        for spelling in spellings {
            let mut manifest = base.clone();
            manifest["contributes"]["ui"]["settings"][0]["schema"]["fields"]["Budget"][field] =
                serde_json::from_str(spelling).unwrap();
            cases.push((format!("{field}={spelling}"), manifest));
        }
    }
    for (kind, field, spellings) in [
        (
            "string",
            "maxLength",
            ["1.0", "1e2", "1.5", "9007199254740992"],
        ),
        (
            "repos",
            "maxItems",
            ["1.0", "1e2", "1.5", "9007199254740992"],
        ),
    ] {
        for spelling in spellings {
            let mut manifest = base.clone();
            manifest["contributes"]["ui"]["settings"][0]["schema"]["fields"]["Budget"] =
                serde_json::json!({"type":kind,"title":"Budget"});
            manifest["contributes"]["ui"]["settings"][0]["schema"]["fields"]["Budget"][field] =
                serde_json::from_str(spelling).unwrap();
            cases.push((format!("{field}={spelling}"), manifest));
        }
    }
    for (field, value) in [
        ("title", "😀".repeat(80)),
        ("default", "😀".repeat(2000)),
        ("default", "😀".repeat(2001)),
    ] {
        let mut manifest = base.clone();
        manifest["contributes"]["ui"]["settings"][0]["schema"]["fields"]["Budget"] =
            serde_json::json!({"type":"string","title":"Budget"});
        manifest["contributes"]["ui"]["settings"][0]["schema"]["fields"]["Budget"][field] =
            serde_json::json!(value);
        cases.push((format!("{field}={}", value.chars().count()), manifest));
    }
    let input: Vec<_> = cases.iter().map(|(_, manifest)| manifest).collect();
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = Command::new("bun").current_dir(root)
        .args(["-e", "import {parseManifest} from './src/plugins/manifest.ts'; const cases=JSON.parse(Bun.argv.at(-1)); console.log(JSON.stringify(cases.map(c=>parseManifest(c).ok)));", &serde_json::to_string(&input).unwrap()])
        .output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    assert!(expected.iter().any(|accepted| *accepted));
    assert!(expected.iter().any(|accepted| !*accepted));
    for ((name, manifest), accepted) in cases.iter().zip(expected) {
        assert_eq!(parse_manifest(manifest.clone()).is_ok(), accepted, "{name}");
    }
}
