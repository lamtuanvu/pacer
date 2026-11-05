#![allow(clippy::unwrap_used)]
use super::*;
use crate::parse_manifest;

fn manifest() -> ParsedManifest {
    parse_manifest(serde_json::json!({"id":"fx-good","version":"1.0.0","publisher":"fixture","host":">=1.6.0","contributes":{"usage":{}}})).unwrap()
}

#[test]
fn shadow_never_starts_a_second_host() {
    let mut registry = Registry::shadow();
    registry.insert(manifest(), false, true);
    assert_eq!(registry.mode(), HostMode::Shadow);
    assert!(matches!(
        registry.prepare_native(),
        Err(RegistryError::TypeScriptOwnsHost)
    ));
    assert!(matches!(
        registry.start("fx-good", 0),
        Err(RegistryError::TypeScriptOwnsHost)
    ));
    assert_eq!(registry.get("fx-good").unwrap().state, PluginState::Idle);
    assert_eq!(
        registry.plugin_states(),
        vec![("fx-good".into(), PluginState::Idle)]
    );
}

#[test]
fn crash_window_backoff_and_enable_match_ts() {
    let mut registry = Registry::shadow();
    registry.insert(manifest(), false, true);
    registry.crash("fx-good", 100).unwrap();
    assert_eq!(registry.get("fx-good").unwrap().next_start_at, 1100);
    registry.crash("fx-good", 200).unwrap();
    assert_eq!(registry.get("fx-good").unwrap().next_start_at, 2200);
    registry.crash("fx-good", 300).unwrap();
    assert_eq!(registry.get("fx-good").unwrap().state, PluginState::Failing);
    registry.enable("fx-good").unwrap();
    assert_eq!(registry.get("fx-good").unwrap().state, PluginState::Idle);
}

#[test]
fn handshake_filters_claims_and_negotiates_features() {
    let mut registry = Registry::shadow();
    registry.insert(manifest(), false, true);
    registry.entries.get_mut("fx-good").unwrap().state = PluginState::Starting;
    let hello: HelloResult = serde_json::from_value(serde_json::json!({
        "protocol":"1.10.0", "id":"fx-good", "version":"1.0.0",
        "contributes":["usage","policy"], "features":["chunkedResults","policyRedactionMetadata","unknown"]
    })).unwrap();
    registry.handshake("fx-good", hello).unwrap();
    let entry = registry.get("fx-good").unwrap();
    assert_eq!(entry.state, PluginState::Ready);
    assert_eq!(entry.served, ["diagnostic", "usage"]);
    assert_eq!(
        entry.features,
        ["chunkedResults", "policyRedactionMetadata"]
    );
}
