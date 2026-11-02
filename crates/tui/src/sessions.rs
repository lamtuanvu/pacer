use crate::{layout::*, model::*, render::*};
use serde_json::{Value as V, json};
pub fn error_rows(e: &V) -> Vec<Row> {
    vec![
        Row::new(line(format!(
            "✕ {}{}",
            text(&e["message"]),
            if truth(&e["hint"]) {
                format!(" ({})", text(&e["hint"]))
            } else {
                String::new()
            }
        ))),
        Row::new(line("R retries")),
    ]
}
fn thread_keys(ctx: &Ctx, t: &V, d: &V) -> Vec<(String, String)> {
    if !ctx.supports("msg.send")
        || d["messages"].is_null()
        || truth(&t["review"])
        || truth(&t["dismissed"])
        || t["state"] == "stopped"
    {
        return vec![];
    }
    let mut keys = vec![("p".into(), "Reply".into())];
    let messages = arr(&d["messages"]["value"]);
    if let Some(q) = messages
        .iter()
        .rev()
        .find(|m| m["kind"] == "question" && m["to"] == "human")
        && !messages
            .iter()
            .any(|m| m["kind"] == "answer" && m["replyTo"] == q["id"])
    {
        keys.push(("y".into(), "Answer".into()));
    }
    keys
}
fn review_item(ctx: &Ctx, a: &V, t: &V, d: &V) -> Item {
    let id = format!("review:{}", text(&a["taskId"]));
    if !ctx.supports("task.review") {
        return Item::new(id, None, 0, &[]);
    }
    let mut i = Item::new(id, None, 0, &[]);
    let accept = a["kind"] == "review"
        && fallback(&t["state"], &d["state"]) == "done"
        && t["acceptanceState"] != "failed"
        && d["acceptance"]["state"] != "failed";
    if accept {
        i.keys.push(("a".into(), "Mark accepted".into()));
    }
    if a["kind"] != "review"
        && fallback(&t["state"], &d["state"]) == "done"
        && t["acceptanceState"] != "failed"
        && d["acceptance"]["state"] != "failed"
    {
        i.actions += 1;
    }
    let root = d["work"]["userStarted"] == true && d["work"]["parentId"].is_null();
    let has_rev = fallback(&t["rev"], &d["rev"]).is_number();
    if !d.is_null()
        && (d["work"].is_null()
            || (d["work"]["userStarted"] == true && d["work"]["parentId"].is_null()))
    {
        i.actions += 1;
        i.keys.push(("s".into(), "Send back".into()));
    }
    i.actions += 1;
    i.keys.push(("r".into(), "Reject".into()));
    if d["work"].is_null()
        && arr(&d["retryOptions"])
            .iter()
            .any(|o| o["state"] == "ready")
    {
        i.actions += 1;
        i.keys
            .push(("t".into(), "Retry on another executor".into()));
    }
    let managed_answer = root
        && has_rev
        && d["state"] == "needs_input"
        && truth(&d["question"]["text"])
        && !truth(&d["question"]["answer"]);
    if !d["work"].is_null() && (managed_answer || can_answer_work(ctx, t, d)) {
        i.actions += 1;
        set_key(
            &mut i,
            "a",
            if managed_answer {
                "Answer"
            } else {
                "Answer work question"
            },
        );
    }
    if !d["work"].is_null() && has_rev && managed_eligible(t, d) && ctx.supports("dispatch.retry") {
        i.actions += 1;
        set_key(&mut i, "t", "Retry work");
    }
    if truth(&d["worktree"]) {
        i.actions += 1;
        i.keys.push(("o".into(), "Show worktree path".into()));
    }
    let tk = thread_keys(ctx, t, d);
    i.actions += tk.len();
    i.keys.extend(tk);
    i
}
fn set_key(item: &mut Item, key: &str, label: &str) {
    if let Some((_, old)) = item.keys.iter_mut().find(|(k, _)| k == key) {
        *old = label.into();
    } else {
        item.keys.push((key.into(), label.into()));
    }
}
fn managed_eligible(t: &V, d: &V) -> bool {
    let id = fallback(&t["id"], &d["id"]);
    arr(&d["workTree"]["nodes"])
        .iter()
        .find(|node| node["taskId"] == *id)
        .is_some_and(|node| node["retryEligibility"]["allowed"] == true)
}
fn can_answer_work(ctx: &Ctx, t: &V, d: &V) -> bool {
    !d["work"].is_null()
        && managed_eligible(t, d)
        && fallback(&t["rev"], &d["rev"]).is_number()
        && d["state"] == "needs_input"
        && truth(&d["question"]["text"])
        && !truth(&d["question"]["answer"])
        && ctx.supports("dispatch.answer")
}
struct AnswerRoute {
    label: Option<&'static str>,
    command: String,
    reason: Option<&'static str>,
}
fn answer_route(ctx: &Ctx, t: &V, d: &V) -> AnswerRoute {
    let id = text(&t["id"]);
    let (label, reason) = if !d["work"].is_null() {
        if can_answer_work(ctx, t, d) {
            (Some("Answer work question"), None)
        } else if !ctx.supports("dispatch.answer") {
            (
                None,
                Some("This pacer service does not offer answering managed work."),
            )
        } else if !truth(&d["question"]["text"]) {
            (None, None)
        } else {
            (
                None,
                Some("This work step's question cannot be answered from here."),
            )
        }
    } else if t["question"].get("answer").is_some() || !truth(&t["question"]["text"]) {
        (None, None)
    } else if !ctx.supports("task.answer") {
        (None, Some("This pacer service does not offer answering."))
    } else {
        (Some("Answer"), None)
    };
    AnswerRoute {
        label,
        reason,
        command: if d["work"].is_null() {
            format!("pacer answer {id} \"…\"")
        } else {
            format!("pacer dispatch answer --id {id} --request-id <id> --text \"…\"")
        },
    }
}
pub fn review(ctx: &Ctx) -> View {
    let mut v = View {
        list_width: if ctx.wide { 52 } else { ctx.width },
        ..View::default()
    };
    v.list.push(h("Decisions and problems", None, None));
    let attention = needs(ctx.s, ctx.scope());
    for a in &attention {
        let t = task(ctx.s, text(&a["taskId"])).unwrap_or(&V::Null);
        let d = ctx.detail(text(&a["taskId"]));
        let item = if a["kind"] == "review" && truth(&a["taskId"]) {
            review_item(ctx, a, t, d)
        } else {
            let actions: Vec<_> = arr(&a["actions"])
                .iter()
                .filter(|a| a["op"] == "ui.open" || ctx.supports(text(&a["op"])))
                .collect();
            Item::new(
                format!("attention:{}", text(&a["id"])),
                actions.first().map(|a| text(&a["label"])),
                actions.len().saturating_sub(1),
                &[],
            )
        };
        let ws = flex(v.list_width - 2, &[(20, 0), (-1, 8)], 1);
        v.list.push(Row::item(
            &item.id,
            cols(
                vec![
                    (attention_status(a, ctx.s), ws[0], false),
                    c(
                        if t.is_null() {
                            text(&a["title"]).into()
                        } else {
                            title(t)
                        },
                        ws[1],
                    ),
                ],
                1,
            ),
        ));
        v.list.extend(
            wrap(text(&a["detail"]), v.list_width - 2, 2)
                .into_iter()
                .map(|l| Row::cont(&item.id, line(l))),
        );
        v.list.push(blank());
        v.items.push(item);
    }
    if attention.is_empty() {
        v.list.push(Row::new(line(
            "Nothing needs your attention. See Tasks for completed work.",
        )));
    }
    let n = v
        .items
        .iter()
        .position(|i| i.id == ctx.selected("review"))
        .unwrap_or(0);
    let w = if ctx.wide {
        ctx.width - v.list_width - 3
    } else {
        ctx.width - 2
    };
    v.detail = Some(if let Some(a) = attention.get(n) {
        if truth(&a["taskId"]) {
            review_detail(ctx, a, &ctx.details[text(&a["taskId"])], w)
        } else {
            prose(text(&a["detail"]), w)
        }
    } else {
        vec![]
    });
    v
}
fn awaiting(t: &V) -> bool {
    t["interactionMode"] == "conversation"
        && t["state"] == "needs_input"
        && !["retriedBy", "review", "dismissed", "resolved"]
            .iter()
            .any(|k| truth(&t[k]))
}
fn waiting(t: &V) -> bool {
    truth(&t["reviewRequest"])
        && t["state"] == "done"
        && t["acceptanceState"] != "failed"
        && !["retriedBy", "review", "dismissed", "resolved"]
            .iter()
            .any(|k| truth(&t[k]))
}
fn session_item(ctx: &Ctx, t: &V) -> Item {
    let id = text(&t["id"]);
    let d = ctx.detail(id);
    let live =
        !t["session"].is_null() && t["session"]["host"] != "none" && ctx.supports("task.attach");
    let active = active(t);
    let asking = awaiting(t);
    let review = waiting(t);
    let answer = asking
        .then(|| answer_route(ctx, t, d))
        .and_then(|r| r.label);
    let mut i = if !active
        && !asking
        && !["review", "resolved", "dismissed", "retriedBy"]
            .iter()
            .any(|k| truth(&t[k]))
    {
        review_item(
            ctx,
            &json!({"taskId":id,"kind":if review{"review"}else{"failed"}}),
            t,
            d,
        )
    } else {
        Item::default()
    };
    i.id = format!("session:{id}");
    i.primary = if live {
        Some(if active { "Watch" } else { "Replay" }.into())
    } else if review {
        Some("Review".into())
    } else {
        answer.map(str::to_string)
    };
    let verdict_actions = i.actions;
    i.actions = 0;
    if live && review {
        i.actions += 1;
    }
    if let Some(label) = answer {
        if live || review {
            i.actions += 1;
        }
        set_key(&mut i, "a", label);
    } // no screen action is executed by this port
    // Keep action and key insertion order identical to the TS object spreads.
    let mut add = |key: &str, label: &str| {
        i.actions += 1;
        if let Some(old) = i.keys.iter_mut().find(|(k, _)| k == key) {
            old.1 = label.into();
        } else {
            i.keys.push((key.into(), label.into()));
        }
    };
    if live {
        add("t", "Open in a terminal window");
        add("m", "Open in a tmux pane");
    }
    if (active || t["state"] == "needs_input")
        && (ctx.supports("task.stop")
            || (t["interactionMode"] == "conversation" && ctx.supports("session.end")))
    {
        add(
            "s",
            if t["interactionMode"] == "conversation" {
                "End session"
            } else {
                "Stop"
            },
        );
    }
    if !active && ctx.supports("task.dismiss") {
        add("x", "Dismiss");
    }
    for (k, l) in thread_keys(ctx, t, d) {
        add(&k, &l);
    }
    i.actions += verdict_actions;
    i
}
pub fn build(ctx: &Ctx) -> View {
    let mut v = View {
        list_width: if ctx.wide { 46 } else { ctx.width },
        ..View::default()
    };
    let active = running(ctx.s, ctx.scope());
    let queued = active.iter().filter(|t| t["state"] == "queued").count();
    v.list.push(h(
        "Running",
        Some((active.len() - queued).to_string()),
        (queued > 0).then(|| format!("{queued} queued")),
    ));
    if active.is_empty() {
        v.list.push(Row::new(line("No running sessions.")));
    }
    let mut all = active.clone();
    let history = &ctx.case["history"];
    if !history["error"].is_null() {
        v.list.splice(0..0, error_rows(&history["error"]));
    }
    let mut merged: Vec<&V> = vec![];
    for t in arr(&history["value"]["tasks"])
        .iter()
        .chain(arr(&ctx.s["tasks"]).iter())
    {
        if let Some(i) = merged.iter().position(|x| x["id"] == t["id"]) {
            merged[i] = t;
        } else {
            merged.push(t);
        }
    }
    let mut ended: Vec<_> = merged
        .into_iter()
        .filter(|t| !truth(&t["dismissed"]) && !active_fn(t) && in_scope(t, ctx.scope()))
        .collect();
    ended.sort_by(|a, b| num(&b["updatedAt"]).total_cmp(&num(&a["updatedAt"])));
    let row = |v: &mut View, t: &V, timing: String| {
        let item = session_item(ctx, t);
        let w = v.list_width - 2;
        let ws = if ctx.wide {
            flex(w, &[(-1, 8), (9, 0)], 2)
        } else {
            flex(w, &[(20, 0), (-1, 8), (9, 0)], 2)
        };
        if ctx.wide {
            v.list.push(Row::item(
                &item.id,
                cols(vec![c(title(t), ws[0]), cr(timing, ws[1])], 2),
            ));
            v.list.push(Row::cont(&item.id, status(t)));
        } else {
            v.list.push(Row::item(
                &item.id,
                cols(
                    vec![
                        (status(t), ws[0], false),
                        c(title(t), ws[1]),
                        cr(timing, ws[2]),
                    ],
                    2,
                ),
            ));
        }
        v.items.push(item);
    };
    for t in active {
        row(
            &mut v,
            t,
            if t["state"] == "queued" {
                "queued".into()
            } else {
                elapsed(ctx.now - num(fallback(&t["attemptStartedAt"], &t["updatedAt"])))
            },
        );
    }
    v.list
        .extend([blank(), h("Completed", Some(ended.len().to_string()), None)]);
    if ended.is_empty() {
        v.list.push(Row::new(line("No completed tasks.")));
    }
    for t in &ended {
        row(&mut v, t, ctx.time(&t["updatedAt"]));
    }
    if truth(&history["value"]["next"]) {
        v.items
            .push(Item::new("history-more", Some("Load older tasks"), 0, &[]));
        v.list
            .push(Row::item("history-more", line("Load older tasks")));
    }
    all.extend(ended);
    let selected = all
        .iter()
        .find(|t| format!("session:{}", text(&t["id"])) == ctx.selected("sessions"))
        .copied()
        .or(all.first().copied());
    let w = if ctx.wide {
        ctx.width - v.list_width - 3
    } else {
        ctx.width - 2
    };
    v.detail = Some(
        selected
            .map(|t| session_detail(ctx, t, w))
            .unwrap_or_else(|| vec![Row::new(line("Select a session."))]),
    );
    if !ctx.wide && !v.items.is_empty() && ctx.state["focus"] != "detail" {
        v.hints.push("→ details".into());
    }
    v
}
fn active_fn(t: &V) -> bool {
    active(t)
}
fn facts(prefix: Line, parts: Vec<String>, w: usize) -> Vec<Row> {
    let text = parts
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" · ");
    let p = if text.is_empty() {
        prefix
    } else {
        [prefix, line(" · ")].concat()
    };
    if text.is_empty() {
        vec![Row::new(p)]
    } else {
        wrap_after(p, &text, w).into_iter().map(Row::new).collect()
    }
}
fn timeline_copy(raw: &str) -> String {
    match raw {
        "Testing" | "testing" => "Running checks",
        "done" => "Run completed",
        "partial" => "Run ended with work to review",
        "failed" => "Run failed",
        "limit" => "Run stopped at the quota limit",
        "stopped" => "Run stopped",
        "running" => "Run started",
        "queued" => "Run queued",
        "needs_input" => "Waiting for your answer",
        "hook: PostToolUse" => "Agent finished a tool step",
        "hook: PreToolUse" => "Agent started a tool step",
        "hook: Stop" => "Agent finished responding",
        "hook: SessionStart" => "Agent session started",
        "hook: SessionEnd" => "Agent session ended",
        s if s.starts_with("Worktree created from ") => "Working copy created",
        s if s.starts_with("Routed to ") => "Executor selected",
        s if s
            .strip_suffix(" commit")
            .or_else(|| s.strip_suffix(" commits"))
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit())) =>
        {
            s
        }
        _ => "Session activity recorded",
    }
    .into()
}
fn session_detail(ctx: &Ctx, t: &V, w: usize) -> Vec<Row> {
    let id = text(&t["id"]);
    let resource = &ctx.details[id];
    let d = &resource["value"];
    if !crate::model::active(t) && !awaiting(t) {
        return review_detail(
            ctx,
            &json!({"taskId":id,"title":title(t),"kind":if waiting(t){"review"}else{"failed"}}),
            resource,
            w,
        );
    }
    let mut rows: Vec<Row> = wrap(&title(t), w, 2)
        .into_iter()
        .map(|s| Row::new(line(s)))
        .collect();
    let started = fallback(&d["startedAt"], &t["attemptStartedAt"]);
    let parts = vec![
        executor(text(&t["executor"]), &V::Null),
        text(&t["repo"]["label"]).into(),
        text(&d["branch"]).into(),
        if truth(started) {
            format!("started {}", ctx.time(started))
        } else {
            "Start time unknown".into()
        },
    ];
    rows.extend(facts(status(t), parts, w));
    let p = &t["progress"];
    let session_time = if t["state"] == "running" && !t["attemptStartedAt"].is_null() {
        format!(
            "running for {}",
            elapsed(ctx.now - num(&t["attemptStartedAt"]))
        )
    } else if t["state"] == "queued" {
        format!("queued for {}", elapsed(ctx.now - num(&t["updatedAt"])))
    } else {
        format!("last updated {}", ago(num(&t["updatedAt"]), ctx.now))
    };
    let mut parts = vec![session_time];
    if !p.is_null() {
        parts.push(format!(
            "{} files · {} commits",
            js_string(&p["files"]),
            js_string(&p["commits"])
        ));
        if !p["lastOutputAt"].is_null() {
            parts.push(if p["phase"] == "idle" {
                format!("idle {}", elapsed(ctx.now - num(&p["lastOutputAt"])))
            } else {
                format!("output {}", ago(num(&p["lastOutputAt"]), ctx.now))
            });
        }
    }
    rows.extend(
        wrap_after(vec![], &parts.join(" · "), w)
            .into_iter()
            .map(Row::new),
    );
    if awaiting(t) {
        rows.extend([blank(), h("Question", None, None)]);
        if t["question"].get("answer").is_none() && truth(&t["question"]["text"]) {
            rows.extend(prose(text(&t["question"]["text"]), w));
        } else {
            rows.push(Row::new(line("The question is not loaded yet.")));
        }
        let route = answer_route(ctx, t, d);
        if route.label.is_some() {
            rows.extend(prose("Answering resumes this session with your answer. A lane whose executor is still running receives it live.",w));
            rows.push(Row::new(vec![
                "a".into(),
                " answer   ".into(),
                route.command,
            ]));
        } else if let Some(reason) = route.reason {
            rows.push(Row::new(line(reason)));
        }
    }
    rows.extend([blank(), h("Watch", None, None)]);
    if !t["session"].is_null() && t["session"]["host"] != "none" && ctx.supports("task.attach") {
        rows.push(Row::new(vec![
            "⏎".into(),
            " here   ".into(),
            "t".into(),
            " terminal window   ".into(),
            "m".into(),
            " tmux pane".into(),
        ]));
        rows.push(Row::new(line(format!("pacer attach {id}"))));
        rows.extend(prose(
            "Any terminal, tmux or SSH session works. Everyone sees the same stream.",
            w,
        ));
    } else {
        rows.push(Row::new(line(
            if t["session"].is_null() || t["session"]["host"] == "none" {
                "This run is headless; its output is in the task log."
            } else {
                "Watching is not offered by this pacer service."
            },
        )));
    }
    rows.extend([blank(), h("Done when", None, None)]);
    let acc = fallback(&d["acceptance"], &t["acceptance"]);
    if truth(&acc["cmd"]) {
        rows.push(Row::new(line(text(&acc["cmd"]))));
        rows.extend(prose(
            "pacer runs it after the executor exits, records the checks with the result.",
            w,
        ));
    } else {
        rows.push(Row::new(line("No done-when command.")));
    }
    if !d["work"].is_null() {
        rows.push(blank());
        rows.extend(crate::work::rows(d, w));
    }
    if ctx.supports("msg.log") && !d["messages"].is_null() {
        rows.extend(thread(ctx, d, w));
    }
    rows.extend([blank(), h("Timeline", None, None)]);
    if d.is_null() {
        if !resource["error"].is_null() {
            rows.extend(error_rows(&resource["error"]));
        } else {
            rows.push(Row::new(line("Loading session…")));
        }
    } else if arr(&d["timeline"]).is_empty() {
        rows.push(Row::new(line("No timeline events yet.")));
    } else {
        let mut seen = std::collections::HashSet::new();
        let timeline: Vec<_> = arr(&d["timeline"])
            .iter()
            .filter(|entry| seen.insert((number(num(&entry["at"])), text(&entry["text"]))))
            .collect();
        for entry in timeline.iter().skip(timeline.len().saturating_sub(12)) {
            let time = ctx.time(&entry["at"]);
            rows.push(Row::new(vec![
                format!(
                    "{time}{}",
                    " ".repeat(6usize.saturating_sub(time.encode_utf16().count()))
                ),
                timeline_copy(text(&entry["text"])),
            ]));
        }
    }
    rows
}
pub fn review_detail(ctx: &Ctx, a: &V, resource: &V, w: usize) -> Vec<Row> {
    let t = task(ctx.s, text(&a["taskId"])).unwrap_or(&V::Null);
    let d = &resource["value"];
    let title = if !t.is_null() {
        title(t)
    } else if !d.is_null() {
        title(d)
    } else {
        text(&a["title"]).into()
    };
    let mut rows: Vec<_> = wrap(&title, w, 2)
        .into_iter()
        .map(|s| Row::new(line(s)))
        .collect();
    let executor_id = text(fallback(
        &d["executor"],
        fallback(&t["executor"], &a["executor"]),
    ));
    let ran = if truth(&d["startedAt"]) && truth(&d["endedAt"]) {
        format!("ran {}", elapsed(num(&d["endedAt"]) - num(&d["startedAt"])))
    } else if truth(&t["attemptStartedAt"]) {
        format!(
            "ran {}",
            elapsed(num(&t["updatedAt"]) - num(&t["attemptStartedAt"]))
        )
    } else {
        String::new()
    };
    let branch = if truth(&d["branch"]) {
        format!(
            "{}{}",
            text(&d["branch"]),
            if truth(&d["base"]) {
                format!(" → {}", text(&d["base"]))
            } else {
                String::new()
            }
        )
    } else {
        String::new()
    };
    rows.extend(facts(
        status(if !d.is_null() { d } else { t }),
        vec![executor(executor_id, &V::Null), ran, branch],
        w,
    ));
    let finished = fallback(&d["endedAt"], &t["updatedAt"]);
    let mut parts = vec![text(fallback(&a["repo"]["label"], &t["repo"]["label"])).to_string()];
    if truth(finished) {
        parts.push(format!("finished {}", ctx.time(finished)));
    }
    rows.push(Row::new(line(
        parts
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · "),
    )));
    if d.is_null() {
        rows.push(blank());
        if !resource["error"].is_null() {
            let message = text(&resource["error"]["message"]).to_lowercase();
            if message.contains("worktree")
                && ["removed", "missing", "not found"]
                    .iter()
                    .any(|s| message.contains(s))
            {
                rows.push(Row::new(line(
                    "! Changes unavailable · the worktree was removed after the task finished",
                )));
            } else {
                rows.extend(error_rows(&resource["error"]));
            }
        } else {
            rows.push(Row::new(line("Loading task…")));
        }
        return rows;
    }
    if truth(&resource["loading"]) {
        rows.push(Row::new(line("Updating…")));
    }
    rows.extend([blank(), h("Result", None, None)]);
    let summary = text(&d["summary"]).trim_matches(crate::js_whitespace);
    let lower = summary.to_lowercase();
    let concise = !summary.is_empty()
        && summary.split('\n').count() <= 8
        && !lower.contains("i'll start")
        && ![
            "let me read",
            "let me look",
            "let me check",
            "let me explore",
        ]
        .iter()
        .any(|s| lower.contains(s));
    rows.extend(
        wrap_after(
            vec![],
            if concise {
                summary
            } else {
                "Execution ended. Inspect checks and changes."
            },
            w,
        )
        .into_iter()
        .map(Row::new),
    );
    rows.push(Row::new(outcome(d)));
    rows.extend(
        wrap_after(
            vec![],
            &if truth(&d["reviewRequest"]) {
                format!("Review requested: {}", text(&d["reviewRequest"]["note"]))
            } else {
                String::new()
            },
            w,
        )
        .into_iter()
        .map(Row::new),
    );
    rows.extend(crate::work::skipped(d, w));
    rows.extend([
        blank(),
        h("Delivery", None, None),
        Row::new(line("Integration not recorded")),
        blank(),
    ]);
    let acc = fallback(&d["acceptance"], &t["acceptance"]);
    let done_when = if truth(&acc["cmd"]) {
        let status = match text(&acc["state"]) {
            "passed" => "✓ Tests passed",
            "failed" => "✕ Failed",
            "pending" => "… Waiting for tests",
            "running" => "▶ Testing",
            _ => "? No done-when command",
        };
        let mut body = vec![line(text(&acc["cmd"]))];
        body.extend(
            facts(
                line(status),
                vec![
                    text(&acc["summary"]).into(),
                    if acc["durationS"].is_null() {
                        String::new()
                    } else {
                        format!("checks ran {} s", js_string(&acc["durationS"]))
                    },
                    if truth(&acc["machine"]) {
                        format!("run by pacer on {}", text(&acc["machine"]))
                    } else {
                        String::new()
                    },
                ],
                w.saturating_sub(4),
            )
            .into_iter()
            .map(|r| r.line),
        );
        body
    } else {
        vec![line("No done-when command")]
    };
    rows.extend(boxed("Done when", done_when, w).into_iter().map(Row::new));
    let mut why = wrap_after(
        vec![],
        &reason(text(&d["routing"]["why"])),
        w.saturating_sub(4),
    );
    for x in arr(&d["routing"]["skipped"]).iter().take(3) {
        why.extend(wrap_after(
            vec![],
            &format!(
                "Skipped {}: {}",
                executor(text(&x["executor"]), &V::Null),
                reason(text(&x["reason"]))
            ),
            w.saturating_sub(4),
        ));
    }
    if truth(&d["cost"]["executor"]) {
        why.extend(wrap_after(
            vec![],
            &format!("Cost: {}", cost(&d["cost"]["executor"])),
            w.saturating_sub(4),
        ));
    }
    rows.extend(
        boxed(&format!("Why {}", executor(executor_id, &V::Null)), why, w)
            .into_iter()
            .map(Row::new),
    );
    if !d["work"].is_null() {
        rows.push(blank());
        rows.extend(crate::work::rows(d, w));
    }
    if ctx.supports("msg.log") && !d["messages"].is_null() {
        rows.extend(thread(ctx, d, w));
    }
    rows.push(blank());
    let files = arr(&d["files"]);
    let added: f64 = files.iter().map(|f| num(&f["added"])).sum();
    let removed: f64 = files.iter().map(|f| num(&f["removed"])).sum();
    rows.push(h(
        "Changes",
        Some(format!(
            "{} {}",
            files.len(),
            if files.len() == 1 { "file" } else { "files" }
        )),
        (!files.is_empty()).then(|| format!("+{} −{}", number(added), number(removed))),
    ));
    if files.is_empty() {
        rows.push(Row::new(line("No changes recorded.")));
    }
    let ws = flex(w, &[(1, 0), (-1, 10), (6, 0), (6, 0)], 2);
    for f in files.iter().take(12) {
        rows.push(Row::new(cols(
            vec![
                c(
                    text(&f["status"])
                        .chars()
                        .next()
                        .unwrap_or('?')
                        .to_uppercase()
                        .to_string(),
                    ws[0],
                ),
                c(text(&f["path"]), ws[1]),
                cr(
                    if truth(&f["binary"]) {
                        "binary".into()
                    } else {
                        format!("+{}", number(num(&f["added"])))
                    },
                    ws[2],
                ),
                cr(
                    if truth(&f["binary"]) {
                        String::new()
                    } else {
                        format!("−{}", number(num(&f["removed"])))
                    },
                    ws[3],
                ),
            ],
            2,
        )));
    }
    if files.len() > 12 {
        rows.push(Row::new(line(format!(
            "+{} more files · pacer review {} shows the diff",
            files.len() - 12,
            text(&d["id"])
        ))));
    }
    rows.push(blank());
    let can = a["kind"] == "review"
        && ctx.supports("task.review")
        && !["review", "resolved", "dismissed", "retriedBy"]
            .iter()
            .any(|k| truth(&d[k]));
    if a["kind"] == "review" && !ctx.supports("task.review") {
        rows.push(Row::new(line("This service does not offer reviews here.")));
    }
    if can {
        let item = review_item(ctx, a, t, d);
        let mut key_lines: Vec<Line> = vec![];
        for key in ["a", "s", "r", "t"] {
            if let Some((_, label)) = item.keys.iter().find(|(k, _)| k == key) {
                let group = vec![key.into(), format!(" {label}")];
                if let Some(last) = key_lines
                    .last_mut()
                    .filter(|l| width(l) + 3 + width(&group) <= w.saturating_sub(4))
                {
                    last.push("   ".into());
                    last.extend(group);
                } else {
                    key_lines.push(group);
                }
            }
        }
        key_lines.extend(wrap_after(
            vec![],
            "Accept records the verdict; you merge the branch.",
            w.saturating_sub(4),
        ));
        rows.extend(
            boxed("Your verdict", key_lines, w)
                .into_iter()
                .map(Row::new),
        );
    }
    rows
}
fn thread(ctx: &Ctx, d: &V, w: usize) -> Vec<Row> {
    let mut rows = vec![blank(), h("Thread", None, None)];
    let resource = &d["messages"];
    if resource["value"].is_null() {
        rows.push(Row::new(line(if resource["error"].is_null() {
            "Loading messages…"
        } else {
            "Messages are unavailable. Refresh to try again."
        })));
        return rows;
    }
    let mut messages: Vec<_> = arr(&resource["value"]).iter().collect();
    messages.sort_by(|a, b| {
        num(&a["createdAt"])
            .total_cmp(&num(&b["createdAt"]))
            .then_with(|| text(&a["id"]).cmp(text(&b["id"])))
    });
    if messages.is_empty() {
        rows.push(Row::new(line("No messages yet.")));
    }
    let start = messages.len().saturating_sub(20);
    let mut previous: Option<&V> = None;
    for m in &messages[start..] {
        if previous.is_none_or(|p| {
            p["from"] != m["from"] || num(&m["createdAt"]) - num(&p["createdAt"]) > 600.
        }) {
            let from = text(&m["from"]);
            let sender = match from {
                "human" => "You".into(),
                "broker" => "pacer".into(),
                _ if from.starts_with("external:") => "Planner".into(),
                _ if from.starts_with("task:") => task(ctx.s, &from[5..])
                    .map(|t| {
                        format!(
                            "Task: {}",
                            text(fallback(&t["title"], fallback(&t["goal"], &V::Null)))
                        )
                    })
                    .unwrap_or("Task".into()),
                _ => "Someone else".into(),
            };
            rows.push(Row::new(line(sender)));
        }
        let mut l = line(ctx.time(&m["createdAt"]));
        let kind = match text(&m["kind"]) {
            "question" => "Question",
            "answer" => "Answer",
            "report" => "Report",
            "nudge" => "Reminder",
            "close" => "Closed",
            _ => "",
        };
        if !kind.is_empty() {
            l.push(format!("  {kind}"));
        }
        if m["to"] == "human" && m["status"] != "read" && m["status"] != "held" {
            l.push("  New".into());
        }
        rows.push(Row::new(l));
        rows.extend(prose(text(&m["body"]), w));
        previous = Some(m);
    }
    rows
}
