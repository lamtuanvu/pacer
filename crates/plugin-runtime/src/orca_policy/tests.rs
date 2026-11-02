#![allow(clippy::unwrap_used)]
use super::*;
#[test]
fn numeric_runner_identity_uses_js_numbers_without_signaling() {
    for raw in ["1234", "1234.0", "1.234e3", "2147483647.0"] {
        let value: Value = serde_json::from_str(raw).unwrap();
        assert_eq!(
            runner_pid(&value),
            Some(if raw.starts_with("2147") {
                i32::MAX
            } else {
                1234
            }),
            "{raw}"
        );
    }
    for raw in [
        "0",
        "-0",
        "-1",
        "1.1",
        "2147483648",
        "9007199254740992",
        "null",
        "true",
        "\"1234\"",
    ] {
        assert_eq!(
            runner_pid(&serde_json::from_str(raw).unwrap()),
            None,
            "{raw}"
        );
    }
}

#[test]
fn active_task_uses_numeric_identity_and_original_root_rules_with_injected_probe() {
    let top = std::env::temp_dir().join(format!("pacer-pid-preview-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&top).unwrap();
    let top = top.to_str().unwrap();
    for raw in ["1234", "1234.0", "1.234e3"] {
        let task = json!({"id":"other","runnerPid":serde_json::from_str::<Value>(raw).unwrap(),"brief":{"repo":top}});
        assert!(active_task_at(&task, &json!("current"), top, |pid| {
            assert_eq!(pid, 1234);
            true
        }));
        assert!(!active_task_at(&task, &json!("current"), top, |_| false));
        assert!(!active_task_at(&task, &json!("other"), top, |_| panic!(
            "current task must not probe"
        )));
        let other = json!({"id":"other","runnerPid":1234.0,"worktree":format!("{top}-sibling")});
        assert!(!active_task_at(&other, &json!("current"), top, |_| true));
    }
    let task = json!({"id":"other","runnerPid":0,"brief":{"repo":top}});
    assert!(!active_task_at(&task, &json!("current"), top, |_| panic!(
        "invalid PID must not probe"
    )));
    std::fs::remove_dir(top).unwrap();
}
