#![allow(clippy::unwrap_used)]
use super::*;

#[test]
fn claude_canary_correlates_the_denied_tool_result() {
    let output = [
        r#"{"type":"system","subtype":"init","tools":["Agent","Task","Bash"]}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Task"}]}}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"pacer: native subagents are blocked for this managed attempt"}]}}"#,
    ]
    .join("\n");
    let result = observe_claude_canary(&output, "Task");
    assert_eq!(result["attempted"], json!(true));
    assert_eq!(result["blocked"], json!(true));
    assert_eq!(result["childStarted"], json!(false));
}

#[test]
fn claude_canary_rejects_an_uncorrelated_denial() {
    let output = [
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Task"}]}}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"other","is_error":true,"content":"pacer: native subagents are blocked for this managed attempt"}]}}"#,
    ]
    .join("\n");
    let result = observe_claude_canary(&output, "Task");
    assert_eq!(result["attempted"], json!(true));
    assert_eq!(result["blocked"], json!(false));
}

#[test]
fn strict_launch_writes_a_private_settings_file_and_inserts_the_flag() {
    let dir = tempfile::tempdir().unwrap();
    let argv = vec![
        "claude".into(),
        "-p".into(),
        "--".into(),
        "reply canary".into(),
    ];
    let guard = vec!["/pacer".into(), "guard".into()];
    let out = strict_claude_launch(&argv, &guard, dir.path()).unwrap();
    assert_eq!(out[2], "--settings");
    assert_eq!(out[3], dir.path().join("strict-claude-settings.json").to_string_lossy());
    assert_eq!(out[4], "--");
    let text = fs::read_to_string(dir.path().join("strict-claude-settings.json")).unwrap();
    assert!(text.contains("/pacer guard"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.path().join("strict-claude-settings.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
