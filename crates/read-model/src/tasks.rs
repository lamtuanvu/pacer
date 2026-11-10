//! Task selection and message/liveness enrichment. SQLite is authoritative; the
//! shared store imports old-release JSON using the existing revision protocol.
use crate::snapshot::ActiveCounts;
use crate::{Error, js::*, read};
use pacer_foundation::Ctx;
use pacer_store::{TaskFilter, TaskStore};
use regex::Regex;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::Path;
fn replace(s: &str, pat: &str, to: &str) -> String {
    crate::js::regex(pat).map_or_else(|_| s.to_owned(), |r| r.replace_all(s, to).into_owned())
}
fn balanced(s: &str) -> String {
    let mut stack = Vec::new();
    for (i, c) in s.char_indices() {
        if "([{“".contains(c) {
            stack.push((i, c));
        } else if let Some((_, open)) = stack.last()
            && "([{“".chars().position(|x| x == *open) == ")]}”".chars().position(|x| x == c)
        {
            stack.pop();
        }
    }
    trim(&s[..stack.first().map_or(s.len(), |(i, _)| *i)]).into()
}
fn clip_points(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.into();
    }
    let prefix: String = s.chars().take(max - 1).collect();
    let cut = prefix.rfind(' ').filter(|i| *i > 0).unwrap_or(prefix.len());
    let b = balanced(&prefix[..cut]);
    format!("{}…", if b.is_empty() { "Task" } else { &b })
}
fn links(s: &str) -> String {
    let Ok(re) = Regex::new(r"!?\[([^\]]+)\]\(") else {
        return s.into();
    };
    let mut rest = s;
    let mut result = String::new();
    while let Some(cap) = re.captures(rest) {
        let Some(m) = cap.get(0) else { break };
        result.push_str(&rest[..m.start()]);
        result.push_str(cap.get(1).map_or("", |x| x.as_str()));
        let mut depth = 1;
        let mut end = m.end();
        for (i, c) in rest[m.end()..].char_indices() {
            end = m.end() + i + c.len_utf8();
            if c == '(' {
                depth += 1;
            }
            if c == ')' {
                depth -= 1;
            }
            if depth == 0 {
                break;
            }
        }
        rest = &rest[end..];
    }
    result.push_str(rest);
    result
}
pub fn goal_title(goal: &str, compact: bool) -> String {
    let input = replace(&slice(goal, 4000), r"```[^\n]*\n[\s\S]*?(?:```|$)", "");
    let sentence_re = crate::js::regex(r"[.!?](?:\s|$)").ok();
    for line in input.lines() {
        let mut plain = replace(&links(line), r"!?\[([^\]]+)\]\[[^\]]*\]", "$1");
        plain = replace(
            &plain,
            r"^[\t \r]*(?:(?:#{1,6}\s*|>\s*|[-+*]\s+|\d+[.)]\s+))+",
            "",
        );
        plain = replace(&plain, r"[`*~]", "");
        // Underscores surrounded by letters/numbers belong to identifiers.
        let chars: Vec<char> = plain.chars().collect();
        plain = chars
            .iter()
            .enumerate()
            .filter(|(i, c)| {
                **c != '_'
                    || (*i > 0
                        && chars[*i - 1].is_alphanumeric()
                        && chars.get(*i + 1).is_some_and(|c| c.is_alphanumeric()))
            })
            .map(|(_, c)| *c)
            .collect();
        plain = replace(&plain, r"\s+#+\s*$", "");
        plain = replace(&plain, r"\s+", " ");
        let plain = trim(&plain);
        if plain.is_empty()
            || ["goal", "task", "summary", "context"]
                .contains(&plain.trim_end_matches(':').to_ascii_lowercase().as_str())
        {
            continue;
        }
        let sentence = sentence_re
            .as_ref()
            .and_then(|r| r.find(plain).map(|m| &plain[..m.start()]))
            .unwrap_or(plain);
        let sentence = balanced(sentence);
        if sentence.is_empty() {
            continue;
        }
        return if compact {
            clip_points(&sentence, 80)
        } else {
            sentence
        };
    }
    "Task".into()
}
fn safe_title(title: &str) -> String {
    Regex::new(r#"(^|[\s("'`])((?:[A-Za-z]:[\\/]|~?/)[^\s<>`]+)"#).map_or_else(
        |_| title.into(),
        |r| {
            r.replace_all(title, |c: &regex::Captures<'_>| {
                format!(
                    "{}{}",
                    &c[1],
                    c[2].split(['/', '\\'])
                        .rfind(|s| !s.is_empty())
                        .unwrap_or("file")
                )
            })
            .into_owned()
        },
    )
}
fn capitalize(s: &str) -> String {
    let mut out = String::new();
    let mut changed = false;
    for c in s.chars() {
        if !changed && c.is_alphabetic() {
            out.extend(c.to_uppercase());
            changed = true;
        } else {
            out.push(c);
        }
    }
    out
}
fn leading(s: &str) -> String {
    replace(s, r"^[\s\p{P}>+=~|]+", "")
}
fn is_path(token: &str) -> bool {
    crate::js::regex(r"^(?:/|\.{1,2}/|~|[A-Za-z]:[\\/])").is_ok_and(|r| r.is_match(token))
        || token.split('/').count() >= 3
        || token.contains('/')
            && crate::js::regex(r"\.[A-Za-z0-9]{1,10}$").is_ok_and(|r| r.is_match(token))
}
fn short_title(goal: &str, legacy: bool) -> String {
    let input = slice(goal, 400);
    let mut text = replace(&input, r"```[\s\S]*?(?:```|$)|`[^`]*(?:`|$)", " ");
    if let Ok(url) = crate::js::regex(r"(?i)(?:https?://|www\.)[^\s<>]+") {
        text = url
            .replace_all(&text, |c: &regex::Captures<'_>| {
                let matched = c.get(0).map_or("", |m| m.as_str());
                let suffix = crate::js::regex(r"[.!?;:,]+$")
                    .ok()
                    .and_then(|r| r.find(matched).map(|m| m.as_str()))
                    .unwrap_or("");
                format!(" \u{1}url{suffix}")
            })
            .into_owned();
    }
    let mut basename = String::new();
    let lines = text.split('\n');
    for raw in lines {
        let line = replace(
            &replace(raw, r"^\s*#{1,6}\s*", ""),
            r"(?i)^\s*(?:goal|task|summary|context)\s*(?::\s*|$)",
            "",
        );
        let mut cleaned = String::new();
        let Ok(tokens) = crate::js::regex(r"[\s<>]+") else {
            continue;
        };
        for token in tokens.split(&line) {
            if token.is_empty() {
                continue;
            }
            let candidate = replace(
                &replace(token, r#"^[([{"']+|[)\]}"',;:!?]+$"#, ""),
                r"\.+$",
                "",
            );
            let url = candidate == "\u{1}url";
            if !url && !is_path(&candidate) {
                cleaned.push(' ');
                cleaned.push_str(token);
                continue;
            }
            let punctuation = crate::js::regex(r"[.!?;:,]+$")
                .ok()
                .and_then(|r| r.find(token).map(|m| m.as_str()))
                .unwrap_or("");
            if !url && basename.is_empty() {
                basename = trim(&leading(&replace(
                    candidate.split(['\\', '/']).next_back().unwrap_or(""),
                    r"\.[^.]*$",
                    "",
                )))
                .into();
            }
            let clause = crate::js::regex(r"[.!?;:,](?:\s|$)")
                .ok()
                .and_then(|r| r.split(&cleaned).last().map(String::from))
                .unwrap_or(cleaned.clone());
            if !trim(&leading(&clause)).is_empty() {
                cleaned = replace(
                    &cleaned,
                    r"(?i)(?:\s+(?:in|on|at|to|for|from|of|and|or|with|into|under|via|by|the|a|an))+\s*$",
                    "",
                );
                cleaned.push_str(punctuation);
                break;
            }
            cleaned.push(' ');
            cleaned.push_str(punctuation);
        }
        cleaned = trim(&replace(&cleaned, r"\s+", " ")).into();
        if let Ok(parts) = crate::js::regex(r"[.!?;:,](?:\s|$)|\s[—–]\s") {
            for part in parts.split(&cleaned) {
                let clause = leading(part);
                let clause = trim(&clause);
                if !clause.is_empty() {
                    return title_clip(&capitalize(clause), legacy);
                }
            }
        }
    }
    title_clip(
        &capitalize(if text == input && !basename.is_empty() {
            &basename
        } else {
            "Task"
        }),
        legacy,
    )
}
fn title_clip(s: &str, legacy: bool) -> String {
    if !legacy {
        return clip_points(s, 60);
    }
    if s.chars().count() <= 60 {
        return s.into();
    }
    let prefix: String = s.chars().take(59).collect();
    let cut = prefix.rfind(' ').filter(|i| *i > 0).unwrap_or(prefix.len());
    format!("{}…", prefix[..cut].trim_end_matches(whitespace))
}

