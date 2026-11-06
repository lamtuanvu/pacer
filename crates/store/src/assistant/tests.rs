#![allow(clippy::unwrap_used)]
use super::*;

fn open() -> (tempfile::TempDir, TaskStore) {
    let dir = tempfile::tempdir().unwrap();
    let store = TaskStore::open(dir.path()).unwrap();
    (dir, store)
}

fn seed(db: &Connection) {
    db.execute_batch(
        "INSERT INTO assistant_conversations VALUES('c-old','Old',1.0,100.0),('c-new','New',2.0,300.5),('c-mid','Mid',3.0,200.0);
         INSERT INTO assistant_turns(id,conversation_id,seq,at,question,answer,state,error,account,scope,cards,citations) VALUES
           ('t-1','c-new',1,300.5,'q','a','done',NULL,'ep','{\"kind\":\"task\",\"id\":\"x\"}','[{\"id\":\"k\",\"b\":1,\"2\":0,\"1\":0,\"result\":\"r\"}]','[]'),
           ('t-2','c-new',2,301.0,'q2',NULL,'running',NULL,NULL,'{\"kind\":\"dispatch\",\"days\":7}','[]','[]');
         INSERT INTO assistant_usage VALUES('t-1','c-new',300.5,'ep',10,20,5,NULL,'measured'),('t-gone','c-x',400.0,NULL,1,2,NULL,NULL,'unknown');",
    )
    .unwrap();
}

#[test]
fn settings_default_parse_and_guard_revisions() {
    let (_dir, mut store) = open();
    let db = database(&mut store).unwrap();
    let defaults = read_settings(db).unwrap().unwrap();
    assert_eq!(
        defaults.to_json().to_string(),
        r#"{"runner":null,"account":null,"limits":{"maxInputTokens":32000,"maxOutputTokens":8000,"maxToolRounds":6,"turnsPerDay":50,"deadlineMs":120000},"retention":{"days":30,"conversations":200},"rev":1}"#
    );
    assert!(matches!(
        write_settings(db, None, None, None, None, 2).unwrap(),
        SettingsWrite::Conflict(1)
    ));
    let SettingsWrite::Saved(saved) = write_settings(
        db,
        Some("r".into()),
        Some("ep".into()),
        None,
        Some(vec![7, 9]),
        1,
    )
    .unwrap() else {
        panic!("not saved")
    };
    assert_eq!(saved.rev, 2);
    assert_eq!(read_settings(db).unwrap().unwrap(), saved);
    let stored: String = db
        .query_row("SELECT retention FROM assistant_settings", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, r#"{"days":7,"conversations":9}"#);
    // Missing keys take defaults, unknown keys drop and integral floats pass; anything else is TypeScript's error.
    db.execute(
        "UPDATE assistant_settings SET limits='{\"turnsPerDay\":5.0,\"x\":1}'",
        [],
    )
    .unwrap();
    assert_eq!(read_settings(db).unwrap().unwrap().limit("turnsPerDay"), 5);
    for bad in [
        "{\"turnsPerDay\":0}",
        "{\"turnsPerDay\":null}",
        "{\"turnsPerDay\":1.5}",
        "[]",
        "x",
    ] {
        db.execute("UPDATE assistant_settings SET limits=?", [bad])
            .unwrap();
        assert!(read_settings(db).unwrap().is_none(), "{bad}");
        assert!(matches!(
            write_settings(db, None, None, None, None, 2).unwrap(),
            SettingsWrite::Unusable
        ));
    }
}

#[test]
fn history_reads_retention_and_deletes_match_typescript() {
    let (_dir, mut store) = open();
    let db = database(&mut store).unwrap();
    seed(db);
    let page = conversations(db, 9_007_199_254_740_991.0, 2).unwrap();
    assert_eq!(
        Value::Array(page).to_string(),
        r#"[{"id":"c-new","title":"New","updatedAt":300.5,"turns":2},{"id":"c-mid","title":"Mid","updatedAt":200,"turns":0}]"#
    );
    let turns = conversation_turns(db, "c-new").unwrap().unwrap();
    assert_eq!(
        turns[0].to_string(),
        r#"{"id":"t-1","conversationId":"c-new","at":300.5,"question":"q","answer":"a","state":"done","error":null,"account":"ep","usage":{"input":10,"output":20,"coverage":"measured","cacheRead":5},"cards":[{"1":0,"2":0,"id":"k","b":1,"result":"r"}],"citations":[],"scope":{"kind":"task","id":"x"}}"#
    );
    assert_eq!(turns[1]["usage"], Value::Null);
    assert!(conversation_turns(db, "nope").unwrap().is_none());
    assert_eq!(turn(db, "t-2").unwrap().unwrap()["state"], "running");
    assert!(turn(db, "nope").unwrap().is_none());
    assert_eq!(
        usage_since(db, 300.5).unwrap(),
        [json!(2), json!(11), json!(22)]
    );
    assert_eq!(
        usage_since(db, 1e9).unwrap(),
        [json!(0), json!(0), json!(0)]
    );
    // Older than 1 day at now=86_550 removes c-old (100); a cap of 1 also drops c-mid.
    assert_eq!(enforce_retention(db, 86_550.0, 1, 1).unwrap(), 2);
    assert_eq!(delete_conversations(db, Some("c-old")).unwrap(), None);
    assert_eq!(delete_conversations(db, Some("c-new")).unwrap(), Some(1));
    let usage: i64 = db
        .query_row("SELECT COUNT(*) FROM assistant_usage", [], |r| r.get(0))
        .unwrap();
    assert_eq!(usage, 2);
    assert_eq!(delete_conversations(db, None).unwrap(), Some(0));
    checkpoint(db);
}

#[test]
fn card_updates_keep_key_positions() {
    let (_dir, mut store) = open();
    let db = database(&mut store).unwrap();
    seed(db);
    let stringify = |v: &Value| v.to_string();
    let CardUpdate::Updated(card) = update_card(
        db,
        "t-1",
        "k",
        |card| {
            card.insert("b".into(), json!(2));
            card.shift_remove("result");
            card.insert("state".into(), json!("done"));
        },
        stringify,
    )
    .unwrap() else {
        panic!("not updated")
    };
    assert_eq!(
        card.to_string(),
        r#"{"1":0,"2":0,"id":"k","b":2,"state":"done"}"#
    );
    let stored: String = db
        .query_row(
            "SELECT cards FROM assistant_turns WHERE id='t-1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, format!("[{card}]"));
    assert!(matches!(
        update_card(db, "nope", "k", |_| {}, stringify).unwrap(),
        CardUpdate::UnknownTurn
    ));
    assert!(matches!(
        update_card(db, "t-1", "nope", |_| {}, stringify).unwrap(),
        CardUpdate::UnknownCard
    ));
}
