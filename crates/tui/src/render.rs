use crate::{home, sessions, settings};
use crate::{layout::*, model::*};
use serde_json::Value as V;
#[derive(Clone, Default)]
pub(crate) struct Row {
    pub line: Line,
    pub item: String,
    pub cont: bool,
}
impl Row {
    pub fn new(l: Line) -> Self {
        Self {
            line: l,
            ..Self::default()
        }
    }
    pub fn item(id: impl Into<String>, l: Line) -> Self {
        Self {
            item: id.into(),
            line: l,
            cont: false,
        }
    }
    pub fn cont(id: impl Into<String>, l: Line) -> Self {
        Self {
            item: id.into(),
            line: l,
            cont: true,
        }
    }
}
#[derive(Clone, Default)]
pub(crate) struct Item {
    pub id: String,
    pub primary: Option<String>,
    pub actions: usize,
    pub keys: Vec<(String, String)>,
}
impl Item {
    pub fn new(
        id: impl Into<String>,
        primary: Option<&str>,
        actions: usize,
        keys: &[(&str, &str)],
    ) -> Self {
        Self {
            id: id.into(),
            primary: primary.map(str::to_string),
            actions,
            keys: keys
                .iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect(),
        }
    }
}
#[derive(Default)]
pub(crate) struct View {
    pub list: Vec<Row>,
    pub detail: Option<Vec<Row>>,
    pub items: Vec<Item>,
    pub list_width: usize,
    pub hints: Vec<String>,
    pub initial: String,
}
pub(crate) struct Ctx<'a> {
    pub s: &'a V,
    pub details: &'a V,
    pub settings: &'a V,
    pub state: &'a V,
    pub case: &'a V,
    pub width: usize,
    pub wide: bool,
    pub now: f64,
}
impl Ctx<'_> {
    pub fn scope(&self) -> &str {
        text(&self.state["scope"])
    }
    pub fn selected(&self, screen: &str) -> &str {
        text(&self.state["selected"][screen])
    }
    pub fn supports(&self, op: &str) -> bool {
        self.case["ops"].is_null() || arr(&self.case["ops"]).iter().any(|o| text(o) == op)
    }
    pub fn detail(&self, id: &str) -> &V {
        &self.details[id]["value"]
    }
    pub fn time(&self, v: &V) -> String {
        clock(num(v), self.now)
    }
    pub fn op<'b>(&self, op: &str, label: &'b str) -> Option<&'b str> {
        self.supports(op).then_some(label)
    }
}
pub(crate) fn c(s: impl Into<String>, w: usize) -> (Line, usize, bool) {
    (line(s), w, false)
}
pub(crate) fn cr(s: impl Into<String>, w: usize) -> (Line, usize, bool) {
    (line(s), w, true)
}
pub(crate) fn blank() -> Row {
    Row::default()
}
pub(crate) fn prose(text: &str, w: usize) -> Vec<Row> {
    wrap(text, w, usize::MAX)
        .into_iter()
        .map(|s| Row::new(line(s)))
        .collect()
}
pub(crate) fn h(s: &str, n: Option<String>, note: Option<String>) -> Row {
    Row::new(heading(s, n, note, true))
}
fn label(screen: &str) -> &str {
    match screen {
        "home" => "Home",
        "review" => "Needs you",
        "sessions" => "Tasks",
        "settings" => "Settings",
        _ => "Setup",
    }
}
fn ends(left: Line, right: Line, w: usize) -> Line {
    let r = fit(&right, w.saturating_sub(10));
    let l = fit(&left, w.saturating_sub(width(&r) + 2));
    let gap = w.saturating_sub(width(&l) + width(&r)).max(1);
    [l, line(" ".repeat(gap)), r].concat()
}
fn list_rows(rows: &[Row], selected: &str, show: bool, w: usize) -> (Vec<Line>, usize) {
    let mut chosen = 0;
    let out = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let is = show && !r.item.is_empty() && r.item == selected;
            let mark = if is && !r.cont {
                chosen = i;
                "› "
            } else {
                "  "
            };
            let l = [line(mark), r.line.clone()].concat();
            if is { pad(&l, w) } else { l }
        })
        .collect();
    (out, chosen)
}
fn viewport(rows: Vec<Line>, selected: usize, height: usize) -> Vec<Line> {
    if rows.len() <= height {
        return rows;
    }
    let offset = if selected < height.saturating_sub(1) {
        0
    } else {
        (rows.len() - height + 1).min(selected.saturating_sub(height.saturating_sub(2)))
    };
    let mut out = rows[offset..(offset + height).min(rows.len())].to_vec();
    if offset > 0 {
        out[0] = line(format!("↑ {} more", offset + 1));
    }
    if offset + height < rows.len() {
        out[height - 1] = line(format!("↓ {} more", rows.len() - offset - height + 1));
    }
    out
}
fn key_bar(ctx: &Ctx, item: Option<&Item>, v: &View, screen: &str, w: usize) -> Line {
    let mut groups: Vec<Line> = vec![];
    let mut add = |k: &str, s: &str| groups.push(vec![k.into(), format!(" {s}")]);
    if screen == "settings" && text(&ctx.state["focus"]) != "detail" {
        add("⏎", "open section");
        add("j k", "sections");
    } else if let Some(i) = item {
        if let Some(p) = &i.primary {
            add("⏎", p);
        }
        for (k, a) in &i.keys {
            if k != "left" && k != "right" && Some(a) != i.primary.as_ref() {
                add(k, &a.to_lowercase());
            }
        }
        if i.actions > 0 {
            add(
                ".",
                &format!("actions ({})", i.actions + usize::from(i.primary.is_some())),
            );
        }
    }
    for hint in &v.hints {
        let (k, l) = hint.split_once(' ').unwrap_or((hint, ""));
        add(k, l);
    }
    let help = vec!["?".into(), " help".into()];
    let p = &ctx.s["policy"];
    let policy = if p.is_null() {
        "policy: unknown".into()
    } else if p["mode"] == "closed" {
        format!(
            "policy: closed ({} {})",
            js_string(&p["plugins"]),
            if p["plugins"] == 1 {
                "plugin"
            } else {
                "plugins"
            }
        )
    } else {
        "policy: open".into()
    };
    let compact = if p.is_null() {
        "policy:unknown".into()
    } else {
        format!("policy:{}/{}", text(&p["mode"]), js_string(&p["plugins"]))
    };
    let update = text(&ctx.case["update"]);
    let known = match update {
        "available" => "update available",
        "current" => "up to date",
        "disabled" => "update checks off",
        "failed" => "update check failed",
        _ => "",
    };
    let version = format!(
        "pacer {}",
        ctx.case["version"].as_str().unwrap_or("0.0.0-test")
    );
    let sep = " · ".to_string();
    let plain = if known.is_empty() || (w < 100 && update == "current") {
        line(version)
    } else if w >= 100 {
        vec![version, sep.clone(), known.into()]
    } else {
        line(known)
    };
    let join = |groups: &[Line]| -> Line {
        let mut out = vec![];
        for (i, g) in groups.iter().enumerate() {
            if i > 0 {
                out.push("  ".into());
            }
            out.extend(g.clone());
        }
        out
    };
    let kept = |right: &Line| -> usize {
        let room = w as isize - width(right) as isize - 2;
        let mut n = groups.len();
        while n > 1
            && width(&join(&[groups[..n].to_vec(), vec![help.clone()]].concat())) as isize > room
        {
            n -= 1;
        }
        n
    };
    let shown = kept(&plain);
    let mut options = vec![
        vec![policy.clone(), sep.clone()],
        vec![compact.clone(), sep.clone()],
    ]
    .into_iter()
    .map(|mut l| {
        l.extend(plain.clone());
        l
    })
    .collect::<Vec<_>>();
    if !known.is_empty() && update != "current" {
        options.extend([
            vec![policy.clone(), sep.clone(), known.into()],
            vec![compact.clone(), sep, known.into()],
        ]);
    }
    if !matches!(update, "available" | "failed") {
        options.extend([line(policy), line(compact)]);
    }
    let right = options
        .into_iter()
        .find(|l| kept(l) >= shown)
        .unwrap_or(plain);
    let n = kept(&right);
    groups.truncate(n);
    groups.push(help);
    ends(join(&groups), right, w)
}
pub(crate) fn rows(input: &V, case: &V) -> Vec<Line> {
    let w = num(&case["width"]).floor().max(1.) as usize;
    let height = num(&case["height"]).floor().max(1.) as usize;
    if w < 60 || height < 16 {
        let mut shown = wrap(
            "Make the terminal at least 60×16 to use pacer dashboard.",
            w,
            usize::MAX,
        );
        shown.push("q quits.".into());
        if shown.len() > height {
            shown.truncate(height.saturating_sub(1));
            shown.push("q quits.".into());
        }
        let top = (height - shown.len()) / 2;
        return (0..height)
            .map(|i| {
                if i >= top && i < top + shown.len() {
                    line(crate::clip(&shown[i - top], w, "…"))
                } else {
                    vec![]
                }
            })
            .collect();
    }
    let s = if case["snapshot"].is_null() {
        &input["snapshot"]
    } else {
        &case["snapshot"]
    };
    let state = &case["state"];
    let details = if case["details"].is_null() {
        &input["details"]
    } else {
        &case["details"]
    };
    let settings = if case["settings"].is_null() {
        &input["settings"]
    } else {
        &case["settings"]
    };
    let mut screen = state["screen"].as_str().unwrap_or("home");
    let inner = w.min(160) - 2;
    let bh = height - 6;
    let ctx = Ctx {
        s,
        details,
        settings,
        state,
        case,
        width: inner,
        wide: w >= 110,
        now: case["now"].as_f64().unwrap_or(num(&s["at"])),
    };
    if s["setup"]["complete"] == false
        && matches!(screen, "home" | "review" | "sessions")
        && !(screen == "sessions"
            && arr(&case["ops"])
                .iter()
                .any(|x| text(x) == "session.create"))
    {
        screen = "setup";
    }
    let v = match screen {
        "settings" => settings::build(&ctx),
        "sessions" => sessions::build(&ctx),
        "review" => sessions::review(&ctx),
        "setup" => home::setup(&ctx),
        _ => home::build(&ctx),
    };
    let selected = state["selected"][screen].as_str();
    let item = if selected == Some("") {
        None
    } else {
        v.items
            .iter()
            .find(|i| Some(i.id.as_str()) == selected)
            .or_else(|| v.items.iter().find(|i| i.id == v.initial))
            .or(v.items.first())
    };
    let mut tabs = vec!["home", "review", "sessions", "settings"];
    if s["setup"]["ready"] == false {
        tabs.push("setup");
    }
    let mut left = vec!["▬".into(), "┃".into(), " pacer".into(), " ".into()];
    let attention = needs(s, "").len();
    for tab in tabs {
        left.push("  ".into());
        left.push(if tab == screen {
            format!("[ {} ]", label(tab))
        } else {
            label(tab).into()
        });
        let n = if tab == "review" {
            attention
        } else if tab == "sessions" {
            num(&s["counts"]["running"]) as usize
        } else {
            0
        };
        if n > 0 && tab != screen {
            left.push(format!(" {n}"));
        }
        if tab == "setup" && tab != screen {
            left.push(" !".into());
        }
    }
    let connection = case["connection"].as_str().unwrap_or("live");
    let live = match connection {
        "connecting" => "○ connecting".into(),
        "local" => format!("○ local {}", clock(ctx.now, ctx.now)),
        "offline" => format!(
            "○ not responding{}",
            if num(&s["at"]) > 0. {
                format!(" · updated {}", ctx.time(&s["at"]))
            } else {
                String::new()
            }
        ),
        _ => format!("● live {}", clock(ctx.now, ctx.now)),
    };
    let scope = arr(&s["repos"])
        .iter()
        .find(|r| text(&r["key"]) == ctx.scope())
        .map(|r| text(&r["label"]))
        .unwrap_or(if ctx.scope().is_empty() {
            "All repos"
        } else {
            ctx.scope()
        });
    let mode = text(fallback(&s["mode"]["mode"], &s["planner"]["mode"]));
    let mut right = if inner < 100 {
        vec![]
    } else {
        let mut l = line(scope);
        if !mode.is_empty() {
            let mut chars = mode.chars();
            let word = format!(
                "{}{}",
                chars
                    .next()
                    .map(|c| c.to_uppercase().to_string())
                    .unwrap_or_default(),
                chars.as_str().to_lowercase()
            );
            l.extend([" · ".into(), word]);
        }
        l.push(" · ".into());
        l
    };
    right.push(live);
    let mut planner = if s["planner"].is_null() {
        line("Planner · waiting for service data")
    } else {
        let p = &s["planner"];
        let wide = inner >= 100;
        let name = format!(
            "{}{}",
            agent(text(&p["agent"])),
            if wide { " planner" } else { "" }
        );
        let used = p["usedPct"].as_f64();
        let pace = p["pacePct"].as_f64();
        let caption = used.map_or("usage unknown".into(), |u| {
            format!(
                "{}% used{}",
                round(u),
                pace.map_or(String::new(), |p| format!(" · pace {}%", round(p)))
            )
        });
        let mut l = line(name);
        l.push("  ".into());
        l.extend(meter(used, pace, if wide { 20 } else { 12 }));
        l.extend(["  ".into(), caption, "  ".into()]);
        l.extend(crate::model::pace(text(&p["verdict"])));
        let mut extra = vec![];
        if !p["activeHoursLeft"].is_null() {
            extra.push(format!("{} active-h", round(num(&p["activeHoursLeft"]))));
        }
        if !p["resetsAt"].is_null() {
            extra.push(format!("resets {}", ctx.time(&p["resetsAt"])));
        }
        if truth(&p["stale"]) {
            extra.push("stale reading".into());
        }
        if !extra.is_empty() {
            l.push(format!("  {}", extra.join(" · ")));
        }
        l
    };
    planner = fit(&planner, inner);
    let mut out = vec![
        [line(" "), ends(left, right, inner)].concat(),
        [line(" "), planner].concat(),
        line(format!(" {}", "─".repeat(inner))),
    ];
    let item_id = item.map(|i| i.id.as_str()).unwrap_or("");
    let detail_focus = text(&state["focus"]) == "detail";
    let mut body = if let Some(detail) = &v.detail {
        if ctx.wide {
            let lw = v.list_width;
            let dw = inner.saturating_sub(lw + 3);
            let section = format!("section:{}", state["section"].as_str().unwrap_or("planner"));
            let list_id = if screen == "settings" {
                &section
            } else {
                item_id
            };
            let (l, mut selected) =
                list_rows(&v.list, list_id, screen != "settings" || !detail_focus, lw);
            if screen == "settings" && detail_focus {
                selected = v.list.iter().position(|r| r.item == *list_id).unwrap_or(0);
            }
            let left = viewport(l, selected, bh);
            let (r, chosen) = if screen == "settings" {
                list_rows(detail, item_id, detail_focus, dw)
            } else {
                (
                    detail
                        .iter()
                        .skip(num(&state["scroll"]) as usize)
                        .map(|r| r.line.clone())
                        .collect(),
                    0,
                )
            };
            let right = viewport(r, chosen, bh);
            (0..bh)
                .map(|i| {
                    [
                        pad(left.get(i).unwrap_or(&vec![]), lw),
                        line(" │ "),
                        fit(right.get(i).unwrap_or(&vec![]), dw),
                    ]
                    .concat()
                })
                .collect()
        } else if detail_focus {
            if screen == "settings" {
                let (r, n) = list_rows(detail, item_id, true, inner);
                viewport(r, n, bh)
            } else {
                viewport(
                    detail
                        .iter()
                        .skip(num(&state["scroll"]) as usize)
                        .map(|r| [line("  "), r.line.clone()].concat())
                        .collect(),
                    0,
                    bh,
                )
            }
        } else {
            let id = if screen == "settings" {
                format!("section:{}", state["section"].as_str().unwrap_or("planner"))
            } else {
                item_id.into()
            };
            let (r, n) = list_rows(&v.list, &id, true, inner);
            viewport(r, n, bh)
        }
    } else {
        let (r, n) = list_rows(&v.list, item_id, true, inner);
        viewport(r, n, bh)
    };
    body.resize(bh, vec![]);
    if !state["overlay"].is_null() {
        let lines = crate::overlay::build(&ctx, &state["overlay"], screen, inner, bh);
        let top = bh.saturating_sub(lines.len()) / 3;
        let left = inner.saturating_sub(lines.first().map(width).unwrap_or(0)) / 2;
        for (i, l) in lines.into_iter().take(bh).enumerate() {
            body[top + i] = [line(" ".repeat(left)), l].concat();
        }
    }
    out.extend(
        body.into_iter()
            .take(bh)
            .map(|l| [line(" "), fit(&l, inner)].concat()),
    );
    out.push(line(format!(" {}", "─".repeat(inner))));
    let message = &case["message"];
    out.push(if message.is_null() {
        line(" ")
    } else {
        [
            line(" "),
            fit(
                &line(format!(
                    "{} {}",
                    match text(&message["tone"]) {
                        "bad" => "✕",
                        "warn" => "!",
                        "good" => "✓",
                        _ => "·",
                    },
                    text(&message["text"])
                )),
                inner,
            ),
        ]
        .concat()
    });
    out.push([line(" "), key_bar(&ctx, item, &v, screen, inner)].concat());
    out
}
