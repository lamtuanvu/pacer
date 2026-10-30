#![allow(clippy::unwrap_used)]
use std::path::Path;

#[test]
fn policy_observations_are_a_separate_generated_area_without_moving_lifecycle_types() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let schema = root.join("docs/plugin-protocol.schema.json");
    let core = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-protocol/src/generated.rs"),
    )
    .unwrap();
    let policy = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-policy-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(core.contains("pub struct CallMetadata"));
    assert!(core.contains("pub struct CallMetadataCapabilityCall("));
    assert!(policy.contains("pub enum PluginMetadata"));
    assert!(policy.contains("for PluginMetadata {"));
    assert!(policy.contains("expected exactly one reserved authority key"));
    assert!(!core.contains("expected exactly one reserved authority key"));
    assert!(core.contains("pub struct HelloParams"));
    assert!(!core.contains("pub enum PolicyBeforeParams"));
    assert!(policy.contains("pub enum PolicyBeforeParams"));
    assert!(policy.contains("pub struct CapabilityTasksReadParams"));
    assert!(!policy.contains("pub struct CallMetadata"));
    assert!(!policy.contains("pub struct HelloParams"));
}
