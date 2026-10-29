#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn round_trips_a_delegate_request() {
    let value = serde_json::json!({ "goal": "x", "repo": "/tmp/r" });
    let params: pacer_task_protocol::TaskDelegateParams = serde_json::from_value(value).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap()["goal"], "x");
}

#[test]
fn send_requires_a_message() {
    let ok = serde_json::json!({ "id": "t-123", "text": "keep going" });
    let params: pacer_task_protocol::TaskSendParams = serde_json::from_value(ok.clone()).unwrap();
    assert_eq!(serde_json::to_value(params).unwrap(), ok);
    let empty = serde_json::json!({ "id": "t-123", "text": "" });
    assert!(serde_json::from_value::<pacer_task_protocol::TaskSendParams>(empty).is_err());
}
