//! wasm-ready: uses only fs.read/fs.stat/fs.list/fs.readRange and usage.state (M3 E4).
//! Codex session-log quota reader, port of `plugins/pacer-usage/codex.ts`.

use super::{ReaderContext, UsageReading, UsageSource, UsageWindow, empty_reading};
use crate::util::{is_obj, parse_ts, to_num};
use pacer_plugin::usage::{Cursor, CursorFiles, ReaderIo};
use pacer_plugin::PluginError;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const TAIL_BYTES: u64 = 4_000_000;
const MAX_FILES: usize = 15;
const CHUNK_BYTES: u64 = 256 * 1024;
const CURSOR_VERSION: u64 = 4;

/// A `rate_limits` block with the time it was observed (codex.ts:18).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct RateLimitObservation {
    #[serde(rename = "rateLimits", default, skip_serializing_if = "Value::is_null")]
    rate_limits: Value,
    #[serde(rename = "observedAt")]
    observed_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    alternatives: Vec<RateLimitObservation>,
}

/// The cursor aggregate: which observation won and where (codex.ts:44-48).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
struct RateAggregate {
    found: Option<RateLimitObservation>,
    position: i64,
    last: Option<RateLimitObservation>,
}

fn aggregate_to_value(agg: &RateAggregate) -> Value {
    serde_json::to_value(agg).unwrap_or(Value::Null)
}

fn value_to_aggregate(v: &Value) -> Option<RateAggregate> {
    serde_json::from_value(v.clone()).ok()
}

/// `findRateLimits` (codex.ts:7): a DFS for the first `rate_limits` object
/// that carries a primary window or a secondary object.
fn find_rate_limits(root: &Value) -> Option<Value> {
    let mut stack: Vec<&Value> = vec![root];
    while let Some(o) = stack.pop() {
        if let Value::Array(arr) = o {
            stack.extend(arr.iter());
        } else if is_obj(o) {
            if let Some(rl) = o.get("rate_limits").filter(|v| is_obj(v)) {
                let primary_ok = rl.get("primary").is_some_and(|p| !p.is_null());
                let secondary_ok = rl.get("secondary").is_some_and(is_obj);
                if primary_ok || secondary_ok {
                    return Some(rl.clone());
                }
            }
            if let Value::Object(map) = o {
                stack.extend(map.values());
            }
        }
    }
    None
}

/// `rateLimitObservation` (codex.ts:19-24).
fn rate_limit_observation(event: &Value) -> Option<RateLimitObservation> {
    let rate_limits = find_rate_limits(event)?;
    let observed_at = if is_obj(event) {
        parse_ts(event.get("timestamp").unwrap_or(&Value::Null))
    } else {
        None
    };
    Some(RateLimitObservation {
        rate_limits,
        observed_at,
        alternatives: Vec::new(),
    })
}

/// `newer` (codex.ts:25-34): at equal time, merge unique rate-limit
/// blocks (the last one wins, the rest become alternatives); otherwise
/// keep the observation with the larger (or only) timestamp.
fn newer(
    a: Option<RateLimitObservation>,
    b: Option<RateLimitObservation>,
) -> Option<RateLimitObservation> {
    let a = match a {
        None => return b,
        Some(a) => a,
    };
    let b = match b {
        None => return Some(a),
        Some(b) => b,
    };
    if a.observed_at == b.observed_at {
        let a_alts = a.alternatives.clone();
        let b_alts = b.alternatives.clone();
        let mut samples = vec![a];
        samples.extend(a_alts);
        samples.push(b);
        samples.extend(b_alts);
        let mut seen: HashSet<String> = HashSet::new();
        let mut unique: Vec<RateLimitObservation> = Vec::new();
        for sample in samples {
            let key = serde_json::to_string(&sample.rate_limits).unwrap_or_default();
            if seen.insert(key) {
                unique.push(sample);
            }
        }
        let last = unique.pop()?;
        let mut result = last;
        result.alternatives = unique;
        Some(result)
    } else {
        let bt = b.observed_at.unwrap_or(f64::NEG_INFINITY);
        let at = a.observed_at.unwrap_or(f64::NEG_INFINITY);
        if bt >= at {
            Some(b)
        } else {
            Some(a)
        }
    }
}

