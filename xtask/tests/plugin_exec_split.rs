#![allow(clippy::unwrap_used)]
use std::path::Path;

fn in_exec_area(name: &str) -> bool {
    name.starts_with("executor.") || name.starts_with("capability.process.") ||
        name.starts_with("capability.worktree.")
}

#[test]
fn process_and_executor_types_have_an_independent_bounded_area() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let schema = root.join("docs/plugin-protocol.schema.json");
    let core = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-protocol/src/generated.rs"),
    )
    .unwrap();
    let execution = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-exec-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(core.contains("pub struct CallMetadata"));
    assert!(!core.contains("pub struct CapabilityProcessSpawnParams"));
    assert!(!core.contains("pub struct ExecutorAvailableParams"));
    assert!(!core.contains("pub struct CapabilityWorktreeInspectParams"));
    assert!(execution.contains("pub struct CapabilityProcessSpawnParams"));
    assert!(execution.contains("pub struct ExecutorAvailableParams"));
    assert!(execution.contains("pub struct CapabilityWorktreeInspectParams"));
    assert!(!execution.contains("pub struct CallMetadata"));
    for area in [core, execution] {
        let lines = area
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim().starts_with("//"))
            .count();
        assert!(lines <= 10_000, "area generated code has {lines} lines");
    }
}

#[test]
fn process_and_executor_definitions_have_a_complete_local_schema_closure() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let value: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("docs/plugin-protocol.schema.json")).unwrap(),
    )
    .unwrap();
    let defs = value["$defs"].as_object().unwrap();
    fn visit(value: &serde_json::Value) {
        match value {
            serde_json::Value::Object(object) => {
                if let Some(reference) = object.get("$ref").and_then(|value| value.as_str()) {
                    assert!(
                        reference.strip_prefix("#/$defs/").is_some_and(in_exec_area),
                        "external schema reference {reference}"
                    );
                }
                for value in object.values() {
                    visit(value);
                }
            }
            serde_json::Value::Array(array) => {
                for value in array {
                    visit(value);
                }
            }
            _ => {}
        }
    }
    for (name, value) in defs {
        if in_exec_area(name) {
            visit(value);
        }
    }
}
