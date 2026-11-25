#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-prepared.test.ts. The Rust builder
//! is `&mut`, so the TS promise-race cases assert sequential join semantics.
use pacer_plugin::install::{
    PlanEnv, PlannerCommandIntent, PlannerCommandResult, PlannerRecord, PreparedPlannerIo,
    RunOptions, prepare_planner_install,
};
use std::sync::{Arc, Mutex};

fn env() -> PlanEnv {
    let mut env = PlanEnv::new(1, &["pacer"]);
    env.planner_key = Some("claude".into());
    env
}

fn ok() -> PlannerCommandResult {
    PlannerCommandResult {
        code: 0,
        stdout: "actual output".into(),
        stderr: String::new(),
    }
}

fn io<F>(run: F) -> PreparedPlannerIo
where
    F: Fn(
            PlannerCommandIntent,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<PlannerCommandResult, String>> + Send>,
        > + Send
        + Sync
        + 'static,
{
    PreparedPlannerIo::from_parts(
        pacer_plugin::install::PlanIo::new(|_| async { Ok(None) }),
        Arc::new(run),
    )
}

// test/plugin-sdk-install-prepared.test.ts:6 real results control probes and note order
#[tokio::test]
async fn real_results_control_probes_and_note_order() {
    let admitted: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&admitted);
    let backend = io(move |intent| {
        let log = Arc::clone(&log);
        Box::pin(async move {
            log.lock().unwrap().push(format!("{:?}", intent));
            match intent.argv.first().map(String::as_str) {
                Some("get") => Ok(PlannerCommandResult {
                    code: 1,
                    stdout: "missing".into(),
                    stderr: String::new(),
                }),
                Some("bad") => Ok(PlannerCommandResult {
                    code: 2,
                    stdout: "fallback\nsecond".into(),
                    stderr: "problem\nsecond".into(),
                }),
                Some("throw") => Err("spawn failed".into()),
                _ => Ok(ok()),
            }
        })
    });
    let plan = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async {
            assert_eq!((tx.run_raw(&["get".into()], None).await.unwrap()).code, 1);
            tx.run(
                &["add".into()],
                Some(&["remove".into()]),
                RunOptions {
                    quiet: None,
                    success_note: Some("added".into()),
                },
            )
            .await
            .unwrap();
            tx.run(
                &["bad".into()],
                Some(&["remove".into()]),
                RunOptions::default(),
            )
            .await
            .unwrap();
            tx.run(
                &["throw".into()],
                Some(&["undo-throw".into()]),
                RunOptions::default(),
            )
            .await
            .unwrap();
            tx.run(
                &["bad".into()],
                None,
                RunOptions {
                    quiet: Some(true),
                    success_note: None,
                },
            )
            .await
            .unwrap();
            tx.plan.notes.push("Pipe note".into());
            Ok(())
        })
    })
    .await
    .unwrap();
    assert_eq!(
        plan.notes,
        vec![
            "added",
            "`bad` failed (exit 2): problem",
            "`throw` failed: spawn failed",
            "Pipe note"
        ]
    );
    assert_eq!(plan.record.notes, plan.notes);
    assert_eq!(
        plan.record
            .commands
            .iter()
            .map(|c| c.undo.clone())
            .collect::<Vec<_>>(),
        vec![vec!["remove"], vec!["undo-throw"]]
    );
    assert!(admitted.lock().unwrap()[1].contains("undo: Some([\"remove\"])"));
    assert!(admitted.lock().unwrap()[1].contains("timeout_ms: 30000"));
}

// test/plugin-sdk-install-prepared.test.ts:27 raw probe/remove status precedence
#[tokio::test]
async fn raw_probe_and_remove_status_precedence() {
    for get in [0i32, 1, -1] {
        for remove in [0i32, 1, -1] {
            let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let log = Arc::clone(&calls);
            let backend = io(move |intent| {
                let log = Arc::clone(&log);
                let (get, remove) = (get, remove);
                Box::pin(async move {
                    let name = intent.argv[0].clone();
                    log.lock().unwrap().push(name.clone());
                    let status = if name == "get" { get } else { remove };
                    if status == -1 {
                        Err("offline".into())
                    } else {
                        Ok(PlannerCommandResult {
                            code: status,
                            stdout: String::new(),
                            stderr: String::new(),
                        })
                    }
                })
            });
            let plan = prepare_planner_install(backend, env(), None, |tx| {
                Box::pin(async {
                    let outcome = match tx.run_raw(&["get".into()], None).await {
                        Ok(result) => result.code == 0,
                        Err(_) => {
                            tx.plan.notes.push("not installed".into());
                            return Ok(());
                        }
                    };
                    if outcome {
                        match tx.run_raw(&["remove".into()], None).await {
                            Ok(result) => tx.plan.notes.push(
                                if result.code == 0 {
                                    "removed"
                                } else {
                                    "remove failed"
                                }
                                .into(),
                            ),
                            Err(_) => tx.plan.notes.push("not installed".into()),
                        }
                    }
                    Ok(())
                })
            })
            .await
            .unwrap();
            let expected_calls = if get == 0 {
                vec!["get", "remove"]
            } else {
                vec!["get"]
            };
            assert_eq!(calls.lock().unwrap().as_slice(), expected_calls);
            let expected_notes: Vec<&str> = if get == -1 || (get == 0 && remove == -1) {
                vec!["not installed"]
            } else if get == 0 {
                vec![if remove == 0 {
                    "removed"
                } else {
                    "remove failed"
                }]
            } else {
                vec![]
            };
            assert_eq!(plan.notes, expected_notes);
        }
    }
}

