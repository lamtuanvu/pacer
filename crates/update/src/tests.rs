#![allow(clippy::unwrap_used)]
use crate::{
    Code, apply,
    check::{compare_versions, is_version, update_check_false},
    feed::{latest, normalize_base, parse_latest},
    service::{js_number, launchd_number, systemd_fields},
    update_check,
};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::collections::HashMap;

fn ctx(dir: &std::path::Path, env: &[(&str, &str)]) -> Ctx {
    let env: HashMap<String, String> = env
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect();
    Ctx::with(dir.into(), dir.join(".pacer"), env, 1_000_000.5)
}

fn run(ctx: &Ctx, params: Value) -> Result<Value, pacer_foundation::api::CoreError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(update_check(ctx, params))
}

#[test]
fn update_check_opt_out_matches_the_multiline_pattern() {
    for text in [
        "update_check: false",
        "a: 1\nupdate_check:false # off\n",
        "update_check:\n  false\nx: 1",
        "update_check: false\t\r\n",
    ] {
        assert!(update_check_false(text), "{text:?}");
    }
    for text in [
        "update_check: falsey",
        " update_check: false",
        "update_check: false x",
        "update_check: true",
    ] {
        assert!(!update_check_false(text), "{text:?}");
    }
}

#[test]
fn versions_follow_semver_precedence() {
    assert!(is_version("1.2.3") && is_version("1.2.3-rc.1+build.5"));
    assert!(
        !is_version("01.2.3")
            && !is_version("1.2")
            && !is_version("1.2.3-")
            && !is_version("v1.2.3")
    );
    assert_eq!(compare_versions("1.10.0", "1.9.9"), 1);
    assert_eq!(compare_versions("1.0.0-rc.1", "1.0.0"), -1);
    assert_eq!(compare_versions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
    assert_eq!(compare_versions("1.0.0-alpha", "1.0.0-1"), 1);
    assert_eq!(compare_versions("1.0.0-a", "1.0.0-a.1"), -1);
    assert_eq!(compare_versions("1.0.0+a", "1.0.0+b"), 0);
}

#[test]
fn release_bases_and_feeds_use_the_reference_messages() {
    assert_eq!(
        normalize_base(" https://example.test/r// ").unwrap(),
        "https://example.test/r"
    );
    assert_eq!(
        normalize_base("http://127.0.0.1:8080").unwrap(),
        "http://127.0.0.1:8080"
    );
    for bad in [
        "http://example.test",
        "https://u@example.test",
        "https://e.test/?q",
        "http://localhost.evil",
    ] {
        assert_eq!(
            normalize_base(bad).unwrap_err(),
            format!(
                "release base must start with https://, file://, or http://127.0.0.1 / http://localhost (got \"{bad}\")"
            )
        );
    }
    assert_eq!(
        parse_latest(&json!({"version": "v2.0.0"})).unwrap(),
        "2.0.0"
    );
    assert_eq!(
        parse_latest(&json!({})).unwrap_err(),
        "latest.json has no valid \"version\" (got null)"
    );
    assert_eq!(
        parse_latest(&json!({"version": 2})).unwrap_err(),
        "latest.json has no valid \"version\" (got 2)"
    );

    let dir = tempfile::tempdir().unwrap();
    let base = format!("file://{}", dir.path().display());
    let missing = latest(Some(&base)).unwrap_err();
    assert!(
        missing.starts_with(&format!(
            "download failed: {base}/latest.json (ENOENT: no such file or directory, open '"
        )),
        "{missing}"
    );
    std::fs::write(dir.path().join("latest.json"), "<html>").unwrap();
    assert_eq!(
        latest(Some(&base)).unwrap_err(),
        "JSON Parse error: Unrecognized token '<'"
    );
    std::fs::write(dir.path().join("latest.json"), "{\"version\":\"9.9.9\"}").unwrap();
    assert_eq!(latest(Some(&base)).unwrap(), "9.9.9");
}

#[test]
fn update_check_caches_the_feed_and_honours_the_opt_out() {
    let dir = tempfile::tempdir().unwrap();
    let feed = dir.path().join("feed");
    std::fs::create_dir(&feed).unwrap();
    std::fs::write(feed.join("latest.json"), "{\"version\":\"999.0.0\"}").unwrap();
    let base = format!("file://{}", feed.display());
    let ctx = ctx(dir.path(), &[("PACER_RELEASE_BASE", &base)]);
    let first = run(&ctx, json!({})).unwrap();
    assert_eq!(first["latest"], "999.0.0");
    assert_eq!(first["available"], true);
    assert_eq!(first["plugin"], Value::Null);
    let cache = std::fs::read_to_string(ctx.pacer_home.join("update-check.json")).unwrap();
    assert!(
        cache.starts_with("{\"checkedAt\":1000000.5,\"latest\":\"999.0.0\",\"current\":"),
        "{cache}"
    );
    assert!(cache.ends_with("}\n"));

    std::fs::remove_file(feed.join("latest.json")).unwrap();
    assert_eq!(run(&ctx, json!({})).unwrap(), first);
    let forced = run(&ctx, json!({"force": true})).unwrap();
    assert_eq!(forced["latest"], "999.0.0");
    assert!(forced["error"].as_str().unwrap().contains("ENOENT"));
    assert_eq!(
        run(&ctx, json!({"force": 1})).unwrap_err().message,
        "force: Invalid input: expected boolean, received number"
    );

    let off = ctx_off(dir.path());
    let disabled = run(&off, json!({})).unwrap();
    assert_eq!(disabled["disabled"], true);
    assert_eq!(disabled["latest"], Value::Null);
}

fn ctx_off(dir: &std::path::Path) -> Ctx {
    ctx(dir, &[("PACER_NO_UPDATE_CHECK", "1")])
}

#[test]
fn service_manager_output_parses_like_the_reference() {
    let launchd =
        "gui/501/com.pacer.serve = {\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n";
    assert_eq!(launchd_number(launchd, "pid"), Some(4242.0));
    assert_eq!(launchd_number("\tpid = 12x\n", "pid"), None);
    assert_eq!(launchd_number("\tpid = -3 \n", "pid"), Some(-3.0));

    let data = systemd_fields("ActiveState=active\r\nSubState=running\nMainPID=77\nweird\n");
    assert_eq!(data["ActiveState"], "active");
    assert_eq!(data["SubState"], "running");
    assert_eq!(data["MainPID"], "77");
    assert_eq!(data["weir"], "weird");
    assert_eq!(js_number("0x10"), Some(16.0));
    assert_eq!(js_number(" 12 "), Some(12.0));
    assert_eq!(js_number(""), Some(0.0));
    assert_eq!(js_number("12abc"), None);
}

#[derive(Default)]
struct Effects(Vec<Value>);

impl apply::UpdateEffects for Effects {
    fn call(&mut self, request: Value) -> pacer_foundation::api::OpFuture<'_> {
        self.0.push(request);
        Box::pin(async { Ok(json!({"job": {"id": "j-1"}})) })
    }
}

