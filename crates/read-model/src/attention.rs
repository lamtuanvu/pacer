use crate::{capacity, js::*, read, tasks};
use pacer_foundation::Ctx;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
fn action(label: &str, op: &str, params: Value) -> Value {
    json!({
    "label":label,"op":op,"params":params}
    )
}
fn open(label: &str, params: Value) -> Value {
    action(label, "ui.open", params)
}
/// Stalled caller_decision older than this becomes an important (grouped) notification.
const CALLER_GONE_AFTER_S: f64 = 30.0 * 60.0;

fn is_external_agent_origin(origin: &Value) -> bool {
    text(origin).starts_with("external:")
}

fn owned_by_human(t: &Value) -> bool {
    let parent = &t["work"]["parentId"];
    if !parent.is_null() && truth(parent) {
        return false;
    }
    if truth(&t["work"]["userStarted"]) {
        return true;
    }
    match text(&t["source"]) {
        "ui" | "onboarding" => true,
        // CLI pacer delegate from a planner still records source "cli"; origin decides.
        "cli" => !is_external_agent_origin(&t["origin"]),
        _ => false,
    }
}

fn notify_level(kind: &str, task: Option<&Value>, now: f64) -> &'static str {
    if matches!(kind, "account_signin" | "planner_quota") {
        return "important";
    }
    if matches!(
        kind,
        "stuck"
            | "executor_down"
            | "host_down"
            | "discovery"
            | "discovery-network"
            | "setup"
            | "update"
    ) {
        return "all";
    }
    if kind == "stalled" {
        if let Some(t) = task
            && text(&t["liveness"]["reason"]) == "caller_decision"
            && now - num(&t["liveness"]["since"]) >= CALLER_GONE_AFTER_S
        {
            return "important";
        }
        return "all";
    }
    let Some(t) = task else {
        return "important";
    };
    if kind == "review" {
        return "important";
    }
    if kind == "message" && truth(&t["messages"]["question"]) {
        return "important";
    }
    if truth(&t["liveness"]["escalatedAt"])
        && matches!(kind, "question" | "failed" | "limit" | "message")
    {
        return "important";
    }
    if owned_by_human(t) && matches!(kind, "question" | "failed" | "limit") {
        return "important";
    }
    "all"
}

#[allow(clippy::too_many_arguments)]
fn item(
    kind: &str,
    key: &str,
    title: &str,
    detail: &str,
    actions: Vec<Value>,
    now: f64,
    extra: Value,
) -> Value {
    item_for(kind, key, title, detail, actions, now, extra, None)
}

#[allow(clippy::too_many_arguments)]
fn item_for(
    kind: &str,
    key: &str,
    title: &str,
    detail: &str,
    actions: Vec<Value>,
    now: f64,
    extra: Value,
    task: Option<&Value>,
) -> Value {
    merge(
        &json!({
        "id":format!("{kind}:{key}"),"kind":kind,"severity":if ["stuck","stalled"].contains(&kind){
        "blocked"}
        else if ["review","discovery","discovery-network","update"].contains(&kind){
        "decide"}
        else{
        "problem"}
        ,"repo":null,"title":title,"detail":detail,"raisedAt":number(now),"since":number(now),"actions":actions,"notify":notify_level(kind, task, now)}
        ),
        &extra,
    )
}
fn unblocks_rank(v: &Value) -> i32 {
    match text(&v["unblocks"]) {
        "run" => 0,
        "branch" => 1,
        "nothing" => 2,
        // Ordinary items omit unblocks — same sentinel as TS (`nothing`).
        _ => 2,
    }
}
fn priority_rank(v: &Value) -> i32 {
    match text(&v["run"]["priority"]) {
        "urgent" => 0,
        "normal" => 1,
        "background" => 2,
        _ => 1,
    }
}
pub fn sort(items: &mut [Value]) {
    let rank = |v: &Value| match text(&v["severity"]) {
        "blocked" => 0,
        "problem" => 1,
        _ => 2,
    };
    // Total order: missing unblocks/run use the same sentinels as TS (nothing / normal).
    items.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then(unblocks_rank(a).cmp(&unblocks_rank(b)))
            .then(priority_rank(a).cmp(&priority_rank(b)))
            .then(num(&a["since"]).total_cmp(&num(&b["since"])))
            .then(text(&a["id"]).cmp(text(&b["id"])))
    });
}
/// Letter for a lone run id via resolve_run_letters (matches TS `runAttentionLetter`).
pub fn run_attention_letter(run_id: &str) -> String {
    crate::runs::resolve_run_letters(&[(run_id.to_string(), 0.0, None)])
        .get(run_id)
        .cloned()
        .unwrap_or_else(|| "A".into())
}
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

