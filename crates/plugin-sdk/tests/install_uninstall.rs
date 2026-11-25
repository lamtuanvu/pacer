#![allow(clippy::unwrap_used)]
//! Transcribed from install-uninstall-user-content.test.ts:36 and
//! plugins-planner-retention.test.ts:90.
use pacer_plugin::install::{
    FileChange, FileImage, PlanIo, PlannerRecord, UninstallFailureReason,
    prepare_planner_uninstall_files, sha256,
};

fn record(planner: &str, files: Vec<FileChange>, notes: Vec<String>) -> PlannerRecord {
    PlannerRecord {
        mcp: None,
        integration: None,
        planner: planner.into(),
        account: None,
        folder: None,
        config_env: None,
        installed_at: 1,
        pacer_argv: vec!["pacer".into()],
        files,
        commands: vec![],
        notes,
        undo_connect: None,
        undone_at: None,
    }
}

// test/install-uninstall-user-content.test.ts:36 intact created file removed
#[tokio::test]
async fn intact_created_file_removed() {
    let text = "owned bytes";
    for exact in [Some(true), Some(false), None] {
        let io = PlanIo::new(|_| async {
            Ok(Some(FileImage {
                text: "owned bytes".into(),
                mode: 0o600,
            }))
        });
        let prior = record(
            "codex",
            vec![FileChange {
                path: "/fixture/owned.txt".into(),
                action: "created".into(),
                managed: None,
                backup: None,
                after_hash: Some(sha256(text)),
                exact,
                undo: vec![],
            }],
            vec![],
        );
        let plan = prepare_planner_uninstall_files(&io, &prior, None)
            .await
            .unwrap();
        assert_eq!(plan.files.len(), 1);
        assert_eq!(plan.files[0].path, "/fixture/owned.txt");
        assert_eq!(plan.files[0].before.as_deref(), Some(text));
        assert_eq!(plan.files[0].after, None);
        assert_eq!(plan.files[0].before_mode, Some(0o600));
        assert_eq!(plan.uninstall_report.removed, vec!["/fixture/owned.txt"]);
    }
}

// test/plugins-planner-retention.test.ts:90 typed incomplete outcomes
#[tokio::test]
async fn typed_incomplete_outcomes() {
    let failures = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = failures.clone();
    let io = PlanIo::new(|path| async move {
        match path.as_str() {
            "/read-error" => Err("synthetic read failure".into()),
            "/edited" => Ok(Some(FileImage {
                text: "managed".into(),
                mode: 0o600,
            })),
            _ => Ok(None),
        }
    });
    let mut callback = |failure: pacer_plugin::install::UninstallPreparationFailure| {
        log.lock().unwrap().push(failure);
    };
    let prior = record(
        "orca-plugin",
        vec![
            FileChange {
                path: "/read-error".into(),
                action: "created".into(),
                managed: None,
                backup: None,
                after_hash: None,
                exact: None,
                undo: vec![],
            },
            FileChange {
                path: "/moved".into(),
                action: "moved".into(),
                managed: None,
                backup: Some("/missing".into()),
                after_hash: None,
                exact: None,
                undo: vec![],
            },
            FileChange {
                path: "/edited".into(),
                action: "edited".into(),
                managed: None,
                backup: Some("/missing".into()),
                after_hash: Some(sha256("managed")),
                exact: Some(true),
                undo: vec![],
            },
        ],
        vec!["unrelated user note".into()],
    );
    let plan = prepare_planner_uninstall_files(&io, &prior, Some(&mut callback))
        .await
        .unwrap();
    let observed = failures.lock().unwrap().clone();
    assert_eq!(observed.len(), 3);
    assert_eq!(observed[0].path, "/edited");
    assert_eq!(observed[0].reason, UninstallFailureReason::MissingBackup);
    assert_eq!(observed[1].path, "/moved");
    assert_eq!(observed[1].reason, UninstallFailureReason::MissingBackup);
    assert_eq!(observed[2].path, "/read-error");
    assert_eq!(observed[2].reason, UninstallFailureReason::ReadError);
    let mut keys: Vec<_> = [
        "files",
        "notes",
        "record",
        "schema",
        "touched",
        "uninstallReport",
    ]
    .to_vec();
    keys.sort();
    assert!(
        plan.notes
            .iter()
            .any(|n| n == "cannot restore /moved; backup kept at /missing")
    );
    assert_eq!(plan.record.notes, vec!["unrelated user note"]);
}
