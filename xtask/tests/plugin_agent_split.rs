#![allow(clippy::unwrap_used)]
use std::path::Path;

#[test]
fn agent_session_and_native_types_have_an_independent_generated_area() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let schema = root.join("docs/plugin-protocol.schema.json");
    let core = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-protocol/src/generated.rs"),
    )
    .unwrap();
    let agent = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-agent-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(core.contains("pub struct CallMetadata"));
    assert!(core.contains("pub struct HelloParams"));
    assert!(!core.contains("pub struct AgentSessionPrepareParams"));
    assert!(agent.contains("pub struct AgentSessionPrepareParams"));
    assert!(agent.contains("pub enum AgentSessionIdentityResult"));
    assert!(!agent.contains("pub struct CallMetadata"));
    assert!(!agent.contains("pub struct HelloParams"));
    let dispatch = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-dispatch-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(dispatch.contains("pub struct ObservationObserveParams"));
    assert!(dispatch.contains("pub struct DecisionDecideParams"));
    assert!(!core.contains("pub struct ObservationObserveParams"));
    assert!(!core.contains("pub struct DecisionDecideParams"));
    assert!(!dispatch.contains("pub struct AgentSessionPrepareParams"));
    assert!(!dispatch.contains("pub struct CallMetadata"));
    for area in [core, agent, dispatch] {
        let lines = area
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim().starts_with("//"))
            .count();
        assert!(lines <= 10_000, "area generated code has {lines} lines");
    }
}

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
        |name: &str| name.starts_with("observation.") || name.starts_with("decision."),
        |name: &str| name.starts_with("hostRunner.") || name.starts_with("capability.hosts."),
    ] {
        for (name, value) in defs {
            if includes(name) {
                visit(value, includes);
            }
        }
    }
}

#[test]
fn host_runner_and_host_capabilities_have_an_independent_generated_area() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let schema = root.join("docs/plugin-protocol.schema.json");
    let core = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-protocol/src/generated.rs"),
    )
    .unwrap();
    let hosts = xtask::generate_for(
        &schema,
        &root.join("crates/plugin-hosts-protocol/src/generated.rs"),
    )
    .unwrap();
    assert!(core.contains("pub struct CallMetadata"));
    assert!(!core.contains("pub struct HostRunnerOpenParams"));
    assert!(!core.contains("pub struct CapabilityHostsRunParams"));
    assert!(hosts.contains("pub struct HostRunnerOpenParams"));
    assert!(hosts.contains("pub struct CapabilityHostsRunParams"));
    assert!(!hosts.contains("pub struct CallMetadata"));
    for area in [core, hosts] {
        let lines = area
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.trim().starts_with("//"))
            .count();
        assert!(lines <= 10_000, "area generated code has {lines} lines");
    }
}
