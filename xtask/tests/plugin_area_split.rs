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
    let install = area("plugin-install-protocol");
    assert!(install.contains("pub struct PlannerInstallParams") || install.contains("pub enum PlannerInstallParams"));
    assert!(!core.contains("PlannerInstallParams"));
    assert!(core.contains("pub struct Manifest"));
    assert!(core.contains("pub struct UiRenderParams"));
    assert!(!core.contains("pub struct DecisionDecideParams"));
    assert!(!core.contains("pub struct AgentSessionPrepareParams"));
    assert!(decision.contains("pub struct DecisionDecideParams"));
    assert!(!decision.contains("pub struct Manifest"));
    assert!(!decision.contains("pub struct AgentSessionPrepareParams"));
    assert!(session.contains("pub struct AgentSessionPrepareParams"));
    assert!(!session.contains("pub struct DecisionDecideParams"));
    let version = core
        .lines()
        .find(|line| line.starts_with("pub const VERSION: &str ="))
        .expect("entry crate declares the protocol version");
    for code in [&core, &decision, &session, &install] {
        assert!(
            code.contains(version),
            "every area carries the entry crate's protocol version"
        );
        // CRATE-3 counts generated code lines as `cargo xtask loc` does: no blank or comment lines.
        let lines = code
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("//"))
            .count();
        assert!(lines <= 10_000, "CRATE-3 generated budget: {lines} code lines");
    }
}
