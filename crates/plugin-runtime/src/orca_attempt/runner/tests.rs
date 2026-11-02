#![allow(clippy::unwrap_used)]
use super::*;
use std::process::{Command, Stdio};

#[test]
fn configured_resolution_matches_actual_typescript_for_defaults_aliases_and_endpoints() {
    let ids = [
        "codex",
        "codex#main",
        "codex#main@local",
        "codex#named",
        "codex#main@box",
        "codex@box",
        "alias",
        "broken-alias",
        "endpoint",
        "opencode#endpoint",
        "opencode",
        "unknown",
        "CODEX",
        "codex\n",
        "codex#main@box@extra",
    ];
    let mut cases = Vec::new();
    for second in [false, true] {
        for home in [Value::Null, json!(""), json!("/named")] {
            for orca in [Value::Null, json!(""), json!("folder")] {
                let mut strategy = json!({
                    "runners":{"codex":{"id":"codex","account":"main"},"codex#named":{"id":"codex#named","account":"named"},"codex@box":{"id":"codex@box","account":"main"},"opencode#endpoint":{"id":"opencode#endpoint","account":"endpoint"}},
                    "runnerAliases":{"alias":"codex","broken-alias":"missing"},
                    "accounts":{"main":{"name":"main","kind":"codex","home":home,"orcaAccount":orca},"named":{"name":"named","kind":"codex","home":"/named"},"endpoint":{"name":"endpoint","kind":"endpoint"}}
                });
                if second {
                    strategy["accounts"]["second"] = json!({"name":"second","kind":"codex"});
                }
                for id in ids {
                    cases.push(json!({"strategy":strategy,"id":id}));
                }
            }
        }
    }
    let script = "const {resolveRunner,parseRunnerId}=await import('./src/config/runner-id.ts');console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()).map(c=>[resolveRunner(c.strategy,c.id),parseRunnerId(c.id)])));";
    let mut child = Command::new("bun")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .args(["-e", script])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        json!(cases).to_string().as_bytes(),
    )
    .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: Vec<Value> = serde_json::from_slice(&output.stdout).unwrap();
    for (case, want) in cases.iter().zip(expected) {
        let id = case["id"].as_str().unwrap();
        assert_eq!(
            resolve_runner(&case["strategy"], id)
                .cloned()
                .unwrap_or(Value::Null),
            want[0],
            "{case}"
        );
        let parsed = parse_runner_id(id)
            .map(|r| json!({"agent":r.agent,"account":r.account,"host":r.host}))
            .unwrap_or(Value::Null);
        assert_eq!(parsed, want[1], "{case}");
    }
}
#[test]
fn missing_source_is_explicit_and_loaded_missing_account_keeps_its_error() {
    let missing = OrcaStrategySource::Missing {
        message: "original missing strategy path".into(),
    };
    for id in ["codex", "codex@box", "unknown#account", "codex#bad#extra"] {
        assert!(
            account(&Value::Null, &json!({"id":id}), &missing)
                .unwrap()
                .is_none()
        );
    }
    assert!(
        account(
            &Value::Null,
            &json!({"id":"codex#work","via":"opencode"}),
            &missing
        )
        .unwrap()
        .is_none()
    );
    assert_eq!(
        account(&Value::Null, &json!({"id":"codex#work"}), &missing)
            .unwrap_err()
            .to_string(),
        BrokerError::Effect("original missing strategy path".into()).to_string()
    );
    for strategy in [Value::Null, json!({})] {
        assert!(
            account(
                &strategy,
                &json!({"id":"codex"}),
                &OrcaStrategySource::Loaded
            )
            .unwrap_err()
            .to_string()
            .contains("runner not configured: codex")
        );
    }
    assert!(
        account(
            &json!({"runners":{"codex":{"account":"absent"}}}),
            &json!({"id":"codex"}),
            &OrcaStrategySource::Loaded
        )
        .unwrap_err()
        .to_string()
        .contains("account not configured: absent")
    );
}

#[test]
fn provider_environment_reference_distinguishes_missing_loaded_and_invalid_strategy() {
    let raw=json!({"planner":"claude-code","accounts":{"plan":{"kind":"claude"},"personal":{"kind":"codex"},"named":{"kind":"codex","home":"/named"}},"runners":{"codex":{},"codex#named":{}},"routing":[{"default":["codex"]}]}).to_string();
    let cases = json!([
        {"provider":{"id":"codex"}},
        {"provider":{"id":"codex#named"}},
        {"provider":{"id":"codex#named","via":"opencode"}},
        {"provider":{"id":"unknown#named"}},
        {"source":raw,"provider":{"id":"codex"}},
        {"source":raw,"provider":{"id":"codex#personal@local"}},
        {"source":raw,"provider":{"id":"codex#named"}},
        {"source":raw,"provider":{"id":"codex#absent"}},
        {"source":"not: [valid","provider":{"id":"codex"}}
    ]);
    let mut child = Command::new("bun")
        .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .arg("test/fixtures/orca-text-parity.ts")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::io::Write::write_all(
        &mut child.stdin.take().unwrap(),
        json!({"mode":"provider","cases":cases})
            .to_string()
            .as_bytes(),
    )
    .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let out: Vec<Value> = serde_json::from_slice(&out.stdout).unwrap();
    for i in [0, 2, 3, 4, 5] {
        assert_eq!(out[i], json!({"env":{}}), "case{i}");
    }
    assert_eq!(out[1]["name"], "MissingStrategyError");
    assert_eq!(out[6], json!({"env":{"CODEX_HOME":"/named"}}));
    assert_eq!(out[7]["error"], "runner not configured: codex#absent");
    assert_eq!(out[8]["name"], "StrategyError");
    // The constructor receives an already-loaded policy or a genuine Missing
    // source; arbitrary loader errors have no fallback carrier in this API.
    let source = OrcaStrategySource::Missing {
        message: out[1]["error"].as_str().unwrap().into(),
    };
    assert!(
        account(&Value::Null, &cases[1]["provider"], &source)
            .unwrap_err()
            .to_string()
            .contains(out[1]["error"].as_str().unwrap())
    );
}
