#![allow(clippy::unwrap_used)]

use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, fs};

fn ctx(dir: &tempfile::TempDir) -> Ctx {
    Ctx::with(
        dir.path().join("home"),
        dir.path().join("pacer"),
        HashMap::new(),
        12345.0,
    )
}
fn golden() -> Value {
    serde_json::from_str(include_str!("../../../test/fixtures/routing-get.json")).unwrap()
}
fn write(ctx: &Ctx, yaml: &str) {
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    fs::write(ctx.pacer_home.join("strategy.yaml"), yaml).unwrap();
}

#[test]
fn simple_read_models_match_typescript_goldens_without_writes() {
    let cases = [
        (
            "basic",
            "# comment\naccounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - default: [codex] # rule\npacing: {order: [codex], policy: priority}\n",
        ),
        (
            "kinds",
            "accounts:\n  personal: {kind: claude}\n  codex: {kind: codex}\nplanner: claude-code\nrouting:\n  - kinds: [docs, tests]\n    executors: [codex]\n  - default: [claude-code]\n",
        ),
        (
            "alias",
            "accounts:\n  team: {kind: codex}\nplanner: codex#team\nrouting:\n  - default: [codex#team]\n",
        ),
    ];
    for (name, yaml) in cases {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        write(&ctx, yaml);
        let before = fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap();
        assert_eq!(pacer_config::routing_get(&ctx).unwrap(), golden()[name]);
        assert_eq!(
            fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap(),
            before
        );
    }
}

#[test]
fn unsupported_or_changed_strategy_stays_with_typescript() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(&dir);
    assert!(pacer_config::requires_core_routing_parser(&ctx));
    let basic = "accounts:\n  personal: {kind: claude}\nplanner: claude-code\nrouting:\n  - default: [claude-code]\n";
    write(&ctx, basic);
    assert!(!pacer_config::requires_core_routing_parser(&ctx));
    for yaml in [
        format!("{basic}hosts: {{box: {{ssh: box, max_tasks: 3}}}}\n"),
        format!("{basic}accounts: {{other: {{kind: codex}}}}\n"),
        "accounts: &accounts {personal: {kind: claude}}\nplanner: claude-code\n".to_owned(),
        "accounts: [bad]\nplanner: claude-code\n".to_owned(),
        "accounts: {téam: {kind: codex}}\nplanner: codex#téam\nrouting: [{default: [codex#téam]}]\n".to_owned(),
    ] {
        write(&ctx, &yaml);
        assert!(pacer_config::requires_core_routing_parser(&ctx), "{yaml}");
        assert!(pacer_config::routing_get(&ctx).is_err());
    }
    write(&ctx, basic);
    fs::write(ctx.pacer_home.join("active"), "../escape\n").unwrap();
    assert!(pacer_config::requires_core_routing_parser(&ctx));
    fs::write(ctx.pacer_home.join("active"), "team\n").unwrap();
    fs::create_dir_all(ctx.pacer_home.join("strategies")).unwrap();
    fs::write(ctx.pacer_home.join("strategies/team.yaml"), basic).unwrap();
    assert_eq!(
        pacer_config::routing_get(&ctx).unwrap()["available"],
        json!(["claude-code"])
    );
}
