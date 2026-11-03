//! Task JSON import, stored-row reads and edits against the actual TS store
//! (§7 rows 1-26, 30-33). Expected TS rows come from `support/ts_oracle.rs`;
//! records compare through the Bun canonical form (§2.1). Rows the base
//! already imports also pin the base Rust record bytes.
#![allow(clippy::unwrap_used)]
#[path = "support/isolation.rs"]
mod isolation;
#[path = "support/ts_oracle.rs"]
mod ts_oracle;
use isolation::{isolated, js_canonical};
use pacer_js_json::{Utf16String, WireReply};
use pacer_store::{StoreError, TaskFilter, TaskStore};
use serde_json::json;
use std::path::{Path, PathBuf};
use ts_oracle::{CASES, TsCase};

struct Home {
    _dir: tempfile::TempDir,
    path: PathBuf,
}

fn home() -> Home {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    std::fs::create_dir_all(path.join("tasks")).unwrap();
    Home { _dir: dir, path }
}

fn import(id: &str, text: &str) -> (Home, TaskStore) {
    let home = home();
    std::fs::write(home.path.join(format!("tasks/{id}.json")), text).unwrap();
    let store = TaskStore::open(&home.path).unwrap();
    (home, store)
}

#[derive(Debug)]
struct SqlRow {
    rev: i64,
    updated_at: f64,
    settled_at: Option<f64>,
    archived: i64,
    record: String,
}

fn sql_row(home: &Path, id: &str) -> Option<SqlRow> {
    let db = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    let mut stmt = db
        .prepare("SELECT rev,updated_at,settled_at,archived,record FROM tasks WHERE id=?")
        .unwrap();
    let mut rows = stmt
        .query_map([id], |r| {
            Ok(SqlRow {
                rev: r.get(0)?,
                updated_at: r.get(1)?,
                settled_at: r.get(2)?,
                archived: r.get(3)?,
                record: r.get(4)?,
            })
        })
        .unwrap();
    rows.next().map(Result::unwrap)
}

