use crate::{layout::*, model::*, render::*};
use serde_json::Value as V;
pub fn build(ctx: &Ctx) -> View {
    let mut v = View::default();
    let rows = &mut v.list;
    let s = ctx.s;
    let w = ctx.width - 2;
    let wide = ctx.width >= 100;
    if truth(&s["planner"]["advice"]) {
        rows.push(Row::new(line(text(&s["planner"]["advice"]))));
        rows.push(blank());
    }
    let attention = needs(s, ctx.scope());
    let others = needs(s, "").len() - attention.len();
    rows.push(h(
        "Needs you",
        Some(attention.len().to_string()),
        (others > 0).then(|| format!("+{others} in other repos")),
    ));
    if attention.is_empty() {
        rows.push(Row::new(line("Nothing needs you.")));
    }
    for a in &attention {
        let t = task(s, text(&a["taskId"]));
        let title = t.map(title).unwrap_or_else(|| text(&a["title"]).into());
        let id = format!("attention:{}", text(&a["id"]));
        let acts: Vec<_> = arr(&a["actions"])
            .iter()
            .filter(|a| a["op"] == "ui.open" || ctx.supports(text(&a["op"])))
            .collect();
        let dismiss = ctx.supports("attention.dismiss");
        let review = a["kind"] == "review" && truth(&a["taskId"]);
        let mut keys = vec![];
        if dismiss {
            keys.push(("x", "Dismiss"));
        }
        if review {
            keys.push(("v", "Review changes"));
        }
        v.items.push(Item::new(
            &id,
            acts.first().map(|a| text(&a["label"])),
            acts.len().saturating_sub(1) + usize::from(dismiss) + usize::from(review),
            &keys,
        ));
        let ws = if wide {
            flex(w, &[(20, 0), (-3, 16), (10, 0), (-2, 10), (5, 0)], 2)
        } else {
            flex(w, &[(20, 0), (-1, 12), (-1, 8)], 2)
        };
        let status = attention_status(a, s);
        let cells = if wide {
            vec![
                (status, ws[0], false),
                c(title, ws[1]),
                c(text(&a["repo"]["label"]), ws[2]),
                c(text(&a["detail"]), ws[3]),
                cr(ctx.time(&a["raisedAt"]), ws[4]),
            ]
        } else {
            vec![
                (status, ws[0], false),
                c(title, ws[1]),
                c(text(&a["detail"]), ws[2]),
            ]
        };
        rows.push(Row::item(id, cols(cells, 2)));
    }
    rows.push(blank());
    let active = running(s, ctx.scope());
    let queued = active.iter().filter(|t| t["state"] == "queued").count();
    let running_count = if ctx.scope().is_empty() {
        s["counts"]["running"]
            .as_u64()
            .unwrap_or((active.len() - queued) as u64)
    } else {
        s["counts"]["byRepo"][ctx.scope()]["running"]
            .as_u64()
            .unwrap_or((active.len() - queued) as u64)
    };
    rows.push(h(
        "Running",
        Some(running_count.to_string()),
        (queued > 0).then(|| format!("{queued} queued")),
    ));
    if active.is_empty() {
        rows.push(Row::new(line(
            "Nothing running. Delegate a task, or ask your planner to.",
        )));
    }
    for t in active {
        let id = format!("task:{}", text(&t["id"]));
        let live = !t["session"].is_null()
            && t["session"]["host"] != "none"
            && ctx.supports("task.attach");
        let mut i = Item::new(
            &id,
            Some(if live { "Watch" } else { "Open in Tasks" }),
            0,
            &[],
        );
        if live {
            i.actions += 3;
            i.keys.extend([
                ("t".into(), "Open in a terminal window".into()),
                ("m".into(), "Open in a tmux pane".into()),
            ]);
        }
        if ctx.supports("task.stop") {
            i.actions += 1;
            i.keys.push(("s".into(), "Stop".into()));
        }
        v.items.push(i);
        let ws = if wide {
            flex(w, &[(16, 0), (-1, 14), (12, 0), (24, 0)], 2)
        } else {
            flex(w, &[(16, 0), (-1, 10), (18, 0)], 2)
        };
        let name = executor(text(&t["executor"]), &s["accounts"]);
        let cells = if wide {
            vec![
                (status(t), ws[0], false),
                c(title(t), ws[1]),
                c(text(&t["repo"]["label"]), ws[2]),
                c(name, ws[3]),
            ]
        } else {
            vec![
                (status(t), ws[0], false),
                c(title(t), ws[1]),
                c(name, ws[2]),
            ]
        };
        rows.push(Row::item(&id, cols(cells, 2)));
        let meta = if t["state"] == "queued" {
            line(queue_wait(t, s))
        } else {
            let mut l = line(format!(
                "running {}",
                elapsed(ctx.now - num(fallback(&t["attemptStartedAt"], &t["updatedAt"])))
            ));
            l.push(" · ".into());
            let p = &t["progress"];
            l.push(if p.is_null() {
                "Changes and output pending".into()
            } else {
                format!(
                    "{} files · {} commits",
                    js_string(&p["files"]),
                    js_string(&p["commits"])
                )
            });
            if !p.is_null() {
                l.push(" · ".into());
                l.push(if p["lastOutputAt"].is_null() {
                    "output pending".into()
                } else if p["phase"] == "idle" {
                    format!("idle {}", elapsed(ctx.now - num(&p["lastOutputAt"])))
                } else {
                    format!("output {}", ago(num(&p["lastOutputAt"]), ctx.now))
                });
            }
            l
        };
        rows.push(Row::cont(id, [line(" ".repeat(ws[0] + 2)), meta].concat()));
    }
    rows.push(blank());
    let executors = arr(&s["executors"]);
    let count = if s["counts"].is_null() {
        executors.len().to_string()
    } else {
        format!(
            "{}/{}",
            js_string(&s["counts"]["ready"]),
            js_string(&s["counts"]["executors"])
        )
    };
    rows.push(Row::new(heading(
        "Capacity",
        Some(count),
        Some(
            if s["counts"].is_null() {
                "executors"
            } else {
                "executors ready"
            }
            .into(),
        ),
        false,
    )));
    let ws = if wide {
        flex(
            w,
            &[
                (2, 0),
                (26, 0),
                (22, 0),
                (4, 0),
                (-1, 12),
                (14, 0),
                (4, 0),
                (5, 0),
            ],
            2,
        )
    } else {
        flex(w, &[(2, 0), (-1, 12), (22, 0), (4, 0), (5, 0)], 2)
    };
    if executors.is_empty() {
        rows.push(Row::new(line(
            "No executors yet. Add one in Settings › Executors.",
        )));
    } else {
        let labels = if wide {
            vec![
                "#", "EXECUTOR", "STATUS", "", "PACE", "USAGE", "USED", "TASKS",
            ]
        } else {
            vec!["#", "EXECUTOR", "STATUS", "USED", "TASKS"]
        };
        rows.push(Row::new(cols(
            labels
                .iter()
                .enumerate()
                .map(|(i, l)| (line(*l), ws[i], i >= labels.len() - 2))
                .collect(),
            2,
        )));
    }
    for e in executors {
        let id = format!("executor:{}", text(&e["id"]));
        let planner = e["rank"] == "planner";
        let block = if e["state"] == "blocked" {
            "Unblock"
        } else {
            "Block"
        };
        let can = !planner
            && ctx.supports(if e["state"] == "blocked" {
                "runner.unblock"
            } else {
                "runner.block"
            });
        v.items.push(Item::new(
            &id,
            Some("Open in Settings"),
            usize::from(can),
            &if can { vec![("b", block)] } else { vec![] },
        ));
        let (status, detail, age) = eligibility(e, ctx.now);
        let p = if e["stale"] == true && !e["usedPct"].is_null() {
            line("? Historical usage")
        } else {
            let verdict = if s["planner"]["runner"] == e["id"] {
                text(&s["planner"]["verdict"])
            } else {
                arr(&s["accounts"])
                    .iter()
                    .find(|a| a["name"] == e["account"] || arr(&a["executors"]).contains(&e["id"]))
                    .map(|a| text(&a["verdict"]))
                    .unwrap_or("unknown")
            };
            pace(verdict)
        };
        let pace_label = p
            .concat()
            .split_once(' ')
            .map(|(_, l)| l.to_string())
            .unwrap_or_default();
        let why = fallback(&e["reason"], &e["paceReason"]);
        let pace_label = format!(
            "{pace_label}{}",
            if truth(why) {
                format!(" · {}", text(why))
            } else {
                String::new()
            }
        );
        let used = e["usedPct"]
            .as_f64()
            .map_or("—".into(), |n| format!("{}%", round(n)));
        let slots = format!(
            "{}/{}",
            js_string(&e["slots"]["used"]),
            js_string(&e["slots"]["max"])
        );
        let rank = if planner {
            "P".into()
        } else {
            js_string(&e["rank"])
        };
        let name = executor(text(&e["id"]), &s["accounts"]);
        let cells = if wide {
            vec![
                c(rank, ws[0]),
                c(name, ws[1]),
                (status, ws[2], false),
                c(if truth(&e["next"]) { "next" } else { "" }, ws[3]),
                c(pace_label, ws[4]),
                (
                    if e["paceReason"] == "unmetered" {
                        line("unmetered")
                    } else {
                        meter(e["usedPct"].as_f64(), e["pacePct"].as_f64(), ws[5])
                    },
                    ws[5],
                    false,
                ),
                cr(used, ws[6]),
                cr(slots, ws[7]),
            ]
        } else {
            vec![
                c(rank, ws[0]),
                c(name, ws[1]),
                (status, ws[2], false),
                cr(used, ws[3]),
                cr(slots, ws[4]),
            ]
        };
        rows.push(Row::item(&id, cols(cells, 2)));
        if truth(&e["eligibility"]) || truth(&e["stale"]) {
            let mut parts = vec![];
            if truth(&e["stale"]) {
                parts.push("Historical usage".into());
            }
            parts.push(detail);
            if let Some(age) = age {
                parts.push(age);
            }
            for l in wrap(&parts.join(" · "), w, usize::MAX) {
                rows.push(Row::cont(&id, line(l)));
            }
        }
    }
    rows.push(blank());
    let mut done: Vec<_> = arr(&s["tasks"])
        .iter()
        .filter(|t| {
            !s["today"]["since"].is_null()
                && t["source"] != "onboarding"
                && !crate::model::active(t)
                && num(&t["updatedAt"]) >= num(&s["today"]["since"])
                && in_scope(t, ctx.scope())
        })
        .collect();
    done.sort_by(|a, b| num(&b["updatedAt"]).total_cmp(&num(&a["updatedAt"])));
    rows.push(h(
        "Done today",
        Some(if s["today"].is_null() {
            done.len().to_string()
        } else {
            js_string(&s["today"]["done"])
        }),
        (!s["today"].is_null()).then(|| format!("{} accepted", js_string(&s["today"]["accepted"]))),
    ));
    if done.is_empty() {
        rows.push(Row::new(line("Nothing finished yet today.")));
    }
    for t in done {
        let id = format!("task:{}", text(&t["id"]));
        let waiting = attention
            .iter()
            .any(|a| a["kind"] == "review" && a["taskId"] == t["id"]);
        v.items.push(Item::new(
            &id,
            Some(if waiting { "Review" } else { "Open in Tasks" }),
            usize::from(waiting) + usize::from(ctx.supports("task.dismiss")),
            if ctx.supports("task.dismiss") {
                &[("x", "Dismiss")]
            } else {
                &[]
            },
        ));
        let ws = if wide {
            flex(
                w,
                &[(5, 0), (20, 0), (-1, 14), (12, 0), (24, 0), (10, 0)],
                2,
            )
        } else {
            flex(w, &[(5, 0), (20, 0), (-1, 10)], 2)
        };
        let cells = if wide {
            vec![
                c(ctx.time(&t["updatedAt"]), ws[0]),
                (status(t), ws[1], false),
                c(title(t), ws[2]),
                c(text(&t["repo"]["label"]), ws[3]),
                c(executor(text(&t["executor"]), &s["accounts"]), ws[4]),
                c(
                    if t["attemptStartedAt"].is_null() {
                        String::new()
                    } else {
                        format!(
                            "ran {}",
                            elapsed(num(&t["updatedAt"]) - num(&t["attemptStartedAt"]))
                        )
                    },
                    ws[5],
                ),
            ]
        } else {
            vec![
                c(ctx.time(&t["updatedAt"]), ws[0]),
                (status(t), ws[1], false),
                c(title(t), ws[2]),
            ]
        };
        rows.push(Row::item(&id, cols(cells, 2)));
        if !t["review"].is_null() {
            rows.push(Row::cont(id, outcome(t)));
        }
    }
    v.hints = vec!["f repo scope".into(), "d delegate".into()];
    v
}
fn queue_wait(t: &V, s: &V) -> String {
    let q = &t["queue"];
    match text(&q["reason"]) {
        "paused" => "Waiting: delegation is paused".into(),
        "machine_memory_pressure" => format!(
            "Waiting: memory pressure {}",
            q["machine"]["memoryPressure"].as_str().unwrap_or("high")
        ),
        "machine_load" => "Waiting: this machine is under heavy load".into(),
        "no_slot" => {
            let limit = text(&q["limit"]);
            let cap = if q["capacity"].is_null() && limit == "machine" {
                &s["machine"]
            } else {
                &q["capacity"]
            };
            if !limit.is_empty() && !cap.is_null() {
                format!(
                    "Waiting: {} is running {} of {}",
                    match limit {
                        "machine" => "this machine",
                        "host" => t["host"].as_str().unwrap_or("this host"),
                        _ => "this executor",
                    },
                    js_string(&cap["used"]),
                    js_string(&cap["max"])
                )
            } else {
                "Waiting for parallel task capacity".into()
            }
        }
        _ => "Queued".into(),
    }
}
pub fn setup(ctx: &Ctx) -> View {
    let mut v = View::default();
    let setup = &ctx.s["setup"];
    if setup.is_null() {
        v.list.push(Row::new(line("Checking setup…")));
        return v;
    }
    v.list.push(Row::new(line(
        "pacer works once the required steps are done. The rest makes it useful.",
    )));
    if setup["complete"] == true {
        v.list.extend([
            blank(),
            Row::item("setup:done", line("✓ Required setup done")),
        ]);
        v.items
            .push(Item::new("setup:done", Some("Go to Home"), 0, &[]));
    }
    let items = arr(&setup["items"]);
    let ws = flex(ctx.width - 2, &[(13, 0), (-2, 16), (-3, 10)], 2);
    for (required, label) in [(true, "Required"), (false, "Recommended")] {
        let group: Vec<_> = items.iter().filter(|i| i["required"] == required).collect();
        if group.is_empty() {
            continue;
        }
        v.list.extend([
            blank(),
            Row::new(heading(
                label,
                Some(format!(
                    "{} of {}",
                    group.iter().filter(|i| i["status"] == "done").count(),
                    group.len()
                )),
                Some("done".into()),
                false,
            )),
        ]);
        for i in group {
            let id = format!("setup:{}", text(&i["id"]));
            let act = if i["status"] == "done" {
                None
            } else if i["id"] == "executor" || i["action"] == "nav:add-executor" {
                Some("Add executor".into())
            } else if i["action"] == "service.install" {
                ctx.op("service.install", "Install service")
                    .map(str::to_string)
            } else if i["action"] == "agent.connect"
                && ctx.supports("agent.connect")
                && ctx.supports("agent.preview")
            {
                Some(format!("Connect {}", text(&i["agent"])))
            } else if i["id"] == "first"
                && items
                    .iter()
                    .any(|i| i["id"] == "executor" && i["status"] == "done")
            {
                ctx.op("onboarding.try", "Try a delegation")
                    .map(str::to_string)
            } else if truth(&i["command"]) {
                Some("Show command".into())
            } else {
                None
            };
            if v.initial.is_empty() && act.is_some() {
                v.initial = id.clone();
            }
            let skip =
                i["id"] == "first" && i["status"] != "done" && ctx.supports("onboarding.skip");
            v.items.push(Item::new(
                &id,
                act.as_deref(),
                usize::from(skip),
                if skip {
                    &[("x", "Skip first delegation")]
                } else {
                    &[]
                },
            ));
            let detail = if truth(&i["command"]) && i["status"] != "done" {
                format!(
                    "{}{}",
                    if truth(&i["detail"]) {
                        format!("{} · ", text(&i["detail"]))
                    } else {
                        String::new()
                    },
                    text(&i["command"])
                )
            } else {
                if i["detail"].is_null()
                    && !truth(&i["required"])
                    && i["id"] == "first"
                    && act.is_none()
                    && items
                        .iter()
                        .any(|i| i["required"] == true && i["status"] != "done")
                {
                    "Finish the required steps first.".into()
                } else {
                    text(&i["detail"]).into()
                }
            };
            let status = match text(&i["status"]) {
                "done" => "✓ Done",
                "failed" => "✕ Failed",
                _ => "! Needs you",
            };
            v.list.push(Row::item(
                id,
                cols(
                    vec![
                        c(status, ws[0]),
                        c(text(&i["title"]), ws[1]),
                        c(detail, ws[2]),
                    ],
                    2,
                ),
            ));
        }
    }
    v
}
