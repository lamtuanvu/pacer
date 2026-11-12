#![allow(clippy::unwrap_used)]
use super::*;
use std::{fs, path::Path, process::Command};

const STRATEGY: &str = "planner: claude-code\naccounts:\n  claude: {kind: claude}\nrunners:\n  claude-code: {}\nhosts:\n  dev:\n    ssh: dev.example.invalid\n    repos:\n      github.com/acme/app: ~/app\n";

fn ctx(dir: &Path, env: &[(&str, &str)]) -> Ctx {
    fs::write(dir.join("strategy.yaml"), STRATEGY).unwrap();
    Ctx::with(
        dir.into(),
        dir.into(),
        env.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect(),
        1_700_000_000.0,
    )
}

fn run(ctx: &Ctx, op: &str, params: Value, core: Option<OpFuture<'_>>) -> Result<Value, CoreError> {
    tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap()
        .block_on(call(ctx, op, params, core))
}

fn message(ctx: &Ctx, op: &str, params: Value) -> String {
    admit(ctx, op, &params).unwrap_err().message
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.name=t", "-c", "user.email=t@example.invalid"])
        .args(args)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}");
    String::from_utf8(out.stdout).unwrap().trim().into()
}

/// A checkout whose `pacer/<id>` branches point at the returned head.
fn checkout(dir: &Path, origin: &str, ids: &[&str]) -> String {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q"]);
    git(dir, &["remote", "add", "origin", origin]);
    git(dir, &["commit", "-q", "--allow-empty", "-m", "base"]);
    for id in ids {
        git(dir, &["branch", &format!("pacer/{id}")]);
    }
    git(dir, &["rev-parse", "HEAD"])
}

fn task(id: &str, state: &str, repo: &Path, run: Value) -> Value {
    let mut run_fields =
        json!({"host": "dev", "mode": "new", "remoteWorktree": "/w", "remoteDir": "/d"});
    run_fields
        .as_object_mut()
        .unwrap()
        .extend(run.as_object().unwrap().clone());
    json!({
        "id": id, "rev": 1, "state": state, "createdAt": 1, "attempts": [],
        "brief": {"repo": repo.to_str().unwrap()}, "review": {"ok": true}, "run": run_fields,
    })
}

#[test]
fn refusals_come_before_any_core_effect() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    assert_eq!(
        message(&ctx, "host.check", json!({"alias": "nope"})),
        "unknown host nope"
    );
    assert_eq!(
        message(
            &ctx,
            "host.clean",
            json!({"alias": "nope", "dry_run": true})
        ),
        "unknown host nope"
    );
    assert_eq!(
        message(&ctx, "host.check", json!([])),
        "params: Invalid input: expected object, received array"
    );
    assert_eq!(
        message(&ctx, "host.check", Value::Null),
        "alias: Invalid input: expected string, received undefined"
    );
    assert_eq!(
        message(&ctx, "host.check", json!({"alias": "", "repo": ""})),
        "alias: Too small: expected string to have >=1 characters; repo: Too small: expected string to have >=1 characters"
    );
    assert_eq!(
        message(
            &ctx,
            "host.check",
            json!({"alias": "😀".repeat(65), "repo": null})
        ),
        "alias: Too big: expected string to have <=128 characters; repo: Invalid input: expected string, received null"
    );
    assert_eq!(
        message(
            &ctx,
            "host.clean",
            json!({"alias": "dev", "dry_run": "yes"})
        ),
        "dry_run: Invalid input: expected boolean, received string"
    );
    let enforced = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        [("PACER_ENFORCEMENT_TOKEN".into(), "x".into())].into(),
        1.0,
    );
    let refused = admit(&enforced, "host.check", &json!([])).unwrap_err();
    assert_eq!(refused.code, Code::NotAllowed);
    assert_eq!(
        refused.message,
        "Enforcement identity only reports a native child denial"
    );
}

