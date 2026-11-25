#![allow(clippy::unwrap_used)]
//! Transcribed from test/plugin-sdk-install-plan.test.ts.
use pacer_plugin::install::{
    BlockStyle, FileImage, InstallPlan, PendingFile, PlanEnv, PlanIo, PlannerRecord, UndoOp,
    sha256, upsert_block,
};
use serde_json::Value;
use std::sync::{Arc, Mutex};

const ORACLE: &str = include_str!("fixtures/install/plan-oracle.json");
const NOW: i64 = 1700000000;

type Files = Arc<Mutex<std::collections::BTreeMap<String, FileImage>>>;

fn memory(
    initial: &[(&str, &str, u32)],
    signal: Option<tokio_util::sync::CancellationToken>,
) -> (Files, Arc<Mutex<Vec<String>>>, PlanIo) {
    let files: Files = Arc::new(Mutex::new(
        initial
            .iter()
            .map(|(p, t, m)| {
                (
                    p.to_string(),
                    FileImage {
                        text: t.to_string(),
                        mode: *m,
                    },
                )
            })
            .collect(),
    ));
    let reads = Arc::new(Mutex::new(Vec::new()));
    let reader_files = Arc::clone(&files);
    let reader_log = Arc::clone(&reads);
    let io = PlanIo::new(move |path| {
        let files = Arc::clone(&reader_files);
        let log = Arc::clone(&reader_log);
        async move {
            log.lock().unwrap().push(path.clone());
            Ok(files.lock().unwrap().get(&path).cloned())
        }
    });
    (
        files,
        reads,
        match signal {
            Some(signal) => io.with_signal(signal),
            None => io,
        },
    )
}

fn block() -> Vec<UndoOp> {
    vec![UndoOp::Block {
        style: BlockStyle::Md,
        restore: None,
    }]
}

fn record(planner: &str, files: Vec<pacer_plugin::install::FileChange>) -> PlannerRecord {
    PlannerRecord {
        mcp: None,
        integration: None,
        planner: planner.into(),
        account: None,
        folder: None,
        config_env: None,
        installed_at: 1,
        pacer_argv: vec!["old".into()],
        files,
        commands: vec![],
        notes: vec![],
        undo_connect: None,
        undone_at: None,
    }
}

