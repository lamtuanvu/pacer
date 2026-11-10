#![allow(clippy::unwrap_used)]
#[path = "support/cost_oracle.rs"]
mod oracle;
use pacer_store::TaskStore;
use rusqlite::{Connection, params};
use serde_json::{Value, json};

fn put(db: &Connection, task: &Value) {
    db.execute("INSERT INTO tasks(id,rev,state,created_at,updated_at,record,archived) VALUES(?1,1,'done',0,0,?2,1) ON CONFLICT(id) DO UPDATE SET record=excluded.record", params![task["id"].as_str().unwrap(), task.to_string()]).unwrap();
}

#[test]
fn projected_peers_match_frozen_full_history_oracle() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    assert!(!store.cost_overlap("target", 10., 20., 100.).unwrap());
    let numbers = [
        json!(null),
        json!(false),
        json!(true),
        json!("12"),
        json!({}),
        json!([]),
        json!(-1),
        json!(0),
        json!(10),
        json!(15),
        json!(20),
        json!(30),
        json!(10.000000000000002),
        json!(0.00000000000000000001),
        json!(9007199254740992_u64),
        json!(9007199254740993_u64),
        json!(-9007199254740992_i64),
        json!(-9007199254740993_i64),
        json!(1e100),
    ];
    let accounts = [
        json!(null),
        json!(false),
        json!(1),
        json!(""),
        json!("other"),
        json!("\u{0000}"),
    ];
    for (i, start) in numbers.iter().enumerate() {
        for (j, end) in numbers.iter().enumerate() {
            for (a, account) in accounts.iter().enumerate() {
                let peer = json!({"id":"peer","archived":true,"state":"done","attempts":[
                    {"startedAt":-100,"endedAt":-50},
                    {"startedAt":start,"endedAt":end,"usageAtStart":{"account":account},"usageAtEnd":{"account":accounts[(a+2)%accounts.len()]}}
                ]});
                put(&db, &peer);
                for (from, until) in [(10., 20.), (15., 15.), (20., 10.), (-1., 0.), (1e99, 1e101)]
                {
                    let target = json!({"id":"target","attempts":[{"startedAt":from,"endedAt":until,"usageAtStart":{"account":"target","usedPct":1},"usageAtEnd":{"account":"target","usedPct":2}}]});
                    let expected = oracle::executor_cost(
                        &target,
                        std::slice::from_ref(&peer),
                        100.,
                    )["executor"]["reason"]
                        == "shared";
                    assert_eq!(
                        store.cost_overlap("target", from, until, 100.).unwrap(),
                        expected,
                        "case {i}/{j}/{a} [{from},{until}]"
                    );
                }
            }
        }
    }
    // Non-array attempts and primitive entries have the same empty-field defaults.
    for attempts in [
        json!({"0":{"usageAtStart":{"account":"x"}}}),
        json!(null),
        json!(["text", 12, false, null, []]),
    ] {
        let peer = json!({"id":"peer","attempts":attempts});
        put(&db, &peer);
        assert!(!store.cost_overlap("target", -1., 1., 100.).unwrap());
    }
}

#[test]
fn pending_fallbacks_remain_dynamic_and_self_exclusion_uses_record_id() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    for state in ["running", "done"] {
        for run in [
            json!(null),
            json!("12"),
            json!(false),
            json!(0),
            json!(10.5),
        ] {
            for attempt in [json!(null), json!(20), json!(15.5)] {
                for created in [json!(null), json!("1"), json!(5)] {
                    let peer = json!({"id":"peer","state":state,"createdAt":created,"run":{"startedAt":run},"attemptStartedAt":attempt,"pendingAttempt":{"usageAtStart":{"account":"different"}},"attempts":[]});
                    put(&db, &peer);
                    for now in [0., 10., 15., 30.] {
                        for (from, until) in [(10., 20.), (20., 10.), (15., 15.)] {
                            let target = json!({"id":"target","attempts":[{"startedAt":from,"endedAt":until,"usageAtStart":{}}]});
                            let expected = oracle::executor_cost(
                                &target,
                                std::slice::from_ref(&peer),
                                now,
                            )["executor"]["reason"]
                                == "shared";
                            assert_eq!(
                                store.cost_overlap("target", from, until, now).unwrap(),
                                expected,
                                "{peer} now={now}"
                            );
                            assert!(!store.cost_overlap("peer", from, until, now).unwrap());
                        }
                    }
                }
            }
        }
    }
}

