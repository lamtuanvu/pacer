use super::{Result, TaskFilter};
use rusqlite::{Connection, types::Value as SqlValue};

// Private acceleration only: no shared schema version or record format change.
// Check before DDL so subsequent opens do not acquire a writer reservation.
pub(super) fn ensure_index(db: &Connection) -> Result<()> {
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='tasks_native_unarchived_id')",
        [], |r| r.get(0),
    )?;
    if !exists {
        db.execute_batch("CREATE INDEX IF NOT EXISTS tasks_native_unarchived_id ON tasks(id DESC) WHERE archived=0")?;
    }
    Ok(())
}

fn index_hint(filter: &TaskFilter<'_>) -> &'static str {
    // Do not override competing selective predicates (including JSON filters).
    if filter.repo.is_some()
        || filter.executor.is_some()
        || filter.visible_states.is_some()
        || filter.settled_before.is_some()
        || filter.query.is_some()
    {
        return "";
    }
    match (
        filter.states.is_some(),
        filter.updated_since.is_some(),
        filter.created_since.is_some(),
    ) {
        (true, false, false) => " INDEXED BY tasks_state",
        (false, true, false) => " INDEXED BY tasks_updated_at",
        (false, false, true) => " INDEXED BY tasks_created_at",
        (false, false, false) if !filter.all => " INDEXED BY tasks_native_unarchived_id",
        (false, false, false) => " INDEXED BY sqlite_autoindex_tasks_1",
        _ => "",
    }
}

pub(super) fn query(filter: &TaskFilter<'_>) -> (String, Vec<SqlValue>) {
    let mut clauses = Vec::new();
    let mut bind = Vec::<SqlValue>::new();
    if !filter.all {
        clauses.push("archived=0".to_owned());
    }
    if let Some(v) = filter.settled_before {
        clauses.push("settled_at<?".into());
        bind.push(SqlValue::Real(v));
    }
    if let Some(v) = filter.before {
        clauses.push("id<?".into());
        bind.push(SqlValue::Text(v.into()));
    }
    if let Some(states) = filter.states {
        clauses.push(format!("state IN ({})", vec!["?"; states.len()].join(",")));
        bind.extend(states.iter().map(|s| SqlValue::Text((*s).into())));
    }
    if let Some(v) = filter.updated_since {
        clauses.push("updated_at>=?".into());
        bind.push(SqlValue::Real(v));
    }
    if let Some(v) = filter.created_since {
        clauses.push("created_at>=?".into());
        bind.push(SqlValue::Real(v));
    }
    if let Some(v) = filter.repo {
        let paths = filter.repo_paths.unwrap_or_default();
        clauses.push(format!(
                "(json_extract(record, '$.repo.key')=? OR (json_type(record, '$.repo') IS NULL OR json_type(record, '$.repo')='null') AND repo IN ({}))",
                vec!["?"; paths.len()].join(",")
            ));
        bind.push(SqlValue::Text(v.into()));
        bind.extend(paths.iter().map(|p| SqlValue::Text((*p).into())));
    }
    if let Some(v) = filter.executor {
        clauses.push("COALESCE(json_extract(record, '$.result.executor'),json_extract(record, '$.executor'),json_extract(record, '$.attempts[#-1].executor'),json_extract(record, '$.requestedExecutor'))=?".into());
        bind.push(SqlValue::Text(v.into()));
    }
    if let Some(states) = filter.visible_states {
        clauses.push(format!("(CASE WHEN state='running' AND json_type(record, '$.question')='object' AND json_type(record, '$.question.answer') IS NULL THEN 'needs_input' ELSE state END) IN ({})",vec!["?"; states.len()].join(",")));
        bind.extend(states.iter().map(|s| SqlValue::Text((*s).into())));
    }
    if let Some(q) = filter.query {
        // Every whitespace-separated word must appear somewhere in the id
        // (which covers the short suffix and any date prefix), title or goal.
        // Kept identical to TypeScript `listTasksWhere` (src/tasks/store.ts).
        for word in q.split_whitespace().filter(|w| !w.is_empty()) {
            let w = word.to_lowercase();
            clauses.push(
                "(instr(lower(id), ?)>0 OR instr(lower(json_extract(record, '$.title')), ?)>0 OR instr(lower(json_extract(record, '$.brief.goal')), ?)>0)"
                    .to_owned(),
            );
            bind.push(SqlValue::Text(w.clone()));
            bind.push(SqlValue::Text(w.clone()));
            bind.push(SqlValue::Text(w.clone()));
        }
    }
    let sql = format!(
        "SELECT record FROM tasks{} {} ORDER BY id DESC LIMIT ?",
        index_hint(filter),
        if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        }
    );
    bind.push(filter.limit.map_or(SqlValue::Integer(-1), |n| {
        SqlValue::Integer(i64::try_from(n).unwrap_or(i64::MAX))
    }));
    (sql, bind)
}

#[cfg(test)]
#[path = "task_selection/tests.rs"]
mod tests;
