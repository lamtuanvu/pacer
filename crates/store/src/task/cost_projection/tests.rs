#![allow(clippy::unwrap_used)]
use super::*;
use rusqlite::StatementStatus;
use std::time::Instant;

#[test]
fn large_history_reads_only_scalar_indexes_and_reports_worst_case() {
    for count in [5_000, 50_000] {
        for fractional in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut store = TaskStore::open(dir.path()).unwrap();
            let fraction = if fractional { 0.25 } else { 0.0 };
            // Cast integer fixtures explicitly; decimal tokens intentionally
            // take the conservative residual branch, even if mathematically integral.
            let start = if fractional { "n+10000+?2" } else { "n+10000" };
            let end = if fractional { "n+10010+?2" } else { "n+10010" };
            let sql=format!("WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<?1)
                INSERT INTO tasks(id,record,archived)
                SELECT printf('peer-%d',n),json_object('id',printf('peer-%d',n),'brief',printf('%01000d',n),
                'attempts',json_array(json_object('startedAt',{start},'endedAt',{end},'usageAtStart',json_object('account','x')),json_object('startedAt',{start},'endedAt',{end},'usageAtEnd',json_object('account','y')))),1 FROM nums");
            if fractional {
                store.db.execute(&sql, params![count, fraction]).unwrap();
            } else {
                store.db.execute(&sql, [count]).unwrap();
            }
            let before: i64 = store
                .db
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .unwrap();
            let cold = Instant::now();
            ensure(&mut store.db).unwrap();
            let cold_ms = cold.elapsed().as_secs_f64() * 1000.;
            let after: i64 = store
                .db
                .query_row("PRAGMA page_count", [], |r| r.get(0))
                .unwrap();
            let page_size: i64 = store
                .db
                .query_row("PRAGMA page_size", [], |r| r.get(0))
                .unwrap();
            let wal_bytes = std::fs::metadata(dir.path().join("state/tasks.db-wal"))
                .unwrap()
                .len();
            eprintln!(
                "cost-storage count={count} intervals={} fractional={fractional} added_db_bytes={} wal_bytes={wal_bytes}",
                count * 2,
                (after - before) * page_size
            );
            let mut explain = store
                .db
                .prepare(&format!("EXPLAIN QUERY PLAN {CANDIDATES}"))
                .unwrap();
            let plan = explain
                .query_map(params!["target", 0., 1., 100.], |r| r.get::<_, String>(3))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap();
            assert!(
                plan.iter()
                    .all(|s| !s.contains("SCAN tasks") && !s.contains("SEARCH tasks")),
                "{plan:?}"
            );
            assert!(plan.iter().any(|s| s.contains("task_cost_exact_v1")));
            assert!(plan.iter().any(|s| s.contains("task_cost_residual_v1")));
            drop(explain);
            for (label, from, until) in [
                ("older-target", 0., 1.),
                ("newer-target", 1000000., 1000001.),
            ] {
                let started = Instant::now();
                let mut stmt = store.db.prepare(CANDIDATES).unwrap();
                let mut rows = stmt.query(params!["target", from, until, 100.]).unwrap();
                let mut candidates = 0;
                while let Some(row) = rows.next().unwrap() {
                    candidates += 1;
                    let a = scalar(row.get(0).unwrap(), 100.).unwrap();
                    let b = scalar(row.get(1).unwrap(), 100.).unwrap();
                    assert!(!(a < until && b > from));
                }
                drop(rows);
                let steps = stmt.get_status(StatementStatus::VmStep);
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
                assert_eq!(candidates, if fractional { count * 2 } else { 0 });
                drop(stmt);
                assert!(!store.cost_overlap("target", from, until, 100.).unwrap());
                eprintln!(
                    "cost-projection count={count} fractional={fractional} path={label} cold_ms={cold_ms:.3} warm_ms={elapsed_ms:.3} candidates={candidates} scalar_parses={} vm_steps={steps} historical_record_decodes=0",
                    2 * candidates
                );
            }
        }
    }
}
