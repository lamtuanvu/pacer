#![allow(clippy::unwrap_used)]

use pacer_config::strategy::{
    StrategyError, list_strategy_reads, load_strategy, migrate_strategy, show_strategy,
    validate_strategy,
};
use serde_json::json;
use std::fs;

#[test]
fn legacy_defaults_and_errors_match_strategy_contract() {
    let path = std::path::Path::new("/x.yaml");
    let raw = json!({"planner":"claude-code","providers":{"claude-code":{},"codex":{},"cursor":{"cooldown":"6h"},"local":{"via":"opencode","model":"ollama/qwen","usage":"unmetered"}},"routing":[{"default":["codex","local"]}]});
    let s = validate_strategy(&raw, path, "default").unwrap();
    assert_eq!(
        s["pacing"],
        json!({"policy":"priority","order":["codex","cursor","opencode"],"plannerReserve":15,"plannerReserveHeadroom":25,"plannerProbe":"ask","aheadThreshold":10,"behindThreshold":-10,"accounts":"spread","balance":"off","fillThreshold":90})
    );
    assert_eq!(s["providers"]["cursor"]["cooldownS"], 21600);
    assert_eq!(
        s["routing"],
        json!([{"kinds":null,"executors":["codex","opencode#local"]}])
    );
    let bad = json!({"planner":"gemini","providers":{"cursor":{"usage":"quota"},"ollama":{"model":"llama"},"meter":{"via":"opencode","model":"x/y","usage":"metered"}},"pacing":{"policy":"fastest"},"routing":[{"kinds":["tests","dance"],"executors":["nobody"]}]});
    let Err(StrategyError::Invalid { problems, .. }) = validate_strategy(&bad, path, "default")
    else {
        panic!("expected strategy error")
    };
    assert!(
        problems
            .iter()
            .any(|p| p.contains("planner must be one of"))
    );
    assert!(
        problems
            .iter()
            .any(|p| p.contains("providers.cursor: quota usage"))
    );
    assert!(
        problems
            .iter()
            .any(|p| p.contains("unknown kind \"dance\""))
    );
    assert!(
        problems
            .iter()
            .any(|p| p.contains("unknown provider \"nobody\""))
    );
}

#[test]
fn modern_accounts_derive_sources_runners_and_aliases() {
    let raw = json!({"accounts":{"claude":{"kind":"claude"},"work":{"kind":"codex","home":"~/.codex-work"},"team":{"kind":"codex","orca_account":"team-id"},"endpoint":{"kind":"endpoint","usage":"quota","quota_source":"arkcli"},"local":{"kind":"endpoint","usage":"unmetered"}},"planner":{"agent":"claude-code","account":"claude"},"runners":{"work":{"agent":"codex","account":"work"},"seed":{"agent":"opencode","account":"endpoint","model":"coding-plan/seed"},"local":{"agent":"opencode","account":"local","model":"ollama/qwen3"}}});
    let s = validate_strategy(&raw, std::path::Path::new("strategy.yaml"), "default").unwrap();
    assert_eq!(s["accounts"]["work"]["source"], "pacer");
    assert_eq!(s["accounts"]["team"]["source"], "orca");
    assert_eq!(
        s["providers"]["opencode#endpoint"]["model"],
        "coding-plan/seed"
    );
    assert_eq!(
        s["pacing"]["order"],
        json!([
            "claude-code",
            "codex#work",
            "opencode#endpoint",
            "opencode#local"
        ])
    );
}

