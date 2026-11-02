use crate::{layout::*, model::*, render::*};
use serde_json::Value as V;
fn scrolled(rows: Vec<Line>, scroll: usize, room: usize) -> Vec<Line> {
    if rows.len() <= room {
        return rows;
    }
    let offset = scroll.min(rows.len() - room.saturating_sub(1));
    let up = offset > 0;
    let mut shown = room - usize::from(up);
    let down = offset + shown < rows.len();
    if down {
        shown -= 1;
    }
    let mut out = vec![];
    if up {
        out.push(line(format!("↑ {offset} more · j k scroll")));
    }
    out.extend_from_slice(&rows[offset..offset + shown]);
    if down {
        out.push(line(format!(
            "↓ {} more · j k scroll",
            rows.len() - offset - shown
        )));
    }
    out
}
fn help(ctx: &Ctx, screen: &str) -> Vec<Line> {
    let tabs = if ctx.s["setup"]["ready"] == false {
        5
    } else {
        4
    };
    let switch = format!("1-{tabs} / Tab Shift-Tab");
    let anywhere = [
        ("TABS", "Switch screen", ""),
        (",", "Settings", ""),
        ("j k / ↑ ↓", "Select", ""),
        ("PgUp PgDn", "Page through a list", ""),
        ("⏎", "Primary action", ""),
        (".", "All actions for the row", ""),
        ("n", "Start interactive session", "session.create"),
        ("d", "Delegate a task", "task.delegate"),
        ("f", "Repo scope", ""),
        ("R / Ctrl-R", "Refresh", ""),
        ("?", "Keyboard shortcuts", ""),
        ("Esc", "Close or go back", ""),
        ("q", "Quit", ""),
    ];
    let local: Vec<(&str, &str, &str)> = match screen {
        "home" => vec![
            ("x", "Dismiss", "attention.dismiss"),
            ("v", "Open in Review", ""),
            ("b", "Block or unblock an executor", "runner.block"),
            ("t m", "Terminal window · tmux pane", "task.attach"),
            ("s", "Stop", "task.stop"),
        ],
        "review" => vec![
            ("a", "Mark accepted", "task.review"),
            ("s", "Send back with a note", "task.review"),
            ("r", "Reject with a note", "task.review"),
            ("t", "Retry on another executor", "task.review"),
            ("o", "Show worktree path", ""),
        ],
        "sessions" => vec![
            ("⏎", "Watch here", "task.attach"),
            ("t", "Open in a terminal window", "task.attach"),
            ("m", "Open in a tmux pane", "task.attach"),
            ("s", "Stop", "task.stop"),
            ("x", "Dismiss", "task.dismiss"),
        ],
        "settings" => vec![
            ("⏎ / →", "Open a section", ""),
            ("← →", "Adjust a value", ""),
            ("Esc", "Back to sections", ""),
        ],
        _ => vec![
            ("⏎", "Run the selected step", ""),
            ("x", "Skip first delegation", "onboarding.skip"),
        ],
    };
    let key = |k: &str| {
        if k == "TABS" {
            switch.clone()
        } else {
            k.into()
        }
    };
    let column = anywhere
        .iter()
        .chain(local.iter())
        .map(|(k, _, _)| key(k).encode_utf16().count() + 2)
        .max()
        .unwrap_or(12)
        .max(12);
    let group = |title: &str, entries: &[(&str, &str, &str)]| {
        let mut rows = vec![heading(title, None, None, true)];
        for (k, label, op) in entries {
            if op.is_empty() || ctx.supports(op) {
                let k = key(k);
                let gap = column.saturating_sub(k.encode_utf16().count());
                rows.push(vec![format!("{k}{}", " ".repeat(gap)), label.to_string()]);
            }
        }
        rows
    };
    let label = match screen {
        "home" => "Home",
        "review" => "Needs you",
        "sessions" => "Tasks",
        "settings" => "Settings",
        _ => "Setup",
    };
    [
        group("Anywhere", &anywhere),
        vec![vec![]],
        group(label, &local),
    ]
    .concat()
}
pub fn build(ctx: &Ctx, overlay: &V, screen: &str, width: usize, height: usize) -> Vec<Line> {
    let w = width.min(72);
    let title = text(&overlay["title"]);
    match text(&overlay["kind"]) {
        "help" => boxed(
            "Keyboard shortcuts",
            scrolled(
                help(ctx, screen),
                num(&overlay["scroll"]) as usize,
                height.saturating_sub(2).max(3),
            ),
            w,
        ),
        "confirm" => {
            let mut body = vec![];
            for p in arr(&overlay["body"]) {
                body.extend(
                    wrap(text(p), w.saturating_sub(4), usize::MAX)
                        .into_iter()
                        .map(line),
                );
            }
            body.push(vec![]);
            let mut l = vec!["y".into(), format!(" {}", text(&overlay["yes"]))];
            if !overlay["alt"].is_null() {
                l.extend([
                    "   ".into(),
                    text(&overlay["alt"]["key"]).into(),
                    format!(" {}", text(&overlay["alt"]["label"])),
                ]);
            }
            l.extend(["   ".into(), "n".into(), " Cancel".into()]);
            body.push(l);
            boxed(title, body, w)
        }
        "menu" => {
            let mut body = arr(&overlay["actions"])
                .iter()
                .enumerate()
                .map(|(i, a)| {
                    vec![
                        if i == num(&overlay["index"]) as usize {
                            "› "
                        } else {
                            "  "
                        }
                        .into(),
                        (i + 1).to_string(),
                        format!(" {}", text(&a["label"])),
                    ]
                })
                .collect::<Vec<_>>();
            body.extend([vec![], line("1-9 or ⏎ choose · Esc cancel")]);
            boxed(title, body, w)
        }
        "prompt" => {
            let spec = &overlay["spec"];
            let mut body = vec![
                line(text(&spec["label"])),
                vec![
                    "› ".into(),
                    crate::clip(text(&overlay["value"]), w.saturating_sub(8), "…"),
                    "▌".into(),
                ],
            ];
            if truth(&overlay["error"]) {
                body.push(line(format!("✕ {}", text(&overlay["error"]))));
            }
            if truth(&spec["help"]) {
                body.push(line(text(&spec["help"])));
            }
            body.extend([vec![], line("⏎ submit · Esc cancel")]);
            boxed(text(&spec["title"]), body, w)
        }
        _ => vec![],
    }
}