fn first_settle(home: &Path, id: &str) -> Vec<f64> {
    let db = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    let mut stmt = db
        .prepare("SELECT at FROM task_first_settle WHERE task_id=?")
        .unwrap();
    stmt.query_map([id], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn case(name: &str) -> &'static TsCase {
    CASES.iter().find(|c| c.name == name).unwrap()
}

/// Import one compatibility file and compare presence, indexed columns,
/// `task_first_settle` and the canonical record with the TS store.
fn imports_like_ts(name: &str) -> Option<String> {
    let c = case(name);
    let (home, mut store) = import(c.id, c.text);
    let row = sql_row(&home.path, c.id);
    let Some(ts) = &c.ts else {
        assert!(row.is_none(), "{name}: TS skips this task");
        assert!(store.read(c.id).unwrap().is_none());
        return None;
    };
    let row = row.unwrap_or_else(|| panic!("{name}: Rust skipped a task TS imports"));
    assert_eq!(row.rev, 1, "{name} rev");
    assert_eq!(row.archived, ts.archived, "{name} archived");
    assert_eq!(row.updated_at, ts.updated_at, "{name} updated_at");
    assert_eq!(row.settled_at, ts.settled_at, "{name} settled_at");
    assert_eq!(
        first_settle(&home.path, c.id),
        ts.first_settle,
        "{name} first settle"
    );
    assert_eq!(js_canonical(&row.record), ts.record, "{name} record");
    let wire = store.read_wire(c.id).unwrap().unwrap();
    assert_eq!(wire.to_json().unwrap(), row.record, "{name} read_wire");
    assert_eq!(store.read(c.id).unwrap().unwrap()["id"], c.id);
    let listed = store
        .list(&TaskFilter::default())
        .unwrap()
        .iter()
        .any(|t| t["id"] == c.id);
    assert_eq!(listed, ts.archived == 0, "{name}: list without `all`");
    Some(row.record)
}

macro_rules! import_rows {
    ($($test:ident => $name:literal $(, base = $bytes:literal)?;)*) => {$(
        #[test]
        fn $test() {
            let record = imports_like_ts($name);
            $(assert_eq!(record.as_deref(), Some($bytes), "base Rust record bytes");)?
            let _ = record;
        }
    )*};
}

// `base` pins the record bytes the base Rust import writes for rows it already accepts.
import_rows! {
    row01_control => "r01-control", base = r#"{"id":"t-20261103-070000-0001","rev":1,"state":"queued","createdAt":1.0,"brief":{"repo":"/tmp/repo"},"attempts":[]}"#;
    row02_lone_value_in_array => "r02-lone-value-array", base = r#"{"id":"t-20261103-070000-0002","rev":1,"state":"queued","createdAt":1.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"title":["\ud800"]}"#;
    row03_lone_key => "r03-lone-key";
    row04_lone_and_replacement_keys => "r04-lone-and-fffd-keys";
    row05_duplicate_lone_keys => "r05-duplicate-lone-keys";
    row06_depth_140 => "r06-depth-140";
    row10_overflow_unknown_field => "r10-overflow-unknown";
    row11_number_forms => "r11-number-forms";
    row12_created_at_overflow_is_skipped => "r12-created-overflow";
    row13_attempt_started_overflow_is_skipped => "r13-attempt-started-overflow";
    row14_rev_overflow_is_skipped => "r14-rev-overflow";
    row15_review_at_overflow => "r15-review-at-overflow";
    row16_attempt_started_at_overflow => "r16-attempt-started-at-overflow";
    row17_settled_at_overflow => "r17-settled-at-overflow";
    row18_index_keys => "r18-index-keys", base = r#"{"id":"t-20261103-070000-0018","rev":1,"state":"queued","createdAt":1.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"o":{"b":1.0,"1":2.0,"0":3.0}}"#;
    row19_duplicates => "r19-duplicates", base = r#"{"id":"t-20261103-070000-0019","rev":1,"state":"queued","createdAt":1.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"title":"b","note":1.0}"#;
    row20_rev_exponent => "r20-rev-exponent", base = r#"{"id":"t-20261103-070000-0020","rev":1,"state":"queued","createdAt":1.0,"brief":{"repo":"/tmp/repo"},"attempts":[]}"#;
    row21_proto => "r21-proto", base = r#"{"id":"t-20261103-070000-0021","rev":1,"state":"queued","createdAt":1.0,"brief":{"repo":"/tmp/repo"},"attempts":[],"__proto__":{"x":1.0}}"#;
    row22_control_and_replacement => "r22-control-and-fffd", base = "{\"id\":\"t-20261103-070000-0022\",\"rev\":1,\"state\":\"queued\",\"createdAt\":1.0,\"brief\":{\"repo\":\"/tmp/repo\"},\"attempts\":[],\"s\":\"\\u0001\\b\\u001f\u{fffd}\"}";
    row23_trailing_is_skipped => "r23-trailing";
    row23_bom_is_skipped => "r23-bom";
    row23_invalid_escape_is_skipped => "r23-invalid-escape";
    row23_raw_control_is_skipped => "r23-raw-control";
    row23_truncated_is_skipped => "r23-truncated";
    row30_archived_positive_overflow => "r30-archived-pos-overflow";
    row31_archived_negative_overflow => "r31-archived-neg-overflow";
    row32_archived_zero => "r32-archived-0";
    row32_archived_one => "r32-archived-1";
    row32_archived_negative_zero => "r32-archived-negative-zero";
    row32_archived_half => "r32-archived-0.5";
    row32_archived_empty_string => "r32-archived-empty-string";
    row32_archived_string => "r32-archived-string-x";
    row32_archived_true => "r32-archived-true";
    row32_archived_false => "r32-archived-false";
    row32_archived_null => "r32-archived-null";
    row32_archived_object => "r32-archived-object";
    row32_archived_array => "r32-archived-array";
    row32_archived_absent => "r32-archived-absent";
    row33_review_positive_overflow_settled_5 => "r33-review-pos-settled-5";
    row33_review_negative_overflow_settled_5 => "r33-review-neg-settled-5";
    row33_settled_positive_overflow_review_7 => "r33-settled-pos-review-7";
    row33_settled_negative_overflow_review_7 => "r33-settled-neg-review-7";
    row33_settled_positive_overflow_alone => "r33-settled-pos-alone";
}

/// Row 24/33: a TaskEdit after import, against TS `updateTask` on the same input.
fn edits_like_ts(name: &str) {
    let c = case(name);
    let (home, mut store) = import(c.id, c.text);
    let (archived, updated_at, record) = c.ts.as_ref().unwrap().edited.unwrap();
    store
        .edit(c.id, 1, 2000.0, |t| {
            t.put("/title", WireReply::new(json!("edited")))
        })
        .unwrap_or_else(|e| panic!("{name}: {e:?}"));
    let row = sql_row(&home.path, c.id).unwrap();
    assert_eq!(row.rev, 2);
    assert_eq!(row.archived, archived, "{name} archived after edit");
    assert_eq!(row.updated_at, updated_at, "{name} updated_at after edit");
    assert_eq!(
        js_canonical(&row.record),
        record,
        "{name} record after edit"
    );
}

#[test]
fn row24_put_sibling_beside_a_lone_surrogate_key() {
    edits_like_ts("r03-lone-key");
}

#[test]
fn row24_put_sibling_beside_lone_and_replacement_keys() {
    edits_like_ts("r04-lone-and-fffd-keys");
}

#[test]
fn row24_put_sibling_beside_an_overflow_member() {
    edits_like_ts("r10-overflow-unknown");
}

#[test]
fn row33_edit_after_archived_overflow_rederives_archived_zero() {
    edits_like_ts("r30-archived-pos-overflow");
}

fn task_text(n: u32, extra: &str) -> (String, String) {
    let id = format!("t-20261103-070000-{n:04x}");
    let text = format!(
        r#"{{"id":"{id}","rev":1,"state":"queued","createdAt":1,"brief":{{"repo":"/tmp/repo"}},"attempts":[]{extra}}}"#
    );
    (id, text)
}

fn nest(n: usize, leaf: &str) -> String {
    format!("{}{leaf}{}", "[".repeat(n), "]".repeat(n))
}

type Mutation = fn(&mut pacer_store::TaskEdit) -> Result<(), StoreError>;

/// Row 24: structural edits compared with JS parse/mutate/stringify
/// (`.work/reviews/task-json-t1/js-mutation-oracle.json`).
fn edits_like_js(n: u32, extra: &str, mutate: Mutation, expected: &str) {
    let (id, text) = task_text(n, extra);
    let (home, mut store) = import(&id, &text);
    store
        .edit(&id, 1, 2000.0, mutate)
        .unwrap_or_else(|e| panic!("{e:?}"));
    let row = sql_row(&home.path, &id).unwrap();
    assert_eq!(js_canonical(&row.record), expected);
}

#[test]
fn row24_replacing_a_parent_drops_its_hidden_member() {
    edits_like_js(
        0x240,
        r#","p":{"\ud800":1,"k":2}"#,
        |t| t.put("/p", WireReply::new(json!({"k":3}))),
        r#"{"id":"t-20261103-070000-0240","rev":2,"state":"queued","createdAt":1,"brief":{"repo":"/tmp/repo"},"attempts":[],"p":{"k":3}}"#,
    );
}

#[test]
fn row24_putting_under_a_parent_keeps_its_hidden_member() {
    edits_like_js(
        0x241,
        r#","p":{"\ud800":1,"k":2}"#,
        |t| t.put("/p/k", WireReply::new(json!(3))),
        r#"{"id":"t-20261103-070000-0241","rev":2,"state":"queued","createdAt":1,"brief":{"repo":"/tmp/repo"},"attempts":[],"p":{"\ud800":1,"k":3}}"#,
    );
}

#[test]
fn row24_copying_a_parent_carries_its_hidden_member() {
    edits_like_js(
        0x242,
        r#","p":{"\ud800":1,"k":2}"#,
        |t| t.copy("/p", "/q"),
        r#"{"id":"t-20261103-070000-0242","rev":2,"state":"queued","createdAt":1,"brief":{"repo":"/tmp/repo"},"attempts":[],"p":{"\ud800":1,"k":2},"q":{"\ud800":1,"k":2}}"#,
    );
}

#[test]
fn row24_set_string_replacement_character_beside_a_hidden_key() {
    edits_like_js(
        0x243,
        r#","\ud800":1,"title":"\ud801""#,
        |t| t.set_string("/title", Utf16String::slice("\u{fffd}", 0, 1)),
        "{\"id\":\"t-20261103-070000-0243\",\"rev\":2,\"state\":\"queued\",\"createdAt\":1,\"brief\":{\"repo\":\"/tmp/repo\"},\"attempts\":[],\"\\ud800\":1,\"title\":\"\u{fffd}\"}",
    );
}

#[test]
fn row24_deep_splice_below_the_preview_boundary() {
    let extra = format!(r#","deep":{}"#, nest(139, "1"));
    let deep = format!("{}{},2{}", "[".repeat(135), nest(4, "1"), "]".repeat(135));
    edits_like_js(
        0x244,
        &extra,
        |t| {
            let path = format!("/deep{}", "/0".repeat(134));
            t.splice(&path, 1, 0, vec![WireReply::new(json!(2))])
        },
        &format!(
            r#"{{"id":"t-20261103-070000-0244","rev":2,"state":"queued","createdAt":1,"brief":{{"repo":"/tmp/repo"}},"attempts":[],"deep":{deep}}}"#
        ),
    );
}

fn row07_body() {
    let (id, text) = task_text(7, &format!(r#","deep":{}"#, nest(19_999, "1")));
    let (home, mut store) = import(&id, &text);
    let row = sql_row(&home.path, &id).unwrap_or_else(|| panic!("Rust skipped a task TS imports"));
    assert_eq!(
        (row.archived, row.updated_at, row.settled_at),
        (0, 1.0, None)
    );
    assert_eq!(js_canonical(&row.record), js_canonical(&text));
    let wire = store.read_wire(&id).unwrap().unwrap();
    assert_eq!(wire.to_json().unwrap(), row.record);
    assert!(store.read(&id).unwrap().is_some());
}

#[test]
fn row07_depth_20000_import_and_reads() {
    isolated("row07_depth_20000_import_and_reads", row07_body);
}

fn row08_body() {
    let (id, text) = task_text(8, &format!(r#","deep":{}"#, nest(199_999, "1")));
    let (home, mut store) = import(&id, &text);
    assert!(sql_row(&home.path, &id).is_some());
    assert!(store.read_wire(&id).unwrap().is_some());
}

/// Unsupported comparison: the TS store's stringify RangeError breaks the home
/// at this depth. Only native resource-safe acceptance is pinned.
#[test]
fn row08_depth_200000_import_is_an_unsupported_comparison() {
    isolated(
        "row08_depth_200000_import_is_an_unsupported_comparison",
        row08_body,
    );
}

#[test]
fn row09_depth_1000_reaches_the_sqlite_json_limit_in_list_live() {
    let (id, text) = task_text(9, &format!(r#","deep":{}"#, nest(999, "1")));
    let (home, mut store) = import(&id, &text);
    assert!(
        sql_row(&home.path, &id).is_some(),
        "Rust skipped a task TS imports"
    );
    assert!(store.read(&id).unwrap().is_some());
    // TS: SQLiteError "malformed JSON" from json_extract; same SQLite error class.
    assert!(matches!(store.list_live(), Err(StoreError::Sql(_))));
}

/// Row 26: a TS-written SQLite row (no compatibility file), then native reads.
fn reads_ts_stored_row(name: &str) {
    let c = case(name);
    let ts = c.ts.as_ref().unwrap();
    let home = home();
    drop(TaskStore::open(&home.path).unwrap());
    let state = ["queued", "running", "done"]
        .into_iter()
        .find(|s| ts.record.contains(&format!(r#""state":"{s}""#)))
        .unwrap();
    let db = rusqlite::Connection::open(home.path.join("state/tasks.db")).unwrap();
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived,json_mtime) VALUES(?,1,?,1,?,?,'/tmp/repo',?,?,NULL)",
        rusqlite::params![c.id, state, ts.updated_at, ts.settled_at, ts.record, ts.archived],
    )
    .unwrap();
    drop(db);
    let mut store = TaskStore::open(&home.path).unwrap();
    let read = store
        .read(c.id)
        .unwrap_or_else(|e| panic!("{name}: read {e:?}"));
    assert_eq!(read.unwrap()["id"], c.id);
    let wire = store
        .read_wire(c.id)
        .unwrap_or_else(|e| panic!("{name}: read_wire {e:?}"))
        .unwrap();
    assert_eq!(js_canonical(&wire.to_json().unwrap()), ts.record);
}

macro_rules! stored_rows {
    ($($test:ident => $name:literal;)*) => {$(
        #[test]
        fn $test() {
            reads_ts_stored_row($name);
        }
    )*};
}

stored_rows! {
    row26_stored_lone_key => "r03-lone-key";
    row26_stored_lone_and_replacement_keys => "r04-lone-and-fffd-keys";
    row26_stored_duplicate_lone_keys => "r05-duplicate-lone-keys";
    row26_stored_depth_140 => "r06-depth-140";
    row26_stored_overflow_unknown_field => "r10-overflow-unknown";
    row26_stored_number_forms => "r11-number-forms";
    row26_stored_review_at_overflow => "r15-review-at-overflow";
    row26_stored_attempt_started_at_overflow => "r16-attempt-started-at-overflow";
    row26_stored_settled_at_overflow => "r17-settled-at-overflow";
    row26_stored_index_keys => "r18-index-keys";
    row26_stored_duplicates => "r19-duplicates";
    row26_stored_rev_exponent => "r20-rev-exponent";
    row26_stored_proto => "r21-proto";
    row26_stored_control_and_replacement => "r22-control-and-fffd";
    row26_stored_archived_positive_overflow => "r30-archived-pos-overflow";
    row26_stored_archived_negative_overflow => "r31-archived-neg-overflow";
    row26_stored_review_positive_overflow_settled_5 => "r33-review-pos-settled-5";
    row26_stored_settled_negative_overflow_review_7 => "r33-settled-neg-review-7";
}

fn row26_deep_body() {
    let (id, text) = task_text(7, &format!(r#","deep":{}"#, nest(19_999, "1")));
    let home = home();
    drop(TaskStore::open(&home.path).unwrap());
    let db = rusqlite::Connection::open(home.path.join("state/tasks.db")).unwrap();
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived,json_mtime) VALUES(?,1,'queued',1,1,NULL,'/tmp/repo',?,0,NULL)",
        rusqlite::params![id, text],
    )
    .unwrap();
    drop(db);
    let mut store = TaskStore::open(&home.path).unwrap();
    assert!(store.read(&id).unwrap().is_some());
    assert_eq!(
        store.read_wire(&id).unwrap().unwrap().to_json().unwrap(),
        text
    );
}

#[test]
fn row26_stored_depth_20000() {
    isolated("row26_stored_depth_20000", row26_deep_body);
}