#[test]
fn admitted_effects_go_to_core_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    for (op, params) in [
        ("host.check", json!({"alias": "dev", "repo": "/r"})),
        ("host.clean", json!({"alias": "dev"})),
        ("host.clean", json!({"alias": "dev", "dry_run": false})),
    ] {
        assert_eq!(admit(&ctx, op, &params).unwrap(), Admission::Core);
        let core: OpFuture<'_> = Box::pin(async { Ok(json!({"job": {"id": "j"}})) });
        assert_eq!(
            run(&ctx, op, params.clone(), Some(core)).unwrap(),
            json!({"job": {"id": "j"}})
        );
        let failed: OpFuture<'_> =
            Box::pin(async { Err(CoreError::new(Code::Unavailable, "host dev is unreachable")) });
        let error = run(&ctx, op, params.clone(), Some(failed)).unwrap_err();
        assert_eq!(error.message, "host dev is unreachable");
        let error = run(&ctx, op, params, None).unwrap_err();
        assert_eq!(error.message, "host effects bridge unavailable");
    }
    fs::write(dir.path().join("strategy.yaml"), "hosts: [").unwrap();
    assert_eq!(
        admit(&ctx, "host.check", &json!({"alias": "nope"})).unwrap(),
        Admission::Core
    );
}

#[test]
fn work_grants_stay_forwarded() {
    let dir = tempfile::tempdir().unwrap();
    let plain = ctx(dir.path(), &[]);
    let granted = ctx(dir.path(), &[("PACER_WORK_GRANT", "pwg_x")]);
    let params = json!({"alias": "dev"});
    for op in ["host.check", "host.clean", "host.repo.setup"] {
        assert!(needs_host_effects(op), "{op}");
        assert!(!host_stays_forwarded(&plain, op, &params), "{op}");
        assert!(host_stays_forwarded(&granted, op, &params), "{op}");
    }
    assert!(!needs_host_effects("host.terminal"));
    assert!(!host_stays_forwarded(&granted, "host.list", &params));
}

#[test]
fn repo_setup_needs_consent_and_a_mapped_key_before_core() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let setup = |params: Value| admit(&ctx, "host.repo.setup", &params);
    let message = |params: Value| setup(params).unwrap_err().message;
    let consent = "consent: Invalid input: expected true";
    for value in [
        None,
        Some(json!(false)),
        Some(json!("true")),
        Some(json!(1)),
        Some(json!(null)),
    ] {
        let mut params = json!({"alias": "dev", "key": "github.com/acme/app"});
        if let Some(value) = value {
            params["consent"] = value;
        }
        assert_eq!(message(params), consent);
    }
    // The schema refuses before the unknown host, as parseOpParams runs before setupJob.
    assert_eq!(
        message(json!({"alias": "nope", "key": "github.com/acme/app"})),
        consent
    );
    assert_eq!(
        message(json!({})),
        "alias: Invalid input: expected string, received undefined; key: Invalid input: expected string, received undefined; consent: Invalid input: expected true"
    );
    assert_eq!(
        message(json!({"alias": 1, "key": "", "clone": "x", "identity": null, "consent": false})),
        "alias: Invalid input: expected string, received number; key: Too small: expected string to have >=1 characters; clone: Invalid input: expected boolean, received string; identity: Invalid input: expected boolean, received null; consent: Invalid input: expected true"
    );
    assert_eq!(
        message(json!({"alias": "a".repeat(129), "key": "😀".repeat(65), "consent": true})),
        "alias: Too big: expected string to have <=128 characters; key: Too big: expected string to have <=128 characters"
    );
    assert_eq!(
        message(json!([])),
        "params: Invalid input: expected object, received array"
    );
    assert_eq!(
        message(json!({"alias": "nope", "key": "github.com/acme/app", "consent": true})),
        "unknown host nope"
    );
    for key in [
        "github.com/acme/other",
        "not-canonical",
        "github.com/acme/app.git",
        "github.com/acme/app/extra",
    ] {
        let error = setup(json!({"alias": "dev", "key": key, "consent": true})).unwrap_err();
        assert_eq!(error.code, Code::InvalidInput, "{key}");
        assert_eq!(error.message, "repo not mapped on dev", "{key}");
        assert_eq!(
            error.hint.as_deref(),
            Some("Use a mapped canonical host/owner/repo key."),
            "{key}"
        );
    }
    for params in [
        json!({"alias": "dev", "key": "github.com/acme/app", "consent": true}),
        json!({"alias": "dev", "key": "GitHub.com/ACME/App", "consent": true, "clone": false}),
        json!({"alias": "dev", "key": "github.com/acme/app", "consent": true, "identity": false, "extra": 1}),
    ] {
        assert_eq!(setup(params.clone()).unwrap(), Admission::Core, "{params}");
        let denied: OpFuture<'_> = Box::pin(async {
            Err(CoreError::new(
                Code::CapabilityDenied,
                "configured clone changed after consent",
            ))
        });
        let error = run(&ctx, "host.repo.setup", params, Some(denied)).unwrap_err();
        assert_eq!(
            (error.code, error.message.as_str()),
            (
                Code::CapabilityDenied,
                "configured clone changed after consent"
            )
        );
    }
    let enforced = Ctx::with(
        dir.path().into(),
        dir.path().into(),
        [("PACER_ENFORCEMENT_TOKEN".into(), "x".into())].into(),
        1.0,
    );
    let refused = admit(&enforced, "host.repo.setup", &json!({})).unwrap_err();
    assert_eq!(refused.code, Code::NotAllowed);
    fs::write(dir.path().join("strategy.yaml"), "hosts: [").unwrap();
    assert_eq!(
        setup(json!({"alias": "nope", "key": "x", "consent": true})).unwrap(),
        Admission::Core
    );
}

