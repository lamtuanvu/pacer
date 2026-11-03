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

#[test]
fn exact_placement_reason_matches_actual_typescript_utf16_trim_and_prefix() {
    use std::io::Write;
    let spaces = [
        0x9, 0xa, 0xb, 0xc, 0xd, 0x20, 0xa0, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f,
        0x205f, 0x3000, 0xfeff, 0x85, 0x180e, 0x200b, 0x2060,
    ];
    let mut records = Vec::new();
    for requested in ["current", "new", "auto"] {
        for space in spaces {
            for middle in [
                vec![],
                vec![0xd800],
                vec![0xfffd],
                vec![0xdc01, 0x20, 0xd800],
                vec![0xd83d, 0xde00],
            ] {
                let units = [vec![space], middle, vec![space]].concat();
                let mut task = WireReply::new(
                    json!({"brief":{},"placement":{"requested":requested,"reason":""}}),
                );
                task.set_string("/placement/reason", crate::Utf16String::from_units(units))
                    .unwrap();
                records.push(task.to_json().unwrap());
            }
        }
        records.push(json!({"brief":{},"placement":{"requested":requested}}).to_string());
        records.push(
            json!({"brief":{},"placement":{"requested":requested,"reason":null}}).to_string(),
        );
    }
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/tasks/types.ts");
    let script = r#"const {resolvePlacement}=await import(Bun.argv.at(-1));const rows=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify(rows.map(raw=>JSON.stringify(resolvePlacement(JSON.parse(raw),'current',false,false)))));"#;
    let mut child = std::process::Command::new("bun")
        .args(["-e", script, source.to_str().unwrap()])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(serde_json::to_string(&records).unwrap().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    let expected: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(records.len(), expected.len());
    for (record, expected) in records.iter().zip(expected) {
        let actual =
            resolve_placement_wire(&WireReply::parse(record).unwrap(), "current", false, false)
                .unwrap();
        let expected = WireReply::parse(&expected).unwrap();
        assert_eq!(
            actual.preview()["mode"],
            expected.preview()["mode"],
            "{record}"
        );
        assert_eq!(
            actual.string_at("/why").unwrap().units(),
            expected.string_at("/why").unwrap().units(),
            "{record}"
        );
    }
}
