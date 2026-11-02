use crate::{layout::*, model::*, render::*};
use serde_json::Value as V;
pub const SECTIONS: [(&str, &str); 11] = [
    ("planner", "Planner & pacing"),
    ("accounts", "Accounts"),
    ("executors", "Executors"),
    ("machine", "This machine"),
    ("hosts", "Remote hosts"),
    ("routing", "Routing"),
    ("projects", "Project strategies"),
    ("strategies", "Strategies"),
    ("updates", "Updates"),
    ("notifications", "Notifications"),
    ("appearance", "Appearance"),
];
pub(crate) fn field(rows: &mut Vec<Row>, w: usize, label: &str, value: Line, note: &str, id: &str) {
    let ws = flex(w, &[(24, 0), (-1, 10)], 2);
    let labels = if label.is_empty() {
        vec![String::new()]
    } else {
        wrap(label, ws[0], usize::MAX)
    };
    let mut pieces = value;
    if !note.is_empty() {
        pieces.push(format!("  {note}"));
    }
    let mut values: Vec<Line> = vec![vec![]];
    for piece in pieces {
        let parts = if crate::cell_width(&piece) > ws[1] {
            wrap(&piece, ws[1], usize::MAX)
        } else {
            vec![piece]
        };
        for (i, t) in parts.into_iter().enumerate() {
            let n = values.len() - 1;
            if i > 0 || (!values[n].is_empty() && width(&values[n]) + crate::cell_width(&t) > ws[1])
            {
                values.push(vec![]);
            }
            let n = values.len() - 1;
            let shown = if values[n].is_empty() {
                t.trim_start_matches(crate::js_whitespace).into()
            } else {
                t
            };
            if !shown.is_empty() {
                values[n].push(shown);
            }
        }
    }
    values.retain(|l| !l.is_empty());
    if values.is_empty() {
        values.push(vec![]);
    }
    for i in 0..labels.len().max(values.len()) {
        let l = cols(
            vec![
                c(labels.get(i).cloned().unwrap_or_default(), ws[0]),
                (values.get(i).cloned().unwrap_or_default(), ws[1], false),
            ],
            2,
        );
        rows.push(if id.is_empty() {
            Row::new(l)
        } else if i == 0 {
            Row::item(id, l)
        } else {
            Row::cont(id, l)
        });
    }
}
fn prose_item(rows: &mut Vec<Row>, id: &str, s: &str, w: usize) {
    rows.extend(
        wrap(s, w.saturating_sub(2).max(10), usize::MAX)
            .into_iter()
            .map(|s| Row::cont(id, line(s))),
    );
}
fn choices(entries: &[(&str, &str)], current: &str) -> Line {
    let mut l = vec![];
    for (i, (id, label)) in entries.iter().enumerate() {
        if i > 0 {
            l.push("  ".into());
        }
        l.push(if *id == current {
            format!("[{label}]")
        } else {
            label.to_string()
        });
    }
    l
}
fn pending(ctx: &Ctx, r: &V) -> Option<Vec<Row>> {
    if !r["value"].is_null() {
        None
    } else if !r["error"].is_null() {
        Some(crate::sessions::error_rows(&r["error"]))
    } else {
        Some(vec![Row::new(line(if ctx.state["section"] == "updates" {
            "Checking for updates…"
        } else {
            "Loading…"
        }))])
    }
}
pub fn build(ctx: &Ctx) -> View {
    let section = ctx.state["section"].as_str().unwrap_or("planner");
    let (section, label) = SECTIONS
        .iter()
        .find(|(id, _)| *id == section)
        .copied()
        .unwrap_or(SECTIONS[0]);
    let focus = text(&ctx.state["focus"]) == "detail";
    let lw = if ctx.wide { 30 } else { ctx.width };
    let w = if ctx.wide {
        ctx.width - lw - 3
    } else {
        ctx.width
    } - 2;
    let down = arr(&ctx.s["executors"])
        .iter()
        .filter(|e| matches!(text(&e["state"]), "down" | "failing"))
        .count();
    let hosts = arr(&ctx.s["hosts"])
        .iter()
        .filter(|h| matches!(text(&h["state"]), "down" | "needs_setup"))
        .count();
    let signin = arr(&ctx.s["accounts"])
        .iter()
        .filter(|a| a["signedIn"] == false)
        .count();
    let list = SECTIONS
        .iter()
        .map(|(id, label)| {
            let badge = match *id {
                "updates" => crate::updates::badge(&ctx.s["desktopUpdates"]),
                "executors" if down > 0 => format!(" {down} down"),
                "hosts" if hosts > 0 => format!(" {hosts} needs setup"),
                "accounts" if signin > 0 => format!(" {signin} sign-in"),
                _ => String::new(),
            };
            let mut l = if focus {
                line(if *id == section { "▸ " } else { "  " })
            } else {
                vec![]
            };
            l.push(label.to_string());
            if !badge.is_empty() {
                l.push(badge);
            }
            Row::item(format!("section:{id}"), l)
        })
        .collect();
    let mut v = View {
        list,
        list_width: lw,
        ..View::default()
    };
    let mut rows = vec![h(label, None, None), blank()];
    let mut body = vec![];
    let mut hints = vec![];
    let config = &ctx.settings["config"]["value"];
    let keys = &config["keys"];
    let val = |k: &str| &keys[k]["value"];
    let resource = match section {
        "planner" | "machine" => "config",
        "updates" => "update",
        s => s,
    };
    let op = match section {
        "planner" => "config.get",
        "accounts" => "account.list",
        "routing" => "routing.get",
        "projects" => "project.strategy.*",
        "strategies" => "strategy.list",
        "updates" => "update.check",
        "notifications" => "notifications.get",
        _ => "",
    };
    let supported = if section == "projects" {
        [
            "project.strategy.list",
            "project.strategy.set",
            "project.strategy.remove",
        ]
        .iter()
        .all(|op| ctx.supports(op))
    } else {
        op.is_empty() || ctx.supports(op)
    };
    if !supported {
        body.push(Row::new(line(format!(
            "Not offered by this pacer service ({op})."
        ))));
    } else if matches!(section, "planner" | "machine" | "notifications")
        && pending(ctx, &ctx.settings[resource]).is_some()
    {
        body.extend(pending(ctx, &ctx.settings[resource]).unwrap_or_default());
    } else if section == "updates" && !arr(&ctx.s["desktopUpdates"]).is_empty() {
        let (r, i, h) = crate::updates::build(ctx, w);
        body = r;
        v.items = i;
        hints = h;
    } else {
        match section {
            "planner" => {
                let id = val("planner").as_str().unwrap_or("");
                field(
                    &mut body,
                    w,
                    "Planner",
                    vec![executor(id, &V::Null), format!("  {id}")],
                    "",
                    "setting:planner",
                );
                v.items.push(Item::new(
                    "setting:planner",
                    if arr(&config["planners"]).len() > 1 && ctx.supports("config.set") {
                        Some("Change planner")
                    } else {
                        None
                    },
                    0,
                    &[],
                ));
                if truth(&ctx.s["planner"]["advice"]) {
                    field(
                        &mut body,
                        w,
                        "",
                        line(text(&ctx.s["planner"]["advice"])),
                        "",
                        "",
                    );
                }
                field(
                    &mut body,
                    w,
                    "Policy",
                    choices(
                        &[
                            ("priority", "Priority"),
                            ("even", "Even"),
                            ("burn-before-reset", "Burn before reset"),
                            ("cheapest-first", "Cheapest first"),
                        ],
                        val("pacing.policy").as_str().unwrap_or("priority"),
                    ),
                    "",
                    "setting:policy",
                );
                v.items.push(Item::new(
                    "setting:policy",
                    ctx.op("config.set", "Policy"),
                    0,
                    &[],
                ));
                let mut numeric =
                    |key: &str, id: &str, label: &str, default: f64, unit: &str, note: &str| {
                        let n = if val(key).is_null() {
                            default
                        } else {
                            js_number(val(key))
                        };
                        field(
                            &mut body,
                            w,
                            label,
                            vec!["‹ ".into(), format!("{}{unit}", number(n)), " ›".into()],
                            note,
                            id,
                        );
                        v.items.push(Item::new(id, None, 0, &[]));
                    };
                numeric(
                    "pacing.planner_reserve",
                    "setting:reserve",
                    "Planner reserve",
                    10.,
                    "%",
                    "kept for planning and review",
                );
                let mode = val("pacing.accounts").as_str().unwrap_or("spread");
                field(
                    &mut body,
                    w,
                    "Multiple accounts",
                    choices(&[("spread", "Spread"), ("fill", "Fill")], mode),
                    "",
                    "setting:accounts-mode",
                );
                v.items.push(Item::new(
                    "setting:accounts-mode",
                    ctx.op("config.set", "Multiple accounts"),
                    0,
                    &[],
                ));
                if mode == "fill" {
                    let n = if val("pacing.fill_threshold").is_null() {
                        80.
                    } else {
                        js_number(val("pacing.fill_threshold"))
                    };
                    field(
                        &mut body,
                        w,
                        "Move to the next account at",
                        vec!["‹ ".into(), format!("{}% used", number(n)), " ›".into()],
                        "50–100, steps of 5",
                        "setting:threshold",
                    );
                    v.items.push(Item::new("setting:threshold", None, 0, &[]));
                }
                hints.push("← → adjust".into());
            }
            "accounts" => {
                body.extend([
                    Row::new(line(
                        "Where quota comes from. An executor uses one account.",
                    )),
                    blank(),
                ]);
                if let Some(p) = pending(ctx, &ctx.settings["accounts"]) {
                    body.extend(p);
                } else {
                    let list = arr(&ctx.settings["accounts"]["value"]);
                    if list.is_empty() {
                        body.push(Row::new(line(
                            "No accounts yet. Add an account to get started.",
                        )));
                    }
                    let ws = flex(w, &[(-1, 12), (22, 0), (18, 0)], 2);
                    for a in list {
                        let name = text(&a["name"]);
                        let id = format!("account:{name}");
                        let usage = arr(&ctx.s["accounts"])
                            .iter()
                            .find(|a| text(&a["name"]) == name)
                            .unwrap_or(&V::Null);
                        let signed = fallback(&usage["signedIn"], &a["signedIn"]);
                        let fix = if signed != true {
                            ctx.op("account.signin", "Fix sign-in")
                        } else {
                            None
                        };
                        let remove = !truth(&a["locked"]) && ctx.supports("account.remove");
                        let mut i = Item::new(
                            &id,
                            fix,
                            usize::from(remove),
                            &[("a", "Add account"), ("l", "Link Orca account")],
                        );
                        if remove {
                            i.keys.push(("x".into(), "Remove".into()));
                        }
                        v.items.push(i);
                        let name = if truth(&a["label"]) && a["label"] != a["name"] {
                            format!("{name} ({})", text(&a["label"]))
                        } else {
                            name.into()
                        };
                        let sign = if signed == true {
                            "✓ Signed in"
                        } else if signed == false {
                            "! Sign-in needed"
                        } else {
                            "? Unknown"
                        };
                        body.push(Row::item(
                            &id,
                            cols(
                                vec![
                                    c(name, ws[0]),
                                    c(
                                        [text(&a["kind"]), text(&a["source"])]
                                            .into_iter()
                                            .filter(|s| !s.is_empty())
                                            .collect::<Vec<_>>()
                                            .join(" · "),
                                        ws[1],
                                    ),
                                    c(sign, ws[2]),
                                ],
                                2,
                            ),
                        ));
                        let used = if usage["usedPct"].is_null() {
                            "Usage unknown".into()
                        } else {
                            format!(
                                "{}% of {}{}",
                                round(num(&usage["usedPct"])),
                                match text(&usage["window"]) {
                                    "weekly" => "week",
                                    "" => "quota",
                                    s => s,
                                },
                                if truth(&usage["resetsAt"]) {
                                    format!(" · resets {}", ctx.time(&usage["resetsAt"]))
                                } else {
                                    String::new()
                                }
                            )
                        };
                        let freshness = account_freshness(usage, num(&ctx.s["at"]))
                            .map(|s| format!(" · Historical usage · {s}"))
                            .unwrap_or_default();
                        let users = arr(fallback(&a["executors"], &a["runners"]));
                        let users = if users.is_empty() {
                            "Not used".into()
                        } else {
                            format!(
                                "Used by {}",
                                users
                                    .iter()
                                    .map(|u| executor(text(u), &V::Null))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            )
                        };
                        let lock = if truth(&a["locked"]) {
                            format!(" · {}", text(&a["locked"]))
                        } else {
                            String::new()
                        };
                        prose_item(
                            &mut body,
                            &id,
                            &format!("{used}{freshness} · {users}{lock}"),
                            w,
                        );
                    }
                    body.push(blank());
                    for (id, label) in [
                        ("account-add", "Add account"),
                        ("account-link", "Link Orca account"),
                    ] {
                        v.items.push(Item::new(
                            id,
                            Some(label),
                            0,
                            &[("a", "Add account"), ("l", "Link Orca account")],
                        ));
                        body.push(Row::item(id, line(format!("+ {label}"))));
                    }
                }
            }
            "executors" => {
                body.extend([
                    Row::new(line(
                        "Agent + account + where it runs. Set the priority order.",
                    )),
                    blank(),
                ]);
                let list = arr(&ctx.s["executors"]);
                let ws = flex(w, &[(2, 0), (24, 0), (22, 0), (-1, 3)], 2);
                let ordered: Vec<_> = list.iter().filter(|e| e["rank"] != "planner").collect();
                for e in list {
                    let id = format!("executor:{}", text(&e["id"]));
                    let planner = e["rank"] == "planner";
                    let mut i = Item::new(
                        &id,
                        ctx.op("runner.check", "Run check"),
                        0,
                        &[("a", "Add executor")],
                    );
                    if !planner {
                        for (k, op, label) in [
                            (
                                "e",
                                "runner.set",
                                if truth(&e["enabled"]) {
                                    "Disable"
                                } else {
                                    "Enable"
                                },
                            ),
                            (
                                "b",
                                if e["state"] == "blocked" {
                                    "runner.unblock"
                                } else {
                                    "runner.block"
                                },
                                if e["state"] == "blocked" {
                                    "Unblock"
                                } else {
                                    "Block"
                                },
                            ),
                        ] {
                            if ctx.supports(op) {
                                i.actions += 1;
                                i.keys.push((k.into(), label.into()));
                            }
                        }
                        if ctx.supports("runner.reorder") {
                            let n = ordered.iter().position(|x| *x == e).unwrap_or(0);
                            if n > 0 {
                                i.actions += 1;
                                i.keys.push(("[".into(), "Move up".into()));
                            }
                            if n + 1 < ordered.len() {
                                i.actions += 1;
                                i.keys.push(("]".into(), "Move down".into()));
                            }
                        }
                        if ctx.supports("runner.remove") {
                            i.actions += 1;
                            i.keys.push(("x".into(), "Remove".into()));
                        }
                    }
                    v.items.push(i);
                    let (status, detail, age) = eligibility(e, ctx.now);
                    body.push(Row::item(
                        &id,
                        cols(
                            vec![
                                c(
                                    if planner {
                                        "P".into()
                                    } else {
                                        js_string(&e["rank"])
                                    },
                                    ws[0],
                                ),
                                c(executor(text(&e["id"]), &V::Null), ws[1]),
                                (status, ws[2], false),
                                c(if truth(&e["enabled"]) { "" } else { "off" }, ws[3]),
                            ],
                            2,
                        ),
                    ));
                    let check = if e["lastCheck"].is_null() {
                        "not checked".into()
                    } else {
                        format!(
                            "check {} {}",
                            if truth(&e["lastCheck"]["passed"]) {
                                "passed"
                            } else {
                                "failed"
                            },
                            ctx.time(&e["lastCheck"]["at"])
                        )
                    };
                    let mut parts = vec![
                        text(&e["id"]).into(),
                        e["model"].as_str().unwrap_or("agent default").into(),
                        if truth(&e["host"]) {
                            format!("runs on {}", text(&e["host"]))
                        } else {
                            "this machine".into()
                        },
                        format!(
                            "{}/{} tasks",
                            js_string(&e["slots"]["used"]),
                            js_string(&e["slots"]["max"])
                        ),
                        check,
                    ];
                    if truth(&e["stale"]) {
                        parts.push("Historical usage".into());
                    }
                    parts.push(detail.clone());
                    if let Some(age) = age {
                        parts.push(age);
                    }
                    if text(&e["reason"]) != detail {
                        parts.push(text(&e["reason"]).into());
                    }
                    if let Some(note) = capacity_note(e, ctx.s) {
                        parts.push(note);
                    }
                    parts.retain(|s| !s.is_empty());
                    prose_item(&mut body, &id, &parts.join(" · "), w);
                }
                if list.is_empty() {
                    body.push(Row::new(line("No executors yet. Add one.")));
                }
                body.push(blank());
                v.items.push(Item::new(
                    "executor-add",
                    Some("Add executor"),
                    0,
                    &[("a", "Add executor")],
                ));
                body.push(Row::item("executor-add", line("+ Add executor")));
                body.push(blank());
                body.extend(prose("The planner can't be removed. An executor that fails its check is skipped until it passes again.",w));
            }
            "machine" => {
                let max = if val("execution.local_max_tasks").is_number() {
                    js_string(val("execution.local_max_tasks"))
                } else {
                    "No limit".into()
                };
                let pressure = val("execution.local_memory_pressure_limit")
                    .as_str()
                    .unwrap_or("critical");
                let pressure = match pressure {
                    "critical" => "Critical",
                    "warning" => "Warning",
                    "off" => "Off",
                    s => s,
                };
                let load = if val("execution.local_load_limit").is_number() {
                    js_string(val("execution.local_load_limit"))
                } else {
                    "Off".into()
                };
                for (id, label, value, note) in [
                    (
                        "setting:local-max",
                        "Parallel tasks",
                        max,
                        if ctx.s["machine"].is_null() {
                            String::new()
                        } else {
                            format!("{} busy now", js_string(&ctx.s["machine"]["used"]))
                        },
                    ),
                    (
                        "setting:memory-pressure",
                        "Hold at memory pressure",
                        pressure.into(),
                        String::new(),
                    ),
                    (
                        "setting:load-limit",
                        "Load limit per core",
                        load,
                        String::new(),
                    ),
                ] {
                    field(
                        &mut body,
                        w,
                        label,
                        vec!["‹ ".into(), value, " ›".into()],
                        &note,
                        id,
                    );
                    v.items.push(Item::new(id, None, 0, &[]));
                }
                let m = &ctx.s["machine"];
                let mut guard = vec![];
                if m.get("memoryPressure").is_some() {
                    guard.push(if m["memoryPressure"].is_null() {
                        "memory pressure unavailable".into()
                    } else {
                        format!("memory pressure {}", text(&m["memoryPressure"]))
                    });
                }
                if !m["loadPerCore"].is_null() {
                    guard.push(format!(
                        "load {} per core",
                        number(crate::model::js_round(num(&m["loadPerCore"]) * 10.) / 10.)
                    ));
                }
                if m["open"] == false && truth(&m["detail"]) {
                    guard.push(format!("new tasks wait: {}", text(&m["detail"])));
                }
                if !guard.is_empty() {
                    field(&mut body, w, "Now", line(guard.join(" · ")), "", "");
                }
                field(
                    &mut body,
                    w,
                    "",
                    line(
                        "Shared by all executors that run on this machine. Without a limit, new tasks start until memory pressure or load reaches its limit. Running tasks are never stopped.",
                    ),
                    "",
                    "",
                );
                let env = text(&keys["execution.backend"]["source"]).starts_with("env");
                field(
                    &mut body,
                    w,
                    "Task backend",
                    vec![
                        "‹ ".into(),
                        if val("execution.backend") == "orca" {
                            "Orca"
                        } else {
                            "Direct"
                        }
                        .into(),
                        " ›".into(),
                    ],
                    if env { "Set by PACER_BACKEND" } else { "" },
                    "setting:backend",
                );
                v.items.push(Item::new("setting:backend", None, 0, &[]));
                field(
                    &mut body,
                    w,
                    "",
                    line(format!(
                        "Orca runs interactive tasks as supervised workers in Orca terminals. Headless tasks, and any task when Orca isn't running or the agent isn't supported, run directly.{}",
                        if env {
                            " PACER_BACKEND overrides the saved setting. Unset PACER_BACKEND to change it here."
                        } else {
                            ""
                        }
                    )),
                    "",
                    "",
                );
                hints.push("← → adjust".into());
            }
            "hosts" => {
                body.extend([
                    Row::new(line("Machines that run Codex or Claude Code over SSH.")),
                    blank(),
                ]);
                let list = arr(&ctx.s["hosts"]);
                if list.is_empty() {
                    body.push(Row::new(line(
                        "No remote hosts yet. Add one with pacer host add.",
                    )));
                }
                let ws = flex(w, &[(-1, 10), (16, 0), (12, 0)], 2);
                for host in list {
                    let id = format!("host:{}", text(&host["alias"]));
                    let pause = if host["state"] == "paused" {
                        "Resume new work"
                    } else {
                        "Pause new work"
                    };
                    v.items.push(Item::new(
                        &id,
                        ctx.op("host.check", "Run checks"),
                        usize::from(ctx.supports("host.set")),
                        &if ctx.supports("host.set") {
                            vec![("p", pause)]
                        } else {
                            vec![]
                        },
                    ));
                    let status = match text(&host["state"]) {
                        "ready" => "✓ Ready",
                        "down" => "✕ Not answering",
                        "checking" => "… Checking",
                        "paused" => "■ Paused",
                        "needs_setup" => "! Needs setup",
                        _ => "? Not checked",
                    };
                    body.push(Row::item(
                        &id,
                        cols(
                            vec![
                                (
                                    vec![
                                        text(&host["alias"]).into(),
                                        format!("  ssh {}", text(&host["ssh"])),
                                    ],
                                    ws[0],
                                    false,
                                ),
                                c(status, ws[1]),
                                cr(
                                    format!(
                                        "{} / {} busy",
                                        js_string(&host["running"]),
                                        js_string(&host["maxTasks"])
                                    ),
                                    ws[2],
                                ),
                            ],
                            2,
                        ),
                    ));
                    let users = arr(&host["executors"]);
                    prose_item(
                        &mut body,
                        &id,
                        &format!(
                            "{} · {} {}",
                            if users.is_empty() {
                                "No executors".into()
                            } else {
                                users
                                    .iter()
                                    .map(|x| executor(text(x), &V::Null))
                                    .collect::<Vec<_>>()
                                    .join(", ")
                            },
                            js_string(&host["repos"]),
                            if host["repos"] == 1 { "repo" } else { "repos" }
                        ),
                        w,
                    );
                }
                body.push(blank());
                body.extend(prose("Add hosts, map repositories and clean up worktrees with pacer host, or in the app: pacer open settings.",w));
            }
            "routing" => {
                body.extend([
                    Row::new(line(
                        "Which executors a kind of task may use, in order. First match wins.",
                    )),
                    blank(),
                ]);
                if let Some(p) = pending(ctx, &ctx.settings["routing"]) {
                    body.extend(p);
                } else {
                    let rules = arr(&ctx.settings["routing"]["value"]["rules"]);
                    let ws = flex(w, &[(26, 0), (-1, 10)], 2);
                    if rules.is_empty() {
                        body.push(Row::new(line("No routing rules yet.")));
                    }
                    for (i, r) in rules.iter().enumerate() {
                        let id = format!("rule:{i}");
                        let can = ctx.supports("routing.set");
                        let remove = can && !(i + 1 == rules.len() && r["kinds"].is_null());
                        let mut keys = vec![];
                        if can {
                            keys.push(("n", "Add rule"));
                        }
                        if remove {
                            keys.push(("x", "Remove rule"));
                        }
                        v.items.push(Item::new(
                            &id,
                            if can {
                                Some("Edit executor order")
                            } else {
                                None
                            },
                            usize::from(can) + usize::from(remove),
                            &keys,
                        ));
                        let l = if r["kinds"].is_null() {
                            line("Everything else")
                        } else {
                            vec![
                                format!("Rule {}  ", i + 1),
                                arr(&r["kinds"])
                                    .iter()
                                    .map(text)
                                    .collect::<Vec<_>>()
                                    .join(", "),
                            ]
                        };
                        body.push(Row::item(
                            &id,
                            cols(
                                vec![
                                    (l, ws[0], false),
                                    c(
                                        arr(&r["executors"])
                                            .iter()
                                            .map(|x| executor(text(x), &V::Null))
                                            .collect::<Vec<_>>()
                                            .join(" → "),
                                        ws[1],
                                    ),
                                ],
                                2,
                            ),
                        ));
                    }
                    if ctx.supports("routing.set") {
                        body.push(blank());
                        v.items.push(Item::new(
                            "rule-add",
                            Some("Add rule"),
                            0,
                            &[("n", "Add rule")],
                        ));
                        body.push(Row::item("rule-add", line("+ Add rule")));
                    }
                }
            }
            "projects" => {
                body.extend(prose("Choose which executors may work on a repository, in order. This overrides global routing and stays in place when you switch strategies.",w));
                body.push(blank());
                if let Some(p) = pending(ctx, &ctx.settings["projects"]) {
                    body.extend(p);
                } else {
                    let list = arr(&ctx.settings["projects"]["value"]);
                    let add = arr(&ctx.s["repos"])
                        .iter()
                        .any(|r| !list.iter().any(|p| p["repo"]["key"] == r["key"]));
                    if list.is_empty() {
                        body.push(Row::new(line(if arr(&ctx.s["repos"]).is_empty() {
                            "No repositories yet. Add a repository from the repository picker to configure its strategy."
                        } else {
                            "Every repository uses the global strategy."
                        })));
                    }
                    let ws = flex(w, &[(20, 0), (-1, 10)], 2);
                    for p in list {
                        let id = format!("project:{}", text(&p["repo"]["key"]));
                        let mut keys = vec![("x", "Use global strategy")];
                        if add {
                            keys.push(("n", "Add project order"));
                        }
                        v.items.push(Item::new(
                            &id,
                            Some("Edit project order"),
                            1 + usize::from(add),
                            &keys,
                        ));
                        let refs = arr(&p["executors"]);
                        let desc = if refs.is_empty() {
                            "Using global strategy".into()
                        } else {
                            refs.iter()
                                .enumerate()
                                .map(|(i, r)| {
                                    let label = arr(&p["available"])
                                        .iter()
                                        .find(|a| a["reference"] == *r || a["id"] == *r)
                                        .map(|a| text(&a["label"]).to_string())
                                        .unwrap_or_else(|| {
                                            format!(
                                                "{} (unavailable in the active strategy)",
                                                text(r)
                                            )
                                        });
                                    format!(
                                        "{}: {label}",
                                        if i == 0 {
                                            "First choice".into()
                                        } else {
                                            format!("Fallback {i}")
                                        }
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join(" · ")
                        };
                        body.push(Row::item(
                            id,
                            cols(vec![c(text(&p["repo"]["label"]), ws[0]), c(desc, ws[1])], 2),
                        ));
                    }
                    if add {
                        body.push(blank());
                        v.items.push(Item::new(
                            "project-add",
                            Some("Add project order"),
                            0,
                            &[("n", "Add project order")],
                        ));
                        body.push(Row::item("project-add", line("+ Add project order")));
                    }
                }
            }
            "strategies" => {
                body.extend([
                    Row::new(line("Saved sets of everything above. Switch anytime.")),
                    blank(),
                ]);
                if let Some(p) = pending(ctx, &ctx.settings["strategies"]) {
                    body.extend(p);
                } else {
                    let list = arr(&ctx.settings["strategies"]["value"]);
                    let ws = flex(w, &[(20, 0), (10, 0), (-1, 10)], 2);
                    let build = ctx.supports("strategy.build");
                    if list.is_empty() {
                        body.push(Row::new(line("No strategies yet.")));
                    }
                    for st in list {
                        let id = format!("strategy:{}", text(&st["name"]));
                        let active = truth(&st["active"]);
                        v.items.push(Item::new(
                            &id,
                            if active {
                                None
                            } else {
                                ctx.op("strategy.use", "Use")
                            },
                            usize::from(build),
                            if build {
                                &[("n", "New from a brief")]
                            } else {
                                &[]
                            },
                        ));
                        body.push(Row::item(
                            id,
                            cols(
                                vec![
                                    c(text(&st["name"]), ws[0]),
                                    c(if active { "✓ Active" } else { "" }, ws[1]),
                                    c(text(&st["summary"]), ws[2]),
                                ],
                                2,
                            ),
                        ));
                    }
                    if build {
                        body.push(blank());
                        v.items.push(Item::new(
                            "strategy-new",
                            Some("New from a brief"),
                            0,
                            &[("n", "New from a brief")],
                        ));
                        body.push(Row::item("strategy-new", line("+ New from a brief")));
                    }
                }
            }
            "updates" => {
                if let Some(p) = pending(ctx, &ctx.settings["update"]) {
                    body.extend(p.into_iter().map(|mut r| {
                        r.item = "update:check".into();
                        r
                    }));
                    v.items.push(Item::new(
                        "update:check",
                        ctx.op("update.check", "Check now"),
                        0,
                        &[],
                    ));
                } else {
                    let u = &ctx.settings["update"]["value"];
                    let state = if truth(&u["error"]) {
                        "Update check failed".into()
                    } else if truth(&u["disabled"]) {
                        "Update checking disabled".into()
                    } else if truth(&u["available"]) {
                        format!("Update available: {}", text(&u["latest"]))
                    } else if truth(&u["latest"]) {
                        "Up to date".into()
                    } else {
                        "Not checked".into()
                    };
                    let can = !truth(&u["disabled"]) || truth(&u["error"]);
                    v.items.push(Item::new(
                        "update:check",
                        if can {
                            ctx.op("update.check", "Check now")
                        } else {
                            None
                        },
                        0,
                        &[],
                    ));
                    field(
                        &mut body,
                        w,
                        "Version",
                        vec![text(&u["current"]).into(), format!("  {state}")],
                        if can { "⏎ check now" } else { "" },
                        "update:check",
                    );
                    if truth(&u["available"]) && ctx.supports("update.apply") {
                        v.items.push(Item::new(
                            "update:apply",
                            Some("Update and restart"),
                            0,
                            &[("u", "Update and restart")],
                        ));
                        field(
                            &mut body,
                            w,
                            "",
                            line("Update and restart"),
                            "",
                            "update:apply",
                        );
                    }
                    let configured = val("update_check") != false;
                    if truth(&u["disabled"]) && configured {
                        field(
                            &mut body,
                            w,
                            "Check for updates",
                            line("Off"),
                            "PACER_NO_UPDATE_CHECK is set",
                            "",
                        );
                    } else {
                        v.items.push(Item::new(
                            "update:daily",
                            ctx.op("config.set", "Update checks"),
                            0,
                            &[],
                        ));
                        field(
                            &mut body,
                            w,
                            "Check for updates",
                            line(if configured { "On" } else { "Off" }),
                            "once a day, in the background",
                            "update:daily",
                        );
                    }
                }
            }
            "notifications" => {
                let level = ctx.settings["notifications"]["value"]["level"]
                    .as_str()
                    .unwrap_or("important");
                v.items.push(Item::new(
                    "setting:notifications",
                    ctx.op("notifications.set", "Notifications"),
                    0,
                    &[],
                ));
                field(
                    &mut body,
                    w,
                    "Notify me about",
                    choices(
                        &[("off", "Off"), ("important", "Important"), ("all", "All")],
                        level,
                    ),
                    "",
                    "setting:notifications",
                );
                field(
                    &mut body,
                    w,
                    "",
                    line("Important: failures, stuck tasks and reviews."),
                    "",
                    "",
                );
                hints.push("← → change".into());
            }
            "appearance" => {
                for (id, label, value, act, note) in [
                    (
                        "theme",
                        "Theme",
                        "Dark",
                        "Switch theme",
                        "truecolor and 256-color terminals",
                    ),
                    ("color", "Colors", "No color", "Switch colors", ""),
                    (
                        "motion",
                        "Motion",
                        "Off",
                        "Switch motion",
                        "spinners while loading",
                    ),
                    ("glyphs", "Glyphs", "Unicode", "Switch glyphs", ""),
                ] {
                    let id = format!("appearance:{id}");
                    v.items.push(Item::new(&id, Some(act), 0, &[]));
                    field(&mut body, w, label, line(value), note, &id);
                }
                body.push(blank());
                body.extend(prose("Applied for this session. To keep a choice, set PACER_THEME=light|dark, PACER_COLOR=none|16|256|truecolor or NO_COLOR, PACER_ASCII=1 and PACER_NO_ANIM=1, or run pacer dashboard --plain for screen readers.",w));
            }
            _ => {}
        }
    }
    rows.extend(body);
    v.detail = Some(rows);
    if focus {
        hints.push("Esc sections".into());
        v.hints = hints;
    }
    v
}
