#![allow(clippy::unwrap_used)]
use std::path::Path;

#[test]
fn workflow_definitions_have_an_independent_generated_area() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let schema = root.join("docs/plugin-protocol.schema.json");
    let core = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-protocol/src/generated.rs"),
    )
    .unwrap();
    let workflow = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-workflow-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(core.contains("pub struct CallMetadata"));
    assert!(core.contains("pub struct ManifestContributesWorkflowKey"));
    assert!(!core.contains("pub struct WorkflowDefinitionsParams"));
    assert!(workflow.contains("pub struct WorkflowDefinitionsParams"));
    assert!(workflow.contains("pub struct WorkflowDefinitionsResult"));
    assert!(!workflow.contains("pub struct CallMetadata"));
    assert!(!workflow.contains("pub struct ManifestContributesWorkflowKey"));
    for area in [core, workflow] {
        let lines = area
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim().starts_with("//"))
            .count();
        assert!(lines <= 10_000, "area generated code has {lines} lines");
    }
}
