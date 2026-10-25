#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::path::Path;

#[test]
fn plugin_protocol_shares_validators_without_erasing_public_types() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let code = xtask::generate(&root.join("docs/plugin-protocol.schema.json")).unwrap();
    assert!(
        code.contains("fn validate_string_"),
        "repeated validators should share implementation"
    );
    assert!(code.contains("pub struct AgentSessionAttachmentParamsAgent("));
    assert!(code.contains("pub struct AgentSessionPrepareParamsAgent("));
    assert!(!code.contains("pub type AgentSessionPrepareParamsAgent"));
    let lines = code
        .lines()
        .filter(|line| {
            let line = line.trim();
            !line.is_empty() && !line.starts_with("//")
        })
        .count();
    assert!(lines <= 10_000, "plugin generated code has {lines} lines");
}
