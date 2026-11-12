use super::{Result, TaskFilter};
use rusqlite::{Connection, types::Value as SqlValue};

/// ASCII-only lowercase: SQLite's lower() folds ASCII letters and leaves every
/// other character (and every non-letter) alone, so a word folded this way is
/// matched exactly by `instr(lower(field), …)`.
pub(super) fn ascii_lower(word: &str) -> String {
    word.chars()
        .map(|c| {
            if c.is_ascii_uppercase() {
                (c as u8 + b'a' - b'A') as char
            } else {
                c
            }
        })
        .collect()
}

/// Task ids are `t-YYYYMMDD-HHMMSS-xxxx`. A word shaped like an id prefix (a date
/// prefix such as `t-2026`, a fuller `t-YYYYMMDD-HHMMSS-hex` prefix, or the full id)
/// can never appear inside an id: no id contains a second `t-`. Such a word is
/// therefore matched with a primary-key range instead of a full-table `instr` scan.
/// Titles and goals are not searched with an id-shaped word. Returns the
/// `[start, end)` id bounds. Kept identical to TypeScript `idPrefixRange`
/// (src/tasks/store.ts).
pub(super) fn id_prefix_range(word: &str) -> Option<(String, String)> {
    if !is_id_prefix(word) {
        return None;
    }
    // Successor of the last character; ids extend the prefix with 0-9, a-f or `-`,
    // all below the successor, so `[prefix, successor)` covers exactly its extensions.
    let mut end = word.to_owned();
    let last = end.pop()?;
    end.push(char::from_u32(u32::from(last) + 1).unwrap_or('\u{10FFFF}'));
    Some((word.to_owned(), end))
}

/// The shape check for `id_prefix_range`: `t`, optionally followed by
/// `-1..8 digits`, `-1..6 digits` and `-1..4 hex` (the same shape the TypeScript
/// regex `/^t(?:-\d{1,8}(?:-\d{1,6}(?:-[0-9a-f]{1,4})?)?)?$/` accepts). The word
/// is already ASCII-lowered.
fn is_id_prefix(word: &str) -> bool {
    let mut rest = match word.strip_prefix('t') {
        Some(rest) => rest,
        None => return false,
    };
    if rest.is_empty() {
        return true;
    }
    for (max, hex) in [(8, false), (6, false), (4, true)] {
        let Some(body) = rest.strip_prefix('-') else {
            return false;
        };
        let digits = body
            .chars()
            .take_while(|c| {
                if hex {
                    c.is_ascii_hexdigit()
                } else {
                    c.is_ascii_digit()
                }
            })
            .count();
        if !(1..=max).contains(&digits) {
            return false;
        }
        // The accepted characters are ASCII, so the byte offset equals the char count.
        rest = &body[digits..];
        if rest.is_empty() {
            return true;
        }
    }
    false
}

/// Per-character Unicode lowercase, the same folding both runtimes apply to a
/// non-ASCII query word and to the decoded fields (see the TypeScript
/// counterpart `fold` in src/tasks/store.ts).
pub(super) fn fold(text: &str) -> String {
    text.chars()
        .map(|c| c.to_lowercase().collect::<String>())
        .collect()
}

/// The words SQLite cannot fold (anything with a non-ASCII character): they are
/// checked in `TaskStore::list` on the decoded records, with `fold` applied the
/// same way in both runtimes.
pub(super) fn unicode_words(filter: &TaskFilter<'_>) -> Vec<String> {
    filter
        .query
        .into_iter()
        .flat_map(|q| q.split_whitespace())
        .filter(|word| !word.is_ascii())
        .map(fold)
        .collect()
}

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
    // An id-shaped query word bounds the primary key, the most selective index
    // available, so it wins over every competing predicate (including the JSON
    // filters below). Kept identical to the TypeScript index choice.
    if filter.query.is_some_and(|q| {
        q.split_whitespace()
            .any(|w| w.is_ascii() && id_prefix_range(&ascii_lower(w)).is_some())
    }) {
        return " INDEXED BY sqlite_autoindex_tasks_1";
    }
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
    build_clauses(filter, &mut clauses, &mut bind);
    query_text(
        clauses,
        bind,
        "record",
        filter.limit.map_or(SqlValue::Integer(-1), |n| {
            SqlValue::Integer(i64::try_from(n).unwrap_or(i64::MAX))
        }),
        index_hint(filter),
    )
}