/// Asker task ids with an open person-answerer blocking (step/branch) question —
/// suppress ordinary `question:<taskId>` (I6 / R2-I3 / I-4). `blocks:nothing` and
/// `answerer:orchestrator` do not suppress.
fn open_question_asker_ids(ctx: &Ctx) -> std::collections::HashSet<String> {
    let path = ctx.pacer_home.join("state/tasks.db");
    let db = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(db) => db,
        Err(_) => return std::collections::HashSet::new(),
    };
    if !has_table(&db, "workflow_questions") {
        return std::collections::HashSet::new();
    }
    let mut out = std::collections::HashSet::new();
    let Ok(mut stmt) = db.prepare(
        "SELECT asker_task_id FROM workflow_questions
         WHERE status = 'open' AND answerer = 'person' AND blocks IN ('step', 'branch')
           AND asker_task_id IS NOT NULL",
    ) else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, Option<String>>(0)) else {
        return out;
    };
    for id in rows.flatten().flatten() {
        if !id.is_empty() {
            out.insert(id);
        }
    }
    out
}
/// Open person-answerer run questions for live runs. Missing tables → no items.
fn asker_cue(kind: &str) -> &'static str {
    match kind {
        "human_step" => "Needs your approval",
        "orchestrator" => "Asked by the workflow planner",
        _ => "Asked by a step",
    }
}

fn option_values(options: Option<&[Value]>) -> Vec<String> {
    options
        .unwrap_or(&[])
        .iter()
        .filter_map(|o| o.get("value").and_then(|v| v.as_str()).map(str::to_string))
        .collect()
}

fn complementary_yes_no(first: &str) -> String {
    let lower = first.to_ascii_lowercase();
    if lower == "yes" {
        return if first == "Yes" {
            "No".into()
        } else if first == "YES" {
            "NO".into()
        } else {
            "no".into()
        };
    }
    if first == "No" {
        "Yes".into()
    } else if first == "NO" {
        "YES".into()
    } else {
        "yes".into()
    }
}

/// UI-3: capitalise yes/no button labels; params keep the validator spelling.
fn yes_no_button_label(answer: &str) -> String {
    let lower = answer.to_ascii_lowercase();
    if lower == "yes" {
        "Yes".into()
    } else if lower == "no" {
        "No".into()
    } else {
        answer.to_string()
    }
}

const OPTION_DETAIL_CLIP: usize = 40;
const OPTION_BUTTON_MAX_CODE_POINTS: usize = 80;
const QUESTION_TITLE_CLIP: usize = 80;
const RUN_DETAIL_CLIP: usize = 80;
const FULL_QUESTION_CLIP: usize = 200;
const ANSWER_CHAR_LIMIT: usize = 2000;
const OPTION_BUTTON_CAP: usize = 3;

