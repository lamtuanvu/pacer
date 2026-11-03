//! Import derivation over a wide task root with many attempts (F2). Unknown
//! root members are accepted task content, so `attempts` may follow thousands
//! of them; the derived columns must not depend on that member order.
#![allow(clippy::unwrap_used)]
use pacer_store::TaskStore;
use std::fmt::Write;
use std::path::Path;

/// A valid task with `extras` unknown root members and `attempts` attempts.
/// Attempt `i` starts at `10 + 2i` and ends at `11 + 2i`, except that the
/// first attempt ends latest when `first_latest` holds.
fn task(id: &str, extras: usize, attempts: usize, first: bool, first_latest: bool) -> String {
    let mut list = String::new();
    for i in 0..attempts {
        let end = if i == 0 && first_latest {
            1e6
        } else {
            11.0 + 2.0 * i as f64
        };
        let sep = if i > 0 { "," } else { "" };
        write!(
            list,
            r#"{sep}{{"startedAt":{},"endedAt":{end}}}"#,
            10 + 2 * i
        )
        .unwrap();
    }
    let mut unknown = String::new();
    for i in 0..extras {
        write!(unknown, r#","unused_{i}":{i}"#).unwrap();
    }
    let core = format!(
        r#""id":"{id}","rev":1,"state":"queued","createdAt":1,"brief":{{"repo":"/tmp/repo"}}"#
    );
    if first {
        format!(r#"{{{core},"attempts":[{list}]{unknown}}}"#)
    } else {
        format!(r#"{{{core}{unknown},"attempts":[{list}]}}"#)
    }
}

/// Import one compatibility file into a fresh disposable home and return the
/// derived `updated_at` column.
fn imported_updated_at(id: &str, text: &str) -> f64 {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("tasks")).unwrap();
    std::fs::write(dir.path().join(format!("tasks/{id}.json")), text).unwrap();
    drop(TaskStore::open(dir.path()).unwrap());
    updated_at(dir.path(), id)
}

fn updated_at(home: &Path, id: &str) -> f64 {
    let db = rusqlite::Connection::open(home.join("state/tasks.db")).unwrap();
    db.query_row("SELECT updated_at FROM tasks WHERE id=?", [id], |r| {
        r.get(0)
    })
    .unwrap()
}

#[test]
fn wide_root_with_many_attempts_derives_the_same_columns_in_either_order() {
    let id = "t-20261103-090000-f201";
    let n = 1_000;
    for first in [true, false] {
        // The last attempt's end is the maximum: 11 + 2(n - 1).
        let latest = 11.0 + 2.0 * (n - 1) as f64;
        assert_eq!(
            imported_updated_at(id, &task(id, n, n, first, false)),
            latest,
            "attempts first: {first}"
        );
        // The first attempt's end is the maximum.
        assert_eq!(
            imported_updated_at(id, &task(id, n, n, first, true)),
            1e6,
            "attempts first: {first}"
        );
    }
}

/// Controlled resource probe, not a CI timing gate: imports the same inputs
/// with `attempts` first and last and prints each import time. Run explicitly
/// with `-- --ignored --nocapture`; only the derived values are asserted.
#[test]
#[ignore = "resource probe; run explicitly"]
fn wide_root_with_many_attempts_import_scaling() {
    let id = "t-20261103-090000-f202";
    for n in [1_000, 2_000, 4_000, 8_000] {
        for first in [true, false] {
            let text = task(id, n, n, first, false);
            let start = std::time::Instant::now();
            let updated = imported_updated_at(id, &text);
            let elapsed = start.elapsed();
            assert_eq!(updated, 11.0 + 2.0 * (n - 1) as f64);
            eprintln!(
                "f2 import n={n} attempts_first={first} bytes={} elapsed={elapsed:?}",
                text.len()
            );
        }
    }
}