/// The paging variant of `query`: it also selects the row `id` so the caller can
/// continue a newest-first walk with an id cursor past this page. The walk always
/// rides the primary key: it delivers id order without a temp b-tree, and each
/// page continues from the previous one's cursor.
pub(super) fn page_query(
    filter: &TaskFilter<'_>,
    before: Option<&str>,
    batch: usize,
) -> (String, Vec<SqlValue>) {
    let mut clauses = Vec::new();
    let mut bind = Vec::<SqlValue>::new();
    // The same clauses as `query`; the paging cursor replaces the caller's
    // `before`, which the first page already contains.
    build_clauses(filter, &mut clauses, &mut bind);
    if let Some(cursor) = before {
        clauses.push("id<?".into());
        bind.push(SqlValue::Text(cursor.into()));
    }
    query_text(
        clauses,
        bind,
        "id, record",
        SqlValue::Integer(i64::try_from(batch).unwrap_or(i64::MAX)),
        " INDEXED BY sqlite_autoindex_tasks_1",
    )
}

/// Every WHERE clause of `query`, shared with `page_query`.
fn build_clauses(filter: &TaskFilter<'_>, clauses: &mut Vec<String>, bind: &mut Vec<SqlValue>) {
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
        clauses.push(format!("(CASE WHEN state='running' AND json_type(record, '$.question')='object' AND json_type(record, '$.question.answer') IS NULL THEN 'needs_input' ELSE state END) IN ({})", vec!["?"; states.len()].join(",")));
        bind.extend(states.iter().map(|s| SqlValue::Text((*s).into())));
    }
    if let Some(q) = filter.query {
        // Every whitespace-separated word must appear somewhere in the id
        // (which covers the short suffix and any date prefix), title or goal.
        // Kept identical to TypeScript `listTasksWhere` (src/tasks/store.ts):
        // ASCII words are matched exactly by SQLite (lower() folds ASCII), a
        // word shaped like an id prefix by the primary-key range, and words
        // SQLite cannot fold are checked on the decoded records in
        // `TaskStore::list` with the same per-character Unicode lowercase.
        for word in q.split_whitespace().filter(|w| !w.is_empty()) {
            if word.is_ascii() {
                let w = ascii_lower(word);
                if let Some((start, end)) = id_prefix_range(&w) {
                    clauses.push("id>=? AND id<?".into());
                    bind.push(SqlValue::Text(start));
                    bind.push(SqlValue::Text(end));
                } else {
                    clauses.push(
                        "(instr(lower(id), ?)>0 OR instr(lower(json_extract(record, '$.title')), ?)>0 OR instr(lower(json_extract(record, '$.brief.goal')), ?)>0)"
                            .to_owned(),
                    );
                    bind.push(SqlValue::Text(w.clone()));
                    bind.push(SqlValue::Text(w.clone()));
                    bind.push(SqlValue::Text(w));
                }
            }
        }
    }
}

/// Assemble the SQL around the shared clauses; the limit is always bound last.
fn query_text(
    clauses: Vec<String>,
    mut bind: Vec<SqlValue>,
    select: &str,
    limit: SqlValue,
    hint: &str,
) -> (String, Vec<SqlValue>) {
    let sql = format!(
        "SELECT {} FROM tasks{} {} ORDER BY id DESC LIMIT ?",
        select,
        hint,
        if clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", clauses.join(" AND "))
        }
    );
    bind.push(limit);
    (sql, bind)
}

#[cfg(test)]
#[path = "task_selection/tests.rs"]
mod tests;
