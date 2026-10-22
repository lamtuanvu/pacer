#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn generated_types_are_fresh() {
    for (schema, out) in xtask::targets() {
        let want = xtask::generate_for(&schema, &out).unwrap();
        let have = std::fs::read_to_string(&out).unwrap();
        assert_eq!(
            want,
            have,
            "{} is stale; run cargo xtask gen",
            out.display()
        );
    }
}

#[test]
fn round_trips_a_delegate_request() {
    let value = serde_json::json!({ "goal": "x", "repo": "/tmp/r" });
    let params: pacer_client_protocol::TaskDelegateParams = serde_json::from_value(value).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap()["goal"], "x");
}
