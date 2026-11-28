//! Transcribed from `src/update/manifest.ts` cases in `test/update-run.test.ts`.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_update::manifest::*;
use serde_json::json;

const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

#[test]
fn parses_a_pair_manifest() {
    let m = parse_manifest(&json!({"version":"1.2.3","assets":[{"os":"darwin","arch":"arm64","file":"pacer-darwin-arm64","sha256":SHA,"size":10,
        "companions":[{"name":"pacer-core","file":"pacer-core-darwin-arm64","sha256":SHA,"size":20}]}]})).unwrap();
    assert_eq!(m.assets[0].companions.as_ref().unwrap()[0].size, 20);
}

#[test]
fn reports_every_problem_in_typescript_order() {
    let err = parse_manifest(&json!({"version":"1.2","assets":[{"os":"win32","arch":"x64"},
        {"os":"linux","arch":"x64","file":"x","sha256":"ABC","size":0,"companions":[{"name":"core"},{"name":"pacer-core"}]}]})).unwrap_err();
    assert_eq!(
        err.0,
        "invalid manifest.json: version must be MAJOR.MINOR.PATCH (got \"1.2\"); assets[0]: unsupported os/arch win32-x64; \
assets[1]: file must be \"pacer-linux-x64\" (got \"x\"); assets[1]: sha256 must be 64 lowercase hex characters; assets[1]: size must be a positive integer; \
assets[1].companions[0]: unknown companion name; assets[1].companions[0]: file must be \"pacer-core-linux-x64\"; assets[1].companions[0]: sha256 must be 64 lowercase hex characters; \
assets[1].companions[0]: size must be a positive integer; assets[1].companions[1]: file must be \"pacer-core-linux-x64\"; assets[1].companions[1]: sha256 must be 64 lowercase hex characters; \
assets[1].companions[1]: size must be a positive integer; assets[1].companions[1]: duplicate companion"
    );
}

#[test]
fn empty_assets_and_duplicates() {
    assert_eq!(
        parse_manifest(&json!({"version":"1.0.0","assets":[]}))
            .unwrap_err()
            .0,
        "invalid manifest.json: assets must be a non-empty list"
    );
    let a = json!({"os":"linux","arch":"x64","file":"pacer-linux-x64","sha256":SHA,"size":1});
    assert!(
        parse_manifest(&json!({"version":"1.0.0","assets":[a.clone(), a]}))
            .unwrap_err()
            .0
            .contains("assets[1]: duplicate platform linux-x64")
    );
}

#[test]
fn sums_accept_text_and_binary_markers_and_refuse_conflicts() {
    let s = parse_sha256_sums(&format!(
        "{SHA}  pacer-linux-x64\n{} *pacer-core-linux-x64\nnoise\n",
        SHA.to_uppercase()
    ))
    .unwrap();
    assert_eq!(s["pacer-core-linux-x64"], SHA);
    let other = "b".repeat(64);
    assert_eq!(
        parse_sha256_sums(&format!("{SHA}  f\n{other}  f\n"))
            .unwrap_err()
            .0,
        "SHA256SUMS has conflicting hashes for f"
    );
}

#[test]
fn release_urls_match_the_typescript_layout() {
    assert_eq!(
        release_url(None, "1.2.3", "manifest.json"),
        "https://github.com/lamtuanvu/pacer/releases/download/v1.2.3/manifest.json"
    );
    assert_eq!(
        release_url(Some("file:///r"), "1.2.3", "SHA256SUMS"),
        "file:///r/1.2.3/SHA256SUMS"
    );
}
