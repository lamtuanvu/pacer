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
