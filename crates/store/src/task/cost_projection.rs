//! Private, trigger-maintained scalar cost windows. No historical JSON is read
//! by a ready projection query. See ADR 0025 for bounds and recovery semantics.
use super::{Result, StoreError, TaskStore};
use rusqlite::params;

mod bootstrap;
use bootstrap::{ensure, ready};

// Only integral JSON tokens within the exact f64 integer range may narrow a
// candidate seek. Decimal/exponent tokens retain their original text for Rust.
fn bound(token: &str) -> String {
    format!(
        "CASE WHEN json_type({token})='integer' AND json_extract({token},'$') BETWEEN -9007199254740992 AND 9007199254740992 THEN CAST(json_extract({token},'$') AS REAL) END"
    )
}
fn numeric(record: &str, path: &str, fallback: &str) -> String {
    format!(
        "CASE WHEN json_type({record},{path}) IN ('integer','real') THEN {record} -> {path} ELSE {fallback} END"
    )
}
fn account(record: &str, path: &str) -> String {
    format!(
        "(json_type({record},'{path}')='text' AND length(CAST(json_extract({record},'{path}') AS BLOB))>0)"
    )
}

/// Both backfill and every writer's triggers use this one projection expression.
fn projection(source: &str) -> [String; 2] {
    let start = numeric("record", "(a.fullkey || '.startedAt')", "'0'");
    let end = numeric("record", "(a.fullkey || '.endedAt')", "'0'");
    let pending = numeric(
        "record",
        "'$.run.startedAt'",
        &numeric(
            "record",
            "'$.attemptStartedAt'",
            &numeric("record", "'$.createdAt'", "NULL"),
        ),
    );
    let start_account = account("record", "$.usageAtStart.account");
    let end_account = account("record", "$.usageAtEnd.account");
    // json_each.value is SQL text for a string element, not JSON text. Guard
    // primitives before looking up account fields on the attempt object.
    let qualifying = format!("({start_account} OR {end_account})").replace(
        "record",
        "(CASE WHEN a.type='object' THEN a.value ELSE '{}' END)",
    );
    let pending_account = account("record", "$.pendingAttempt.usageAtStart.account");
    [format!("
INSERT INTO task_cost_invalid_v1(owner)
 SELECT owner FROM ({source}) WHERE
 NOT json_valid(record) OR CASE WHEN json_valid(record) THEN
 json_type(record,'$.id') IS NOT 'text' OR EXISTS(
 SELECT 1 FROM json_tree(record) WHERE typeof(key)='text' GROUP BY parent,key HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM json_tree(record) WHERE type IN ('integer','real') AND abs(atom)>1.7976931348623157e308)
 ELSE 1 END;"), format!("
INSERT INTO task_cost_intervals_v1(owner,record_id,kind,ordinal,start_token,end_token,start_bound,end_bound)
 WITH source AS NOT MATERIALIZED (SELECT owner,CASE WHEN json_valid(record) THEN record ELSE '{{}}' END AS record FROM ({source}) WHERE owner NOT IN (SELECT owner FROM task_cost_invalid_v1)),
 windows AS (
 SELECT owner,json_extract(record,'$.id') AS record_id,0 AS kind,CAST(a.key AS INTEGER) AS ordinal,
 {start} AS start_token,{end} AS end_token
 FROM source,json_each(CASE WHEN json_type(record,'$.attempts')='array' THEN record ELSE '{{}}' END,'$.attempts') a
 WHERE {qualifying}
 UNION ALL
 SELECT owner,json_extract(record,'$.id'),1,-1,{pending},NULL FROM source
 WHERE json_type(record,'$.state')='text' AND json_extract(record,'$.state')='running' AND {pending_account})
 SELECT owner,record_id,kind,ordinal,start_token,end_token,{start_bound},{end_bound} FROM windows;",
 start_bound=bound("start_token"),end_bound=bound("end_token"))]
}

const CANDIDATES: &str = "SELECT start_token,end_token FROM task_cost_intervals_v1 INDEXED BY task_cost_exact_v1
             WHERE kind=0 AND start_bound IS NOT NULL AND end_bound IS NOT NULL
               AND end_bound>?2 AND start_bound<?3 AND record_id<>?1
             UNION ALL
             SELECT start_token,end_token FROM task_cost_intervals_v1 INDEXED BY task_cost_residual_v1
             WHERE kind=0 AND (start_bound IS NULL OR end_bound IS NULL) AND record_id<>?1
             UNION ALL
             SELECT start_token,end_token FROM task_cost_intervals_v1 INDEXED BY task_cost_pending_v1
             WHERE kind=1 AND ?4>?2 AND (start_bound IS NULL OR start_bound<?3) AND record_id<>?1";

fn scalar(token: Option<String>, now: f64) -> Result<f64> {
    match token {
        None => Ok(now),
        Some(token) => serde_json::from_str::<serde_json::Value>(&token)?
            .as_f64()
            .ok_or(StoreError::InvalidRecord),
    }
}

impl TaskStore {
    /// Existing Rust cost semantics: any nonempty peer account, strict endpoint
    /// comparisons, including zero/reversed intervals and dynamic pending now.
    pub fn cost_overlap(&mut self, id: &str, from: f64, until: f64, now: f64) -> Result<bool> {
        self.refresh()?;
        ensure(&mut self.db)?;
        let tx = self.db.transaction()?;
        // Readiness and all peer branches must refer to the same snapshot.
        // Concurrent schema damage is an explicit retryable failure, not false.
        if !ready(&tx)? {
            return Err(StoreError::Admission(
                "cost projection changed during read; retry".into(),
            ));
        }
        let invalid: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM task_cost_invalid_v1)",
            [],
            |r| r.get(0),
        )?;
        if invalid {
            return Err(StoreError::Admission("cost projection requires canonical finite JSON with unique object keys and string task IDs".into()));
        }
        // A B-tree narrows one dimension; no-match work can still be linear.
        // All branches share the same snapshot; no record column is accessed.
        let mut stmt = tx.prepare(CANDIDATES)?;
        let mut rows = stmt.query(params![id, from, until, now])?;
        while let Some(row) = rows.next()? {
            let start = scalar(row.get(0)?, now)?;
            let end = scalar(row.get(1)?, now)?;
            if start < until && end > from {
                return Ok(true);
            }
        }
        Ok(false)
    }
}

#[cfg(test)]
mod tests;
