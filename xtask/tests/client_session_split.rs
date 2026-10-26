#![allow(clippy::unwrap_used, clippy::expect_used)]
use std::path::Path;

#[test]
fn client_protocol_keeps_session_types_in_their_own_generated_crate() {
    let schema = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/protocol.schema.json");
    let code = xtask::generate(&schema).unwrap();
    assert!(code.contains("pub struct TaskDelegateParams"));
    assert!(!code.contains("pub struct SessionCreateParams"));
    let out = schema
        .parent()
        .unwrap()
        .join("../crates/session-protocol/src/generated.rs");
    let sessions = xtask::generate_for(&schema, &out).unwrap();
    assert!(sessions.contains("pub struct SessionCreateParams"));
    assert!(!sessions.contains("pub struct TaskDelegateParams"));
}

#[test]
fn client_controls_have_their_own_generated_area_without_expanding_the_core_crate() {
    let schema = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/protocol.schema.json");
    let core = xtask::generate(&schema).unwrap();
    assert!(!core.contains("pub struct ClientControlRequestParams"));
    assert!(!core.contains("pub struct ApiDescribeParams"));
    let output = schema
        .parent()
        .unwrap()
        .join("../crates/client-control-protocol/src/generated.rs");
    let controls = xtask::generate_for(&schema, &output).unwrap();
    assert!(controls.contains("pub struct ClientControlRequestParams"));
    assert!(controls.contains("pub struct ApiDescribeParams"));
    assert!(!controls.contains("pub struct TaskDelegateParams"));
    assert!(!controls.contains("pub struct SessionCreateParams"));
}

#[test]
fn terminal_operations_have_their_own_generated_area() {
    let schema = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/protocol.schema.json");
    let core = xtask::generate(&schema).unwrap();
    assert!(!core.contains("pub struct TerminalCreateParams"));
    assert!(!core.contains("pub struct HostTerminalParams"));
    let output = schema
        .parent()
        .unwrap()
        .join("../crates/terminal-protocol/src/generated.rs");
    let terminal = xtask::generate_for(&schema, &output).unwrap();
    assert!(terminal.contains("pub struct TerminalCreateParams"));
    assert!(terminal.contains("pub struct HostTerminalParams"));
    assert!(!terminal.contains("pub struct TaskDelegateParams"));
}