/// Collapse newlines to spaces so title/detail stay one line before clipping.
/// Matches TS `/\r\n|\r|\n/g` (a CRLF pair becomes one space).
fn collapse_newlines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push(' ');
        } else if c == '\n' {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// Shared TS/Rust trim: space, tab, CR, LF, NBSP only (not Unicode White_Space).
fn trim_shared_whitespace(s: &str) -> &str {
    let is_ws = |c: char| matches!(c, '\t' | '\n' | '\r' | ' ' | '\u{00A0}');
    s.trim_matches(is_ws)
}

/// One-line question body for title/detail: collapse newlines, then shared trim.
fn collapsed_question_text(text: &str) -> String {
    let collapsed = collapse_newlines(text);
    trim_shared_whitespace(&collapsed).to_string()
}

/// Clip to `max` Unicode code points (mirrors TS `clipCodePoints` / Array.from).
fn clip_code_points(s: &str, max: usize, ellipsis: bool) -> String {
    let points: Vec<char> = s.chars().collect();
    if points.len() <= max {
        return s.to_string();
    }
    let head: String = points.into_iter().take(max).collect();
    if ellipsis { format!("{head}…") } else { head }
}

/// Run title for detail, or the workflow slug when untitled (never a run id).
fn run_detail_subject(title: &str, workflow: &str) -> String {
    let collapsed = collapse_newlines(title);
    let raw = trim_shared_whitespace(&collapsed);
    let subject = if raw.is_empty() { workflow } else { raw };
    clip_code_points(subject, RUN_DETAIL_CLIP, false)
}

fn option_fits_button(value: &str) -> bool {
    // Match TS `value.length` (UTF-16 units) for the 2000 answer cap.
    let utf16: usize = value.chars().map(char::len_utf16).sum();
    utf16 <= ANSWER_CHAR_LIMIT && value.chars().count() <= OPTION_BUTTON_MAX_CODE_POINTS
}

/// Up to 3 option buttons; recommended first. Shared by `single` and custom `approve_revise`.
fn option_choice_actions(
    id: &str,
    expect_rev: &Value,
    values: Vec<String>,
    recommended: Option<&str>,
) -> Value {
    let mut ordered = values.clone();
    if let Some(rec) = recommended
        && values.iter().any(|v| v == rec)
    {
        ordered = std::iter::once(rec.to_string())
            .chain(values.into_iter().filter(|v| v != rec))
            .collect();
    }
    let actions: Vec<Value> = ordered
        .into_iter()
        .filter(|v| option_fits_button(v))
        .take(OPTION_BUTTON_CAP)
        .enumerate()
        .map(|(i, answer)| {
            let mut a = Map::new();
            a.insert(
                "label".into(),
                json!(clip_code_points(&answer, OPTION_DETAIL_CLIP, true)),
            );
            a.insert("op".into(), json!("question.answer"));
            a.insert(
                "params".into(),
                json!({"id": id, "expect_rev": expect_rev, "answer": answer}),
            );
            if i == 0 {
                a.insert("style".into(), json!("primary"));
            }
            Value::Object(a)
        })
        .collect();
    Value::Array(actions)
}

/// Mirror of TS `runQuestionActions` — first action must succeed via direct op call.
fn run_question_actions(
    id: &str,
    rev: i64,
    answer_type: &str,
    options: Option<&[Value]>,
    recommended: Option<&str>,
) -> Value {
    let expect_rev = number(rev as f64);
    match answer_type {
        "yes_no" => {
            let first = match recommended {
                Some(r) => {
                    let lower = r.to_ascii_lowercase();
                    if lower == "yes" || lower == "no" {
                        r.to_string()
                    } else {
                        "Yes".to_string()
                    }
                }
                None => "Yes".to_string(),
            };
            let second = complementary_yes_no(&first);
            let first_label = yes_no_button_label(&first);
            let second_label = yes_no_button_label(&second);
            let mut primary = Map::new();
            primary.insert("label".into(), json!(first_label));
            primary.insert("op".into(), json!("question.answer"));
            primary.insert(
                "params".into(),
                json!({"id": id, "expect_rev": expect_rev.clone(), "answer": first}),
            );
            primary.insert("style".into(), json!("primary"));
            let mut secondary = Map::new();
            secondary.insert("label".into(), json!(second_label));
            secondary.insert("op".into(), json!("question.answer"));
            secondary.insert(
                "params".into(),
                json!({"id": id, "expect_rev": expect_rev, "answer": second}),
            );
            Value::Array(vec![Value::Object(primary), Value::Object(secondary)])
        }
        "approve_revise" => {
            let values = option_values(options);
            if values.is_empty() {
                let mut a = Map::new();
                a.insert("label".into(), json!("Approve"));
                a.insert("op".into(), json!("question.answer"));
                a.insert(
                    "params".into(),
                    json!({"id": id, "expect_rev": expect_rev, "answer": "approve"}),
                );
                a.insert("style".into(), json!("primary"));
                return Value::Array(vec![Value::Object(a)]);
            }
            if let Some(approve_spelling) =
                values.iter().find(|v| v.eq_ignore_ascii_case("approve"))
            {
                let mut a = Map::new();
                a.insert("label".into(), json!("Approve"));
                a.insert("op".into(), json!("question.answer"));
                a.insert(
                    "params".into(),
                    json!({"id": id, "expect_rev": expect_rev.clone(), "answer": approve_spelling}),
                );
                a.insert("style".into(), json!("primary"));
                return Value::Array(vec![Value::Object(a)]);
            }
            // Custom options without "approve" — same as single (I-1).
            option_choice_actions(id, &expect_rev, values, recommended)
        }
        "single" => {
            let values = option_values(options);
            if values.is_empty() {
                return json!([]);
            }
            option_choice_actions(id, &expect_rev, values, recommended)
        }
        _ => json!([]),
    }
}

/// Mirror of TS `runQuestionTitle` — clip to 79 + … when over 80 code points (I-1).
fn run_question_title(text_body: &str) -> String {
    let collapsed = collapsed_question_text(text_body);
    if collapsed.chars().count() <= QUESTION_TITLE_CLIP {
        collapsed
    } else {
        clip_code_points(&collapsed, QUESTION_TITLE_CLIP - 1, true)
    }
}

/// Mirror of TS `runQuestionDetail`.
#[allow(clippy::too_many_arguments)]
fn run_question_detail(
    asker_kind: &str,
    answer_type: &str,
    options: Option<&[Value]>,
    recommended: Option<&str>,
    id: &str,
    run_subject: &str,
    actions: &Value,
    question_text: &str,
) -> String {
    let action_count = actions.as_array().map_or(0, Vec::len);
    let first_label = actions
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|a| a.get("label"))
        .and_then(|v| v.as_str());
    let mut parts: Vec<String> = Vec::new();
    if let Some(label) = first_label {
        parts.push(format!("The first button answers \"{label}\"."));
    }
    parts.push(format!("{run_subject}."));
    parts.push(format!("{}.", asker_cue(asker_kind)));
    let collapsed = collapsed_question_text(question_text);
    if collapsed.chars().count() > QUESTION_TITLE_CLIP {
        parts.push(format!(
            "Full question: {}.",
            clip_code_points(&collapsed, FULL_QUESTION_CLIP, true)
        ));
    }
    let opt_words: Option<Vec<String>> = match answer_type {
        "yes_no" => Some(vec!["yes".into(), "no".into()]),
        "approve_revise" => {
            let vals = option_values(options);
            Some(if vals.is_empty() {
                vec!["approve".into(), "revise".into()]
            } else {
                vals
            })
        }
        _ => {
            let vals = option_values(options);
            if vals.is_empty() { None } else { Some(vals) }
        }
    };
    if let Some(opts) = &opt_words {
        let clipped: Vec<String> = opts
            .iter()
            .map(|o| clip_code_points(&collapse_newlines(o), OPTION_DETAIL_CLIP, true))
            .collect();
        parts.push(format!("Options: {}.", clipped.join(" / ")));
    }
    if let Some(rec) = recommended {
        parts.push(format!(
            "Recommended: {}.",
            clip_code_points(&collapse_newlines(rec), OPTION_DETAIL_CLIP, true)
        ));
    }
    // m1: CLI hint when no buttons, or when listed options exceed the buttons shown.
    if action_count == 0
        || opt_words
            .as_ref()
            .is_some_and(|opts| opts.len() > action_count)
    {
        parts.push(format!("Answer with: pacer answer {id} \"<your answer>\""));
    }
    parts.join(" ")
}

