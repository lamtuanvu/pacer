//! Table invariants for pacer-bundled (M3 C0a). The suite has no `pacer-bundled`
//! crate yet, so it fails until step 4 lands.
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
    // Every row is `run: None` until a port lands.
    for row in TABLE {
        assert!(row.run.is_none(), "{} should still be TypeScript", row.id);
    }
    assert!(native("pacer-notify").is_none());
    assert!(serve_stdio("pacer-notify").is_none());
}

#[test]
fn unknown_id_is_not_served() {
    assert!(serve_stdio("nope").is_none());
    assert!(find("nope").is_none());
}
