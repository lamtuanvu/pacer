//! Native `dispatch.dependencies` and `dispatch.dependencies.waive`, matching
//! `setWorkDependencies` and `waiveWorkDependency` in `src/dispatch/work.ts`:
//! one IMMEDIATE transaction holds the graph edit, the revision bump (whose
//! `work_task_changed` trigger appends `task.changed`), the dependency event
//! and the dependency-wait sync. TypeScript publishes nothing for these ops.
#![allow(clippy::result_large_err)]
use std::{cell::Cell, collections::HashSet};

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::AdmissionState;
use pacer_store::{StoreError, is_task_id};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::dispatch_ops::{
    authorize, finish, invalid, params_object, positive_int_issues, string_issues, type_name,
    with_reads,
};

const REASON_MAX: usize = 2000;

fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

fn unknown_work() -> CoreError {
    CoreError::new(Code::UnknownTask, "Unknown work")
}

struct Node {
    parent: Option<String>,
    root: String,
    dependencies: Vec<String>,
}

fn node(db: &Connection, id: &str) -> Result<Option<Node>, CoreError> {
    let row = db
        .query_row(
            "SELECT parent_id,root_id,dependencies FROM work_nodes WHERE task_id=?",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(internal)?;
    row.map(|(parent, root, dependencies)| {
        Ok(Node {
            parent,
            root,
            dependencies: serde_json::from_str(&dependencies).map_err(internal)?,
        })
    })
    .transpose()
}

/// `visit` in `setWorkDependencies`: one `seen` set per checked dependency.
fn reaches(
    db: &Connection,
    current: &str,
    target: &str,
    seen: &mut HashSet<String>,
) -> Result<bool, CoreError> {
    if current == target {
        return Ok(true);
    }
    if !seen.insert(current.to_owned()) {
        return Ok(false);
    }
    for dependency in node(db, current)?
        .map(|n| n.dependencies)
        .unwrap_or_default()
    {
        if reaches(db, &dependency, target, seen)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn accepted(db: &Connection, id: &str) -> Result<bool, CoreError> {
    if !is_task_id(id) {
        return Ok(false);
    }
    let record: Option<String> = db
        .query_row("SELECT record FROM tasks WHERE id=?", [id], |r| r.get(0))
        .optional()
        .map_err(internal)?;
    let Some(record) = record else {
        return Ok(false);
    };
    let task: Value = serde_json::from_str(&record).map_err(internal)?;
    Ok(task.pointer("/review/accepted") == Some(&Value::Bool(true)))
}

/// `syncDependencyWait` followed by `setWorkWait(id, "dependency", waiting)`.
fn sync_dependency_wait(
    db: &Connection,
    id: &str,
    task: &Value,
    now: f64,
) -> Result<(), CoreError> {
    let mut waiting = false;
    if task.get("state").and_then(Value::as_str) == Some("queued") {
        for dependency in node(db, id)?.map(|n| n.dependencies).unwrap_or_default() {
            let waived: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM work_dependency_waivers WHERE task_id=? AND dependency_id=?)",
                    params![id, dependency],
                    |r| r.get(0),
                )
                .map_err(internal)?;
            if !waived && !accepted(db, &dependency)? {
                waiting = true;
                break;
            }
        }
    }
    let row: Option<Option<f64>> = db
        .query_row(
            "SELECT started_at FROM work_waits WHERE task_id=? AND kind='dependency'",
            [id],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    let result = match row {
        None => db.execute(
            "INSERT INTO work_waits(task_id,kind,started_at,total_seconds,refs) VALUES(?,'dependency',?,0,?)",
            params![id, waiting.then_some(now), i64::from(waiting)],
        ),
        Some(None) if waiting => db.execute(
            "UPDATE work_waits SET started_at=?,refs=1 WHERE task_id=? AND kind='dependency'",
            params![now, id],
        ),
        Some(Some(started)) if !waiting => db.execute(
            "UPDATE work_waits SET total_seconds=total_seconds+?,started_at=NULL,refs=0 WHERE task_id=? AND kind='dependency'",
            params![(now - started).max(0.0), id],
        ),
        Some(_) => Ok(0),
    };
    result.map(drop).map_err(internal)
}

fn append_event(
    db: &Connection,
    id: &str,
    now: f64,
    kind: &str,
    data: &Value,
) -> Result<(), CoreError> {
    db.execute(
        "INSERT INTO work_events(root_id,task_id,at,kind,data) SELECT root_id,task_id,?,?,? FROM work_nodes WHERE task_id=?",
        params![now, kind, data.to_string(), id],
    )
    .map(drop)
    .map_err(internal)
}

/// Check, then edit the graph and bump the revision in one transaction.
fn write(
    ctx: &Ctx,
    id: &str,
    expect_rev: f64,
    now: f64,
    change: impl FnOnce(&Connection, &Node) -> Result<(), CoreError>,
    event: (&str, Value),
) -> Result<(), CoreError> {
    let mut state = AdmissionState::open(&ctx.pacer_home).map_err(|e| internal(e.0))?;
    let work = node(state.tasks.connection().map_err(internal)?, id)?;
    let task = state.tasks.read(id).map_err(internal)?;
    let (Some(_), Some(task)) = (work, task) else {
        return Err(unknown_work());
    };
    if task.get("rev").and_then(Value::as_f64).unwrap_or(1.0) != expect_rev {
        return Err(CoreError::new(Code::Conflict, "Task changed"));
    }
    let domain = Cell::new(None);
    let fail = |error: CoreError| {
        domain.set(Some(error));
        StoreError::Unchanged
    };
    let written = state.tasks.update_admitted_then(
        id,
        expect_rev as i64,
        now,
        |db, _| {
            let work = node(db, id)
                .map_err(fail)?
                .ok_or_else(|| fail(unknown_work()))?;
            change(db, &work).map_err(fail)
        },
        |db, task| {
            append_event(db, id, now, event.0, &event.1)
                .and_then(|()| sync_dependency_wait(db, id, task, now))
                .map_err(fail)
        },
    );
    match written {
        Ok(_) => Ok(()),
        Err(error) => Err(domain.take().unwrap_or_else(|| match error {
            StoreError::Conflict => CoreError::new(Code::Conflict, "Task changed"),
            StoreError::UnknownTask(_) => unknown_work(),
            other => internal(other),
        })),
    }
}

/// `String.prototype.trim` whitespace: Rust's set adds U+0085 and lacks U+FEFF.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

/// `reason.trim().slice(0, 2000)` in UTF-16 units; `None` when the cut would
/// leave a lone surrogate, which a Rust string cannot hold.
fn reason_text(reason: &str) -> Option<&str> {
    let reason = js_trim(reason);
    let mut units = 0;
    for (index, c) in reason.char_indices() {
        if units == REASON_MAX {
            return Some(&reason[..index]);
        }
        units += c.len_utf16();
        if units > REASON_MAX {
            return None;
        }
    }
    Some(reason)
}

/// A valid waiver reason whose stored text would end in half a surrogate pair.
pub fn dependencies_waive_stays_forwarded(op: &str, params: &Value) -> bool {
    op == "dispatch.dependencies.waive"
        && params
            .get("reason")
            .and_then(Value::as_str)
            .is_some_and(|r| js_trim(r).chars().count() <= REASON_MAX && reason_text(r).is_none())
}

fn text<'a>(p: &'a Map<String, Value>, key: &str) -> &'a str {
    p.get(key).and_then(Value::as_str).unwrap_or_default()
}

