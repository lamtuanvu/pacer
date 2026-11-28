#![allow(clippy::unwrap_used)]
//! Ported cases from `test/assistant-grant.test.ts` for the assistant (`pag_`)
//! grant. Only assistant rows are created here; a work row never answers as one.

use pacer_store::{TaskStore, work_grants};
use std::time::{SystemTime, UNIX_EPOCH};

fn db(dir: &tempfile::TempDir) -> TaskStore {
    TaskStore::open(dir.path()).unwrap()
}

fn real_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
}

#[test]
fn a_pag_token_is_hashed_at_rest_and_bound_to_one_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = db(&dir);
    let connection = store.connection().unwrap();
    let token = work_grants::issue_assistant(connection, "c-1", real_now()).unwrap();
    assert_eq!(token.len(), 68);
    assert!(token.starts_with("pag_"));
    assert!(token[4..].bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
    let hash: String = connection
        .query_row("SELECT hash FROM work_grants", [], |r| r.get(0))
        .unwrap();
    assert_ne!(hash, token);
    assert_eq!(hash.len(), 64);
    let rows: String = connection
        .query_row("SELECT group_concat(hash || task_id || conversation_id) FROM work_grants", [], |r| r.get(0))
        .unwrap();
    assert!(!rows.contains(&token));
    assert_eq!(work_grants::authorize_assistant(connection, &token).unwrap(), Some("c-1".to_owned()));
}

#[test]
fn refuses_unknown_malformed_expired_and_revoked_tokens() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = db(&dir);
    let connection = store.connection().unwrap();
    let token = work_grants::issue_assistant(connection, "c-1", real_now()).unwrap();
    // Live until its deadline: a grant issued at a fixed past epoch is already dead.
    let old = work_grants::issue_assistant(connection, "c-2", 1_700_000_000.0).unwrap();
    assert_eq!(work_grants::authorize_assistant(connection, &old).unwrap(), None);
    for bad in [
        format!("pag_{}", "0".repeat(64)),
        "pag_forged".to_owned(),
        format!("pwg_{}", "0".repeat(64)),
        format!("PAG_{}", "0".repeat(64)),
        format!("pag_{}", "g".repeat(64)),
    ] {
        assert_eq!(work_grants::authorize_assistant(connection, &bad).unwrap(), None, "{bad}");
    }
    work_grants::revoke_assistant(connection, &token).unwrap();
    assert_eq!(work_grants::authorize_assistant(connection, &token).unwrap(), None);
    // A later grant for the same conversation is live again; revoking the
    // conversation kills everything still outstanding.
    let again = work_grants::issue_assistant(connection, "c-1", real_now()).unwrap();
    assert_eq!(work_grants::authorize_assistant(connection, &again).unwrap(), Some("c-1".to_owned()));
    work_grants::revoke_conversation(connection, "c-1").unwrap();
    assert_eq!(work_grants::authorize_assistant(connection, &again).unwrap(), None);
}

#[test]
fn the_two_kinds_never_answer_for_each_other() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = db(&dir);
    let connection = store.connection().unwrap();
    work_grants::ensure(connection).unwrap();
    let mine = work_grants::issue_assistant(connection, "c-1", real_now()).unwrap();
    let other = work_grants::issue_assistant(connection, "c-2", real_now()).unwrap();
    // A work-kind row with the same hash shape must not authorize as assistant.
    connection
        .execute(
            "INSERT INTO work_grants(hash,task_id,attempt,expires,revoked,kind,conversation_id) VALUES(?,?,0,?,0,'work',?)",
            rusqlite::params![work_grants::token_hash("pwg_work"), "work", real_now() + 120.0, ""],
        )
        .unwrap();
    assert_eq!(work_grants::authorize_assistant(connection, "pwg_work").unwrap(), None);
    work_grants::revoke_assistant(connection, &mine).unwrap();
    assert_eq!(work_grants::authorize_assistant(connection, &mine).unwrap(), None);
    assert_eq!(work_grants::authorize_assistant(connection, &other).unwrap(), Some("c-2".to_owned()));
    // Changing a row's kind changes which identity it can answer as.
    let hash = work_grants::token_hash(&mine);
    connection
        .execute("UPDATE work_grants SET kind='work' WHERE hash=?", [&hash])
        .unwrap();
    assert_eq!(work_grants::authorize_assistant(connection, &mine).unwrap(), None);
}

#[test]
fn refuses_to_issue_without_a_conversation() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = db(&dir);
    let connection = store.connection().unwrap();
    work_grants::ensure(connection).unwrap();
    assert!(work_grants::issue_assistant(connection, "", real_now()).is_err());
    let count: i64 = connection
        .query_row("SELECT count(*) FROM work_grants", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}