// test/plugin-sdk-install-prepared.test.ts:46 detached metadata and snapshots
#[tokio::test]
async fn queued_metadata_and_snapshots_detached() {
    let intents: Arc<Mutex<Vec<PlannerCommandIntent>>> = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&intents);
    let backend = io(move |intent| {
        let log = Arc::clone(&log);
        Box::pin(async move {
            log.lock().unwrap().push(intent);
            Ok(ok())
        })
    });
    let plan = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async {
            let argv = vec!["add".to_string()];
            let undo = vec!["remove".to_string()];
            tx.run(
                &argv,
                Some(&undo),
                RunOptions {
                    quiet: None,
                    success_note: Some("original".into()),
                },
            )
            .await
            .unwrap();
            let mut copied = argv.clone();
            copied[0] = "changed".into();
            let mut copied_undo = undo.clone();
            copied_undo[0] = "changed".into();
            tx.run(
                &copied,
                Some(&copied_undo),
                RunOptions {
                    quiet: Some(true),
                    success_note: None,
                },
            )
            .await
            .unwrap();
            tx.plan
                .edit("/file", |_| Ok("bytes".into()), vec![], None)
                .await
                .unwrap();
            Ok(())
        })
    })
    .await
    .unwrap();
    assert_eq!(intents.lock().unwrap()[0].argv, vec!["add"]);
    assert_eq!(plan.record.commands[0].undo, vec!["remove"]);
    assert_eq!(plan.notes, vec!["original"]);
    assert_eq!(plan.files[0].after.as_deref(), Some("bytes"));
}

// test/plugin-sdk-install-prepared.test.ts:64 caught staging failure rejects
#[tokio::test]
async fn caught_staging_failure_rejects() {
    let admitted: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&admitted);
    let backend = PreparedPlannerIo::new(
        |_| async { Err("read denied".into()) },
        move |intent| {
            let log = Arc::clone(&log);
            Box::pin(async move {
                log.lock().unwrap().push(intent.argv[0].clone());
                Ok(ok())
            })
        },
    );
    let error = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async {
            tx.run(
                &["add".into()],
                Some(&["remove".into()]),
                RunOptions::default(),
            )
            .await
            .unwrap();
            let _ = tx
                .plan
                .edit("/file", |_| Ok("new".into()), vec![], None)
                .await;
            Ok(())
        })
    })
    .await
    .unwrap_err();
    assert!(error.contains("read denied"));
    assert_eq!(admitted.lock().unwrap().as_slice(), &["add"]);
}

// test/plugin-sdk-install-prepared.test.ts:72 reconcile rejects command helpers
#[tokio::test]
async fn reconcile_rejects_command_helpers() {
    let calls = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&calls);
    let backend = io(move |_| {
        let counter = Arc::clone(&counter);
        Box::pin(async move {
            *counter.lock().unwrap() += 1;
            Ok(ok())
        })
    });
    let mut reconciled = env();
    reconciled.mode = Some("reconcile".into());
    let error = prepare_planner_install(backend, reconciled, None, |tx| {
        Box::pin(async {
            assert!(
                tx.run(&["add".into()], None, RunOptions::default())
                    .await
                    .is_err()
            );
            assert!(tx.run_raw(&["get".into()], None).await.is_err());
            Ok(())
        })
    })
    .await
    .unwrap_err();
    assert!(error.contains("cannot execute"));
    assert_eq!(*calls.lock().unwrap(), 0);
}

// test/plugin-sdk-install-prepared.test.ts:80 missing or mismatched bindings fail early
#[tokio::test]
async fn missing_or_mismatched_bindings_fail_early() {
    let calls = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&calls);
    let backend = io(move |_| {
        let counter = Arc::clone(&counter);
        Box::pin(async move {
            *counter.lock().unwrap() += 1;
            Ok(ok())
        })
    });
    let mut missing = PlanEnv::new(1, &["pacer"]);
    missing.planner_key = None;
    let error = prepare_planner_install(backend.clone(), missing, None, |_| {
        Box::pin(async { Ok(()) })
    })
    .await
    .unwrap_err();
    assert!(error.contains("identity missing"));
    let prior = record("other");
    let error =
        prepare_planner_install(backend, env(), Some(&prior), |_| Box::pin(async { Ok(()) }))
            .await
            .unwrap_err();
    assert!(error.contains("identity mismatch"));
    assert_eq!(*calls.lock().unwrap(), 0);
}

fn record(planner: &str) -> PlannerRecord {
    PlannerRecord {
        mcp: None,
        integration: None,
        planner: planner.into(),
        account: None,
        folder: None,
        config_env: None,
        installed_at: 1,
        pacer_argv: vec![],
        files: vec![],
        commands: vec![],
        notes: vec![],
        undo_connect: None,
        undone_at: None,
    }
}

