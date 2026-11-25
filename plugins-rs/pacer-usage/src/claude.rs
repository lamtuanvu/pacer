//! wasm-ready: uses only fs.read/fs.stat/fs.list/fs.readRange and usage.state (M3 E4).
//! Claude Code quota reader, port of `plugins/pacer-usage/claude.ts`.

use super::{ReaderContext, UsageReading, UsageSource, UsageWindow, empty_reading};
use crate::util::{is_obj, parse_ts, to_num};
use serde_json::Value;

fn seven_day(data: &Value) -> Option<&Value> {
    is_obj(data).then_some(data).and_then(|o| o.get("seven_day")).filter(|v| is_obj(v))
}

fn five_hour(data: &Value) -> Option<&Value> {
    is_obj(data).then_some(data).and_then(|o| o.get("five_hour")).filter(|v| is_obj(v))
}

/// `readClaude` (claude.ts:6-27): newest non-future status-file snapshot.
pub async fn read_claude(ctx: &ReaderContext<'_>) -> UsageReading {
    let mut candidates: Vec<Value> = Vec::new();
    for path in ctx.resources.map(|r| &r.claude_files).unwrap_or(&Vec::new()) {
        let Ok(Some((text, _mtime))) = ctx.io.read(path).await else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if is_obj(&value) {
            candidates.push(value);
        }
    }
    // Newest non-future snapshot wins; null timestamps sort to the back.
    candidates.sort_by(|a, b| {
        let at = parse_ts(a.get("captured_at").unwrap_or(&Value::Null)).unwrap_or(f64::NEG_INFINITY);
        let bt = parse_ts(b.get("captured_at").unwrap_or(&Value::Null)).unwrap_or(f64::NEG_INFINITY);
        bt.partial_cmp(&at).unwrap_or(std::cmp::Ordering::Equal)
    });
    let data = candidates
        .into_iter()
        .find(|d| {
            let at = parse_ts(d.get("captured_at").unwrap_or(&Value::Null));
            at.is_none_or(|a| a <= ctx.now)
        });
    let Some(data) = data else {
        let mut r = empty_reading(false);
        r.error = Some(
            "no Claude rate-limit data yet (the Claude Code status line writes it)".to_owned(),
        );
        return r;
    };
    let captured_at = parse_ts(data.get("captured_at").unwrap_or(&Value::Null));
    let mut windows: Vec<UsageWindow> = Vec::new();
    if let Some(wk) = seven_day(&data) {
        windows.push(UsageWindow {
            name: "weekly".to_owned(),
            used_pct: to_num(wk.get("used_percentage").unwrap_or(&Value::Null)),
            resets_at: parse_ts(wk.get("resets_at").unwrap_or(&Value::Null)),
            length_s: 7.0 * 86400.0,
            paced: true,
            stale: None,
        });
    }
    if let Some(fh) = five_hour(&data) {
        windows.push(UsageWindow {
            name: "5h".to_owned(),
            used_pct: to_num(fh.get("used_percentage").unwrap_or(&Value::Null)),
            resets_at: parse_ts(fh.get("resets_at").unwrap_or(&Value::Null)),
            length_s: 5.0 * 3600.0,
            paced: false,
            stale: None,
        });
    }
    let source = if data.get("source").and_then(Value::as_str) == Some("session-log") {
        UsageSource::SessionLog
    } else {
        UsageSource::StatusLine
    };
    UsageReading {
        windows,
        captured_at,
        stale: false,
        source: Some(source),
        ..Default::default()
    }
}