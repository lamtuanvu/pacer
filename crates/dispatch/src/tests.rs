#![allow(clippy::unwrap_used)]
use super::*;
use crate::hash::canonical;
use serde_json::{Value, json};

fn observation(method: &str, value: Value) -> Value {
    json!({"value": value, "source": "s", "scope": {"account": "codex", "runner": "codex"},
        "method": method, "state": "known", "observedAt": 1.0, "expiresAt": 4e9})
}

#[test]
fn observations_parse_in_schema_order_with_defaults() {
    let parsed = parse_observation(&observation(
        "models",
        json!({"models": [{"strengths": ["a"], "id": "m"}]}),
    ))
    .unwrap();
    assert_eq!(
        Value::Object(parsed).to_string(),
        r#"{"source":"s","scope":{"runner":"codex","account":"codex"},"method":"models","state":"known","observedAt":1,"expiresAt":4000000000,"value":{"models":[{"id":"m","tier":"unknown","strengths":["a"]}]}}"#
    );
    for bad in [
        json!({"extra": 1}),
        json!({"context": 1.5}),
        json!({"windows": [{"pool": "p", "usedPct": 101}]}),
        json!({"model": ""}),
        json!({"models": [{"id": "m", "tier": "huge"}]}),
    ] {
        assert!(parse_observation(&observation("models", bad)).is_none());
    }
}

