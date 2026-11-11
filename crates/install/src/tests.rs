#![allow(clippy::unwrap_used)]
use super::*;
use std::{collections::HashMap, fs, os::unix::fs::PermissionsExt};

fn ctx(home: &Path, path: &str, now: f64) -> Ctx {
    let env = HashMap::from([("PATH".to_owned(), path.to_owned())]);
    Ctx::with(home.to_path_buf(), home.to_path_buf(), env, now)
}

fn executable(dir: &Path, name: &str) -> String {
    let file = dir.join(name);
    fs::write(&file, "#!/bin/sh\n").unwrap();
    fs::set_permissions(&file, fs::Permissions::from_mode(0o755)).unwrap();
    file.to_string_lossy().into_owned()
}

fn write_cache(ctx: &Ctx, key: &Value, body: &Value) {
    let name = format!(
        "agent-detect-{}.json",
        hex::encode(Sha256::digest(key.to_string()))
    );
    fs::create_dir_all(ctx.pacer_home.join("cache")).unwrap();
    fs::write(ctx.pacer_home.join("cache").join(name), body.to_string()).unwrap();
}

fn call(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(agent_detect(ctx, params))
}

#[test]
fn a_fresh_cache_entry_answers_with_its_rows() {
    let home = tempfile::tempdir().unwrap();
    let bin = home.path().join("bin");
    fs::create_dir(&bin).unwrap();
    let claude = executable(&bin, "claude");
    let cursor = executable(&bin, "cursor");
    let path = bin.to_string_lossy().into_owned();
    let ctx = ctx(home.path(), &path, 5000.0);
    let key = json!([[{"name": "claude", "path": claude}, null, {"name": "cursor", "path": cursor}, null], path, null]);
    let rows = json!([{"agent": "claude-code", "found": true}]);
    write_cache(&ctx, &key, &json!({"at": 4000, "rows": rows}));
    assert_eq!(cached_rows_on(&ctx, None, &path), Some(rows));
    assert_eq!(
        cached_rows_on(&ctx, None, &format!("relative:{path}")),
        None
    );
}

#[test]
fn stale_future_or_missing_entries_forward() {
    let home = tempfile::tempdir().unwrap();
    let ctx = ctx(home.path(), "/nonexistent", 5000.0);
    let key = json!([[null, null, null, null], "/nonexistent", "box"]);
    assert!(agent_detect_stays_forwarded(&ctx, &json!({"host": "box"})));
    for at in [1400.0, 5001.0] {
        write_cache(&ctx, &key, &json!({"at": at, "rows": []}));
        assert!(agent_detect_stays_forwarded(&ctx, &json!({"host": "box"})));
    }
    write_cache(&ctx, &key, &json!({"at": 5000, "rows": []}));
    assert!(!agent_detect_stays_forwarded(&ctx, &json!({"host": "box"})));
    write_cache(&ctx, &key, &json!({"at": 5000}));
    assert!(agent_detect_stays_forwarded(&ctx, &json!({"host": "box"})));
}

#[test]
fn params_follow_the_published_schema() {
    let home = tempfile::tempdir().unwrap();
    let ctx = ctx(home.path(), "", 0.0);
    let message = |params| call(&ctx, params).unwrap_err().message;
    assert_eq!(
        message(json!([])),
        "params: Invalid input: expected object, received array"
    );
    assert_eq!(
        message(json!({"host": 1})),
        "host: Invalid input: expected string, received number"
    );
    assert_eq!(
        message(json!({"host": ""})),
        "host: Too small: expected string to have >=1 characters"
    );
    assert_eq!(
        message(json!({"host": "x".repeat(129)})),
        "host: Too big: expected string to have <=128 characters"
    );
    assert!(!agent_detect_stays_forwarded(&ctx, &json!({"host": 1})));
}

#[derive(Default)]
struct Effects(Vec<Value>);

impl install_ops::ServiceEffects for Effects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.0.push(request);
        Box::pin(async { Ok(json!({"installed": true, "running": true})) })
    }
}

fn install(env: &[(&str, &str)], params: Value) -> (Result<Value, CoreError>, Vec<Value>) {
    let home = tempfile::tempdir().unwrap();
    let env = env
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let ctx = Ctx::with(home.path().into(), home.path().into(), env, 1.0);
    let mut effects = Effects::default();
    let result = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(install_ops::service_install(&ctx, params, &mut effects));
    (result, effects.0)
}

#[test]
fn service_install_with_consent_requests_one_core_install() {
    let (result, effects) = install(&[], json!({"consent": true, "extra": 1}));
    assert_eq!(result.unwrap(), json!({"installed": true, "running": true}));
    assert_eq!(effects, vec![json!({"kind": "install"})]);
}

#[test]
fn service_install_refusals_and_schema_issues_never_reach_core() {
    let message = |env: &[(&str, &str)], params: Value| {
        let (result, effects) = install(env, params);
        assert!(effects.is_empty());
        let error = result.unwrap_err();
        (error.code, error.message)
    };
    let consent = (
        Code::InvalidInput,
        "consent: Invalid input: expected true".to_owned(),
    );
    for params in [
        json!({}),
        json!(null),
        json!({"consent": false}),
        json!({"consent": "true"}),
    ] {
        assert_eq!(message(&[], params), consent);
    }
    assert_eq!(
        message(&[], json!([])),
        (
            Code::InvalidInput,
            "params: Invalid input: expected object, received array".to_owned()
        )
    );
    assert_eq!(
        message(
            &[("PACER_ROLE", "executor"), ("PACER_ENFORCEMENT_TOKEN", "t")],
            json!(1)
        ),
        (Code::NotAllowed, install_ops::UPGRADE_REFUSAL.to_owned())
    );
    assert_eq!(
        message(
            &[("PACER_ENFORCEMENT_TOKEN", "t")],
            json!({"consent": true})
        ),
        (
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial".to_owned()
        )
    );
}

#[test]
fn service_install_forwards_work_grants() {
    let home = tempfile::tempdir().unwrap();
    let with = |env: &[(&str, &str)]| {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Ctx::with(home.path().into(), home.path().into(), env, 1.0)
    };
    assert!(install_ops::stays_forwarded(&with(&[(
        "PACER_WORK_GRANT",
        "g"
    )])));
    assert!(!install_ops::stays_forwarded(&with(&[(
        "PACER_WORK_GRANT",
        ""
    )])));
    assert!(!install_ops::stays_forwarded(&with(&[])));
}