fn clock(ctx: &Ctx) -> f64 {
    (ctx.now * 1000.0).floor() / 1000.0
}

pub fn dispatch_dependencies(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("id", p.get("id"), Some(128), &mut issues);
        match p.get("dependencies") {
            Some(Value::Array(items)) => {
                for (index, item) in items.iter().enumerate() {
                    string_issues(
                        &format!("dependencies.{index}"),
                        Some(item),
                        Some(128),
                        &mut issues,
                    );
                }
                if items.len() > 100 {
                    issues.push("dependencies: Too big: expected array to have <=100 items".into());
                }
            }
            other => issues.push(format!(
                "dependencies: Invalid input: expected array, received {}",
                other.map_or("undefined", type_name)
            )),
        }
        positive_int_issues("expect_rev", p.get("expect_rev"), &mut issues);
        finish(issues)?;
        let id = text(&p, "id");
        let dependencies: Vec<String> = p["dependencies"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let event = json!({"dependencies": dependencies});
        let change = |db: &Connection, work: &Node| {
            for dependency in &dependencies {
                let same_root = node(db, dependency)?.is_some_and(|d| d.root == work.root);
                if !same_root || dependency == id {
                    return Err(invalid("Invalid dependency"));
                }
                if reaches(db, dependency, id, &mut HashSet::new())? {
                    return Err(invalid("Dependency cycle"));
                }
            }
            let mut unique: Vec<&String> = Vec::new();
            for dependency in &dependencies {
                if !unique.contains(&dependency) {
                    unique.push(dependency);
                }
            }
            let stored = serde_json::to_string(&unique).map_err(internal)?;
            db.execute(
                "UPDATE work_nodes SET dependencies=? WHERE task_id=?",
                params![stored, id],
            )
            .map_err(internal)?;
            db.execute("DELETE FROM work_dependency_waivers WHERE task_id=?", [id])
                .map_err(internal)?;
            Ok(())
        };
        let expect_rev = p["expect_rev"].as_f64().unwrap_or_default();
        write(
            ctx,
            id,
            expect_rev,
            clock(ctx),
            change,
            ("dependencies.changed", event),
        )?;
        with_reads(ctx, |reads| reads.scoped_tree(id))
    })
}

pub fn dispatch_dependencies_waive(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("id", p.get("id"), Some(128), &mut issues);
        string_issues("dependency", p.get("dependency"), Some(128), &mut issues);
        let trimmed = p.get("reason").map(|reason| match reason {
            Value::String(reason) => Value::String(js_trim(reason).to_owned()),
            other => other.clone(),
        });
        string_issues("reason", trimmed.as_ref(), Some(REASON_MAX), &mut issues);
        positive_int_issues("expect_rev", p.get("expect_rev"), &mut issues);
        finish(issues)?;
        let (id, dependency) = (text(&p, "id"), text(&p, "dependency"));
        let reason = reason_text(text(&p, "reason"))
            .ok_or_else(|| internal("waiver reason requires the TypeScript path"))?;
        let now = clock(ctx);
        let change = |db: &Connection, work: &Node| {
            if !work.dependencies.iter().any(|d| d == dependency)
                && node(db, dependency)?.and_then(|n| n.parent).as_deref() != Some(id)
            {
                return Err(invalid("Not a dependency or direct child of this work"));
            }
            db.execute(
                "INSERT OR REPLACE INTO work_dependency_waivers(task_id,dependency_id,reason,at) VALUES(?,?,?,?)",
                params![id, dependency, reason, now],
            )
            .map(drop)
            .map_err(internal)
        };
        let event = json!({"dependency": dependency, "reason": reason});
        let expect_rev = p["expect_rev"].as_f64().unwrap_or_default();
        write(
            ctx,
            id,
            expect_rev,
            now,
            change,
            ("dependencies.waived", event),
        )?;
        with_reads(ctx, |reads| reads.scoped_tree(id))
    })
}

#[cfg(test)]
#[path = "dependency_writes/tests.rs"]
mod tests;