// test/plugin-sdk-install-prepared.test.ts:87 detached undo and drain on failure
#[tokio::test]
async fn detached_undo_and_drain_on_failure() {
    let undo = vec!["remove".to_string()];
    let observed = Arc::new(Mutex::new(Vec::new()));
    let log = Arc::clone(&observed);
    let backend = io(move |intent| {
        let log = Arc::clone(&log);
        Box::pin(async move {
            log.lock().unwrap().push(intent.undo.unwrap_or_default());
            Ok(ok())
        })
    });
    let error = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async move {
            tx.run(&["add".into()], Some(&undo), RunOptions::default())
                .await
                .unwrap();
            Err("callback failure".into())
        })
    })
    .await
    .unwrap_err();
    assert_eq!(error, "callback failure");
    assert_eq!(observed.lock().unwrap().as_slice(), &[vec!["remove"]]);
}

// test/plugin-sdk-install-prepared.test.ts:104 raw undo claims retained
#[tokio::test]
async fn raw_undo_claims_retained() {
    let backend = io(|intent| {
        Box::pin(async move {
            if intent.argv[0] == "throw" {
                Err("spawn".into())
            } else {
                Ok(PlannerCommandResult {
                    code: 3,
                    stdout: String::new(),
                    stderr: String::new(),
                })
            }
        })
    });
    let plan = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async {
            tx.run_raw(&["bad".into()], Some(&["undo".into()]))
                .await
                .unwrap();
            let _ = tx
                .run_raw(&["throw".into()], Some(&["undo-throw".into()]))
                .await;
            Ok(())
        })
    })
    .await
    .unwrap();
    assert_eq!(
        plan.record
            .commands
            .iter()
            .map(|c| c.undo.clone())
            .collect::<Vec<_>>(),
        vec![vec!["undo"], vec!["undo-throw"]]
    );
}

// test/plugin-sdk-install-prepared.test.ts:114 callback cannot bypass drain
#[tokio::test]
async fn callback_cannot_bypass_drain() {
    let drained = Arc::new(Mutex::new(false));
    let flag = Arc::clone(&drained);
    let backend = io(move |_| {
        let flag = Arc::clone(&flag);
        Box::pin(async move {
            *flag.lock().unwrap() = true;
            Ok(ok())
        })
    });
    let error = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async move {
            tx.run(
                &["add".into()],
                Some(&["remove".into()]),
                RunOptions::default(),
            )
            .await
            .unwrap();
            let prepared = tx.prepare().await.unwrap();
            assert!(!prepared.record.commands.is_empty());
            Err("callback failed after prepare".into())
        })
    })
    .await
    .unwrap_err();
    assert_eq!(error, "callback failed after prepare");
    assert!(*drained.lock().unwrap());
}

// test/plugin-sdk-install-prepared.test.ts:140 sequential join of preparation snapshots
#[tokio::test]
async fn concurrent_preparation_joins() {
    let backend = PreparedPlannerIo::new(
        |_| async { Ok(None) },
        |_| {
            Box::pin(async { Ok(ok()) })
                as std::pin::Pin<
                    Box<
                        dyn std::future::Future<Output = Result<PlannerCommandResult, String>>
                            + Send,
                    >,
                >
        },
    );
    let plan = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async {
            tx.run(
                &["add".into()],
                Some(&["remove".into()]),
                RunOptions::default(),
            )
            .await
            .unwrap();
            let first = tx.prepare().await.unwrap();
            let second = tx.prepare().await.unwrap();
            assert_eq!(first, second);
            Ok(())
        })
    })
    .await
    .unwrap();
    assert_eq!(plan.record.commands[0].undo, vec!["remove"]);
}

// test/plugin-sdk-install-prepared.test.ts:165 cancellation before admission drains admitted
#[tokio::test]
async fn cancellation_before_admission_drains_admitted() {
    let cancel = tokio_util::sync::CancellationToken::new();
    let calls = Arc::new(Mutex::new(0));
    let counter = Arc::clone(&calls);
    let backend = io(move |_| {
        let counter = Arc::clone(&counter);
        Box::pin(async move {
            *counter.lock().unwrap() += 1;
            Ok(ok())
        })
    })
    .with_signal(cancel.clone());
    cancel.cancel();
    let error = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async {
            tx.run(&["denied".into()], None, RunOptions::default())
                .await
                .map_err(|e| e.0)
        })
    })
    .await
    .unwrap_err();
    assert!(error.contains("cancelled"));
    assert_eq!(*calls.lock().unwrap(), 0);
}

// test/plugin-sdk-install-prepared.test.ts:181 mutated planner identity rejects
#[tokio::test]
async fn mutated_identity_rejects() {
    let backend = io(|_| Box::pin(async { Ok(ok()) }));
    let error = prepare_planner_install(backend, env(), None, |tx| {
        Box::pin(async {
            tx.plan.record.planner = "other".into();
            Ok(())
        })
    })
    .await
    .unwrap_err();
    assert!(error.contains("identity mismatch"));
}