/// `readingFromObservation` (codex.ts:35-43).
fn reading_from_observation(observation: &RateLimitObservation) -> UsageReading {
    let mut reading = UsageReading {
        windows: windows_from_rate_limits(&observation.rate_limits, observation.observed_at),
        captured_at: observation.observed_at,
        stale: false,
        source: Some(UsageSource::SessionLog),
        ..Default::default()
    };
    if !observation.alternatives.is_empty() {
        reading.alternatives = Some(
            observation
                .alternatives
                .iter()
                .map(reading_from_observation)
                .collect(),
        );
    }
    if let Some(credits) = observation.rate_limits.get("credits").filter(|v| is_obj(v)) {
        let credit_balance = match credits.get("balance") {
            Some(Value::String(s)) => {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    t.parse::<f64>().ok()
                }
            }
            Some(other) => to_num(other),
            None => None,
        };
        reading.spending = Some(super::SpendingSignals {
            credits_available: credits.get("has_credits").and_then(Value::as_bool),
            credit_balance,
            paid_consumption: super::PaidConsumption::Unknown,
        });
    }
    reading
}

/// Shared conversion for local rollout files and the SSH session-log probe
/// (codex.ts:139-161).
pub fn windows_from_rate_limits(rl: &Value, observed_at: Option<f64>) -> Vec<UsageWindow> {
    let mut windows = Vec::new();
    for key in ["primary", "secondary"] {
        let Some(w) = rl.get(key).filter(|v| is_obj(v)) else {
            continue;
        };
        // A non-positive duration is not a usable window; drop it instead
        // of persisting an invalid 0-length artifact.
        let raw = to_num(w.get("window_minutes").unwrap_or(&Value::Null));
        let mins = raw.unwrap_or(10080.0);
        if !mins.is_finite() || mins <= 0.0 {
            continue;
        }
        let mut resets_at = parse_ts(w.get("resets_at").unwrap_or(&Value::Null));
        let in_s = to_num(w.get("resets_in_seconds").unwrap_or(&Value::Null));
        if resets_at.is_none()
            && let Some(in_s) = in_s
            && let Some(observed_at) = observed_at
        {
            resets_at = Some(observed_at + in_s);
        }
        windows.push(UsageWindow {
            name: if mins >= 7.0 * 1440.0 {
                "weekly".to_owned()
            } else {
                format!("{}h", (mins / 60.0).round())
            },
            used_pct: to_num(w.get("used_percent").unwrap_or(&Value::Null)),
            resets_at,
            length_s: mins * 60.0,
            paced: mins >= 1440.0,
            stale: None,
        });
    }
    windows
}

/// `reusable` (codex.ts:49-53).
fn reusable(cursor: Option<&Cursor>, info: &pacer_plugin::usage::FileInfo) -> bool {
    match cursor {
        None => false,
        Some(c) => {
            c.offset <= c.size
                && c.mtime.is_finite()
                && c.inode == info.inode
                && c.size <= info.size
                && (c.size != info.size || c.mtime == info.mtime_ms)
        }
    }
}

