#![allow(clippy::unwrap_used)]

use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, fs};

fn fixture() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().join("home"),
        dir.path().join("pacer"),
        HashMap::new(),
        12345.0,
    );
    fs::create_dir_all(&ctx.pacer_home).unwrap();
    fs::write(ctx.pacer_home.join("strategy.yaml"), "accounts: {personal: {kind: claude}}\nplanner: claude-code\nrouting: [{default: [claude-code]}]\nhosts: {devbox: {ssh: dev-ssh}}\n").unwrap();
    (dir, ctx)
}
fn golden() -> Value {
    serde_json::from_str(include_str!("../../../test/fixtures/host-suggest.json")).unwrap()
}

#[test]
fn literal_include_matches_typescript_golden_without_writes() {
    let (_dir, ctx) = fixture();
    let ssh = ctx.home.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    fs::write(
        ssh.join("config"),
        "Host dev-ssh fresh-box\nInclude \"extra file\"\nHost * !private qa?\nHost dev-ssh\n",
    )
    .unwrap();
    fs::write(ssh.join("extra file"), "hOsT=\"quoted-box\" # comment\n").unwrap();
    let before = fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap();
    assert_eq!(
        pacer_config::host_suggest(&ctx).unwrap(),
        golden()["literalInclude"]
    );
    assert_eq!(
        fs::read(ctx.pacer_home.join("strategy.yaml")).unwrap(),
        before
    );
}

#[test]
fn missing_config_matches_typescript_golden() {
    let (_dir, ctx) = fixture();
    assert_eq!(
        pacer_config::host_suggest(&ctx).unwrap(),
        golden()["missingConfig"]
    );
}

#[test]
fn literal_includes_stop_after_eight_levels_and_cycles() {
    let (_dir, ctx) = fixture();
    let ssh = ctx.home.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    fs::write(ssh.join("config"), "Include level1\nInclude config\n").unwrap();
    for i in 1..=9 {
        fs::write(
            ssh.join(format!("level{i}")),
            format!("Host level{i}\nInclude level{}\n", i + 1),
        )
        .unwrap();
    }
    assert_eq!(
        pacer_config::host_suggest(&ctx).unwrap(),
        json!([
            "level1", "level2", "level3", "level4", "level5", "level6", "level7", "level8"
        ])
    );
}

#[test]
fn glob_includes_and_advanced_host_shapes_remain_core_owned() {
    let (_dir, ctx) = fixture();
    let ssh = ctx.home.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    fs::write(ssh.join("config"), "Include conf.d/*\n").unwrap();
    assert!(pacer_config::requires_core_host_suggest_parser(&ctx));
    fs::write(ssh.join("config"), "Host spare\n").unwrap();
    assert!(!pacer_config::requires_core_host_suggest_parser(&ctx));
    fs::write(ctx.pacer_home.join("strategy.yaml"),
        "accounts: {personal: {kind: claude}}\nplanner: claude-code\nhosts: {devbox: {ssh: dev-ssh, max_tasks: 3}}\n").unwrap();
    assert!(pacer_config::requires_core_host_suggest_parser(&ctx));
}

#[test]
fn simple_hosts_do_not_change_native_routing_read() {
    let (_dir, ctx) = fixture();
    assert_eq!(
        pacer_config::routing_get(&ctx).unwrap(),
        json!({"rules":[{"executors":["claude-code"]}],"available":["claude-code"]})
    );
}

#[cfg(unix)]
#[test]
fn symlinked_ssh_components_and_leaves_forward_to_core() {
    use std::os::unix::fs::symlink;

    let (dir, ctx) = fixture();
    let outside = dir.path().join("outside");
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(&ctx.home).unwrap();
    fs::write(outside.join("config"), "Host external\n").unwrap();
    symlink(&outside, ctx.home.join(".ssh")).unwrap();
    assert!(pacer_config::requires_core_host_suggest_parser(&ctx));
    assert!(pacer_config::host_suggest(&ctx).is_err());

    fs::remove_file(ctx.home.join(".ssh")).unwrap();
    let ssh = ctx.home.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    symlink(outside.join("config"), ssh.join("config")).unwrap();
    assert!(pacer_config::requires_core_host_suggest_parser(&ctx));
    fs::remove_file(ssh.join("config")).unwrap();

    fs::write(ssh.join("config"), "Include conf.d/extra\n").unwrap();
    symlink(&outside, ssh.join("conf.d")).unwrap();
    assert!(pacer_config::requires_core_host_suggest_parser(&ctx));
    assert!(pacer_config::host_suggest(&ctx).is_err());
}

#[test]
fn unicode_whitespace_ssh_config_remains_core_owned() {
    let (_dir, ctx) = fixture();
    let ssh = ctx.home.join(".ssh");
    fs::create_dir_all(&ssh).unwrap();
    fs::write(ssh.join("config"), "Host\u{feff}fresh-box\n").unwrap();
    assert!(pacer_config::requires_core_host_suggest_parser(&ctx));
    assert!(pacer_config::host_suggest(&ctx).is_err());
}
