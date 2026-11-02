//! Span boundaries matter: TS fits spans before painting, rather than clipping joined text.
use crate::{cell_width, clip, js_whitespace, safe_text};
pub type Line = Vec<String>;
pub fn line(s: impl Into<String>) -> Line {
    vec![safe_text(&s.into())]
}
pub fn width(l: &Line) -> usize {
    l.iter().map(|s| cell_width(s)).sum()
}
pub fn fit(l: &Line, w: usize) -> Line {
    if width(l) <= w {
        return l.clone();
    }
    let mut out = vec![];
    let mut remaining = w;
    for s in l {
        if remaining == 0 {
            break;
        }
        let n = cell_width(s);
        if n < remaining {
            out.push(s.clone());
            remaining -= n;
        } else {
            out.push(clip(&format!("{s} "), remaining, "…"));
            break;
        }
    }
    out
}
pub fn pad(l: &Line, w: usize) -> Line {
    let mut out = fit(l, w);
    let n = width(&out);
    if n < w {
        out.push(" ".repeat(w - n));
    }
    out
}
pub fn cols(c: Vec<(Line, usize, bool)>, gap: usize) -> Line {
    let mut out = vec![];
    for (i, (l, w, right)) in c.into_iter().enumerate() {
        if i > 0 {
            out.push(" ".repeat(gap));
        }
        let fitted = fit(&l, w);
        let room = w.saturating_sub(width(&fitted));
        if right && room > 0 {
            out.push(" ".repeat(room));
        }
        out.extend(fitted);
        if !right && room > 0 {
            out.push(" ".repeat(room));
        }
    }
    out
}
/// Positive entries are fixed; negative entries are flex weights, with optional minimums.
pub fn flex(total: usize, specs: &[(i32, usize)], gap: usize) -> Vec<usize> {
    let gaps = specs.len().saturating_sub(1) * gap;
    let fixed: usize = specs
        .iter()
        .filter(|(v, _)| *v >= 0)
        .map(|(v, _)| *v as usize)
        .sum();
    let weights: i32 = specs.iter().filter(|(v, _)| *v < 0).map(|(v, _)| -v).sum();
    let free = total.saturating_sub(fixed + gaps);
    let mut ws: Vec<usize> = specs
        .iter()
        .map(|(v, min)| {
            if *v >= 0 {
                *v as usize
            } else {
                (*min).max(free * (-v) as usize / weights.max(1) as usize)
            }
        })
        .collect();
    let used = ws.iter().sum::<usize>() + gaps;
    if let Some(i) = specs.iter().rposition(|(v, _)| *v < 0) {
        ws[i] = (ws[i] as isize + total as isize - used as isize).max(0) as usize;
    }
    ws
}
pub fn wrap(text: &str, w: usize, max: usize) -> Vec<String> {
    let mut lines = vec![];
    for p in text.split('\n') {
        let p = p.strip_suffix('\r').unwrap_or(p);
        let clean = safe_text(p);
        let mut current = String::new();
        for word in clean.split(js_whitespace).filter(|s| !s.is_empty()) {
            let candidate = if current.is_empty() {
                word.to_string()
            } else {
                format!("{current} {word}")
            };
            if cell_width(&candidate) <= w {
                current = candidate;
                continue;
            }
            if !current.is_empty() {
                lines.push(current);
            }
            current = if cell_width(word) > w {
                clip(word, w, "…")
            } else {
                word.into()
            };
        }
        lines.push(current);
    }
    if lines.len() > max && max > 0 {
        let rest = lines[max - 1..].join(" ");
        lines.truncate(max - 1);
        lines.push(clip(&rest, w, "…"));
    }
    lines
}
pub fn wrap_after(prefix: Line, text: &str, w: usize) -> Vec<Line> {
    let first = wrap(text, w.saturating_sub(width(&prefix)).max(8), usize::MAX);
    let mut row = prefix;
    row.push(first.first().cloned().unwrap_or_default());
    let mut rows = vec![row];
    let rest = first.get(1..).unwrap_or_default().join(" ");
    if !rest.is_empty() {
        rows.extend(wrap(&rest, w, usize::MAX).into_iter().map(line));
    }
    rows
}
pub fn heading(label: &str, count: Option<String>, note: Option<String>, separator: bool) -> Line {
    let mut l = line(label.to_uppercase());
    if let Some(c) = count {
        l.extend(["  ".into(), c]);
    }
    if let Some(n) = note.filter(|n| !n.is_empty()) {
        l.push(format!(" {}{n}", if separator { "· " } else { "" }));
    }
    l
}
pub fn meter(used: Option<f64>, pace: Option<f64>, size: usize) -> Line {
    let filled = used.map_or(0, |n| {
        crate::model::js_round(n.clamp(0., 100.) * size as f64 / 100.) as usize
    });
    let tick = pace.map(|n| {
        ((n.clamp(0., 100.) * size as f64 / 100.).floor() as usize).min(size.saturating_sub(1))
    });
    let mut out: Line = vec![];
    let mut last_kind = 3;
    for i in 0..size {
        let (s, k) = if Some(i) == tick {
            ("┃", 0)
        } else if i < filled {
            ("━", 1)
        } else {
            ("─", 2)
        };
        if k == last_kind {
            if let Some(last) = out.last_mut() {
                last.push_str(s);
            }
        } else {
            out.push(s.into());
        }
        last_kind = k;
    }
    out
}
pub fn boxed(title: &str, body: Vec<Line>, w: usize) -> Vec<Line> {
    let inner = w.saturating_sub(2);
    let label = clip(&format!(" {title} "), inner, "…");
    let mut out = vec![vec![
        "╭".into(),
        label.clone(),
        "─".repeat(inner.saturating_sub(cell_width(&label))),
        "╮".into(),
    ]];
    for row in body {
        let mut l = line("│ ");
        l.extend(pad(&row, w.saturating_sub(4)));
        l.push(" │".into());
        out.push(l);
    }
    out.push(line(format!("╰{}╯", "─".repeat(inner))));
    out
}
