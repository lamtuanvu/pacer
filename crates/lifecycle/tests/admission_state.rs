#![allow(clippy::unwrap_used)]
use pacer_lifecycle::{AdmissionState, DrainRoute, PreparedAdmission};
use serde_json::{Value, json};
fn task(id: &str) -> Value {
    json!({"id":id,"rev":1,"brief":{"repo":"/repo","goal":"work"},"state":"queued","createdAt":1,"attempts":[],"timeoutS":60,"requestedExecutor":null})
}
#[test]
fn lineage_is_atomic_and_reads_do_not_drain() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    let root = "t-20261102-000000-0001";
    let child = "t-20261102-000000-0002";
    state
        .create(
            &task(root),
            Some(&json!({"allowDelegation":true,"maxDescendants":1})),
            None,
            1.0,
        )
        .unwrap();
    assert_eq!(state.read(root).unwrap().unwrap()["state"], "queued");
    state
        .tasks
        .update(root, 1, 2.0, |t| t["state"] = json!("running"))
        .unwrap();
    state
        .create(&task(child), Some(&json!({})), Some(root), 3.0)
        .unwrap();
    let rejected = "t-20261102-000000-0003";
    assert!(
        state
            .create(&task(rejected), Some(&json!({})), Some(root), 4.0)
            .is_err()
    );
    assert!(state.read(rejected).unwrap().is_none());
    assert!(
        !dir.path()
            .join("tasks")
            .join(format!("{rejected}.json"))
            .exists()
    );
    assert_eq!(state.work(child).unwrap().unwrap()["rootId"], root);
}
#[test]
fn prepared_receipt_is_single_use_and_directory_identity_is_rechecked() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let mut prepared = PreparedAdmission::prepare(
        json!({"repo":repo}),
        std::slice::from_ref(&repo),
        None,
        || Ok(json!({"rev":1})),
        |_| Ok(()),
        |input| Ok(input.clone()),
    )
    .unwrap();
    assert!(
        prepared
            .consume(|| Ok(json!({"rev":2})), |_| Ok(()), |_| Ok(()))
            .is_err()
    );
    assert!(
        prepared
            .consume(|| Ok(json!({"rev":1})), |_| Ok(()), |_| Ok(()))
            .is_err()
    );
    let mut prepared = PreparedAdmission::prepare(
        json!({}),
        std::slice::from_ref(&repo),
        None,
        || Ok(Value::Null),
        |_| Ok(()),
        |input| Ok(input.clone()),
    )
    .unwrap();
    std::fs::rename(&repo, dir.path().join("old")).unwrap();
    std::fs::create_dir(&repo).unwrap();
    let mut effects = 0;
    assert!(
        prepared
            .consume(
                || Ok(Value::Null),
                |_| Ok(()),
                |_| {
                    effects += 1;
                    Ok(())
                }
            )
            .is_err()
    );
    assert_eq!(effects, 0);
}
#[test]
fn explicit_drain_reserves_before_launch_and_restores_failed_launch() {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    for id in ["t-20261102-000000-0001", "t-20261102-000000-0002"] {
        let mut t = task(id);
        t["queue"] = json!({"reason":"paused","since":1,"position":1});
        state.create(&t, None, None, 1.0).unwrap();
    }
    let route = || DrainRoute::local("codex", 1);
    let launched = state
        .drain(2.0, false, |_| Ok(vec![route()]), |_| Ok(Some(42)))
        .unwrap();
    assert_eq!(launched.len(), 1);
    assert_eq!(
        state.read(&launched[0]).unwrap().unwrap()["state"],
        "running"
    );
    let waiting = "t-20261102-000000-0002";
    assert_eq!(
        state.read(waiting).unwrap().unwrap()["queue"]["reason"],
        "paused"
    );
    state
        .tasks
        .update(&launched[0], 3, 3.0, |t| t["state"] = json!("done"))
        .unwrap();
    assert!(
        state
            .drain(
                4.0,
                false,
                |_| Ok(vec![route()]),
                |_| Err(pacer_lifecycle::AdmissionError("spawn failed".into()))
            )
            .is_err()
    );
    assert_eq!(state.read(waiting).unwrap().unwrap()["state"], "queued");
}
#[test]
fn current_strategy_models_aliases_projects_and_policy_guards_are_rechecked() {
    use pacer_lifecycle::{
        AdmissionError, RouteAdmission, resolve_runner, validate_current, validate_strategy_input,
    };
    let strategy = json!({"providers":{"codex":{},"claude-code":{}},"planner":{"agent":"claude-code","account":"main"},"accounts":{"main":{"name":"main","kind":"claude"},"default":{"name":"default","kind":"codex"}},"runners":{"codex":{"id":"codex","agent":"codex","account":"default","host":null,"enabled":true,"models":[{"id":"model","tier":"frontier","tools":true,"context":200}]},"claude-code":{"id":"claude-code","agent":"claude-code","account":"main","host":null}},"runnerAliases":{"fast":"codex"}});
    assert_eq!(
        resolve_runner(&strategy, "codex#default@local").unwrap()["id"],
        "codex"
    );
    assert_eq!(resolve_runner(&strategy, "fast").unwrap()["id"], "codex");
    let mut input = json!({"brief":{"goal":"work","repo":"/repo"},"executor":"fast","dispatch":{"requirements":{"minTier":"medium","tools":true,"context":100},"model":"model"}});
    let projects = json!({"version":1,"projects":{"local:abcdef123456":{"rev":1,"executors":["codex#default@local"]}}});
    let repo = json!({"key":"local:abcdef123456"});
    assert!(validate_current(&strategy, &input, &projects, Some(&repo), &json!({})).is_ok());
    assert!(validate_current(&strategy, &input, &projects, None, &json!({})).is_err());
    input["dispatch"]["requirements"]["context"] = json!(201);
    assert!(
        validate_current(&strategy, &input, &projects, Some(&repo), &json!({}))
            .unwrap_err()
            .0
            .contains("incompatible")
    );
    input["executor"] = json!("claude-code");
    assert!(validate_strategy_input(&strategy, &input, true)[0].contains("planner"));
    input["dispatch"]["allowDelegation"] = json!(true);
    assert!(validate_strategy_input(&strategy, &input, true).is_empty());
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    let mut queued = task("t-20261102-000000-0001");
    queued["queue"] = json!({"reason":"no_slot","since":1,"position":1});
    state.create(&queued, None, None, 1.0).unwrap();
    let launched = state
        .drain_admitted(
            2.0,
            false,
            |_| {
                Ok(RouteAdmission {
                    routes: vec![DrainRoute::local("codex", 1)],
                    project_limited: false,
                    excluded_detail: String::new(),
                    revalidate: Box::new(|_, _| Err(AdmissionError::conflict("project changed"))),
                })
            },
            |_| panic!("stale admission launched"),
        )
        .unwrap();
    assert!(launched.is_empty());
    assert_eq!(
        state.read(queued["id"].as_str().unwrap()).unwrap().unwrap()["state"],
        "queued"
    );
}
#[test]
fn cancellation_and_deadlines_prevent_effects() {
    use pacer_lifecycle::AdmissionLifetime;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let mut receipt = PreparedAdmission::prepare(
        json!({}),
        &[],
        Some(AdmissionLifetime {
            cancelled: vec![cancelled.clone()],
            deadline: None,
        }),
        || Ok(Value::Null),
        |_| Ok(()),
        |i| Ok(i.clone()),
    )
    .unwrap();
    cancelled.store(true, Ordering::Release);
    assert!(
        receipt
            .consume::<()>(
                || Ok(Value::Null),
                |_| Ok(()),
                |_| panic!("cancelled effect")
            )
            .is_err()
    );
    let expired = AdmissionLifetime {
        cancelled: vec![],
        deadline: Some(std::time::Instant::now()),
    };
    assert!(expired.check().is_err());
}
#[test]
fn drain_honors_priority_dependencies_expiry_retry_pause_and_project_filter() {
    use pacer_lifecycle::RouteAdmission;
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    for (suffix, priority) in [(1, 0), (2, 10), (3, 20), (4, 30)] {
        let mut t = task(&format!("t-20261102-000000-{suffix:04}"));
        t["queue"] = json!({"reason":"no_slot","since":1,"position":1});
        if suffix == 3 {
            t["queue"]["nextAt"] = json!(10);
        }
        state
            .create(
                &t,
                Some(&json!({"priority":priority,"expiresAt":if suffix==4 {1}else{100}})),
                None,
                1.0,
            )
            .unwrap();
    }
    assert!(
        state
            .drain(
                2.0,
                true,
                |_| panic!("paused policy"),
                |_| panic!("paused launch")
            )
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        state.read("t-20261102-000000-0004").unwrap().unwrap()["state"],
        "failed"
    );
    let launched = state
        .drain(
            2.0,
            false,
            |_| Ok(vec![DrainRoute::local("codex", 1)]),
            |_| Ok(None),
        )
        .unwrap();
    assert_eq!(launched, ["t-20261102-000000-0002"]);
    state
        .drain_admitted(
            3.0,
            false,
            |_| {
                Ok(RouteAdmission {
                    routes: vec![],
                    project_limited: true,
                    excluded_detail: "refused".into(),
                    revalidate: Box::new(|_, _| Ok(())),
                })
            },
            |_| panic!("project denied launch"),
        )
        .unwrap();
    assert_eq!(
        state.read("t-20261102-000000-0001").unwrap().unwrap()["state"],
        "limit"
    );
}
#[test]
fn admission_lock_artifacts_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    state
        .drain(2.0, false, |_| Ok(vec![]), |_| Ok(None))
        .unwrap();
    assert_eq!(
        std::fs::metadata(dir.path().join("orca"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
}

#[test]
fn full_prepared_delegate_restricts_amendments_and_guards_the_final_insert() {
    use std::cell::Cell;
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let strategy = json!({"providers":{"codex":{}},"planner":{"agent":"other","account":"other"},"runners":{"codex":{"id":"codex","agent":"codex","account":"default","host":null}},"accounts":{}});
    let revision = Cell::new(1);
    let snapshot = || {
        Ok(
            json!({"strategy":strategy,"projects":{"version":1,"projects":{}},"repo":null,"exclusions":{},"policyRev":revision.get()}),
        )
    };
    let input = json!({"brief":{"goal":"work","repo":repo},"executor":"codex","dispatch":{},"worktree":"auto"});
    assert!(
        PreparedAdmission::prepare_delegate(input.clone(), &[], None, snapshot, |i| {
            let mut next = i.clone();
            next["brief"]["goal"] = json!("replacement");
            Ok(next)
        })
        .is_err()
    );
    let mut receipt = PreparedAdmission::prepare_delegate(input, &[], None, snapshot, |i| {
        let mut next = i.clone();
        next["worktree"] = json!("new");
        Ok(next)
    })
    .unwrap();
    let mut copy = receipt.input();
    copy["brief"]["goal"] = json!("tampered");
    assert_eq!(receipt.input()["brief"]["goal"], "work");
    let mut state = AdmissionState::open(dir.path().join("home")).unwrap();
    let id = "t-20261102-000000-0001";
    assert!(
        state
            .create_prepared(&mut receipt, 1.0, snapshot, |input| {
                revision.set(2);
                let mut record = task(id);
                record["brief"] = input["brief"].clone();
                Ok(record)
            })
            .is_err()
    );
    assert!(state.read(id).unwrap().is_none());
    assert!(state.work(id).unwrap().is_none());
    assert!(
        !dir.path()
            .join("home/tasks")
            .join(format!("{id}.json"))
            .exists()
    );
}

#[test]
fn mutation_admission_checks_revision_before_any_effect() {
    use pacer_lifecycle::MutationError;
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    let id = "t-20261102-000000-0001";
    state.create(&task(id), None, None, 1.0).unwrap();
    let mut effects = 0;
    let error = state
        .mutate(id, 2.0, 2.0, |_, _| {
            effects += 1;
            Ok(())
        })
        .unwrap_err();
    assert!(matches!(error,MutationError::Conflict {task} if task["rev"]==1));
    assert_eq!(effects, 0);
    for rev in [0.0, -1.0, 1.5, 9_007_199_254_740_992.0] {
        assert!(
            state
                .mutate(id, rev, 2.0, |_, _| panic!("invalid revision effect"))
                .is_err()
        );
    }
    assert_eq!(
        state
            .mutate(id, 1.0, 2.0, |_, t| {
                t["dismissed"] = json!(true);
                Ok(())
            })
            .unwrap()["rev"],
        2
    );
}

#[test]
fn project_policy_reads_fail_closed_and_references_keep_exact_identity() {
    use pacer_lifecycle::{
        project_selection, read_project_strategies, validate_project_strategies,
    };
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(
        read_project_strategies(dir.path()).unwrap(),
        json!({"version":1,"projects":{}})
    );
    for value in [
        json!({}),
        json!({"version":1,"projects":{"local:abcdef123456":{"rev":1,"executors":[]}}}),
        json!({"version":1,"projects":{"local:abcdef123456":{"rev":1,"executors":["codex"]}}}),
    ] {
        std::fs::write(
            dir.path().join("project-strategies.json"),
            value.to_string(),
        )
        .unwrap();
        assert!(read_project_strategies(dir.path()).is_err());
    }
    let projects = json!({"version":1,"projects":{"local:abcdef123456":{"rev":1,"executors":["codex#old@local"]}}});
    assert!(validate_project_strategies(&projects).is_ok());
    let strategy =
        json!({"runners":{"codex":{"id":"codex","agent":"codex","account":"new","host":null}}});
    assert_eq!(
        project_selection(&strategy, "local:abcdef123456", &projects).unwrap()["executors"],
        json!(["codex#old@local"])
    );
}

#[test]
fn read_only_drain_has_no_policy_or_write_effects() {
    use pacer_lifecycle::DrainOptions;
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    let id = "t-20261102-000000-0001";
    let mut t = task(id);
    t["queue"] = json!({"reason":"no_slot","since":1,"position":1});
    state.create(&t, None, None, 1.0).unwrap();
    assert!(
        state
            .drain_with_options(
                2.0,
                DrainOptions {
                    read_only: true,
                    ..Default::default()
                },
                |_| panic!("read-only policy"),
                |_| panic!("read-only launch")
            )
            .unwrap()
            .is_empty()
    );
    assert_eq!(state.read(id).unwrap().unwrap(), t);
    assert!(!dir.path().join("orca").exists());
}

#[test]
fn receipt_context_tracks_js_serialization_order_and_number_equivalence() {
    let mut receipt = PreparedAdmission::prepare(
        json!({}),
        &[],
        None,
        || Ok(json!({"a":1,"b":2})),
        |_| Ok(()),
        |i| Ok(i.clone()),
    )
    .unwrap();
    assert!(
        receipt
            .consume::<()>(
                || Ok(json!({"b":2,"a":1})),
                |_| Ok(()),
                |_| panic!("reordered context effect")
            )
            .is_err()
    );
    let mut receipt = PreparedAdmission::prepare(
        json!({}),
        &[],
        None,
        || Ok(json!({"a":1.0})),
        |_| Ok(()),
        |i| Ok(i.clone()),
    )
    .unwrap();
    receipt
        .consume(|| Ok(json!({"a":1})), |_| Ok(()), |_| Ok(()))
        .unwrap();
}

#[test]
fn queue_project_and_removed_runner_checks_precede_pause_and_policy() {
    use pacer_lifecycle::{DrainOptions, queue_preflight};
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    let id = "t-20261102-000000-0001";
    let mut record = task(id);
    record["requestedExecutor"] = json!("removed");
    record["queue"] = json!({"reason":"paused","since":1,"position":1});
    state.create(&record, None, None, 1.0).unwrap();
    let s = json!({"runners":{}});
    let projects = json!({"version":1,"projects":{}});
    let repo = json!({"key":"local:abcdef123456"});
    state
        .drain_checked(
            2.0,
            DrainOptions {
                paused: true,
                ..Default::default()
            },
            |task| queue_preflight(&s, &projects, &repo, task),
            |_| panic!("removed runner policy"),
            |_| panic!("removed runner launch"),
        )
        .unwrap();
    let task = state.read(id).unwrap().unwrap();
    assert_eq!(task["state"], "failed");
    assert_eq!(task["result"]["executor"], "removed");
    let projects = json!({"version":1,"projects":{"local:abcdef123456":{"rev":1,"executors":["codex#old@local"]}}});
    assert!(
        queue_preflight(&s, &projects, &repo, &record)
            .unwrap_err()
            .0
            .contains("forbidden")
    );
}

#[test]
fn strategy_dispatch_default_registers_the_root_in_the_creation_transaction() {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    std::fs::create_dir(&repo).unwrap();
    let snapshot = json!({"strategy":{"providers":{},"runners":{},"planner":{},"dispatch":{}},"projects":{"version":1,"projects":{}},"repo":null,"exclusions":{}});
    let mut receipt = PreparedAdmission::prepare_delegate(
        json!({"brief":{"repo":repo,"goal":"work"}}),
        &[],
        None,
        || Ok(snapshot.clone()),
        |i| Ok(i.clone()),
    )
    .unwrap();
    let mut state = AdmissionState::open(dir.path().join("home")).unwrap();
    let id = "t-20261102-000000-0001";
    state
        .create_prepared(
            &mut receipt,
            1.0,
            || Ok(snapshot.clone()),
            |input| {
                let mut t = task(id);
                t["brief"] = input["brief"].clone();
                Ok(t)
            },
        )
        .unwrap();
    assert_eq!(state.work(id).unwrap().unwrap()["rootId"], id);
}
