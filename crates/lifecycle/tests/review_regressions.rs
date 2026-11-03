#![allow(clippy::unwrap_used)]
use pacer_lifecycle::{
    AdmissionState, DrainRoute, MutationError, PreparedAdmission, read_project_strategies,
};
use serde_json::{Value, json};

fn queued(id: &str) -> Value {
    json!({"id":id,"rev":1,"brief":{"repo":"/repo","goal":"work"},"state":"queued","createdAt":1,"attempts":[],"timeoutS":60,"requestedExecutor":null,"queue":{"reason":"no_slot","since":1,"position":1}})
}

#[test]
fn project_and_mutation_numeric_goldens_use_real_admission_boundaries() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/numeric-goldens.json"
    ))
    .unwrap();
    for row in rows {
        let dir = tempfile::tempdir().unwrap();
        if let Some(project) = row.get("project") {
            pacer_foundation::fsutil::write_json_atomic(
                &dir.path().join("project-strategies.json"),
                project,
            )
            .unwrap();
            assert_eq!(
                read_project_strategies(dir.path()).is_ok(),
                row["accept"] == true,
                "{}",
                row["id"]
            );
        }
        if let Some(input) = row.get("mutation") {
            let mut state = AdmissionState::open(dir.path()).unwrap();
            let id = "t-20261102-000000-0001";
            state.create(&queued(id), None, None, 1.0).unwrap();
            state
                .tasks
                .edit(id, 1, 1.0, |t| {
                    t.put("/state", pacer_js_json::WireReply::new(json!("done")))
                })
                .unwrap();
            let result = state.mutate(id, input["expect_rev"].as_f64().unwrap(), 2.0, |_, _| {
                panic!("must refuse before effects")
            });
            if row["accept"] == true {
                assert!(
                    matches!(result, Err(MutationError::Conflict { .. })),
                    "{}: {result:?}",
                    row["id"]
                );
            } else {
                assert!(
                    matches!(result, Err(MutationError::Admission(_))),
                    "{}: {result:?}",
                    row["id"]
                );
            }
        }
    }
}

#[test]
fn receipt_context_uses_js_stringify_equivalence() {
    let rows: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/task-admission/context-goldens.json"
    ))
    .unwrap();
    for row in rows {
        let a: Value = serde_json::from_str(row["aJson"].as_str().unwrap()).unwrap();
        let b: Value = serde_json::from_str(row["bJson"].as_str().unwrap()).unwrap();
        let mut receipt = PreparedAdmission::prepare(
            json!({}),
            &[],
            None,
            || Ok(a.clone()),
            |_| Ok(()),
            |i| Ok(i.clone()),
        )
        .unwrap();
        assert_eq!(
            receipt
                .consume(|| Ok(b.clone()), |_| Ok(()), |_| Ok(()))
                .is_ok(),
            row["same"] == true,
            "{}",
            row["id"]
        );
    }
}

#[test]
fn drain_rechecks_pause_after_authorization_and_after_final_policy_guard() {
    for at_final_guard in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let mut state = AdmissionState::open(dir.path()).unwrap();
        let id = "t-20261102-000000-0001";
        state.create(&queued(id), None, None, 1.0).unwrap();
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let path = dir.path().join("state/pause.json");
        let writer = std::thread::spawn(move || {
            ready_rx.recv().unwrap();
            pacer_foundation::fsutil::write_private(
                &path,
                br#"{"until":100,"reason":"\ud800","by":"\udfff"}"#,
            )
            .unwrap();
            done_tx.send(()).unwrap();
        });
        let synchronize = || {
            ready_tx.send(()).unwrap();
            done_rx.recv().unwrap();
        };
        let spawned = state
            .drain_admitted(
                2.0,
                false,
                |_| {
                    let mut admission =
                        pacer_lifecycle::RouteAdmission::unrestricted(vec![DrainRoute::local(
                            "codex", 1,
                        )]);
                    if at_final_guard {
                        admission.revalidate = Box::new(|_, _| {
                            synchronize();
                            Ok(())
                        });
                    } else {
                        synchronize();
                    }
                    Ok(admission)
                },
                |_| panic!("paused task launched"),
            )
            .unwrap();
        writer.join().unwrap();
        assert!(spawned.is_empty());
        assert_eq!(state.read(id).unwrap().unwrap()["state"], "queued");
    }
}

#[test]
fn policy_cannot_change_requested_executor_or_weaken_isolation() {
    let dir = tempfile::tempdir().unwrap();
    let snapshot = json!({
        "strategy": {"providers":{"codex":{}},"planner":{"agent":"other","account":"other"},
            "accounts":{},"runners":{
                "codex":{"id":"codex","agent":"codex","account":"default","host":null},
                "second":{"id":"second","agent":"codex","account":"second","host":null}}},
        "projects":{"version":1,"projects":{}},"repo":null,"exclusions":{}
    });
    let input =
        json!({"brief":{"goal":"work","repo":dir.path()},"executor":"codex","worktree":"new"});
    for (field, value) in [
        ("executor", json!("second")),
        ("executor", Value::Null),
        ("worktree", json!("current")),
        ("worktree", json!("auto")),
    ] {
        let result = PreparedAdmission::prepare_delegate(
            input.clone(),
            &[],
            None,
            || Ok(snapshot.clone()),
            |candidate| {
                let mut next = candidate.clone();
                next[field] = value;
                Ok(next)
            },
        );
        assert!(result.is_err(), "policy amended {field}");
    }
    for placement in ["auto", "current", "new"] {
        let mut input = input.clone();
        input["worktree"] = json!(placement);
        assert!(
            PreparedAdmission::prepare_delegate(
                input,
                &[],
                None,
                || Ok(snapshot.clone()),
                |candidate| {
                    let mut next = candidate.clone();
                    next["worktree"] = json!("new");
                    Ok(next)
                }
            )
            .is_ok()
        );
    }
}
