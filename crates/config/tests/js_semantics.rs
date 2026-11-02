#![allow(clippy::unwrap_used)]

use pacer_config::strategy::{strategy_path, validate_strategy};
use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn set_path(root: &mut Value, path: &str, value: Value) {
    let mut parts = path.split('.').peekable();
    let mut at = root;
    while let Some(part) = parts.next() {
        if parts.peek().is_none() {
            if let Ok(index) = part.parse::<usize>() {
                at[index] = value;
            } else {
                at[part] = value;
            }
            return;
        }
        at = if let Ok(index) = part.parse::<usize>() {
            &mut at[index]
        } else {
            &mut at[part]
        };
    }
}

#[test]
fn numeric_and_string_fields_match_js_validation() {
    let base = json!({"planner":{"agent":"codex","account":"codex"},"accounts":{"codex":{"kind":"codex"}},"hosts":{"build":{"ssh":"worker"}},"runners":{"codex":{"agent":"codex","account":"codex","models":[{"id":"provider/model"}]}},"dispatch":{"steps":[{"id":"one"}],"discovery":{"runners":["runner"]}},"messaging":{"rules":[{"effect":"allow","limits":{}}]}});
    let fields = [
        "task_retention_days",
        "execution.local_max_tasks",
        "hosts.build.max_tasks",
        "runners.codex.max_tasks",
        "runners.codex.models.0.context",
        "dispatch.timeoutMs",
        "dispatch.learning.minSamples",
        "dispatch.learning.maxAgeDays",
        "dispatch.steps.0.require.context",
        "messaging.keep_worktree_days",
        "messaging.message.max_bytes",
        "messaging.tree.max_turns",
        "messaging.liveness.interval_s",
        "messaging.liveness.backoff_max_s",
        "messaging.liveness.max_nudges",
        "messaging.liveness.escalate_after_s",
        "messaging.hooks.stop_release_after",
        "messaging.rules.0.limits.per_minute",
        "messaging.rules.0.limits.max_bytes",
    ];
    let samples = [
        "1",
        "1.0",
        "1e2",
        "1.5",
        "0",
        "9007199254740991",
        "9007199254740992",
    ];
    let mut cases = Vec::new();
    for field in fields {
        for sample in samples {
            let mut row = base.clone();
            set_path(&mut row, field, serde_json::from_str(sample).unwrap());
            cases.push((field.to_owned(), sample.to_owned(), row));
        }
    }
    for (field, sample) in [
        ("terminal.open", "{cmd}é".repeat(400)),
        ("terminal.open", format!("{{cmd}}{}", "😀".repeat(997))),
        ("terminal.open", format!("{{cmd}}{}", "😀".repeat(998))),
        ("hosts.build.accounts.work.home", "\u{feff}".to_owned()),
        ("dispatch.steps.0.id", "é".repeat(256)),
        ("dispatch.steps.0.id", "é".repeat(257)),
        ("dispatch.steps.0.id", "😀".repeat(256)),
        ("dispatch.discovery.runners.0", "😀".repeat(256)),
        ("dispatch.discovery.runners.0", "😀".repeat(257)),
    ] {
        let mut row = base.clone();
        set_path(&mut row, field, json!(sample));
        cases.push((field.to_owned(), "unicode".to_owned(), row));
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let script = r#"import { validateStrategy } from './src/config/strategy.ts';
const rows=JSON.parse(await Bun.stdin.text());
console.log(JSON.stringify(rows.map(row=>{try{validateStrategy(row,'strategy.yaml');return true}catch{return false}})));"#;
    let mut child = Command::new("bun")
        .args(["-e", script])
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            serde_json::to_string(&cases.iter().map(|c| &c.2).collect::<Vec<_>>())
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<bool> = serde_json::from_slice(&output.stdout).unwrap();
    for ((field, sample, row), ts) in cases.iter().zip(expected) {
        let rust = validate_strategy(row, std::path::Path::new("strategy.yaml"), "default").is_ok();
        assert_eq!(rust, ts, "{field} = {sample}");
    }
}

#[test]
fn active_name_uses_exact_js_trim_set() {
    let home = tempfile::tempdir().unwrap();
    let samples = [
        ("\u{feff}work\u{feff}", "work"),
        (
            "\u{00a0}\u{1680}\u{2000}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}work\u{3000}",
            "work",
        ),
        ("\u{0085}work\u{0085}", "\u{0085}work\u{0085}"),
    ];
    for (input, expected) in samples {
        std::fs::write(home.path().join("active"), input).unwrap();
        let (path, name) = strategy_path(home.path()).unwrap();
        assert_eq!(name, expected);
        assert_eq!(
            path,
            home.path()
                .join("strategies")
                .join(format!("{expected}.yaml"))
        );
    }
}