#[test]
fn plugin_dispatch_and_messaging_sections_normalize_and_reject_unknown_keys() {
    let path = std::path::Path::new("strategy.yaml");
    let base = json!({"planner":"codex","providers":{"codex":{}}});
    let mut raw = base.clone();
    raw["plugins"] = json!({"policy":{"mode":"closed"},"disabled":["pacer-usage"],"installed":{"acme":{"version":"1.2.0","capabilities":["tasks.read"],"policy":true}},"config":{"acme":{"region":"eu"}}});
    raw["dispatch"] = json!({});
    raw["messaging"] = json!({"rules":[{"effect":"deny","from_kind":"external"}]});
    let parsed = validate_strategy(&raw, path, "default").unwrap();
    assert_eq!(parsed["plugins"]["policy"]["mode"], "closed");
    assert_eq!(parsed["dispatch"]["steps"][0]["capacity"], "comfortable");
    assert_eq!(parsed["messaging"]["message"]["max_bytes"], 65536);
    raw["dispatch"] = json!({"engine":"remote","hidden":true});
    raw["messaging"] = json!({"hidden":true});
    let Err(StrategyError::Invalid { problems, .. }) = validate_strategy(&raw, path, "default")
    else {
        panic!("expected section errors")
    };
    assert!(problems.contains(&"Invalid dispatch configuration".into()));
    assert!(problems.contains(&"messaging: Invalid messaging configuration".into()));
}

#[test]
fn hosts_preserve_defaults_and_report_unknown_keys() {
    let path = std::path::Path::new("strategy.yaml");
    let mut raw = json!({"planner":"codex","providers":{"codex":{}},"hosts":{"build":{"ssh":"worker-1","repos":{"github.com/org/repo":"/srv/repo"},"accounts":{"work":{"home":"/srv/codex"}}}}});
    let s = validate_strategy(&raw, path, "default").unwrap();
    assert_eq!(s["hosts"]["build"]["maxTasks"], 2);
    assert_eq!(s["hosts"]["build"]["paused"], false);
    raw["hosts"]["build"]["extra"] = json!(true);
    let Err(StrategyError::Invalid { problems, .. }) = validate_strategy(&raw, path, "default")
    else {
        panic!("expected host error")
    };
    assert!(problems.contains(&"hosts.build: unknown key extra".into()));
}

#[test]
fn runner_model_declarations_normalize_and_reject_duplicates() {
    let mut raw = json!({"planner":"claude-code","accounts":{"claude-code":{"kind":"claude"},"codex":{"kind":"codex"}},"runners":{"codex":{"models":[{"id":"provider/a","tier":"medium"}]}}});
    let path = std::path::Path::new("strategy.yaml");
    let s = validate_strategy(&raw, path, "default").unwrap();
    assert_eq!(
        s["runners"]["codex"]["models"],
        json!([{"id":"provider/a","tier":"medium","strengths":[]}])
    );
    raw["runners"]["codex"]["models"] = json!([{"id":"x"},{"id":"x"}]);
    assert!(validate_strategy(&raw, path, "default").is_err());
}

#[test]
fn repository_example_loads_with_legacy_provider_order() {
    let text = include_str!("../../../examples/strategy.yaml");
    let raw = pacer_config::doc::parse_value(text).unwrap();
    let s = validate_strategy(
        &raw,
        std::path::Path::new("examples/strategy.yaml"),
        "default",
    )
    .unwrap();
    assert_eq!(
        s["providers"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>()
            .len(),
        6
    );
}

#[test]
fn named_reads_keep_yaml_and_isolate_invalid_entries() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    assert!(matches!(
        load_strategy(home),
        Err(StrategyError::Missing(_))
    ));
    fs::create_dir(home.join("strategies")).unwrap();
    let yaml = "# A work plan\nplanner: codex\nproviders:\n  codex: {}\n";
    fs::write(home.join("strategy.yaml"), yaml).unwrap();
    fs::write(home.join("strategies/work.yaml"), yaml).unwrap();
    fs::write(home.join("strategies/broken.yaml"), "planner: [oops\n").unwrap();
    assert_eq!(show_strategy(home, "work").unwrap()["yaml"], yaml);
    assert_eq!(show_strategy(home, "work").unwrap()["active"], false);
    fs::write(home.join("active"), "work\n").unwrap();
    assert_eq!(load_strategy(home).unwrap()["name"], "work");
    assert_eq!(show_strategy(home, "work").unwrap()["active"], true);
    let list = list_strategy_reads(home).unwrap();
    assert_eq!(list[0]["name"], "default");
    assert_eq!(
        list[1],
        json!({"name":"broken","active":false,"summary":"Invalid or missing strategy","description":""})
    );
    assert_eq!(list[2]["description"], "A work plan");
}

