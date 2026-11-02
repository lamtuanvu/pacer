#![allow(clippy::unwrap_used)]
use pacer_foundation::{Ctx, fsutil::write_json_atomic};
use pacer_read_model::{Probes, ReadModel, SnapshotInput, StatusInput};
use serde_json::{Value, json};
use std::collections::HashMap;
fn fixture() -> (tempfile::TempDir, Ctx, Probes, Value) {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/read-model/rust-cases.json"
    ))
    .unwrap();
    let input = &cases[0]["input"];
    let root = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        root.path().into(),
        root.path().join(".pacer"),
        HashMap::new(),
        input["now"].as_f64().unwrap(),
    );
    let probes = Probes {
        setup: input["setup"].clone(),
        policy: input["policy"].clone(),
        machine: input["machine"].clone(),
        service: input["service"].clone(),
        desktop_updates: vec![],
        service_installed: false,
        can_pair: false,
    };
    (root, ctx, probes, input["status"].clone())
}
#[test]
fn status_cache_is_home_scoped_expires_and_does_not_absorb_failures() {
    let (_dir, ctx, p, status) = fixture();
    let mut model = ReadModel::new();
    let zone = chrono_tz::UTC;
    model
        .snapshot(
            &ctx,
            SnapshotInput::new(&p, StatusInput::Provided(status)),
            zone,
            &|_| false,
        )
        .unwrap();
    let cached = model
        .snapshot(
            &Ctx {
                now: ctx.now + 59.0,
                ..ctx.clone()
            },
            SnapshotInput::new(&p, StatusInput::Cached),
            zone,
            &|_| false,
        )
        .unwrap();
    assert_eq!(cached.snapshot["planner"]["runner"], "codex");
    let warming = model
        .snapshot(
            &ctx,
            SnapshotInput::new(&p, StatusInput::Failure("status is warming up".into())),
            zone,
            &|_| false,
        )
        .unwrap();
    assert_eq!(warming.snapshot["service"]["starting"], true);
    let failed = model
        .snapshot(
            &ctx,
            SnapshotInput::new(&p, StatusInput::Failure("status unavailable".into())),
            zone,
            &|_| false,
        )
        .unwrap();
    assert!(failed.snapshot["service"].get("starting").is_none());
    assert!(
        model
            .snapshot(
                &ctx,
                SnapshotInput::new(&p, StatusInput::Cached),
                zone,
                &|_| false
            )
            .is_ok()
    );
    for now in [ctx.now - 1.0, ctx.now + 60.0] {
        assert!(
            model
                .snapshot(
                    &Ctx { now, ..ctx.clone() },
                    SnapshotInput::new(&p, StatusInput::Cached),
                    zone,
                    &|_| false
                )
                .is_err()
        );
    }
    let other = tempfile::tempdir().unwrap();
    let other = Ctx {
        pacer_home: other.path().join(".pacer"),
        ..ctx.clone()
    };
    assert!(
        model
            .snapshot(
                &other,
                SnapshotInput::new(&p, StatusInput::Cached),
                zone,
                &|_| false
            )
            .is_err()
    );
}
#[test]
fn holds_invalidate_status_while_setup_context_has_its_own_five_second_ttl() {
    let (_dir, ctx, mut p, status) = fixture();
    let mut model = ReadModel::new();
    let zone = chrono_tz::UTC;
    let first = model
        .snapshot(
            &ctx,
            SnapshotInput::new(&p, StatusInput::Provided(status.clone())),
            zone,
            &|_| false,
        )
        .unwrap();
    assert_eq!(first.snapshot["setup"]["open"], 3);
    p.setup = json!({"items":[]});
    let next = model
        .snapshot(
            &Ctx {
                now: ctx.now + 4.0,
                ..ctx.clone()
            },
            SnapshotInput::new(&p, StatusInput::Cached),
            zone,
            &|_| false,
        )
        .unwrap();
    assert_eq!(next.snapshot["setup"]["open"], 3);
    let next = model
        .snapshot(
            &Ctx {
                now: ctx.now + 5.0,
                ..ctx.clone()
            },
            SnapshotInput::new(&p, StatusInput::Cached),
            zone,
            &|_| false,
        )
        .unwrap();
    assert_eq!(next.snapshot["setup"]["open"], 0);
    write_json_atomic(
        &ctx.pacer_home.join("state/mode-hold.json"),
        &json!({"mode":"strict","until":ctx.now+30.0}),
    )
    .unwrap();
    assert!(
        model
            .snapshot(
                &ctx,
                SnapshotInput::new(&p, StatusInput::Cached),
                zone,
                &|_| false
            )
            .is_err()
    );
    let held = model
        .snapshot(
            &ctx,
            SnapshotInput::new(&p, StatusInput::Provided(status)),
            zone,
            &|_| false,
        )
        .unwrap();
    assert_eq!(held.snapshot["planner"]["mode"], "strict");
    assert_eq!(
        held.snapshot["planner"]["modeHeldUntil"],
        json!(ctx.now + 30.0)
    );
    let expired = model
        .snapshot(
            &Ctx {
                now: ctx.now + 30.0,
                ..ctx.clone()
            },
            SnapshotInput::new(&p, StatusInput::Failure("unavailable".into())),
            zone,
            &|_| false,
        )
        .unwrap();
    assert!(expired.snapshot["planner"].get("modeHeldUntil").is_none());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for file in ["state/tasks.db", "state/mode-hold.json"] {
            assert_eq!(
                std::fs::metadata(ctx.pacer_home.join(file))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(
            std::fs::metadata(ctx.pacer_home.join("state"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
