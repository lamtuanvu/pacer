//! Table invariants for pacer-bundled (M3 C0a). The suite has no `pacer-bundled`
//! crate yet, so it fails until step 4 lands.
//! Table invariants for the pacer-bundled plugin registry (M3 phase C).
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_bundled::{TABLE, find, native, serve_stdio};
use serde_json::Value;

#[test]
fn table_ids_are_unique_and_match_manifest_ids() {
    let mut ids = std::collections::HashSet::new();
    assert_eq!(TABLE.len(), 12);
    for row in TABLE {
        let manifest: Value =
            serde_json::from_str(row.manifest).expect("rub table manifest must be valid JSON");
        assert!(
            manifest.is_object(),
            "manifest for {} must be an object",
            row.id
        );
        assert_eq!(manifest["id"].as_str(), Some(row.id));
        assert!(ids.insert(row.id), "duplicate bundled id {}", row.id);
    }
}

#[test]
fn manifests_have_the_handshake_fields() {
    for row in TABLE {
        let manifest: Value = serde_json::from_str(row.manifest).expect("valid JSON");
        assert!(manifest["version"].is_string());
        assert!(manifest["publisher"].is_string());
        assert!(manifest["host"].is_string());
        let contributes = &manifest["contributes"];
        assert!(
            contributes.is_object(),
            "{} contributes must be an object",
            row.id
        );
        assert!(!contributes.as_object().expect("object").is_empty());
    }
}

#[test]
fn typescript_rows_are_not_native() {
    // pacer-notify (C1) and pacer-remote-caller (C2) are the ported native
    // rows; the rest are TypeScript until their slices land.
    for row in TABLE {
        let is_native_ported = matches!(row.id, "pacer-notify" | "pacer-remote-caller");
        let is_native = row.run.is_some();
        if is_native_ported {
            assert!(is_native, "{} should now be native", row.id);
        } else {
            assert!(!is_native, "{} should still be TypeScript", row.id);
        }
    }
    assert!(native("pacer-notify").is_some());
    assert!(serve_stdio("pacer-notify").is_some());
    assert!(native("pacer-remote-caller").is_some());
    assert!(serve_stdio("pacer-remote-caller").is_some());
}

#[test]
fn unknown_id_is_not_served() {
    assert!(serve_stdio("nope").is_none());
    assert!(find("nope").is_none());
}