#[test]
fn canonical_sorts_keys_by_utf16_units_and_prints_javascript_numbers() {
    // U+1F600 sorts after U+FF5E by code point but before it by UTF-16 units.
    let value: Value = serde_json::from_str(
        r#"{"😀":1,"～":2,"b":[1.0,-0.0,1e21,1.5e-7,{"z":null,"a":"\u0001é"}],"a":true}"#,
    )
    .unwrap();
    assert_eq!(
        canonical(&value),
        r#"{"a":true,"b":[1,0,1e+21,1.5e-7,{"a":"\u0001é","z":null}],"😀":1,"～":2}"#
    );
    assert_eq!(
        decision_hash(&json!({})),
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
}

fn candidate(id: &str, tier: &str, headroom: Value) -> Value {
    json!({"runner": id, "account": id, "executor": "codex", "binding": {"kind": "exact", "id": id},
        "actualModel": null, "tier": tier, "strengths": [], "provenance": "declared", "id": id,
        "poolIds": [], "headroom": headroom, "burn": null, "cost": null, "capacityKnown": !headroom.is_null()})
}

fn config(steps: Value) -> Value {
    json!({"tierTargets": {"simple": "small", "standard": "medium", "complex": "frontier"},
        "reservePct": 0, "comfortablePct": 20, "steps": steps})
}

fn step(id: &str, capacity: &str) -> Value {
    json!({"id": id, "match": {}, "require": {}, "prefer": {"models": [], "strengths": []},
        "candidates": {}, "capacity": capacity, "rank": ["task-fit", "spare-capacity"]})
}

fn request(candidates: Vec<Value>) -> Value {
    json!({"task": {"kind": null, "difficulty": "standard", "requirements": {},
        "preferences": {"models": [], "strengths": []}, "provenance": "request"},
        "candidates": candidates})
}

#[test]
fn ladder_prefers_the_target_tier_then_falls_upward_and_to_unknown() {
    let steps = json!([step("comfy", "comfortable"), step("usable", "usable")]);
    let req = request(vec![
        candidate("small", "small", json!(90)),
        candidate("big", "frontier", json!(10)),
        candidate("mid", "medium", json!(15)),
    ]);
    let out = evaluate_ladder(&req, &config(steps.clone()));
    assert_eq!(out["step"], "usable");
    assert_eq!(out["skipped"], json!(["comfy"]));
    assert_eq!(out["choices"][0]["id"], "mid");
    assert_eq!(
        out["choices"][0]["reason"],
        "Step usable; 15% measured headroom; configured task-fit 0"
    );
    assert_eq!(
        out["tier"],
        json!({"targetTier": "medium", "selectedTier": "medium", "reason": "target-match"})
    );
    let req = request(vec![
        candidate("big", "frontier", json!(50)),
        candidate("odd", "unknown", json!(90)),
    ]);
    let out = evaluate_ladder(&req, &config(steps.clone()));
    assert_eq!(out["tier"]["reason"], "upward-fallback");
    let req = request(vec![candidate("odd", "unknown", Value::Null)]);
    let out = evaluate_ladder(&req, &config(json!([step("any", "unknown")])));
    assert_eq!(out["tier"]["reason"], "unknown-tier-fallback");
    assert_eq!(out["choices"][0]["factors"], json!([0, 0, 0, 0, 0, 0]));
    let out = evaluate_ladder(&request(vec![]), &config(steps));
    assert_eq!(
        out,
        json!({"state": "no-match", "reason": "No strategy step has qualifying candidates", "skipped": []})
    );
}

#[test]
fn select_model_reports_each_tier_reason() {
    let record = |id: &str, tier: &str| {
        candidate(id, tier, Value::Null)
            .as_object()
            .cloned()
            .unwrap()
    };
    let records = vec![
        record("a", "small"),
        record("b", "frontier"),
        record("c", "unknown"),
    ];
    let targets = json!({"simple": "small", "standard": "medium", "complex": "frontier"});
    let base = SelectOptions {
        difficulty: "standard",
        targets: &targets,
        min_tier: None,
        pin: None,
        fixed_executor: false,
        default_model: None,
        is_usable: None,
    };
    let picked = |o: SelectOptions| {
        let choice = select_model(&records, &o);
        (choice.record.map(|r| r["id"].clone()), choice.reason)
    };
    assert_eq!(picked(base), (Some(json!("b")), TierReason::UpwardFallback));
    let simple = SelectOptions {
        difficulty: "simple",
        ..base
    };
    assert_eq!(picked(simple), (Some(json!("a")), TierReason::TargetMatch));
    let pin = SelectOptions {
        pin: Some("c"),
        ..base
    };
    assert_eq!(
        picked(pin),
        (Some(json!("c")), TierReason::ExplicitOverride)
    );
    let only_small = |r: &Object| r["tier"] != "frontier";
    let fixed = SelectOptions {
        fixed_executor: true,
        is_usable: Some(&only_small),
        ..base
    };
    assert_eq!(picked(fixed), (None, TierReason::NoEligible));
    let fallback = SelectOptions {
        is_usable: Some(&only_small),
        ..base
    };
    assert_eq!(
        picked(fallback),
        (Some(json!("c")), TierReason::UnknownTierFallback)
    );
    let choice = select_model(
        &records,
        &SelectOptions {
            pin: Some("x"),
            ..base
        },
    );
    assert_eq!(
        choice.to_json(),
        json!({"record": null, "targetTier": "medium", "selectedTier": null, "reason": "no-eligible"})
    );
}

#[test]
fn readonly_store_reads_nothing_without_a_database_and_creates_no_file() {
    let dir = tempfile::tempdir().unwrap();
    let store = ReadOnlyStore::open(dir.path(), false).unwrap();
    assert!(!store.available());
    assert!(store.running_tasks().unwrap().is_empty());
    assert!(store.stored_observations(0.0).unwrap().is_empty());
    assert!(!dir.path().join("state").exists());
}

#[test]
fn readonly_store_reads_rows_and_strict_mode_refuses_garbage() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("state")).unwrap();
    let path = dir.path().join("state/tasks.db");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE tasks(id TEXT, state TEXT, record TEXT);
         INSERT INTO tasks VALUES('a','running','{\"id\":\"a\"}'),('b','needs_input','{\"id\":\"b\"}'),('c','running','oops');
         CREATE TABLE work_reservations(pools TEXT, estimate REAL);
         INSERT INTO work_reservations VALUES('[\"p\"]', 2.5),('bad', 1);",
    )
    .unwrap();
    drop(db);
    let store = ReadOnlyStore::open(dir.path(), false).unwrap();
    assert!(store.available() && !store.immutable());
    assert_eq!(store.running_tasks().unwrap(), vec![json!({"id": "a"})]);
    assert_eq!(store.slot_tasks().unwrap().len(), 2);
    assert_eq!(
        store.reservations().unwrap(),
        vec![Reservation {
            pool_ids: json!(["p"]),
            estimate: json!(2.5)
        }]
    );
    let missing = store.query("SELECT nope FROM tasks", [], |row| row.get::<_, String>(0));
    assert!(missing.unwrap().is_empty());
    let strict = ReadOnlyStore::open(dir.path(), true).unwrap();
    let error = strict
        .query("SELECT nope FROM tasks", [], |row| row.get::<_, String>(0))
        .unwrap_err();
    assert_eq!(error.message, "Session reservations could not be read");
    std::fs::write(&path, b"not a database").unwrap();
    let error = ReadOnlyStore::open(dir.path(), true).err().unwrap();
    assert_eq!(error.message, "Session reservations are unreadable");
    assert!(!ReadOnlyStore::open(dir.path(), false).unwrap().available());
}

#[test]
fn status_adapter_marks_unsupported_methods_and_expired_readings() {
    let status = json!({"generatedAt": 1000, "providers": [{"id": "codex", "installed": true,
        "usage": "metered", "windows": [{"name": "5h", "usedPct": 40, "resetsAt": 1000 + 7200, "stale": false}]}],
        "accounts": [{"name": "codex", "capturedAt": 990}]});
    let scopes = [json!({"runner": "codex", "account": "codex"})];
    let out = status_observations(&status, &scopes, 1000.0);
    let states: Vec<_> = out
        .iter()
        .map(|o| (o["method"].clone(), o["state"].clone()))
        .collect();
    assert_eq!(
        states,
        vec![
            (json!("models"), json!("unsupported")),
            (json!("capabilities"), json!("unsupported")),
            (json!("usage"), json!("known")),
            (json!("health"), json!("known")),
            (json!("actual-model"), json!("unsupported")),
        ]
    );
    assert_eq!(
        out[2]["value"],
        json!({"windows": [{"pool": "[\"codex\",\"5h\"]", "usedPct": 40, "hoursLeft": 2}], "unmetered": false})
    );
    assert_eq!(out[2]["expiresAt"], json!(1050));
    let later = status_observations(&status, &scopes, 1060.0);
    assert_eq!(later[3]["state"], "unknown");
    assert!(later[3].get("value").is_none());
    let mut future = status.clone();
    future["accounts"][0]["capturedAt"] = json!(2000);
    assert_eq!(
        status_observations(&future, &scopes, 1000.0)[3]["state"],
        "error"
    );
}