pub fn run_question_items(ctx: &Ctx) -> Vec<Value> {
    let path = ctx.pacer_home.join("state/tasks.db");
    let db = match Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(db) => db,
        Err(_) => return Vec::new(),
    };
    if !has_table(&db, "workflow_questions") || !has_table(&db, "workflow_runs") {
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
    let priority_expr = if run_cols.contains("priority") {
        "r.priority"
    } else {
        "NULL"
    };
    let letter_expr = if run_cols.contains("letter") {
        "r.letter"
    } else {
        "NULL"
    };
    let sql = format!(
        "SELECT q.id, q.run_id, q.step_id, q.attempt, q.branch, q.asker_task_id, q.asker_kind,
                q.text, q.answer_type, q.options, q.recommended, q.blocks, q.artifact,
                q.suggested, q.rev, q.created_at, r.title, r.workflow, r.status,
                {priority_expr}, {letter_expr}
         FROM workflow_questions q
         JOIN workflow_runs r ON r.id = q.run_id
         WHERE q.status = 'open' AND q.answerer = 'person'
           AND r.status IN ('running', 'waiting')
         ORDER BY q.created_at, q.id"
    );
    let mut stmt = match db.prepare(&sql) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, Option<String>>(10)?,
            row.get::<_, String>(11)?,
            row.get::<_, Option<String>>(12)?,
            row.get::<_, Option<String>>(13)?,
            row.get::<_, i64>(14)?,
            row.get::<_, f64>(15)?,
            row.get::<_, String>(16)?,
            row.get::<_, String>(17)?,
            row.get::<_, String>(18)?,
            row.get::<_, Option<String>>(19)?,
            row.get::<_, Option<String>>(20)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    // Same resolver as snapshot `runs` so letterless attention/snapshot letters agree.
    let live_letter_inputs: Vec<(String, f64, Option<String>)> = {
        let letter_col = if run_cols.contains("letter") {
            "letter"
        } else {
            "NULL"
        };
        let sql = format!(
            "SELECT id, created_at, {letter_col} FROM workflow_runs WHERE status IN ('running','waiting') ORDER BY created_at, id"
        );
        db.prepare(&sql)
            .ok()
            .and_then(|mut s| {
                s.query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .ok()
                .map(|rows| rows.flatten().collect())
            })
            .unwrap_or_default()
    };
    let letters = crate::runs::resolve_run_letters(&live_letter_inputs);

    let mut items = Vec::new();
    for row in rows.flatten() {
        let (
            id,
            run_id,
            _step_id,
            _attempt,
            branch,
            asker_task_id,
            asker_kind,
            text_body,
            answer_type,
            options,
            recommended,
            blocks,
            artifact,
            suggested,
            rev,
            created_at,
            title,
            workflow,
            _status,
            priority,
            letter,
        ) = row;
        let unblocks = match blocks.as_str() {
            "branch" => "branch",
            "nothing" => "nothing",
            _ => "run",
        };
        let severity = if unblocks == "nothing" {
            "decide"
        } else {
            "blocked"
        };
        let notify = if unblocks == "nothing" {
            "all"
        } else {
            "important"
        };
        // Item `run.title` keeps the stored value (or workflow when empty) — matches
        // TS `run.title || run.workflow`. Detail subject is separately normalised (I-2).
        let run_title = if title.is_empty() {
            workflow.clone()
        } else {
            title.clone()
        };
        let detail_subject = run_detail_subject(&title, &workflow);
        let at = if created_at > 0.0 {
            created_at
        } else {
            ctx.now
        };
        let parsed_options: Option<Vec<Value>> = options
            .as_ref()
            .filter(|s| !s.is_empty())
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| v.as_array().cloned());
        let recommended_val = recommended.filter(|s| !s.is_empty());
        let actions = run_question_actions(
            &id,
            rev,
            &answer_type,
            parsed_options.as_deref(),
            recommended_val.as_deref(),
        );
        let item_title = run_question_title(&text_body);
        let detail = run_question_detail(
            &asker_kind,
            &answer_type,
            parsed_options.as_deref(),
            recommended_val.as_deref(),
            &id,
            &detail_subject,
            &actions,
            &text_body,
        );
        let mut question = Map::new();
        question.insert("id".into(), json!(id));
        question.insert("text".into(), json!(text_body));
        question.insert("answerType".into(), json!(answer_type));
        question.insert("blocks".into(), json!(blocks));
        question.insert("rev".into(), number(rev as f64));
        question.insert("askerKind".into(), json!(asker_kind));
        if let Some(opts) = &parsed_options {
            question.insert("options".into(), Value::Array(opts.clone()));
        }
        if let Some(v) = &recommended_val {
            question.insert("recommended".into(), json!(v));
        }
        if let Some(v) = artifact.filter(|s| !s.is_empty()) {
            question.insert("artifact".into(), json!(v));
        }
        if let Some(v) = suggested.filter(|s| !s.is_empty()) {
            question.insert("suggested".into(), json!(v));
        }
        if let Some(v) = asker_task_id.filter(|s| !s.is_empty()) {
            question.insert("askerTaskId".into(), json!(v));
        }
        if let Some(v) = branch.filter(|s| !s.is_empty()) {
            question.insert("branch".into(), json!(v));
        }
        // Key order matches TS `runQuestionItem` for byte-identical stringify.
        let mut obj = Map::new();
        obj.insert("id".into(), json!(format!("question:{id}")));
        obj.insert("kind".into(), json!("question"));
        obj.insert("severity".into(), json!(severity));
        obj.insert("repo".into(), Value::Null);
        obj.insert("title".into(), json!(item_title));
        obj.insert("detail".into(), json!(detail));
        obj.insert("raisedAt".into(), number(at));
        obj.insert("since".into(), number(at));
        obj.insert("notify".into(), json!(notify));
        obj.insert("actions".into(), actions);
        obj.insert("unblocks".into(), json!(unblocks));
        let prio = match priority.as_deref() {
            Some("urgent") => "urgent",
            Some("background") => "background",
            _ => "normal",
        };
        let letter_val = letters
            .get(&run_id)
            .cloned()
            .or_else(|| {
                letter
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            })
            .unwrap_or_else(|| run_attention_letter(&run_id));
        obj.insert(
            "run".into(),
            json!({
                "id":run_id,
                "letter":letter_val,
                "title":run_title,
                "priority":prio
            }),
        );
        obj.insert("question".into(), Value::Object(question));
        items.push(Value::Object(obj));
    }
    sort(&mut items);
    items
}
pub fn derive(
    ctx: &Ctx,
    tasks: &[Value],
    executors: &[Value],
    accounts: &[Value],
    setup: &Value,
    planner: &Value,
    can_pair: bool,
) -> Vec<Value> {
    let items = raised(ctx, tasks, executors, accounts, setup, planner, can_pair);
    let store = read(ctx, "state/attention.json");
    let mut items: Vec<Value> = items
        .into_iter()
        .filter_map(|mut a| {
            let entry = &store[text(&a["id"])];
            let since = entry.get("since").cloned().unwrap_or(number(ctx.now));
            if entry.get("dismissedSince") == Some(&since) || num(&entry["snoozedUntil"]) > ctx.now
            {
                return None;
            }
            a["since"] = since.clone();
            if !truth(&a["taskId"]) {
                a["raisedAt"] = since;
            }
            if let Some(v) = entry.get("snoozedUntil") {
                a["snoozedUntil"] = v.clone();
            }
            Some(a)
        })
        .collect();
    sort(&mut items);
    items
}
/// The items the rules raise before `state/attention.json` hides dismissed and snoozed ones.
pub fn raised(
    ctx: &Ctx,
    tasks: &[Value],
    executors: &[Value],
    accounts: &[Value],
    setup: &Value,
    planner: &Value,
    can_pair: bool,
) -> Vec<Value> {
    let mut items = Vec::new();
    let structured_askers = open_question_asker_ids(ctx);
    let superseded = tasks::superseded(tasks);
    for source in tasks {
        if superseded.contains(&source["id"]) {
            continue;
        }
        let mut t = source.clone();
        if tasks.iter().any(|a| {
            a["id"] == t["retriedBy"] && (truth(&a["dismissed"]) || a["state"] == "stopped")
        }) {
            remove(&mut t, "retriedBy");
        }
        let id = text(&t["id"]);
        let title = t["fullTitle"].as_str().unwrap_or(text(&t["title"]));
        let mut extra = json!({
        "repo":t["repo"],"taskId":id}
        );
        for key in ["executor", "host"] {
            if truth(&t[key]) {
                extra[key] = t[key].clone();
            }
        }
        extra["since"] = t["updatedAt"].clone();
        extra["raisedAt"] = t["updatedAt"].clone();
        let params = json!({
        "view":"task","id":id}
        );
        let reason = tasks::attention_reason(&t);
        let legacy = t["state"] == "needs_input"
            && truth(&t["question"])
            && t["question"].get("answer").is_none()
            && !truth(&t["retriedBy"]);
        // I6 / R2-I3: suppress ordinary task.answer items for askers with an open structured question.
        if legacy && !truth(&t["dismissed"]) && !structured_askers.contains(id) {
            let mut e = extra.clone();
            e["severity"] = json!("blocked");
            e["since"] = t["question"]["at"].clone();
            e["raisedAt"] = t["question"]["at"].clone();
            let mut stop = action(
                "Stop",
                "task.stop",
                json!({
                "id":id}
                ),
            );
            stop["style"] = json!("danger");
            items.push(item_for(
                "question",
                id,
                title,
                &slice(text(&t["question"]["text"]), 200),
                vec![
                    action(
                        "Answer",
                        if truth(&t["work"]) { "dispatch.answer" } else { "task.answer" },
                        if truth(&t["work"]) { json!({"id":id,"expect_rev":t["rev"],"requestId":format!("{}.{}.answer",id,t["rev"])}) } else { json!({"id":id}) },
                    ),
                    stop,
                ],
                ctx.now,
                e,
                Some(&t),
            ));
        } else if let Some(reason) = reason {
            let (detail, label, view) = match reason {
                "checks_failed" => ("Acceptance checks failed", "Inspect failures", "task"),
                "incomplete" => ("Execution is incomplete", "Inspect incomplete work", "task"),
                _ => (
                    text(&t["reviewRequest"]["note"]),
                    "Review changes",
                    "review",
                ),
            };
            let kind = if reason == "review_requested" {
                "review"
            } else {
                "failed"
            };
            let mut e = extra.clone();
            if kind == "review" {
                e["since"] = t["reviewRequest"]["at"].clone();
                e["raisedAt"] = t["reviewRequest"]["at"].clone();
            }
            items.push(item_for(
                kind,
                id,
                title,
                detail,
                vec![open(
                    label,
                    json!({
                    "view":view,"id":id}
                    ),
                )],
                ctx.now,
                e,
                Some(&t),
            ));
        } else if ["failed", "limit"].contains(&text(&t["state"]))
            && !["retriedBy", "dismissed", "review", "resolved"]
                .iter()
                .any(|key| truth(&t[key]))
        {
            let managed = truth(&t["work"]);
            let target = executors.iter().find(|e| {
                e["id"] != t["executor"]
                    && e["enabled"] == true
                    && e["rank"] != "planner"
                    && e["state"] == "ready"
                    && num(&e["slots"]["used"]) < num(&e["slots"]["max"])
            });
            let target = if managed { None } else { target };
            let mut params = if managed {
                json!({"id":id,"expect_rev":t["rev"],"requestId":format!("{}.{}.retry",id,t["rev"])})
            } else {
                json!({"id":id})
            };
            let label = target.map_or("Retry".into(), |e| {
                format!("Retry on {}", capacity::display(text(&e["id"])))
            });
            if let Some(e) = target {
                params["executor"] = e["id"].clone();
            }
            let detail = if managed || target.is_some() {
                format!(
                    "{} {}",
                    capacity::display(text(&t["executor"])),
                    if t["state"] == "limit" {
                        "reached its limit"
                    } else {
                        "failed"
                    }
                )
            } else {
                "No other executor available".into()
            };
            items.push(item_for(
                text(&t["state"]),
                id,
                title,
                &detail,
                vec![
                    action(
                        &label,
                        if managed {
                            "dispatch.retry"
                        } else {
                            "task.retry"
                        },
                        params,
                    ),
                    open(
                        "See error",
                        json!({
                        "view":"task","id":id}
                        ),
                    ),
                ],
                ctx.now,
                extra.clone(),
                Some(&t),
            ));
        } else if t["state"] == "running" && t["progress"]["phase"] == "idle" {
            let mut stop = action(
                "Stop it",
                "task.stop",
                json!({
                "id":id}
                ),
            );
            stop["style"] = json!("danger");
            items.push(item_for(
                "stuck",
                id,
                title,
                "Waiting for output",
                vec![open("Open task", params.clone()), stop],
                ctx.now,
                extra.clone(),
                Some(&t),
            ));
        }
        // prompt_wait:<taskId> — Convert to question (I-3). Id prefix is not the kind.
        // Field order matches TS attention/rules.ts for byte-identical wire JSON.
        if t["state"] == "running" && truth(&t["promptWait"]) {
            let raw = clip_code_points(text(&t["promptWait"]["text"]), 200, false);
            // Convert first: Dispatch shows only the first action; convert_prompt
            // succeeds with { id } alone (UI evidence batch G / UI-13).
            let mut convert = action(
                "Convert to question",
                "question.convert_prompt",
                json!({
                "id":id}
                ),
            );
            convert["style"] = json!("primary");
            let mut row = Map::new();
            row.insert("id".into(), json!(format!("prompt_wait:{id}")));
            row.insert("kind".into(), json!("stuck"));
            row.insert("severity".into(), json!("blocked"));
            row.insert("repo".into(), t["repo"].clone());
            row.insert("taskId".into(), json!(id));
            row.insert("title".into(), json!(text(&t["goal"])));
            // UI-1: Convert sentence first, then the captured terminal text.
            row.insert(
                "detail".into(),
                json!(format!(
                    "Convert hands the question to the workflow planner, who answers or asks you. {raw}"
                )),
            );
            row.insert("raisedAt".into(), t["promptWait"]["at"].clone());
            row.insert("since".into(), t["promptWait"]["at"].clone());
            row.insert("notify".into(), json!(notify_level("stuck", Some(&t), ctx.now)));
            row.insert(
                "actions".into(),
                json!([
                    convert,
                    open(
                        "Answer in terminal",
                        json!({"view":"task","id":id,"tab":"terminal"})
                    ),
                ]),
            );
            if truth(&t["executor"]) {
                row.insert("executor".into(), t["executor"].clone());
            }
            if truth(&t["host"]) {
                row.insert("host".into(), t["host"].clone());
            }
            items.push(Value::Object(row));
        }
        if t["liveness"]["stalled"] == true {
            let mut e = extra.clone();
            e["since"] = t["liveness"]["since"].clone();
            e["raisedAt"] = t["liveness"]["since"].clone();
            if truth(&t["liveness"]["waitingOn"]) {
                e["waitingOn"] = t["liveness"]["waitingOn"].clone();
            }
            items.push(item_for(
                "stalled",
                id,
                title,
                &stalled_detail(&t["liveness"], ctx.now),
                vec![open(
                    "Open messages",
                    json!({
                    "view":"task","id":id,"tab":"messages"}
                    ),
                )],
                ctx.now,
                e,
                Some(&t),
            ));
        }
        if truth(&t["messages"]["unreadForHuman"]) && !truth(&t["dismissed"]) && !legacy {
            let q = &t["messages"]["question"];
            let n = num(&t["messages"]["unreadForHuman"]);
            let answerable = truth(q) && !truth(&t["review"]) && t["state"] != "stopped";
            let mut a = if answerable {
                open(
                    "Answer",
                    json!({
                    "view":"task","id":id,"tab":"answer"}
                    ),
                )
            } else {
                open("Open task", params)
            };
            a["style"] = json!("primary");
            let mut e = extra;
            e["severity"] = json!(if truth(q) { "blocked" } else { "decide" });
            if truth(q) {
                e["since"] = q["at"].clone();
                e["raisedAt"] = q["at"].clone();
            }
            let detail = if truth(q) {
                slice(text(&q["text"]), 200)
            } else {
                format!(
                    "{} unread message{}",
                    stringify(&number(n)),
                    if n == 1.0 { "" } else { "s" }
                )
            };
            items.push(item_for(
                "message",
                id,
                title,
                &detail,
                vec![a],
                ctx.now,
                e,
                Some(&t),
            ));
        }
    }
    for a in accounts {
        if a["signedIn"] == false
            && executors
                .iter()
                .any(|e| e["account"] == a["name"] && truth(&e["enabled"]))
        {
            let mut actions = vec![action(
                "Sign in",
                "account.signin",
                json!({
                "name":a["name"]}
                ),
            )];
            actions.extend(
                executors
                    .iter()
                    .filter(|e| {
                        e["account"] == a["name"] && truth(&e["enabled"]) && e["rank"] != "planner"
                    })
                    .map(|e| {
                        action(
                            "Disable",
                            "runner.set",
                            json!({
                            "id":e["id"],"enabled":false}
                            ),
                        )
                    }),
            );
            items.push(item(
                "account_signin",
                text(&a["name"]),
                &format!("Sign in to {}", capacity::display(text(&a["agent"]))),
                "Account is signed out",
                actions,
                ctx.now,
                json!({
                "account":a["name"]}
                ),
            ));
        }
    }
    for e in executors {
        if e["enabled"] == true
            && e["rank"] != "planner"
            && !accounts
                .iter()
                .any(|a| a["name"] == e["account"] && a["signedIn"] == false)
            && (e["state"] == "down"
                || e["lastCheck"]["passed"] == false && e["state"] != "checking")
        {
            let mut extra = json!({
            "executor":e["id"]}
            );
            if truth(&e["host"]) {
                extra["host"] = e["host"].clone();
            }
            items.push(item(
                "executor_down",
                text(&e["id"]),
                &format!("{} needs attention", capacity::display(text(&e["id"]))),
                "Executor is not working",
                vec![
                    open(
                        "Open settings",
                        json!({
                        "view":"settings","section":"executors"}
                        ),
                    ),
                    action(
                        "Disable",
                        "runner.set",
                        json!({
                        "id":e["id"],"enabled":false}
                        ),
                    ),
                ],
                ctx.now,
                extra,
            ));
        }
    }
    if planner["verdict"] == "out" && num(&planner["modeHeldUntil"]) <= ctx.now {
        items.push(item(
            "planner_quota",
            text(&planner["runner"]),
            &format!(
                "{} is out of quota",
                capacity::display(text(&planner["runner"]))
            ),
            text(&planner["advice"]),
            vec![
                open(
                    "Open planner settings",
                    json!({
                    "view":"settings","section":"planner"}
                    ),
                ),
                action(
                    "Keep normal",
                    "mode.hold",
                    json!({
                    "mode":"normal"}
                    ),
                ),
            ],
            ctx.now,
            json!({
            "executor":planner["runner"]}
            ),
        ));
    }
    for s in array(&setup["items"]) {
        if s["required"] == true && s["status"] != "done" {
            items.push(item(
                "setup",
                text(&s["id"]),
                text(&s["title"]),
                "Setup required",
                vec![open(
                    "Open settings",
                    json!({
                    "view":"settings","section":s["id"]}
                    ),
                )],
                ctx.now,
                object(),
            ));
        }
    }
    let state = read(ctx, "discovery/state.json");
    if state.is_null() || state["enabled"] != false {
        let mut seen = values(&state["seen"]);
        seen.sort_by(|a, b| num(&a["promptedAt"]).total_cmp(&num(&b["promptedAt"])));
        for p in seen {
            let id = text(&p["discoveryId"]);
            let at = num(&p["promptedAt"]);
            let silence = &state["silenced"][id];
            if at <= ctx.now - 604800.0
                || p.get("promptedAt").is_none()
                || p.get("handedOverAt").is_some_and(|v| num(v) >= at)
                || *silence == "forever"
                || num(silence) > ctx.now
                || state["networks"][text(&p["network"])]["muted"] == true
            {
                continue;
            }
            let mut pair = if can_pair {
                action(
                    "Pair",
                    "discovery.respond",
                    json!({
                    "discoveryId":id,"action":"pair"}
                    ),
                )
            } else {
                open(
                    "Pair",
                    json!({
                    "view":"settings","section":"pairing"}
                    ),
                )
            };
            pair["style"] = json!("primary");
            items.push(item(
                "discovery",
                id,
                &format!("Found pacer on {}", text(&p["name"])),
                "Unverified name. Pair only if this is your machine.",
                vec![
                    pair,
                    action(
                        "Later",
                        "discovery.respond",
                        json!({
                        "discoveryId":id,"action":"later"}
                        ),
                    ),
                ],
                ctx.now,
                json!({
                "since":number(at),"raisedAt":number(at)}
                ),
            ));
        }
    }
    items.extend(run_question_items(ctx));
    items
}

