#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn session_end_roundtrip_preserves_revision_and_validates_identity() {
    let input = serde_json::json!({"id": "t-123", "expect_rev": 7});
    let params: pacer_session_protocol::SessionEndParams =
        serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), input);
    for invalid in [
        serde_json::json!({"id": "../outside", "expect_rev": 7}),
        serde_json::json!({"id": "t-123", "expect_rev": 0}),
    ] {
        assert!(
            serde_json::from_value::<pacer_session_protocol::SessionEndParams>(invalid).is_err()
        );
    }
}
