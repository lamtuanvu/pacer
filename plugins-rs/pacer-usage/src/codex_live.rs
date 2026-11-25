//! Codex app-server quota probe, port of `plugins/pacer-usage/codex-live.ts`.
//! Subprocess-backed (via the host's `process.spawn` capability only).

use super::{ReaderContext, UsageReading, UsageSource, UsageWindow};
use crate::util::is_obj;
use serde_json::Value;

const ARGV: &[&str] = &["codex", "-s", "read-only", "-a", "never", "app-server"];
const TIMEOUT_MS: u64 = 10_000;

/// A codex rate-limit window, or `None` when malformed (codex-live.ts:5-12).
fn window(value: &Value) -> Option<UsageWindow> {
    if !is_obj(value) {
        return None;
    }
    let used_pct = value.get("usedPercent").and_then(Value::as_f64)?;
    if !used_pct.is_finite() || used_pct < 0.0 || used_pct > 100.0 {
        return None;
    }
    let minutes = value.get("windowDurationMins").and_then(Value::as_f64)?;
    if !minutes.is_finite() || minutes <= 0.0 {
        return None;
    }
    let resets_at = value
        .get("resetsAt")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite());
    let name = if minutes >= 10080.0 {
        "weekly".to_owned()
    } else {
        format!("{}h", (minutes / 60.0).round())
    };
    Some(UsageWindow {
        name,
        used_pct: Some(used_pct),
        resets_at,
        length_s: minutes * 60.0,
        paced: minutes >= 1440.0,
        stale: None,
    })
}

/// `readCodexLive` (codex-live.ts:14-26): a fixed read-only app-server probe.
pub async fn read_codex_live(ctx: &ReaderContext<'_>) -> UsageReading {
    let result = match ctx.io.run(ARGV, TIMEOUT_MS).await {
        Ok(r) => r,
        Err(_) => {
            return UsageReading {
                windows: Vec::new(),
                captured_at: None,
                stale: true,
                error: Some("Codex usage request failed".to_owned()),
                ..Default::default()
            };
        }
    };
    if result.timed_out || result.code != 0 {
        return UsageReading {
            windows: Vec::new(),
            captured_at: None,
            stale: true,
            error: Some(if result.timed_out {
                "Codex usage request timed out".to_owned()
            } else {
                "Codex usage request failed".to_owned()
            }),
            ..Default::default()
        };
    }
    let mut response: Option<Value> = None;
    for line in result.stdout.split('\n') {
        if line.is_empty() {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(line)
            && is_obj(&parsed)
            && parsed.get("id").and_then(Value::as_u64) == Some(2)
        {
            response = Some(parsed);
        }
    }
    let unavailable = |message: &str| UsageReading {
        windows: Vec::new(),
        captured_at: None,
        stale: true,
        error: Some(message.to_owned()),
        ..Default::default()
    };
    let Some(response) = response else {
        return unavailable("Codex usage unavailable");
    };
    // `!response || isObj(response.error)` (codex-live.ts:21).
    if response.get("error").map(is_obj).unwrap_or(false) {
        return unavailable("Codex usage unavailable");
    }
    let empty = Value::Object(Default::default());
    let payload = response
        .get("result")
        .filter(|v| is_obj(v))
        .cloned()
        .unwrap_or(empty.clone());
    let limits = payload
        .get("rateLimits")
        .filter(|v| is_obj(v))
        .cloned()
        .unwrap_or(empty);
    let mut windows = Vec::new();
    if let Some(p) = window(limits.get("primary").unwrap_or(&Value::Null)) {
        windows.push(p);
    }
    if let Some(s) = window(limits.get("secondary").unwrap_or(&Value::Null)) {
        windows.push(s);
    }
    if windows.is_empty() {
        UsageReading {
            windows: Vec::new(),
            captured_at: None,
            stale: true,
            error: Some("Codex returned no quota windows".to_owned()),
            ..Default::default()
        }
    } else {
        UsageReading {
            windows,
            captured_at: Some(ctx.now),
            stale: false,
            source: Some(UsageSource::ProviderCli),
            ..Default::default()
        }
    }
}