/// The stalled item's detail; a no-progress stall counts minutes from its last progress, as the TypeScript rules do.
fn stalled_detail(liveness: &Value, now: f64) -> String {
    let reason = liveness["reason"].as_str().unwrap_or("");
    if reason == "no_progress" {
        let since = liveness["since"].as_f64().unwrap_or(now);
        return format!(
            "No progress for {} min",
            (((now - since) / 60.0).floor() as i64).max(1)
        );
    }
    if reason == "silent_prompt" {
        let since = liveness["since"].as_f64().unwrap_or(now);
        return format!(
            "Waiting at prompt with no open question for {} min",
            (((now - since) / 60.0).floor() as i64).max(1)
        );
    }
    if reason == "caller_decision" {
        let who = liveness["waitingOn"]
            .as_str()
            .and_then(|p| p.strip_prefix("external:"))
            .and_then(|p| p.split(':').next())
            .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_lowercase() || c == '-'))
            .unwrap_or("the caller");
        return format!("Waiting for {who} to review and decide");
    }
    format!("Conversation stalled: {reason}")
}

#[cfg(test)]
mod managed_action_tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn managed_and_ordinary_attention_actions_preserve_protocol() -> std::io::Result<()> {
        let dir = tempfile::tempdir()?;
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().join("home"),
            HashMap::new(),
            100.0,
        );
        for state in ["failed", "limit", "needs_input"] {
            for managed in [false, true] {
                let mut task = json!({"id":"t-1","title":"Task","state":state,"rev":7,"updatedAt":10,"executor":"codex","question":{"text":"Which?","at":5}});
                if managed {
                    task["work"] = json!({"rootId":"t-1","depth":0});
                }
                let items = raised(
                    &ctx,
                    &[task],
                    &[],
                    &[],
                    &json!({"items":[]}),
                    &Value::Null,
                    false,
                );
                let action = &items[0]["actions"][0];
                let kind = if state == "needs_input" {
                    "answer"
                } else {
                    "retry"
                };
                assert_eq!(
                    action["op"],
                    format!("{}.{}", if managed { "dispatch" } else { "task" }, kind)
                );
                if managed {
                    assert_eq!(
                        action["params"],
                        json!({"id":"t-1","expect_rev":7,"requestId":format!("t-1.7.{kind}")})
                    );
                } else {
                    assert_eq!(action["params"], json!({"id":"t-1"}));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod stalled_detail_tests {
    use super::stalled_detail;
    use serde_json::json;

    #[test]
    fn caller_decision_names_the_planner_kind() {
        let now = 1_000_000.0;
        assert_eq!(
            stalled_detail(
                &json!({"reason":"caller_decision","since":now,"waitingOn":"external:claude-code:s1"}),
                now
            ),
            "Waiting for claude-code to review and decide"
        );
        assert_eq!(
            stalled_detail(&json!({"reason":"caller_decision","since":now}), now),
            "Waiting for the caller to review and decide"
        );
    }

    #[test]
    fn no_progress_counts_minutes_from_the_last_progress() {
        let now = 1_000_000.0;
        assert_eq!(
            stalled_detail(&json!({"reason":"no_progress","since":now - 4500.0}), now),
            "No progress for 75 min"
        );
        assert_eq!(
            stalled_detail(&json!({"reason":"no_progress","since":now}), now),
            "No progress for 1 min"
        );
        assert_eq!(
            stalled_detail(&json!({"reason":"cycle","since":now}), now),
            "Conversation stalled: cycle"
        );
    }
}
