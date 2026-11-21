#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn workflow_parameters_have_their_own_generated_area() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let schema = root.join("docs/protocol.schema.json");
    let client = xtask::generate_for(
        &schema,
        &root.join("crates/client-protocol/src/generated.rs"),
    )
    .unwrap();
    let workflow = xtask::generate_for(
        &schema,
        &root.join("crates/workflow-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(!client.contains("pub struct RunStartParams"));
    assert!(!client.contains("pub struct WorkflowAddParams"));
    assert!(workflow.contains("pub struct RunStartParams"));
    assert!(workflow.contains("pub struct WorkflowAddParams"));
    assert!(!workflow.contains("pub struct RunnerAddParams"));
    assert!(!workflow.contains("pub struct SessionCreateParams"));
}