/// Decode a line the way `TextDecoder("utf-8",{ignoreBOM:true})` does:
/// `ignoreBOM` strips a BOM only when it is the very first chunk of the whole
/// stream, never a mid-stream, per-line-subarray decode. A leading byte-order
/// mark on a record is therefore left in the text, so `serde_json` fails and
/// the BOM-prefixed record is skipped exactly as TS `JSON.parse` skips it.
fn decode_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `incrementalRateLimits` (codex.ts:55-95): read only the tail and only
/// the lines not covered by a reusable cursor.
async fn incremental_rate_limits(
    io: &dyn ReaderIo,
    path: &str,
    previous: Option<Cursor>,
    now: f64,
) -> Result<Cursor, PluginError> {
    let Some(s) = io.stat(path).await? else {
        return Err(PluginError::new("ENOENT", "Codex log disappeared"));
    };
    let cached = if reusable(previous.as_ref(), &s) {
        previous
    } else {
        None
    };
    if let Some(cached) = &cached
        && cached.size == s.size {
            return Ok(cached.clone());
        }
    let tail = s.size.saturating_sub(TAIL_BYTES);
    let start = cached
        .as_ref()
        .map(|c| c.offset.max(tail))
        .unwrap_or(tail);
    let mut found = match cached.as_ref() {
        Some(c) => match value_to_aggregate(&c.aggregate) {
            Some(agg) if (agg.position as u64) >= tail => agg.found,
            _ => None,
        },
        None => None,
    };
    let mut position: i64 = match (&cached, &found) {
        (Some(c), Some(_)) => value_to_aggregate(&c.aggregate)
            .map(|agg| agg.position)
            .unwrap_or(-1),
        _ => -1,
    };
    let total = s.size - start;
    let mut bytes: Vec<u8> = Vec::with_capacity(total as usize);
    let mut read_len: u64 = 0;
    while read_len < total {
        let (part, _) = io
            .range(path, start + read_len, CHUNK_BYTES.min(total - read_len), &s)
            .await?;
        if part.is_empty() {
            break;
        }
        bytes.extend_from_slice(&part);
        read_len += part.len() as u64;
    }
    let readlen = bytes.len() as u64;
    let mut offset = start;
    let mut line_start: usize = 0;
    let mut last = found.clone();
    let mut i: u64 = 0;
    while i <= readlen {
        if i < readlen && bytes[i as usize] != 10 {
            i += 1;
            continue;
        }
        let text = decode_line(&bytes[line_start..i as usize]);
        let mut candidate: Option<RateLimitObservation> = None;
        if text.contains("\"rate_limits\"")
            && let Ok(v) = serde_json::from_str::<Value>(&text) {
                candidate = rate_limit_observation(&v);
            }
        if let Some(c) = &candidate
            && c.observed_at.is_some_and(|at| at > now) {
                candidate = None;
            }
        if i < readlen {
            if let Some(cand) = candidate {
                let merged = newer(found.clone(), Some(cand));
                let equal = merged == found;
                let equal_time = merged
                    .as_ref()
                    .and_then(|m| m.observed_at)
                    .is_some()
                    && merged.as_ref().and_then(|m| m.observed_at)
                        == found.as_ref().and_then(|f| f.observed_at);
                if !equal || equal_time {
                    found = merged;
                    position = (start + line_start as u64) as i64;
                }
            }
            offset = start + i + 1;
            last = found.clone();
        }
        line_start = i as usize + 1;
        i += 1;
    }
    Ok(Cursor {
        size: s.size,
        mtime: s.mtime_ms,
        inode: s.inode,
        offset,
        aggregate: aggregate_to_value(&RateAggregate {
            found,
            position,
            last,
        }),
        retained_since: None,
    })
}

/// The cursor validator for codex aggregates (readCodex, codex.ts:102-104).
fn valid_aggregate(v: &Value) -> bool {
    let Some(agg) = v.as_object() else {
        return false;
    };
    let found_ok = match agg.get("found") {
        Some(f) => f.is_null() || is_obj(f),
        None => false,
    };
    let last_ok = match agg.get("last") {
        Some(l) => l.is_null() || is_obj(l),
        None => false,
    };
    let position_ok = agg
        .get("position")
        .and_then(Value::as_f64)
        .is_some_and(|p| p.is_finite());
    found_ok && last_ok && position_ok
}

fn no_logs() -> UsageReading {
    let mut r = empty_reading(false);
    r.error = Some("no Codex session logs".to_owned());
    r
}

fn no_rate_limits() -> UsageReading {
    let mut r = empty_reading(false);
    r.error = Some("no rate_limits found in recent Codex session logs".to_owned());
    r
}

