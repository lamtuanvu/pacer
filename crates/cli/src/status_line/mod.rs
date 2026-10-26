mod agents;
mod fields;
mod format;
mod runtime;
mod selectors;
mod words;
use agents::agent_info;
pub use fields::fields;
use format::{back_in, js_round, meter_text};
pub use runtime::run;
use serde_json::Value;
use words::{OFFLINE_WORDS, compact_verdict_words, mode_words, policy_words, tone_for};

pub fn fmt_reset(ts: Option<f64>, now: f64) -> String {
    let Some(ts) = ts.filter(|ts| *ts != 0.0) else {
        return String::new();
    };
    let Ok(timestamp) = jiff::Timestamp::from_second(ts.floor() as i64) else {
        return String::new();
    };
    let d = timestamp.to_zoned(jiff::tz::TimeZone::system());
    let hm = format!("{:02}:{:02}", d.hour(), d.minute());
    if ts - now < 20.0 * 3600.0 {
        format!("↻ {hm}")
    } else {
        let weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
            [d.weekday().to_monday_zero_offset() as usize];
        format!("↻ {weekday} {hm}")
    }
}

pub fn render(input: Option<&Value>, width: usize, color: bool) -> String {
    let f = fields(input);
    if f["online"] != true {
        return format!(
            "{} {OFFLINE_WORDS}",
            if color {
                "\x1b[2m▬┃\x1b[0m"
            } else {
                "▬┃"
            }
        );
    }
    if input.is_some_and(|s| s["disabled"] == true) {
        return "pacer off (PACER=off)".into();
    }
    let paint = |s: &str, hex: &str| -> String {
        if !color {
            return s.into();
        }
        let rgb: Vec<String> = hex
            .as_bytes()
            .chunks(2)
            .map(|c| {
                u8::from_str_radix(std::str::from_utf8(c).unwrap_or("00"), 16)
                    .unwrap_or(0)
                    .to_string()
            })
            .collect();
        format!("\x1b[38;2;{}m{s}\x1b[0m", rgb.join(";"))
    };
    let verdict = f["verdict"].as_str().unwrap_or("unknown");
    let tick = match tone_for(verdict) {
        "bad" => "fca5a5",
        "warn" => "fcd34d",
        "neutral" => "71717a",
        _ => "a3e635",
    };
    let mark = paint("▬", "a3e635") + &paint("┃", tick);
    let name = paint(
        f["planner"].as_str().unwrap_or_default(),
        agent_info(f["agent"].as_str().unwrap_or_default()).1,
    );
    let verdict = compact_verdict_words(verdict);
    let now = input
        .and_then(|s| s.get("at").or_else(|| s.get("generatedAt")))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let main = if verdict == "out" {
        let reset = f["resetsAt"].as_f64();
        format!(
            "out · {}",
            reset.map_or_else(
                || back_in(None, now),
                |_| format!(
                    "back {}",
                    fmt_reset(reset, now).chars().skip(2).collect::<String>()
                )
            )
        )
    } else {
        format!(
            "{}{}",
            meter_text(f["usedPct"].as_f64(), f["pacePct"].as_f64(), "compact"),
            if verdict.is_empty() {
                String::new()
            } else {
                format!(" {verdict}")
            }
        )
    };
    let used = f["usedPct"].as_f64().map_or_else(|| "?".into(), js_round);
    let running = if f["running"].is_null() {
        String::new()
    } else {
        paint(&format!("▸{}", f["running"]), "93c5fd")
    };
    let attention = if f["attention"].as_f64().is_some_and(|n| n != 0.0) {
        paint(&format!("⚑{}", f["attention"]), "fcd34d")
    } else {
        String::new()
    };
    let mode = f["mode"]
        .as_str()
        .filter(|m| *m != "normal")
        .map_or_else(String::new, |m| mode_words(m).to_lowercase());
    let suffix = |parts: &[&str]| {
        parts
            .iter()
            .filter(|s| !s.is_empty())
            .map(|s| format!("  {s}"))
            .collect::<String>()
    };
    let join = |parts: &[&str]| {
        parts
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ")
    };
    let policy = policy_words(&f["policy"], false);
    let compact_policy = policy_words(&f["policy"], true);
    let mark_used = format!("{mark}{used}");
    let stages = [
        format!(
            "{mark} {name} {main}{}",
            suffix(&[&policy, &running, &attention, &mode])
        ),
        format!(
            "{mark} {name} {main}{}",
            suffix(&[&policy, &running, &attention])
        ),
        join(&[&mark, &main, &policy, &running, &attention]),
        join(&[&mark, &used, &policy, &attention]),
        join(&[&mark, &used, &compact_policy, &attention]),
        join(&[&mark_used, &compact_policy, &attention]),
        join(&[&compact_policy, &attention]),
        join(&[&mark_used, &compact_policy]),
        join(&[&mark, &compact_policy]),
        compact_policy,
    ];
    let width = if width == 0 { 80 } else { width };
    let start = if width <= 20 {
        3
    } else if width <= 40 {
        2
    } else if width <= 60 {
        1
    } else {
        0
    };
    stages[start..]
        .iter()
        .find(|s| visible_len(s) <= width)
        .unwrap_or(&stages[stages.len() - 1])
        .clone()
}
fn visible_len(s: &str) -> usize {
    let mut chars = s.chars();
    let mut len = 0;
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            for c in chars.by_ref() {
                if c == 'm' {
                    break;
                }
            }
        } else {
            len += c.len_utf16();
        }
    }
    len
}
