//! Live `runs` summaries for the /v3 snapshot. Read-only over workflow tables.
use crate::js::*;
use pacer_foundation::Ctx;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

fn has_table(db: &Connection, name: &str) -> bool {
    db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        [name],
        |_| Ok(true),
    )
    .optional()
    .ok()
    .flatten()
    .unwrap_or(false)
}

fn open_ro(ctx: &Ctx) -> Option<Connection> {
    let path = ctx.pacer_home.join("state/tasks.db");
    Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
}

/// Bijective base-26 letters: A–Z, AA, AB, … (matches `src/workflow/letters.ts`).
pub fn letter_at(index: u32) -> String {
    let mut i = index as i64;
    let mut out = String::new();
    loop {
        let rem = (i % 26) as u8;
        out.insert(0, char::from(b'A' + rem));
        i = i / 26 - 1;
        if i < 0 {
            break;
        }
    }
    out
}

pub fn next_letter(used: &HashSet<String>) -> String {
    let mut i = 0u32;
    loop {
        let letter = letter_at(i);
        if !used.contains(&letter) {
            return letter;
        }
        i += 1;
    }
}

pub fn resolve_run_letters(runs: &[(String, f64, Option<String>)]) -> HashMap<String, String> {
    let mut used = HashSet::new();
    let mut out = HashMap::new();
    for (id, _, letter) in runs {
        if let Some(l) = letter {
            let t = l.trim().to_uppercase();
            if !t.is_empty() {
                out.insert(id.clone(), t.clone());
                used.insert(t);
            }
        }
    }
    let mut missing: Vec<_> = runs
        .iter()
        .filter(|(id, _, _)| !out.contains_key(id))
        .map(|(id, at, _)| (id.clone(), *at))
        .collect();
    missing.sort_by(|a, b| {
        a.1.partial_cmp(&b.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0.cmp(&b.0))
    });
    for (id, _) in missing {
        let letter = next_letter(&used);
        used.insert(letter.clone());
        out.insert(id, letter);
    }
    out
}

fn priority_rank(p: &str) -> i32 {
    match p {
        "urgent" => 0,
        "background" => 2,
        _ => 1,
    }
}

fn unblocks_rank(blocks: &str) -> i32 {
    match blocks {
        "run" | "step" => 0,
        "branch" => 1,
        _ => 2,
    }
}

fn as_priority(p: &str) -> &'static str {
    match p {
        "urgent" => "urgent",
        "background" => "background",
        _ => "normal",
    }
}

fn engine_owned(kind: &str) -> bool {
    kind == "orchestrate" || kind == "workflow-root"
}

