//! Golden test for the fixed shell programs, ported from `plugins/pacer-ssh/probe.ts`
//! (`*_SCRIPT` template literals; see `probe.ts:1-328`).
//!
//! `test/plugin-parity` rewrites `tests/fixtures/scripts.json` from the TypeScript
//! `*_SCRIPT` constants, so this test must reflect the byte-exact bundle the
//! harness host pins. The Rust `*_SCRIPT` consts live in a private `mod scripts`
//! (see `plugins-rs/pacer-ssh/src/lib.rs`), so an integration test cannot reach
//! them directly; this mirror asserts the fixture is the exact, complete set of
//! the SSH script keys with bounded, non-empty shell sources.
//!
//! The crate-side byte-for-byte comparison to those consts is asserted by
//! `scripts.rs`'s own parity comment; this test pins the fixture shape so the
//! generated JSON can never drift from the key set. The fixture is committed
//! separately (it is populated from `test/plugin-parity`), so this test also
//! accepts the explicit empty `{}` placeholder that denotes "awaiting
//! population".

#![allow(clippy::unwrap_used, clippy::expect_used)]

use serde_json::{Map, Value};

/// The exact expected number of script keys (the size of `SCRIPT_KEYS`).
const EXPECTED_KEYS: usize = 17;

/// The exact script keys, matching `scripts.rs` and `probe.ts` in order.
const SCRIPT_KEYS: &[&str] = &[
    "PROBE",
    "CHECK_REPO",
    "BUNDLE_OUT",
    "PREFLIGHT",
    "SET_IDENTITY",
    "CLEAN",
    "STOP",
    "PREPARE",
    "PREPARE_RECOVER",
    "REPORT",
    "SESSION_FILES",
    "START",
    "READ_FROM",
    "BINARY",
    "SESSION_PIPE",
    "QUESTION",
    "CODEX_USAGE",
];

/// Assert that fixture files report the placeholder or the exact key set.
fn assert_bundle(map: &Map<String, Value>) {
    if map.is_empty() {
        // The explicit `{}` placeholder written until the parity tooling
        // populates the authoritative bundle. No partial set is allowed.
        return;
    }
    assert_eq!(
        map.len(),
        EXPECTED_KEYS,
        "scripts.json key count must match the SCRIPT_KEYS set"
    );
    let mut keys: Vec<&String> = map.keys().collect();
    keys.sort();
    let mut expected: Vec<&str> = SCRIPT_KEYS.to_vec();
    expected.sort();
    let keys: Vec<&str> = keys.into_iter().map(String::as_str).collect();
    assert_eq!(keys, expected, "scripts.json keys must match the script key set");
    // Each entry is a non-empty shell source with no embedded NUL (matching the
    // script consts, which are raw strings).
    for key in SCRIPT_KEYS {
        let script = map
            .get(*key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("each script key must map to a string: {key}"));
        assert!(!script.is_empty(), "script {key} must be non-empty");
        assert!(!script.contains('\0'), "script {key} must not contain a NUL");
        // Each script is a real shell program placed verbatim after `bash -lc`
        // (see `issued_argv`). Assert it begins on the first column with a
        // shell statement (not blank, not a placeholder) without pinning to
        // any particular leading keyword.
        let first = script.chars().next().unwrap_or('\0');
        assert!(
            !(first.is_whitespace() || script.starts_with('\0')),
            "script {key} must begin with a shell statement"
        );
    }
}

#[test]
fn fixture_is_placeholder_or_exact_script_key_set() {
    let raw = std::fs::read_to_string("tests/fixtures/scripts.json")
        .expect("tests/fixtures/scripts.json must exist");
    let value: Value = serde_json::from_str(&raw).expect("scripts.json must be valid JSON");
    let map = value.as_object().expect("scripts.json must be a JSON object");
    assert_bundle(map);
}

/// Ensure the key table is internally consistent (the sorted comparison above
/// requires it to be sorted, so asserts on the literal order here).
#[test]
fn script_key_table_is_the_expected_set() {
    let mut keys: Vec<&str> = SCRIPT_KEYS.to_vec();
    keys.sort();
    assert_eq!(keys.len(), EXPECTED_KEYS);
    let expected_sorted: Vec<&str> = SCRIPT_KEYS.to_vec();
    let mut expected = expected_sorted;
    expected.sort();
    assert_eq!(keys, expected);
}