// test/plugin-sdk-install-plan.test.ts:16 staging matches host pending bytes, modes, records
#[tokio::test]
async fn staging_matches_host_pending_bytes_modes_records() {
    let oracle: Value = serde_json::from_str(ORACLE).unwrap();
    let (_, _, io) = memory(
        &[
            ("$HOME/AGENTS.md", "mine\n", 0o600),
            ("$HOME/legacy.sh", "legacy\n", 0o700),
        ],
        None,
    );
    let mut env = PlanEnv::new(NOW, &["pacer"]);
    env.mcp = Some(true);
    env.planner_account = Some("account".into());
    env.folder = Some("$HOME".into());
    let mut config = std::collections::BTreeMap::new();
    config.insert("CODEX_HOME".into(), "$HOME".into());
    env.config_env = Some(config);
    let mut plan = InstallPlan::new(io, env, "codex", None);
    for body in ["one", "two"] {
        assert!(
            plan.edit(
                "$HOME/AGENTS.md",
                |old| upsert_block(old.unwrap_or_default(), body, BlockStyle::Md),
                block(),
                None,
            )
            .await
            .unwrap()
        );
    }
    plan.move_aside("$HOME/legacy.sh").await.unwrap();
    plan.move_aside("$HOME/legacy.sh").await.unwrap();
    plan.edit("$HOME/new", |_| Ok("new\n".into()), vec![], None)
        .await
        .unwrap();

    let expected_files = oracle["record"]["files"].as_array().unwrap();
    assert_eq!(plan.record.files.len(), expected_files.len());
    for file in &plan.record.files {
        let expected = expected_files
            .iter()
            .find(|f| f["path"] == file.path)
            .unwrap_or_else(|| panic!("no oracle file for {}", file.path));
        assert_eq!(file.action, expected["action"].as_str().unwrap());
        assert_eq!(
            file.after_hash,
            expected["afterHash"].as_str().map(str::to_string)
        );
        assert_eq!(
            file.managed,
            serde_json::from_value(expected["managed"].clone()).unwrap()
        );
        assert_eq!(file.exact, expected["exact"].as_bool());
    }
    assert_eq!(
        plan.record.planner,
        oracle["record"]["planner"].as_str().unwrap()
    );
    assert_eq!(
        plan.record.account,
        oracle["record"]["account"].as_str().map(str::to_string)
    );
    assert_eq!(
        plan.touched.len(),
        oracle["touched"].as_array().unwrap().len()
    );
    assert_eq!(
        plan.notes,
        oracle["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap().to_string())
            .collect::<Vec<_>>()
    );
    let staged = plan.pending.get("$HOME/AGENTS.md").unwrap();
    assert_eq!(staged.before.as_deref(), Some("mine\n"));
    assert_eq!(
        staged.after.as_deref(),
        Some("mine\n\n<!-- >>> pacer >>> -->\ntwo\n<!-- <<< pacer <<< -->\n")
    );
}

// test/plugin-sdk-install-plan.test.ts:37 backup collisions probed
#[tokio::test]
async fn backup_collisions_probed() {
    let (_, _, io) = memory(&[("/a/same", "a", 0o755), ("/b/same", "b", 0o600)], None);
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
    plan.edit("/a/same", |_| Ok("new-a".into()), vec![], Some("/backup"))
        .await
        .unwrap();
    plan.edit("/b/same", |_| Ok("new-b".into()), vec![], Some("/backup"))
        .await
        .unwrap();
    let first = plan.record.files[0].backup.clone().unwrap();
    let second = plan.record.files[1].backup.clone().unwrap();
    assert_eq!(second, format!("{first}-2"));
    assert_eq!(
        plan.pending.get(&first),
        Some(&PendingFile {
            path: first.clone(),
            before: None,
            after: Some("a".into()),
            mode: Some(0o700),
            before_mode: None,
        })
    );
    assert_eq!(plan.pending.get(&second).unwrap().mode, Some(0o600));
}

// test/plugin-sdk-install-plan.test.ts:50 only null means missing
#[tokio::test]
async fn only_none_means_missing() {
    let (_, _, io) = memory(&[("/empty", "", 0o600)], None);
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
    assert_eq!(plan.read("/missing").await.unwrap(), None);
    assert_eq!(plan.read("/empty").await.unwrap(), Some(String::new()));
    assert!(
        !plan
            .edit(
                "/empty",
                |old| Ok(old.unwrap_or_default().to_string()),
                vec![],
                None
            )
            .await
            .unwrap()
    );
    assert!(plan.pending.is_empty());
    let io = PlanIo::new(|_| async { Err("owned unreadable fixture".into()) });
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
    assert_eq!(
        plan.read("/unreadable").await.unwrap_err().0,
        "owned unreadable fixture"
    );
    assert!(
        plan.edit("/unreadable", |_| Ok("new".into()), vec![], None)
            .await
            .is_err()
    );
    assert!(plan.pending.is_empty());
}

// test/plugin-sdk-install-plan.test.ts:60 prior user edits set exact false
#[tokio::test]
async fn prior_user_edits_set_exact_false() {
    let prior = record(
        "codex",
        vec![pacer_plugin::install::FileChange {
            path: "/file".into(),
            action: "edited".into(),
            managed: None,
            backup: Some("/original-backup".into()),
            after_hash: Some(sha256("original")),
            exact: Some(true),
            undo: block(),
        }],
    );
    let before = serde_json::to_string(&prior).unwrap();
    let (_, _, io) = memory(&[("/file", "user-edited", 0o700)], None);
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", Some(&prior));
    assert!(
        !plan
            .edit("/file", |old| Ok(old.unwrap().to_string()), vec![], None)
            .await
            .unwrap()
    );
    let file = &plan.record.files[0];
    assert_eq!(file.exact, Some(false));
    assert_eq!(file.backup.as_deref(), Some("/original-backup"));
    assert_eq!(
        file.after_hash.as_deref(),
        Some(sha256("user-edited").as_str())
    );
    let staged = plan.pending.get("/file").unwrap();
    assert_eq!(staged.before.as_deref(), Some("user-edited"));
    assert_eq!(staged.before_mode, Some(0o700));
    assert!(plan.touched.is_empty());
    assert_eq!(plan.record.installed_at, 1);
    assert_eq!(serde_json::to_string(&prior).unwrap(), before);
}

// test/plugin-sdk-install-plan.test.ts:69 re-edits keep first precondition
#[tokio::test]
async fn re_edits_keep_first_precondition() {
    let (files, _, io) = memory(&[("/file", "before", 0o700)], None);
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
    plan.edit(
        "/file",
        |old| Ok(format!("{}-one", old.unwrap())),
        vec![],
        None,
    )
    .await
    .unwrap();
    plan.edit(
        "/file",
        |old| Ok(format!("{}-two", old.unwrap())),
        vec![],
        None,
    )
    .await
    .unwrap();
    files.lock().unwrap().insert(
        "/file".into(),
        FileImage {
            text: "external".into(),
            mode: 0o600,
        },
    );
    assert_eq!(
        plan.read("/file").await.unwrap(),
        Some("before-one-two".into())
    );
    let staged = plan.pending.get("/file").unwrap();
    assert_eq!(staged.before.as_deref(), Some("before"));
    assert_eq!(staged.after.as_deref(), Some("before-one-two"));
    assert_eq!(staged.before_mode, Some(0o700));
    assert_eq!(plan.record.files.len(), 1);
    assert_eq!(plan.touched, vec!["/file"]);
}

// test/plugin-sdk-install-plan.test.ts:77 reconcile skips moves
#[tokio::test]
async fn reconcile_skips_moves() {
    let (_, reads, io) = memory(&[], None);
    let prior = record("codex", vec![]);
    let mut env = PlanEnv::new(NOW, &["pacer"]);
    env.mode = Some("reconcile".into());
    env.mcp = Some(false);
    let mut plan = InstallPlan::new(io, env, "codex", Some(&prior));
    plan.move_aside("/legacy").await.unwrap();
    assert!(reads.lock().unwrap().is_empty());
}

// test/plugin-sdk-install-plan.test.ts:82 callback errors become InstallError
#[tokio::test]
async fn callback_errors_become_install_error() {
    let (files, _, io) = memory(&[("/file", "old", 0o700)], None);
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
    let error = plan
        .edit("/broken", |_| Err("bad JSON".into()), vec![], None)
        .await
        .unwrap_err();
    assert!(error.0.contains("cannot update /broken: bad JSON"));
    plan.move_aside("/file").await.unwrap();
    assert!(
        plan.edit("/file", |_| Ok("new".into()), vec![], None)
            .await
            .unwrap_err()
            .0
            .contains("already moved aside")
    );
    assert_eq!(files.lock().unwrap().get("/file").unwrap().text, "old");
}

// test/plugin-sdk-install-plan.test.ts:89 cancellation after read or backup probe
#[tokio::test]
async fn cancellation_after_read_or_backup_probe() {
    for abort_on in [1, 2] {
        let cancel = tokio_util::sync::CancellationToken::new();
        let reads = Arc::new(Mutex::new(0));
        let reader = Arc::clone(&reads);
        let signal = cancel.clone();
        let io = PlanIo::new(move |_| {
            let reader = Arc::clone(&reader);
            let signal = signal.clone();
            async move {
                let mut count = reader.lock().unwrap();
                *count += 1;
                if *count == abort_on {
                    signal.cancel();
                }
                Ok((*count == 1).then(|| FileImage {
                    text: "old".into(),
                    mode: 0o700,
                }))
            }
        })
        .with_signal(cancel);
        let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
        assert!(
            plan.edit("/file", |_| Ok("new".into()), vec![], None)
                .await
                .unwrap_err()
                .0
                .contains("cancelled")
        );
        assert!(plan.pending.is_empty());
        assert!(plan.record.files.is_empty());
    }
}

// test/plugin-sdk-install-plan.test.ts:101 invalid IO result is an error
// Rust's read callback is typed, so absence cannot be expressed as an invalid
// image; a raw host error rejecting with the host message is asserted instead.
#[tokio::test]
async fn invalid_io_result_is_an_error() {
    let io = PlanIo::new(|_| async { Err("invalid installation file image".into()) });
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
    assert_eq!(
        plan.read("/file").await.unwrap_err().0,
        "invalid installation file image"
    );
    assert!(plan.pending.is_empty());
}

// test/plugin-sdk-install-plan.test.ts:106 captured mode is stable
#[tokio::test]
async fn captured_mode_is_stable() {
    let image = Arc::new(Mutex::new(FileImage {
        text: "before".into(),
        mode: 0o700,
    }));
    let shared = Arc::clone(&image);
    let io = PlanIo::new(move |path| {
        let shared = Arc::clone(&shared);
        async move {
            if path == "/file" {
                Ok(Some(shared.lock().unwrap().clone()))
            } else {
                shared.lock().unwrap().mode = 0o600;
                Ok(None)
            }
        }
    });
    let mut plan = InstallPlan::new(io, PlanEnv::new(NOW, &["pacer"]), "codex", None);
    plan.edit("/file", |_| Ok("after".into()), vec![], None)
        .await
        .unwrap();
    assert_eq!(plan.pending.get("/file").unwrap().before_mode, Some(0o700));
    let backup = plan.record.files[0].backup.clone().unwrap();
    assert_eq!(plan.pending.get(&backup).unwrap().mode, Some(0o700));
}