#[test]
fn fractional_tokens_keep_rust_rounding_at_strict_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    for token in [
        "1.0000000000000001",
        "1.0000000000000002",
        "9007199254740993",
        "9007199254740993.0",
        "-0.0",
        "5e-324",
        "1.7976931348623157e308",
        "1.00000000000000011102230246251565404236316680908203125",
    ] {
        let record = format!(
            r#"{{"id":"peer","attempts":[{{"startedAt":{token},"endedAt":{token},"usageAtStart":{{"account":"x"}}}}]}}"#
        );
        db.execute(
            "INSERT OR REPLACE INTO tasks(id,record) VALUES('peer',?1)",
            [&record],
        )
        .unwrap();
        let peer: Value = serde_json::from_str(&record).unwrap();
        let n = peer["attempts"][0]["startedAt"].as_f64().unwrap();
        for (from, until) in [
            (n, n),
            (n.next_down(), n.next_up()),
            (n.next_up(), n.next_down()),
        ] {
            if !from.is_finite() || !until.is_finite() {
                continue;
            }
            let target = json!({"id":"target","attempts":[{"startedAt":from,"endedAt":until,"usageAtStart":{}}]});
            let expected = oracle::executor_cost(&target, std::slice::from_ref(&peer), 100.)["executor"]
                ["reason"]
                == "shared";
            assert_eq!(
                store.cost_overlap("target", from, until, 100.).unwrap(),
                expected,
                "token {token}"
            );
        }
    }
}

#[test]
fn native_detail_cost_composition_matches_old_oracle_for_target_fallbacks() {
    use pacer_foundation::{Ctx, fsutil::write_json_atomic};
    use pacer_read_model::{ActiveCounts, task_detail::task_detail_by_id};
    let dir = tempfile::tempdir().unwrap();
    let ctx = Ctx::with(
        dir.path().to_path_buf(),
        dir.path().to_path_buf(),
        Default::default(),
        100.,
    );
    let mut store = TaskStore::open(dir.path()).unwrap();
    write_json_atomic(&dir.path().join("state/repos.json"), &json!({})).unwrap();
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    let peer = json!({"id":"peer","state":"running","attempts":[],"run":{"startedAt":12},"pendingAttempt":{"usageAtStart":{"account":"other"}}});
    put(&db, &peer);
    let id = "t-20260101-000001-aaaa";
    for pending in [
        json!(null),
        json!(false),
        json!("pending"),
        json!({}),
        json!({"usageAtStart":{}}),
        json!({"usageAtStart":{"at":11,"account":"target"}}),
    ] {
        for start in [
            json!(null),
            json!(false),
            json!({}),
            json!({"account":"a","window":"week","usedPct":1,"at":10}),
        ] {
            for end in [
                json!(null),
                json!({"account":"a","window":"week","usedPct":1.05}),
                json!({"account":"a","window":"week","usedPct":0}),
                json!({"account":"b","window":"week","usedPct":2}),
            ] {
                let task = json!({"id":id,"rev":1,"state":"done","createdAt":1,"brief":{"goal":"golden","repo":"/repo"},"pendingAttempt":pending,"run":{"startedAt":8},"attemptStartedAt":9,"attempts":[{"startedAt":10,"endedAt":12,"usageAtStart":start,"usageAtEnd":end}]});
                put(&db, &task);
                let detail = task_detail_by_id(
                    &ctx,
                    &ActiveCounts::default(),
                    &mut store,
                    id,
                    &|_| true,
                    false,
                )
                .unwrap();
                assert_eq!(
                    detail["cost"],
                    oracle::executor_cost(&task, std::slice::from_ref(&peer), 100.),
                    "{task}"
                );
            }
        }
    }
}