pub fn full_title(t: &Value) -> String {
    let title = trim(text(&t["title"]));
    let goal = trim(text(&t["brief"]["goal"]));
    let generated = title.is_empty()
        || title == goal
        || ((title.ends_with('…') || balanced(title) != title)
            && goal.starts_with(title.trim_end_matches('…')))
        || title == clip_points(goal, 60)
        || title == short_title(goal, false)
        || title == short_title(goal, true);
    safe_title(&if generated {
        goal_title(goal, false)
    } else {
        title.into()
    })
}
/// Match TS `visibleTaskState`: a running task with an unanswered question is
/// presented as `needs_input` on read surfaces (`task.list` / `task.get` rows).
pub fn visible_task_state(task: &Value) -> String {
    if text(&task["state"]) == "running"
        && task
            .get("question")
            .is_some_and(|q| q.is_object() && q.get("answer").is_none())
    {
        "needs_input".into()
    } else {
        text(&task["state"]).into()
    }
}
pub fn task_data(t: &Value, alive: &dyn Fn(i64) -> bool) -> Value {
    let last = array(&t["attempts"]).last().unwrap_or(&Value::Null);
    let coalesce = |items: &[&Value]| {
        items
            .iter()
            .find(|v| !v.is_null())
            .map_or(Value::Null, |v| (*v).clone())
    };
    let updated = [
        &t["createdAt"],
        &last["startedAt"],
        &last["endedAt"],
        &t["attemptStartedAt"],
        &t["reviewRequest"]["at"],
        &t["stopPending"]["requestedAt"],
        &t["question"]["at"],
        &t["question"]["answeredAt"],
    ]
    .iter()
    .map(|v| num(v))
    .fold(0.0, f64::max);
    let mut row = json!({
    "id":t["id"],"title":if trim(text(&t["title"])).is_empty(){clip_points(&goal_title(text(&t["brief"]["goal"]),true),60)}else{clip_points(&full_title(t),60)},"state":visible_task_state(t),"goal":clip(text(&t["brief"]["goal"]),200),"executor":coalesce(&[&t["result"]["executor"],&t["executor"],&last["executor"]]),"backend":coalesce(&[&t["result"]["backend"],&t["backend"]]),"worktree":coalesce(&[&t["result"]["worktree"],&t["worktree"]]),"updatedAt":number(updated)}
    );
    if truth(&t["placement"]["mode"]) && t["placement"].get("why").is_some() {
        row["placement"] = t["placement"].clone();
    }
    for key in ["interactionMode", "conversation"] {
        if truth(&t[key]) {
            row[key] = t[key].clone();
        }
    }
    let acceptance = if truth(&t["result"]["acceptance"]) {
        if truth(&t["result"]["acceptance"]["passed"]) {
            "passed"
        } else {
            "failed"
        }
    } else if !truth(&t["brief"]["acceptance"]) {
        "none"
    } else if t["progress"]["phase"] == "testing" {
        "running"
    } else {
        "pending"
    };
    row["acceptanceState"] = json!(acceptance);
    for key in [
        "reviewRequest",
        "stopPending",
        "review",
        "resolved",
        "dismissed",
        "retryOf",
        "retriedBy",
    ] {
        if truth(&t[key]) {
            row[key] = t[key].clone();
        }
    }
    if truth(&t["result"]["brokenReason"]) {
        for key in ["brokenExecutor", "brokenReason"] {
            if let Some(v) = t["result"].get(key) {
                row[key] = v.clone();
            }
        }
    }
    if truth(&t["attemptStartedAt"]) {
        row["attemptStartedAt"] = t["attemptStartedAt"].clone();
    }
    if ["queued", "running"].contains(&text(&t["state"])) {
        if truth(&t["progress"]) {
            let p = &t["progress"];
            row["progress"] = json!({
            "phase":p["phase"],"lastOutputAt":p["lastOutputAt"],"files":p["files"],"commits":p["commits"],"logBytes":p["logBytes"]}
            );
        }
        row["runnerAlive"] = json!(t["runnerPid"].as_i64().is_some_and(alive));
    }
    row
}
pub fn registered_repos(ctx: &Ctx) -> Vec<Value> {
    registered_from(&read(ctx, "state/repos.json"))
}
fn registered_from(reg: &Value) -> Vec<Value> {
    let mut rows = values(reg);
    rows.sort_by(|a, b| num(&b["lastUsed"]).total_cmp(&num(&a["lastUsed"])));
    let mut out = Vec::new();
    for r in rows {
        if !out.iter().any(|v: &Value| v["key"] == r["key"]) {
            out.push(json!({
            "key":r["key"],"path":r["path"],"label":label(r)}
            ));
        }
    }
    out
}
fn label(r: &Value) -> String {
    if text(&r["key"]).starts_with("local:") {
        Path::new(text(&r["path"]))
            .file_name()
            .map_or("", |s| s.to_str().unwrap_or(""))
            .into()
    } else {
        text(&r["key"])
            .split('/')
            .skip(1)
            .collect::<Vec<_>>()
            .join("/")
    }
}
fn apply_repo_label(repo: &mut Value, peers: &[Value]) {
    let short = label(repo);
    let collision = peers
        .iter()
        .any(|other| other["key"] != repo["key"] && label(other) == short);
    repo["label"] = json!(if collision {
        if text(&repo["key"]).starts_with("local:") {
            format!("{short} ({})", text(&repo["key"]))
        } else {
            text(&repo["key"]).into()
        }
    } else {
        short
    });
}
fn repo(reg: &Value, aliases: &Value, t: &Value) -> Value {
    if truth(&t["repo"]) {
        return t["repo"].clone();
    }
    let path = text(&t["brief"]["repo"]);
    let mut roots: Vec<&String> = reg
        .as_object()
        .into_iter()
        .flat_map(|m| m.keys())
        .chain(aliases.as_object().into_iter().flat_map(|m| m.keys()))
        .collect();
    roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
    if let Some(root) = roots
        .into_iter()
        .find(|r| path == r.as_str() || path.starts_with(&format!("{r}/")))
    {
        let r = &reg[aliases[root].as_str().unwrap_or(root)];
        return json!({
        "key":r["key"],"path":r["path"],"label":label(r)}
        );
    }
    json!({
    "key":format!("local:{:x}",Sha256::digest(path.as_bytes()))[..18],"label":Path::new(path).file_name().and_then(|s|s.to_str()).unwrap_or(""),"path":path,"identityUnverified":true}
    )
}
fn has_table(db: &Connection, name: &str) -> Result<bool, Error> {
    Ok(db
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
            [name],
            |_| Ok(true),
        )
        .optional()?
        .unwrap_or(false))
}
struct EnrichTables {
    messages: bool,
    liveness: bool,
    work_nodes: bool,
}
fn enrich_tables(db: &Connection) -> Result<EnrichTables, Error> {
    Ok(EnrichTables {
        messages: has_table(db, "messages")?,
        liveness: has_table(db, "msg_liveness")?,
        work_nodes: has_table(db, "work_nodes")?,
    })
}
fn enrich_api_task(
    t: &Value,
    repo: Value,
    active: &ActiveCounts,
    alive: &dyn Fn(i64) -> bool,
    db: &Connection,
    tables: &EnrichTables,
) -> Result<Value, Error> {
    let mut row = task_data(t, alive);
    let n = active.task(text(&t["id"]));
    if n > 0 {
        row["activeAgentSessions"] = json!(n);
    }
    for key in ["archived", "archivePath"] {
        if truth(&t["archived"])
            && let Some(v) = t.get(key)
        {
            row[key] = v.clone();
        }
    }
    row["fullTitle"] = json!(full_title(t));
    if truth(&t["question"]) {
        row["question"] = t["question"].clone();
    }
    row["rev"] = t.get("rev").cloned().unwrap_or(json!(1));
    row["queue"] = t["queue"].clone();
    if truth(&t["source"]) {
        row["source"] = t["source"].clone();
    }
    row["repo"] = repo;
    row["kind"] = t["kind"].clone();
    row["host"] = t["run"]["host"].clone();
    for key in ["diagnosticCheck", "diagnosticRecheck"] {
        if truth(&t[key]) {
            row[key] = t[key].clone();
        }
    }
    if tables.liveness {
        let own = format!("task:{}", text(&t["id"]));
        let work_parent = if tables.work_nodes {
            db.query_row(
                "SELECT parent_id FROM work_nodes WHERE task_id=?",
                [text(&t["id"])],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten()
            .map(|id| format!("task:{id}"))
        } else {
            None
        };
        let parent = work_parent.as_deref().or(t["origin"].as_str()).unwrap_or(
            if t["source"] == "planner" {
                "external:planner"
            } else {
                "human"
            },
        );
        for node in [&own, parent] {
            let live = db
                .query_row(
                    "SELECT reason,since,stalled_at,escalated_at FROM msg_liveness WHERE node=?",
                    [node],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, f64>(1)?,
                            r.get::<_, Option<f64>>(2)?,
                            r.get::<_, Option<f64>>(3)?,
                        ))
                    },
                )
                .optional()?;
            if let Some((reason, since, stalled, escalated)) = live
                && !reason.is_empty()
                && (*node == own || escalated.is_some_and(|n| n != 0.0))
            {
                let mut v = json!({
                "stalled":stalled.is_some_and(|n|n!=0.0),"reason":reason,"since":number(since)}
                );
                if *node != own {
                    v["waitingOn"] = json!(node);
                }
                row["liveness"] = v;
                break;
            }
        }
    }
    if tables.messages {
        let mut stmt = db.prepare("SELECT id,kind,body,created_at FROM messages WHERE recipient='human' AND status IN ('pending','delivered') AND kind<>'report' AND task_id=? ORDER BY id")?;
        let entries = stmt
            .query_map([text(&t["id"])], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, f64>(3)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        if !entries.is_empty() {
            let mut msg = json!({
            "unreadForHuman":entries.len()}
            );
            if let Some((id, _, body, at)) = entries
                .iter()
                .rev()
                .find(|(_, kind, _, _)| kind == "question")
            {
                msg["question"] = json!({
                "id":id,"text":slice(body,1000),"at":number(*at)}
                );
            }
            row["messages"] = msg;
        }
    }
    Ok(row)
}
pub fn api_tasks(
    ctx: &Ctx,
    active: &ActiveCounts,
    records: &[Value],
    store: &mut TaskStore,
    alive: &dyn Fn(i64) -> bool,
) -> Result<Vec<Value>, Error> {
    let db = store.connection()?;
    let tables = enrich_tables(db)?;
    let reg = read(ctx, "state/repos.json");
    let aliases = read(ctx, "state/repo-paths.json");
    let mut repos: Vec<Value> = records.iter().map(|t| repo(&reg, &aliases, t)).collect();
    let all: Vec<Value> = registered_from(&reg)
        .into_iter()
        .chain(repos.clone())
        .collect();
    for r in &mut repos {
        apply_repo_label(r, &all);
    }
    records
        .iter()
        .zip(repos)
        .map(|(t, labeled)| enrich_api_task(t, labeled, active, alive, db, &tables))
        .collect()
}
/// Preserve `task.list`'s per-task label scope: each row collides only against
/// the registered repos plus that row's own repo (not the rest of the page).
pub fn api_task_page(
    ctx: &Ctx,
    active: &ActiveCounts,
    records: &[Value],
    store: &mut TaskStore,
    alive: &dyn Fn(i64) -> bool,
) -> Result<Vec<Value>, Error> {
    if records.is_empty() {
        return Ok(Vec::new());
    }
    let reg = read(ctx, "state/repos.json");
    let registered = registered_from(&reg);
    let aliases = read(ctx, "state/repo-paths.json");
    let db = store.connection()?;
    let tables = enrich_tables(db)?;
    let mut out = Vec::with_capacity(records.len());
    for t in records {
        let mut labeled = repo(&reg, &aliases, t);
        let peers: Vec<Value> = registered
            .iter()
            .cloned()
            .chain(std::iter::once(labeled.clone()))
            .collect();
        apply_repo_label(&mut labeled, &peers);
        out.push(enrich_api_task(t, labeled, active, alive, db, &tables)?);
    }
    Ok(out)
}
/// Options for the `task.list` selection path (`src/core/tasks.ts` `list`).
#[derive(Clone, Debug, Default)]
pub struct TaskListOptions<'a> {
    pub all: bool,
    pub limit: Option<usize>,
    pub before: Option<&'a str>,
    pub repo: Option<&'a str>,
    pub states: Option<&'a [&'a str]>,
    pub executor: Option<&'a str>,
    pub since: Option<f64>,
}
/// Newest-first selection matching TS `core.tasks.list`: filter before paging.
pub fn select_task_list(
    ctx: &Ctx,
    store: &mut TaskStore,
    options: &TaskListOptions<'_>,
) -> Result<Vec<Value>, Error> {
    let paths = if let Some(want) = options.repo {
        let reg = read(ctx, "state/repos.json");
        let aliases = read(ctx, "state/repo-paths.json");
        store
            .legacy_repo_paths()?
            .into_iter()
            .filter(|path| {
                let resolved = repo(&reg, &aliases, &json!({"brief":{"repo":path}}));
                text(&resolved["key"]) == want
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let paths_ref = paths.iter().map(String::as_str).collect::<Vec<_>>();
    Ok(store.list(&TaskFilter {
        visible_states: options.states,
        created_since: options.since,
        repo: options.repo,
        repo_paths: Some(&paths_ref),
        executor: options.executor,
        before: options.before,
        limit: Some(options.limit.unwrap_or(20)),
        all: options.all,
        ..TaskFilter::default()
    })?)
}
/// Compose `{ tasks, next }` for a later native `task.list` registration.
pub fn task_list_page(
    ctx: &Ctx,
    active: &ActiveCounts,
    store: &mut TaskStore,
    options: &TaskListOptions<'_>,
    alive: &dyn Fn(i64) -> bool,
) -> Result<Value, Error> {
    let limit = options.limit.unwrap_or(20);
    let fetch = TaskListOptions {
        limit: Some(limit.saturating_add(1)),
        ..options.clone()
    };
    let rows = select_task_list(ctx, store, &fetch)?;
    let page = if rows.len() > limit {
        &rows[..limit]
    } else {
        &rows[..]
    };
    let tasks = api_task_page(ctx, active, page, store, alive)?;
    let next = if rows.len() > limit {
        page.last().map(|t| t["id"].clone()).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    Ok(json!({ "tasks": tasks, "next": next }))
}
pub fn snapshot_tasks(
    ctx: &Ctx,
    active: &ActiveCounts,
    records: &[Value],
    store: &mut TaskStore,
    alive: &dyn Fn(i64) -> bool,
) -> Result<Vec<Value>, Error> {
    let selected: Vec<_> = records
        .iter()
        .filter(|t| !truth(&t["archived"]))
        .cloned()
        .collect();
    let mut rows = api_tasks(ctx, active, &selected, store, alive)?;
    rows.retain(|t| {
        // Missing map entry reads as 0. A session-holding task stays in the
        // window even if stale (>24h) or dismissed, mirroring `!!t.activeAgentSessions`.
        active.task(text(&t["id"])) > 0
            || ["queued", "running"].contains(&text(&t["state"]))
            || (!truth(&t["dismissed"]) && num(&t["updatedAt"]) >= ctx.now - 86400.0)
    });
    rows.sort_by(|a, b| num(&b["updatedAt"]).total_cmp(&num(&a["updatedAt"])));
    rows.truncate(200);
    Ok(rows)
}
pub fn attention_reason(t: &Value) -> Option<&'static str> {
    if !["done", "partial"].contains(&text(&t["state"]))
        || ["review", "resolved", "dismissed", "retriedBy"]
            .iter()
            .any(|k| truth(&t[k]))
    {
        None
    } else if t["acceptanceState"] == "failed" {
        Some("checks_failed")
    } else if t["state"] == "partial" {
        Some("incomplete")
    } else if truth(&t["reviewRequest"]) {
        Some("review_requested")
    } else {
        None
    }
}
pub fn superseded(tasks: &[Value]) -> Vec<Value> {
    let active: Vec<_> = tasks
        .iter()
        .filter(|t| !truth(&t["dismissed"]) && t["state"] != "stopped")
        .collect();
    tasks
        .iter()
        .filter(|t| truth(&t["retriedBy"]) && active.iter().any(|a| a["id"] == t["retriedBy"]))
        .map(|t| t["id"].clone())
        .chain(
            active
                .iter()
                .filter(|t| truth(&t["retryOf"]))
                .map(|t| t["retryOf"].clone()),
        )
        .collect()
}

/// Snapshot task window as exact JSON, preserving JS message substring results.
pub fn snapshot_document(
    ctx: &Ctx,
    records: &[Value],
    store: &mut TaskStore,
    alive: &dyn Fn(i64) -> bool,
) -> Result<crate::wire::Document, Error> {
    let rows = snapshot_tasks(ctx, &ActiveCounts::default(), records, store, alive)?;
    let questions = crate::wire::questions(store)?;
    let mut doc = crate::wire::Document::new(serde_json::json!(rows));
    crate::wire::task_strings(&mut doc, &rows, "", &questions);
    Ok(doc)
}
