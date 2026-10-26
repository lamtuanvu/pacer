#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn limits_parameters_have_their_own_generated_area() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let schema = root.join("docs/protocol.schema.json");
    let client = xtask::generate_for(
        &schema,
        &root.join("crates/client-protocol/src/generated.rs"),
    )
    .unwrap();
    let limits = xtask::generate_for(
        &schema,
        &root.join("crates/limits-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(!client.contains("pub struct LimitsRefreshParams"));
    assert!(limits.contains("pub struct LimitsRefreshParams"));
    assert!(!limits.contains("pub struct AccountAddParams"));
}