#[test]
fn dry_run_previews_fates_with_the_transfer_gate() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let mapped = dir.path().join("app");
    let unmapped = dir.path().join("other");
    let removable = "t-20260101-000001-aaaa";
    let elsewhere = "t-20260101-000002-bbbb";
    let running = "t-20260101-000003-cccc";
    let moved = "t-20260101-000004-dddd";
    let direct = "t-20260101-000005-eeee";
    let foreign = "t-20260101-000006-ffff";
    let head = checkout(
        &mapped,
        "https://github.com/acme/app.git",
        &[removable, running, moved],
    );
    let other = checkout(&unmapped, "https://github.com/acme/other.git", &[elsewhere]);
    git(&mapped, &["branch", &format!("pacer/{direct}-r2")]);
    let mut store = TaskStore::open(dir.path()).unwrap();
    for record in [
        task(removable, "done", &mapped, json!({"transferredHead": head})),
        task(
            elsewhere,
            "done",
            &unmapped,
            json!({"transferredHead": other, "remoteBranch": "custom"}),
        ),
        task(
            running,
            "running",
            &mapped,
            json!({"transferredHead": head}),
        ),
        task(
            moved,
            "done",
            &mapped,
            json!({"transferredHead": "0".repeat(40)}),
        ),
        {
            let mut t = task(
                direct,
                "done",
                &mapped,
                json!({"transferredHead": head, "attempt": 2, "dir": "/x", "startedAt": 5}),
            );
            t["executorProvider"] = json!("pacer-exec-direct");
            t["remoteTransferIntent"] = json!({"attempt": 2.0, "providerId": "pacer-exec-direct", "dir": "/x", "startedAt": 5, "branch": format!("pacer/{direct}-r2")});
            t
        },
        {
            let mut t = task(foreign, "done", &mapped, json!({"transferredHead": head}));
            t["run"]["host"] = json!("prod");
            t
        },
    ] {
        store.insert(&record, 1.0).unwrap();
    }
    let reply = run(
        &ctx,
        "host.clean",
        json!({"alias": "dev", "dry_run": true}),
        None,
    )
    .unwrap();
    assert_eq!(
        reply,
        json!({"worktrees": [
            {"branch": format!("pacer/{direct}"), "state": "done", "fate": "will remove"},
            {"branch": format!("pacer/{moved}"), "state": "done", "fate": "kept"},
            {"branch": format!("pacer/{running}"), "state": "running", "fate": "in use"},
            {"branch": "custom", "state": "done", "fate": "kept"},
            {"branch": format!("pacer/{removable}"), "state": "done", "fate": "will remove"},
        ]})
    );
}

#[test]
fn direct_transfers_need_a_matching_intent() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("app");
    let id = "t-20260101-000001-aaaa";
    let head = checkout(&repo, "https://github.com/acme/app.git", &[id]);
    let mut t = task(
        id,
        "done",
        &repo,
        json!({"transferredHead": head, "attempt": 1}),
    );
    t["executorProvider"] = json!("pacer-exec-direct");
    assert!(!transferred(&t));
    t["remoteTransferIntent"] =
        json!({"attempt": 1, "providerId": "pacer-exec-direct", "branch": format!("pacer/{id}")});
    assert!(transferred(&t));
    t["remoteTransferIntent"]["dir"] = json!(null);
    assert!(!transferred(&t));
    t["remoteTransferIntent"]["dir"] = json!({});
    t["run"]["dir"] = json!({});
    assert!(!transferred(&t));
}