fn apply_update(
    env: &[(&str, &str)],
    params: Value,
) -> (Result<Value, pacer_foundation::api::CoreError>, Vec<Value>) {
    let dir = tempfile::tempdir().unwrap();
    let mut effects = Effects::default();
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(apply::update_apply(
            &ctx(dir.path(), env),
            params,
            &mut effects,
        ));
    (result, effects.0)
}

#[test]
fn update_apply_requests_one_core_update_job() {
    for params in [json!({}), json!(null), json!({"force": true})] {
        let (result, effects) = apply_update(&[], params);
        assert_eq!(result.unwrap(), json!({"job": {"id": "j-1"}}));
        assert_eq!(effects, vec![json!({"kind": "apply"})]);
    }
}

#[test]
fn update_apply_refusals_and_schema_issues_never_reach_core() {
    let error = |env: &[(&str, &str)], params: Value| {
        let (result, effects) = apply_update(env, params);
        assert!(effects.is_empty());
        let error = result.unwrap_err();
        (error.code, error.message)
    };
    assert_eq!(
        error(&[], json!(false)),
        (
            Code::InvalidInput,
            "params: Invalid input: expected object, received boolean".to_owned()
        )
    );
    assert_eq!(
        error(
            &[("PACER_ROLE", "executor"), ("PACER_ENFORCEMENT_TOKEN", "t")],
            json!([])
        ),
        (
            Code::NotAllowed,
            "PACER_ROLE=executor: upgrades are not allowed from a delegated task.".to_owned()
        )
    );
    assert_eq!(
        error(&[("PACER_ENFORCEMENT_TOKEN", "t")], json!([])),
        (
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial".to_owned()
        )
    );
    let dir = tempfile::tempdir().unwrap();
    assert!(apply::stays_forwarded(&ctx(
        dir.path(),
        &[("PACER_WORK_GRANT", "g")]
    )));
    assert!(!apply::stays_forwarded(&ctx(dir.path(), &[])));
}
