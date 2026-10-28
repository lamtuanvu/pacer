#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn plugin_decision_and_agent_session_methods_have_their_own_generated_areas() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let schema = root.join("docs/plugin-protocol.schema.json");
    let area = |name: &str| {
        xtask::generate_for(
            &schema,
            &root.join(format!("crates/{name}/src/generated.rs")),
        )
        .unwrap()
    };
    let core = area("plugin-protocol");
    let decision = area("plugin-decision-protocol");
    let session = area("plugin-agent-session-protocol");
    assert!(core.contains("pub struct Manifest"));
    assert!(core.contains("pub struct UiRenderParams"));
    assert!(!core.contains("pub struct DecisionDecideParams"));
    assert!(!core.contains("pub struct AgentSessionPrepareParams"));
    assert!(decision.contains("pub struct DecisionDecideParams"));
    assert!(!decision.contains("pub struct Manifest"));
    assert!(!decision.contains("pub struct AgentSessionPrepareParams"));
    assert!(session.contains("pub struct AgentSessionPrepareParams"));
    assert!(!session.contains("pub struct DecisionDecideParams"));
    for code in [&core, &decision, &session] {
        assert!(code.contains("pub const VERSION: &str = \"1.2.0\";"));
        assert!(code.lines().count() <= 10_000, "CRATE-3 generated budget");
    }
}