#[test]
fn migration_preserves_a_backup_and_refuses_conflicting_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    let before = "# a note\nplanner: codex\nproviders:\n  codex: {usage: quota}\n";
    fs::write(&path, before).unwrap();
    let result = migrate_strategy(&path, Some(before)).unwrap();
    assert!(result.changed);
    assert!(
        pacer_config::strategy::migration_lines(&path, &result)
            .last()
            .unwrap()
            .starts_with("Restore: cp '")
    );
    assert_eq!(fs::read_to_string(result.backup.unwrap()).unwrap(), before);
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "# a note\nplanner: codex\naccounts:\n  codex: { usage: quota, kind: codex }\npacing: { order: [ codex ] }\nrouting: [ { default: [ codex ] } ]\n"
    );
    assert!(!migrate_strategy(&path, None).unwrap().changed);
    fs::write(&path, before).unwrap();
    fs::write(format!("{}.pre-accounts.bak", path.display()), "foreign").unwrap();
    assert!(
        migrate_strategy(&path, None)
            .unwrap_err()
            .to_string()
            .contains("backup already exists")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}

#[test]
fn migration_keeps_legacy_references_and_comments() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("strategy.yaml");
    let before = "# starter shape\nplanner: claude-code # planning account\nproviders:\n  # Claude budget\n  claude-code: {usage: quota}\n  codex: {usage: quota, allow_paid: false} # no paid fallback\n  local: {via: opencode, model: ollama/qwen3, usage: unmetered}\npacing: {policy: priority, order: [codex, opencode]}\nrouting:\n  - default: [codex, local]\n";
    fs::write(&path, before).unwrap();
    let old = validate_strategy(
        &pacer_config::doc::parse_value(before).unwrap(),
        &path,
        "default",
    )
    .unwrap();
    migrate_strategy(&path, None).unwrap();
    let after = fs::read_to_string(&path).unwrap();
    let new = validate_strategy(
        &pacer_config::doc::parse_value(&after).unwrap(),
        &path,
        "default",
    )
    .unwrap();
    assert_eq!(new["accounts"], old["accounts"]);
    assert_eq!(new["runners"], old["runners"]);
    assert_eq!(new["pacing"], old["pacing"]);
    assert_eq!(new["routing"], old["routing"]);
    assert_eq!(after.matches("# Claude budget").count(), 1);
    assert!(after.contains("# no paid fallback"));
}

#[test]
fn migration_accepts_flow_and_alias_provider_shapes() {
    for before in [
        "planner: codex\nproviders:\n  claude-code: &quota {usage: quota, allow_paid: true}\n  codex: *quota\n",
        "planner: codex\nproviders: {codex: {usage: quota}, local: {via: opencode, model: ollama/qwen3, usage: unmetered}} # budgets\n",
        "{planner: codex, providers: {codex: {usage: quota}}}\n",
        "planner: codex\nproviders:\n  codex: {usage: quota, model: 123}\n",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("strategy.yaml");
        fs::write(&path, before).unwrap();
        let old = validate_strategy(
            &pacer_config::doc::parse_value(before).unwrap(),
            &path,
            "default",
        )
        .unwrap();
        migrate_strategy(&path, None).unwrap();
        let after = fs::read_to_string(&path).unwrap();
        let new = validate_strategy(
            &pacer_config::doc::parse_value(&after).unwrap(),
            &path,
            "default",
        )
        .unwrap();
        assert_eq!(new["accounts"], old["accounts"], "{after}");
        assert_eq!(new["providers"], old["providers"], "{after}");
    }
}