/// `readCodex` (codex.ts:97-136): newest rate-limits from recent Codex
/// session logs, with a cursor store keeping other account roots intact.
pub async fn read_codex(ctx: &ReaderContext<'_>) -> UsageReading {
    let Some(root) = ctx.resources.and_then(|r| r.codex_sessions.clone()) else {
        return no_logs();
    };
    match ctx.io.stat(&root).await {
        Ok(Some(_)) => {}
        _ => return no_logs(),
    }
    let files = match ctx.io.list(&root, "**/rollout-*.jsonl").await {
        Ok(files) => files,
        Err(_) => return no_logs(),
    };
    let mut files: Vec<_> = files
        .into_iter()
        .map(|info| (info.mtime_ms / 1000.0, info))
        .collect();
    files.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let now = ctx.now;

    // `cursors` takes a `for<'f> FnOnce` action whose returned future must be
    // valid for any borrow of the cursor store, so the action's future can
    // only capture owned data. Reading the tail needs `ctx.io`, which we route
    // by (1) loading the existing cursors with an owned-only action, (2)
    // updating them with `ctx` outside the higher-ranked closure, then (3)
    // writing the result back with another owned-only action.
    let current = match ctx
        .io
        .cursors(
            "codex-cursors",
            CURSOR_VERSION,
            &valid_aggregate,
            Box::new(|cursors: &mut CursorFiles| {
                Box::pin(async move {
                    let mut out = serde_json::Map::new();
                    for path in cursors.keys() {
                        if let Some(c) = cursors.get(path) {
                            out.insert(
                                path.clone(),
                                serde_json::to_value(c).unwrap_or(Value::Null),
                            );
                        }
                    }
                    Ok(serde_json::Value::Object(out))
                })
            }),
        )
        .await
    {
        Ok(v) => v,
        Err(_) => return no_rate_limits(),
    };

    let existing: std::collections::HashMap<String, Cursor> =
        match current.as_object() {
            Some(obj) => obj
                .iter()
                .filter_map(|(k, v)| {
                    serde_json::from_value::<Cursor>(v.clone())
                        .ok()
                        .map(|c| (k.clone(), c))
                })
                .collect(),
            _ => std::collections::HashMap::new(),
        };

    let prefix = root.clone() + "/";
    let live: HashSet<&String> = files
        .iter()
        .take(MAX_FILES)
        .map(|(_, f)| &f.path)
        .collect();
    let stale: Vec<String> = existing
        .keys()
        .filter(|k| k.starts_with(&prefix) && !live.contains(*k))
        .cloned()
        .collect();

    let mut new_cursors: Vec<(String, Cursor)> = Vec::new();
    let mut selected: Option<RateLimitObservation> = None;
    let mut samples: Vec<RateLimitObservation> = Vec::new();
    for (_, f) in files.iter().take(MAX_FILES) {
        let info = f;
        let cursor: Cursor = match existing.get(&info.path) {
            Some(previous) if reusable(Some(previous), info) && previous.size == info.size => {
                previous.clone()
            }
            _ => {
                let previous = existing.get(&info.path).cloned();
                match incremental_rate_limits(ctx.io, &info.path, previous, now).await {
                    Ok(c) => c,
                    Err(e) if e.code == "ENOENT" => continue,
                    Err(_) => continue,
                }
            }
        };
        new_cursors.push((info.path.clone(), cursor.clone()));
        let observation = match value_to_aggregate(&cursor.aggregate) {
            Some(agg) => agg.last,
            None => None,
        };
        if observation
            .as_ref()
            .and_then(|o| o.observed_at)
            .is_some_and(|at| at > now)
        {
            continue;
        }
        if let Some(o) = &observation {
            samples.push(o.clone());
        }
        selected = newer(selected, observation);
    }

    let reading = if let Some(sel) = &selected {
        let mut reading = reading_from_observation(sel);
        let mut extra: Vec<UsageReading> =
            reading.alternatives.clone().unwrap_or_default();
        extra.extend(
            samples
                .iter()
                .filter(|sample| sample.observed_at != sel.observed_at)
                .map(reading_from_observation),
        );
        reading.alternatives = Some(extra);
        reading
    } else {
        no_rate_limits()
    };
    let reading_value = serde_json::to_value(reading.clone()).unwrap_or(Value::Null);

    let store_result = ctx
        .io
        .cursors(
            "codex-cursors",
            CURSOR_VERSION,
            &valid_aggregate,
            Box::new(move |cursors: &mut CursorFiles| {
                Box::pin(async move {
                    for path in stale {
                        cursors.remove(&path);
                    }
                    for (path, cursor) in &new_cursors {
                        cursors.set(path, cursor.clone());
                    }
                    Ok(reading_value)
                })
            }),
        )
        .await;
    match store_result {
        Ok(value) => serde_json::from_value(value).unwrap_or(reading),
        Err(_) => reading,
    }
}
