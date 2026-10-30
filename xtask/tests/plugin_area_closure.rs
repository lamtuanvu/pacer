#![allow(clippy::unwrap_used)]
use std::path::Path;

#[test]
fn generated_extension_areas_have_complete_local_schema_closures() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let value: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(root.join("docs/plugin-protocol.schema.json")).unwrap(),
    )
    .unwrap();
    let defs = value["$defs"].as_object().unwrap();
    fn visit(value: &serde_json::Value, includes: fn(&str) -> bool) {
        match value {
            serde_json::Value::Object(object) => {
                if let Some(reference) = object.get("$ref").and_then(|value| value.as_str()) {
                    assert!(
                        reference.strip_prefix("#/$defs/").is_some_and(includes),
                        "external schema reference {reference}"
                    );
                }
                for value in object.values() {
                    visit(value, includes);
                }
            }
            serde_json::Value::Array(array) => {
                for value in array {
                    visit(value, includes);
                }
            }
            _ => {}
        }
    }
    for includes in [
        (|name: &str| name.starts_with("agentSession.")) as fn(&str) -> bool,
        |name: &str| name.starts_with("decision."),
        |name: &str| name.starts_with("hostRunner.") || name.starts_with("capability.hosts."),
    ] {
        for (name, value) in defs {
            if includes(name) {
                visit(value, includes);
            }
        }
    }
}
