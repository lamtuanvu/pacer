//! Delivery tests for `pacer-bundled-exec-orca` `mapWait` / `mapFailedStart`,
//! ported from `test/plugins-executor-orca-protocol.test.ts:70` and
//! `plugins/pacer-exec-orca/index.ts:22-49` (M3 C5). Summaries are copied
//! verbatim from the TypeScript reference.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use pacer_bundled_exec_orca::{map_failed_start, map_wait};
use serde_json::json;

// TS: index.ts:27-29 — a succeeded done wait resolves green; subject and body
// are joined by a blank line.
#[test]
fn maps_waits_as_461_did() {
    let done = map_wait(&json!({
        "kind": "done", "outcome": "succeeded", "subject": "done", "body": "ok"
    }));
    assert_eq!(
        done,
        json!({ "code": 0, "timedOut": false, "settled": true, "summary": "done\n\nok" })
    );

    let needs_input = map_wait(&json!({
        "kind": "settled", "state": "needs_input", "error": null, "needsStop": true
    }));
    assert_eq!(
        needs_input,
        json!({
            "code": 1, "timedOut": false, "settled": false,
            "summary": "orca worker needs_input without a worker_done report"
        })
    );

    let timeout = map_wait(&json!({ "kind": "timeout" }));
    assert_eq!(
        timeout,
        json!({
            "code": 1, "timedOut": true, "settled": false,
            "summary": "orca worker timed out at the task timeout; stopped it"
        })
    );

    let stopped = map_wait(&json!({ "kind": "stopped" }));
    assert_eq!(
        stopped,
        json!({
            "code": 1, "timedOut": false, "settled": false,
            "summary": "stopped by the planner; stopped the orca worker"
        })
    );
}

// TS: index.ts:28 — a done wait whose subject and body are both blank names
// the outcome instead.
#[test]
fn done_with_blank_subject_and_body_names_the_outcome() {
    let mapped = map_wait(&json!({
        "kind": "done", "outcome": "failed", "subject": " ", "body": ""
    }));
    assert_eq!(mapped["summary"], json!("worker_done: failed"));
    assert_eq!(mapped["code"], json!(1));
}

// TS: index.ts:31-33 — a settled wait keeps the host's tail and error while a
// failed state settles rather than stopping.
#[test]
fn settled_keeps_tail_and_error() {
    let mapped = map_wait(&json!({
        "kind": "settled", "state": "failed", "error": "boom", "tail": "t"
    }));
    assert_eq!(
        mapped["summary"],
        json!("orca worker failed without a worker_done report (boom)")
    );
    assert_eq!(mapped["tail"], json!("t"));
    assert_eq!(mapped["settled"], json!(true));
    assert_eq!(mapped["code"], json!(1));
}

// TS: index.ts:43-48 — an agent-launch failure marks the attempt broken and
// gives a summary naming the failed stage.
#[test]
fn failed_start_marks_agent_launch_broken() {
    let (mapped, launch_broken) = map_failed_start(&json!({
        "failedStage": "Agent-Launch", "lastError": "spawn ENOENT", "stage": "x"
    }));
    assert_eq!(
        mapped["summary"],
        json!("orca worker failed to start at Agent-Launch: spawn ENOENT")
    );
    assert_eq!(
        launch_broken.as_deref(),
        Some("orca agent launch failed: spawn ENOENT")
    );

    let (mapped, launch_broken) = map_failed_start(&json!({
        "failedStage": null, "stage": null, "lastError": null
    }));
    assert_eq!(
        mapped["summary"],
        json!("orca worker failed to start at an unknown stage: no error given")
    );
    assert_eq!(launch_broken, None);
    assert_eq!(mapped["settled"], json!(true));
}
