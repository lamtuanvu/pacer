#![allow(clippy::unwrap_used, clippy::expect_used)]

#[test]
fn dispatch_preview_preserves_requirements() {
    let value = serde_json::json!({"repo": "/tmp/repo", "goal": "Debug", "preferences": {"models": [], "strengths": []}, "requirements": {"tools": true, "minTier": "medium"}});
    let params: pacer_dispatch_protocol::DispatchPreviewParams =
        serde_json::from_value(value).unwrap();
    let result = serde_json::to_value(params).unwrap();
    assert_eq!(result["requirements"]["tools"], true);
    assert_eq!(result["requirements"]["minTier"], "medium");
}