/// Compose live run summaries. Missing workflow tables → [].
#[allow(clippy::collapsible_if, clippy::type_complexity)]
pub fn snapshot_runs(ctx: &Ctx) -> Vec<Value> {
    let db = match open_ro(ctx) {
        Some(db) => db,
        None => return Vec::new(),
    };
    if !has_table(&db, "workflow_runs") {
        return Vec::new();
    }

    let run_cols: HashSet<String> = db
        .prepare("PRAGMA table_info(workflow_runs)")
        .ok()
        .and_then(|mut s| {
            s.query_map([], |row| row.get::<_, String>(1))
                .ok()
                .map(|rows| rows.flatten().collect())
        })
        .unwrap_or_default();
    let col_bare = |name: &str, fallback: &str| {
        if run_cols.contains(name) {
            name.to_string()
        } else {
            fallback.to_string()
        }
    };
    let sql = format!(
        "SELECT id, title, workflow, status, {priority}, {paused}, {letter}, created_at,
                {orch_state}, {planner}, {pending}, reason, {next_wake}, {origin}
         FROM workflow_runs
         WHERE status IN ('running', 'waiting')
         ORDER BY created_at, id",
        priority = col_bare("priority", "NULL"),
        paused = col_bare("paused_reason", "NULL"),
        letter = col_bare("letter", "NULL"),
        orch_state = col_bare("orchestrator_state", "NULL"),
        planner = col_bare("planner", "NULL"),
        pending = col_bare("pending_planner", "NULL"),
        next_wake = col_bare("next_wake_at", "NULL"),
        origin = col_bare("origin", "NULL"),
    );
    let mut run_stmt = match db.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };

    type RunTuple = (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        f64,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<f64>,
        Option<String>,
    );

    let run_rows: Vec<RunTuple> = match run_stmt.query_map([], |row| {
        Ok((
            row.get(0)?,
            row.get(1)?,
            row.get(2)?,
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
            row.get(8)?,
            row.get(9)?,
            row.get(10)?,
            row.get(11)?,
            row.get(12)?,
            row.get(13)?,
        ))
    }) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => return Vec::new(),
    };

    let letter_inputs: Vec<_> = run_rows
        .iter()
        .map(|(id, _, _, _, _, _, letter, at, ..)| (id.clone(), *at, letter.clone()))
        .collect();
    let letters = resolve_run_letters(&letter_inputs);

    // One query: all steps for live runs.
    let mut steps_by_run: HashMap<String, Vec<(String, i64, String, Option<String>, String)>> =
        HashMap::new();
    if has_table(&db, "workflow_steps") {
        let mut step_stmt = match db.prepare(
            "SELECT s.run_id, s.step_id, s.attempt, s.branch, s.task_id, s.status
             FROM workflow_steps s
             JOIN workflow_runs r ON r.id = s.run_id
             WHERE r.status IN ('running', 'waiting')",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        if let Ok(rows) = step_stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
            ))
        }) {
            for row in rows.flatten() {
                let (run_id, step_id, attempt, branch, task_id, status) = row;
                steps_by_run.entry(run_id).or_default().push((
                    step_id,
                    attempt,
                    branch.unwrap_or_default(),
                    task_id,
                    status,
                ));
            }
        }
    }

    // Task kinds for engine-owned exclusion (one query).
    let mut task_kinds: HashMap<String, String> = HashMap::new();
    if has_table(&db, "tasks") {
        let mut ids = HashSet::new();
        for steps in steps_by_run.values() {
            for (_, _, _, task_id, _) in steps {
                if let Some(id) = task_id {
                    ids.insert(id.clone());
                }
            }
        }
        if !ids.is_empty() {
            // Restrict to referenced task ids (chunked); never scan the whole tasks table.
            let id_list: Vec<String> = ids.into_iter().collect();
            const CHUNK: usize = 400;
            for chunk in id_list.chunks(CHUNK) {
                let placeholders = vec!["?"; chunk.len()].join(",");
                let sql = format!(
                    "SELECT id, COALESCE(json_extract(record, '$.kind'), '') FROM tasks WHERE id IN ({placeholders})"
                );
                let mut stmt = match db.prepare(&sql) {
                    Ok(s) => s,
                    Err(_) => return Vec::new(),
                };
                let params: Vec<&dyn rusqlite::types::ToSql> = chunk
                    .iter()
                    .map(|id| id as &dyn rusqlite::types::ToSql)
                    .collect();
                if let Ok(rows) = stmt.query_map(params.as_slice(), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }) {
                    for (tid, kind) in rows.flatten() {
                        task_kinds.insert(tid, kind);
                    }
                }
            }
        }
    }

    // Open person questions (blocks) and orchestrator questions — one query each.
    let mut person_blocks: HashMap<String, Vec<String>> = HashMap::new();
    let mut orch_asks: HashSet<String> = HashSet::new();
    if has_table(&db, "workflow_questions") {
        if let Ok(mut stmt) = db.prepare(
            "SELECT run_id, blocks FROM workflow_questions
             WHERE status = 'open' AND answerer = 'person'",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }) {
                for (run_id, blocks) in rows.flatten() {
                    person_blocks.entry(run_id).or_default().push(blocks);
                }
            }
        }
        if let Ok(mut stmt) = db.prepare(
            "SELECT DISTINCT run_id FROM workflow_questions
             WHERE status = 'open' AND answerer = 'orchestrator'",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
                for id in rows.flatten() {
                    orch_asks.insert(id);
                }
            }
        }
    }

    let mut composed = Vec::new();
    for row in &run_rows {
        let (
            id,
            title,
            workflow,
            status,
            priority,
            paused_reason,
            _letter,
            created_at,
            orch_state,
            planner,
            pending_planner,
            reason,
            next_wake_at,
            origin,
        ) = row;

        let steps = steps_by_run.get(id).cloned().unwrap_or_default();
        // Latest attempt per (step_id, branch).
        let mut latest: HashMap<(String, String), (i64, Option<String>, String)> = HashMap::new();
        for (step_id, attempt, branch, task_id, st) in &steps {
            let key = (step_id.clone(), branch.clone());
            let replace = match latest.get(&key) {
                None => true,
                Some((prev, _, _)) => *attempt >= *prev,
            };
            if replace {
                latest.insert(key, (*attempt, task_id.clone(), st.clone()));
            }
        }

        let mut counts = json!({"running":0,"waiting":0,"done":0,"failed":0});
        let mut waiting_no_task = false;
        let mut executor_work = false;
        for ((_, _), (_, task_id, st)) in &latest {
            if let Some(tid) = task_id {
                if task_kinds
                    .get(tid)
                    .map(|k| engine_owned(k))
                    .unwrap_or(false)
                {
                    continue;
                }
            }
            match st.as_str() {
                "running" => {
                    counts["running"] = json!(counts["running"].as_i64().unwrap_or(0) + 1);
                    if task_id.is_some() {
                        executor_work = true;
                    }
                }
                "waiting" => {
                    counts["waiting"] = json!(counts["waiting"].as_i64().unwrap_or(0) + 1);
                    if task_id.is_none() {
                        waiting_no_task = true;
                    } else {
                        executor_work = true;
                    }
                }
                "done" => counts["done"] = json!(counts["done"].as_i64().unwrap_or(0) + 1),
                "failed" => counts["failed"] = json!(counts["failed"].as_i64().unwrap_or(0) + 1),
                _ => {}
            }
        }

        let open_person = person_blocks.contains_key(id);
        let orch = orch_state.as_deref().unwrap_or("");
        let waits_on = if open_person {
            "you"
        } else if orch_asks.contains(id)
            || orch == "turn"
            || orch == "retrying"
            || orch == "blocked"
            || waiting_no_task
        {
            "planner"
        } else if executor_work {
            "executors"
        } else {
            "nothing"
        };

        let prio = as_priority(priority.as_deref().unwrap_or("normal"));
        let mut orchestrator = Map::new();
        orchestrator.insert(
            "state".into(),
            json!(if orch.is_empty() { "idle" } else { orch }),
        );
        let planner_val = pending_planner
            .as_ref()
            .filter(|s| !s.is_empty())
            .or_else(|| planner.as_ref().filter(|s| !s.is_empty()));
        if let Some(p) = planner_val {
            orchestrator.insert("planner".into(), json!(p));
        }
        if let Some(r) = reason.as_ref().filter(|s| !s.is_empty()) {
            orchestrator.insert("reason".into(), json!(r));
        }
        if let Some(n) = next_wake_at {
            orchestrator.insert("next_wake_at".into(), number(*n));
        }

        let mut obj = Map::new();
        obj.insert("id".into(), json!(id));
        obj.insert(
            "letter".into(),
            json!(letters.get(id).cloned().unwrap_or_else(|| "A".into())),
        );
        obj.insert("title".into(), json!(title));
        obj.insert("workflow".into(), json!(workflow));
        if let Some(o) = origin.as_ref().filter(|s| !s.is_empty()) {
            obj.insert("origin".into(), json!(o));
        }
        obj.insert("status".into(), json!(status));
        obj.insert("priority".into(), json!(prio));
        if let Some(pr) = paused_reason.as_ref().filter(|s| !s.is_empty()) {
            obj.insert("paused_reason".into(), json!(pr));
        }
        obj.insert("waits_on".into(), json!(waits_on));
        obj.insert("steps".into(), counts);
        obj.insert("orchestrator".into(), Value::Object(orchestrator));

        let ub = person_blocks
            .get(id)
            .map(|bs| bs.iter().map(|b| unblocks_rank(b)).min().unwrap_or(2))
            .unwrap_or(2);
        composed.push((
            priority_rank(prio),
            ub,
            *created_at,
            id.clone(),
            Value::Object(obj),
        ));
    }

    composed.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then(a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal))
            .then(a.3.cmp(&b.3))
    });
    composed.into_iter().map(|(_, _, _, _, v)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letter_sequence() {
        assert_eq!(letter_at(0), "A");
        assert_eq!(letter_at(25), "Z");
        assert_eq!(letter_at(26), "AA");
        assert_eq!(letter_at(27), "AB");
        assert_eq!(letter_at(52), "BA");
    }
}