#[test]
fn reasons_round_counts_like_javascript_and_omit_a_missing_subject() {
    let busy = reason(
        "executor_busy",
        "fail",
        json!({"of": "codex", "used": 2.5, "limit": -2.5}),
        None,
        None,
    );
    assert_eq!(
        busy,
        json!({"code": "executor_busy", "outcome": "fail",
            "facts": {"of": "codex", "used": 2.5, "limit": -2.5}, "text": "codex is busy (3/-2 running)."})
    );
    let custom = reason("override", "info", json!({}), Some("cursor"), Some("Mine."));
    assert_eq!(custom["subject"], "cursor");
    assert_eq!(custom["text"], "Mine.");
}

#[test]
fn exclusion_reasons_match_the_last_host_marker_and_keep_unknown_text() {
    let host = exclusion_reason(
        "r",
        "host a reachability unknown b reachability unknown",
        None,
    );
    assert_eq!(host["code"], "host_reachability_unknown");
    assert_eq!(host["facts"], json!({"host": "a reachability unknown b"}));
    let busy = exclusion_reason("r", "a busy (1/2) busy (3/4)", None);
    assert_eq!(
        busy["facts"],
        json!({"of": "a busy (1/2)", "used": 3, "limit": 4})
    );
    let budget = json!({"state": "ineligible", "reasons": [{"code": "budget_exhausted"}]});
    assert_eq!(
        exclusion_reason("r", "spent", Some(&budget))["code"],
        "quota_exhausted"
    );
    let other = exclusion_reason("r", "Something else", None);
    assert_eq!(
        (other["code"].clone(), other["text"].clone()),
        (json!("other_exclusion"), json!("Something else"))
    );
}

#[test]
fn runner_map_keeps_the_first_position_and_the_last_value() {
    let (a, b) = (json!("a"), json!("b"));
    let entries = [(Some(&a), 1), (Some(&b), 2), (Some(&a), 3), (None, 4)];
    assert_eq!(crate::explain::by_key(entries), vec![3, 2, 4]);
}

#[test]
fn learned_fit_needs_enabled_learning_and_enough_recent_reviews() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("state")).unwrap();
    let db = rusqlite::Connection::open(dir.path().join("state/tasks.db")).unwrap();
    db.execute_batch("CREATE TABLE work_reviews(data TEXT)")
        .unwrap();
    let mut strategy = json!({"runners": {"codex": {"agent": "codex", "account": "codex"}}, "providers": {"codex": {}},
        "dispatch": {"engine": "ladder", "learning": {"enabled": true, "minSamples": 2, "maxAgeDays": 1}}});
    let settings = crate::learning::settings_hash(&strategy, "codex");
    for (accepted, at) in [(true, 1000.0), (false, 1000.0), (true, 1000.0 - 86400.5)] {
        let row = json!({"kind": "debug", "difficulty": "standard", "runner": "codex", "model": "m", "settings": settings,
            "accepted": accepted, "at": at, "provenance": "human"});
        db.execute("INSERT INTO work_reviews VALUES (?1)", [row.to_string()])
            .unwrap();
    }
    drop(db);
    let store = ReadOnlyStore::open(dir.path(), false).unwrap();
    let candidate = json!({"runner": "codex", "actualModel": "m"})
        .as_object()
        .cloned()
        .unwrap();
    let task = json!({"kind": "debug", "difficulty": "standard"});
    let fitted =
        apply_learned_fit(&strategy, vec![candidate.clone()], &task, 1000.0, &store).unwrap();
    assert_eq!(fitted[0]["learnedFit"]["sampleCount"], 2);
    assert_eq!(fitted[0]["learnedFit"]["successRate"], 0.5);
    strategy["dispatch"]["learning"]["minSamples"] = json!(3);
    let short =
        apply_learned_fit(&strategy, vec![candidate.clone()], &task, 1000.0, &store).unwrap();
    assert!(short[0].get("learnedFit").is_none());
    strategy["dispatch"]["learning"]["enabled"] = json!(false);
    strategy["dispatch"]["learning"]["minSamples"] = json!(1);
    let off = apply_learned_fit(&strategy, vec![candidate], &task, 1000.0, &store).unwrap();
    assert!(off[0].get("learnedFit").is_none());
}
