//! Read-only presentation helpers over wire snapshots. No service access or state writes.
use crate::js_whitespace;
use crate::layout::*;
use chrono::{DateTime, Datelike, Utc};
use serde_json::Value as V;
pub fn text(v: &V) -> &str {
    v.as_str().unwrap_or("")
}
pub fn arr(v: &V) -> &[V] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
pub fn num(v: &V) -> f64 {
    v.as_f64().unwrap_or(0.)
}
pub fn truth(v: &V) -> bool {
    match v {
        V::Null => false,
        V::Bool(b) => *b,
        V::String(s) => !s.is_empty(),
        V::Number(_) => num(v) != 0.,
        _ => true,
    }
}
pub fn js_number(v: &V) -> f64 {
    match v {
        V::Null => 0.,
        V::Bool(b) => {
            if *b {
                1.
            } else {
                0.
            }
        }
        V::Number(_) => num(v),
        V::Array(_) => js_number(&V::String(js_string(v))),
        V::Object(_) => f64::NAN,
        V::String(s) => {
            let s = s.trim_matches(js_whitespace);
            if s.is_empty() {
                return 0.;
            }
            for (lower, upper, radix) in [("0x", "0X", 16), ("0b", "0B", 2), ("0o", "0O", 8)] {
                if let Some(digits) = s.strip_prefix(lower).or_else(|| s.strip_prefix(upper)) {
                    if digits.is_empty() {
                        return f64::NAN;
                    }
                    // Bun/JavaScriptCore accumulates overflowing radix strings
                    // from the least significant digit. Preserve its intermediate
                    // rounding, rather than rounding an exact integer once.
                    if !digits.chars().all(|c| c.is_ascii() && c.is_digit(radix)) {
                        return f64::NAN;
                    }
                    let mut value = 0.;
                    let mut multiplier = 1f64;
                    for ch in digits.chars().rev() {
                        let digit = ch.to_digit(radix).unwrap_or(0) as f64;
                        if multiplier.is_infinite() {
                            if digit != 0. {
                                return f64::INFINITY;
                            }
                        } else {
                            value += digit * multiplier;
                        }
                        multiplier *= radix as f64;
                    }
                    return value;
                }
            }
            if matches!(s, "Infinity" | "+Infinity") {
                return f64::INFINITY;
            }
            if s == "-Infinity" {
                return f64::NEG_INFINITY;
            }
            if !s
                .bytes()
                .all(|c| c.is_ascii_digit() || matches!(c, b'+' | b'-' | b'.' | b'e' | b'E'))
            {
                return f64::NAN;
            }
            s.parse().unwrap_or(f64::NAN)
        }
    }
}
pub fn js_string(v: &V) -> String {
    match v {
        V::String(s) => s.clone(),
        V::Null => "null".into(),
        V::Bool(b) => b.to_string(),
        V::Number(_) => number(num(v)),
        V::Array(items) => items
            .iter()
            .map(|v| {
                if v.is_null() {
                    String::new()
                } else {
                    js_string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        V::Object(_) => "[object Object]".into(),
    }
}
pub fn number(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_string()
}
pub fn js_round(n: f64) -> f64 {
    let base = n.floor();
    if n - base < 0.5 { base } else { base + 1. }
}
pub fn round(n: f64) -> String {
    number(js_round(n))
}
pub fn fallback<'a>(v: &'a V, other: &'a V) -> &'a V {
    if v.is_null() { other } else { v }
}
pub fn elapsed(s: f64) -> String {
    let m = (s / 60.).floor().max(0.);
    if m >= 60. {
        let minutes = number(m % 60.);
        format!(
            "{}h {}{minutes}m",
            number((m / 60.).floor()),
            if minutes.len() < 2 { "0" } else { "" }
        )
    } else {
        format!("{}m", number(m))
    }
}
pub fn ago(at: f64, now: f64) -> String {
    let s = (now - at).floor().max(0.);
    if s < 60. {
        format!("{}s ago", number(s))
    } else if s < 3600. {
        format!("{}m ago", number((s / 60.).floor()))
    } else if s < 86400. {
        format!("{}h ago", number((s / 3600.).floor()))
    } else {
        format!("{}d ago", number((s / 86400.).floor()))
    }
}
pub fn clock(at: f64, now: f64) -> String {
    let Some(d) = DateTime::<Utc>::from_timestamp_millis((at * 1000.).trunc() as i64) else {
        return "Invalid Date".into();
    };
    let Some(n) = DateTime::<Utc>::from_timestamp_millis((now * 1000.).trunc() as i64) else {
        return "Invalid Date".into();
    };
    let days = (n.date_naive() - d.date_naive()).num_days();
    let time = d.format("%H:%M");
    if days == 0 {
        time.to_string()
    } else if days == 1 {
        format!("Yesterday {time}")
    } else if days > 1 && days < 7 {
        format!("{} {time}", d.format("%a"))
    } else if d.year() == n.year() {
        format!("{} {time}", d.format("%-d %b"))
    } else {
        format!("{} {time}", d.format("%-d %b %Y"))
    }
}
pub fn agent(s: &str) -> &str {
    match s {
        "claude" | "claude-code" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "agy" | "antigravity" => "Antigravity",
        "byteplus" => "BytePlus",
        "local" => "Local model",
        "opencode" => "OpenCode",
        "gemini" => "Gemini",
        _ => s,
    }
}
pub fn executor(id: &str, accounts: &V) -> String {
    if id.is_empty() {
        return "Automatic".into();
    }
    let mut parts = id.split('@');
    let local = parts.next().unwrap_or("");
    let host = parts.next().unwrap_or("");
    let mut parts = local.split('#');
    let a = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    let account = arr(accounts).iter().find(|x| {
        text(&x["name"]) == name
            || arr(fallback(&x["runners"], &x["executors"]))
                .iter()
                .any(|x| text(x) == id)
    });
    let default = account.is_some_and(|x| {
        text(&x["source"]) == "default"
            || (a == "codex" && text(&x["folder"]).ends_with("/.codex"))
            || (a == "claude-code" && text(&x["folder"]).ends_with("/.claude"))
    });
    let label = if a == "opencode" {
        agent(
            account
                .map(|x| text(&x["name"]))
                .filter(|s| !s.is_empty())
                .unwrap_or(if name.is_empty() { "opencode" } else { name }),
        )
        .to_string()
    } else {
        format!(
            "{}{}",
            agent(a),
            if !name.is_empty() && !default {
                format!(" · {}", account.map(|x| text(&x["name"])).unwrap_or(name))
            } else {
                String::new()
            }
        )
    };
    format!(
        "{label}{}",
        if host.is_empty() {
            String::new()
        } else {
            format!(" on {host}")
        }
    )
}
pub fn title(t: &V) -> String {
    crate::titles::title(t)
}

pub fn status(t: &V) -> Line {
    let state = text(&t["state"]);
    let phase = text(fallback(&t["progress"]["phase"], &t["phase"]));
    if state == "running" {
        if text(&t["interactionMode"]) == "conversation" {
            match text(&t["conversation"]["activity"]) {
                "idle" => return line("… Ready for input"),
                "waiting" => return line("? Needs input"),
                "working" => return line("▶ Working"),
                _ => {}
            }
        }
        let s = match phase {
            "driving" => "▶ You're driving",
            "starting" => "▶ Starting",
            "working" => "▶ Editing",
            "testing" => "▶ Testing",
            "idle" => "… Idle",
            "lost-contact" => "! Lost contact",
            _ => "▶ Working",
        };
        return line(s);
    }
    line(match state {
        "needs_input" => "! Needs your answer",
        "queued" => "… Queued",
        "done" => "✓ Completed",
        "partial" => "! Incomplete",
        "failed" => "✕ Failed",
        "limit" => "! Out of quota",
        "stopped" => "■ Stopped",
        _ => "? Unknown",
    })
}
pub fn outcome(t: &V) -> Line {
    line(if t["review"].is_null() {
        "— Outcome not recorded"
    } else if truth(&t["review"]["accepted"]) {
        "✓ Accepted"
    } else {
        "✕ Rejected"
    })
}
pub fn pace(s: &str) -> Line {
    line(match s {
        "behind" | "BEHIND" => "↓ Behind pace",
        "on_pace" | "ON_PACE" | "OK" => "✓ On pace",
        "ahead" | "AHEAD" | "NEAR_LIMIT" => "↑ Ahead of pace",
        "out" | "EXHAUSTED" => "! Out of quota",
        "UNMETERED" => "∞ Unmetered",
        "EXPIRING" | "EXPIRING_SOON" => "! Expiring soon",
        _ => "? Usage unknown",
    })
}
pub fn task<'a>(s: &'a V, id: &str) -> Option<&'a V> {
    arr(&s["tasks"]).iter().find(|t| text(&t["id"]) == id)
}
pub fn attention_status(a: &V, s: &V) -> Line {
    let kind = text(&a["kind"]);
    let t = task(s, text(&a["taskId"]));
    if kind == "review" {
        return line("◐ Review requested");
    }
    if kind == "message" {
        return line("! Waiting on you");
    }
    if let Some(t) = t {
        if kind == "failed"
            && (text(&t["state"]) == "done" || text(&t["acceptanceState"]) == "failed")
        {
            return line("✕ Checks failed");
        }
        return status(t);
    }
    line(match kind {
        "question" => "! Needs your answer",
        "failed" => "✕ Failed",
        "limit" => "! Out of quota",
        "host_down" | "executor_down" => "✕ Unavailable",
        "stuck" => "… Idle",
        _ => "! Needs attention",
    })
}
pub fn in_scope(t: &V, scope: &str) -> bool {
    scope.is_empty() || t["repo"].is_null() || text(&t["repo"]["key"]) == scope
}
pub fn needs(s: &V, scope: &str) -> Vec<V> {
    arr(&s["attention"]).iter().filter_map(|a| {
        if num(&a["snoozedUntil"]) > num(&s["at"]) || !in_scope(a, scope) {
            return None;
        }
        let mut a = a.clone();
        if a["kind"] == "review" && let Some(t) = task(s, text(&a["taskId"])) {
            if ["review", "resolved", "dismissed", "retriedBy"].iter().any(|k| truth(&t[k])) {
                return None;
            }
            if t["state"] == "partial" || t["acceptanceState"] == "failed" {
                let failed = t["acceptanceState"] == "failed";
                a["kind"] = "failed".into();
                a["severity"] = "problem".into();
                a["detail"] = if failed { "Acceptance checks failed" } else { "Execution is incomplete" }.into();
                a["actions"] = serde_json::json!([{
                    "label": if failed { "Inspect failures" } else { "Inspect incomplete work" },
                    "op": "ui.open", "params": { "view": "task", "id": t["id"] },
                }]);
            } else if t["state"] == "done" && !truth(&t["reviewRequest"]) {
                return None;
            }
        }
        Some(a)
    }).collect()
}
pub fn active(t: &V) -> bool {
    matches!(text(&t["state"]), "running" | "queued")
}
pub fn running<'a>(s: &'a V, scope: &str) -> Vec<&'a V> {
    arr(&s["tasks"])
        .iter()
        .filter(|t| active(t) && !truth(&t["dismissed"]) && in_scope(t, scope))
        .collect()
}
pub fn eligibility(e: &V, now: f64) -> (Line, String, Option<String>) {
    let d = &e["eligibility"];
    if d.is_null() {
        if e["state"] == "ready" && truth(&e["enabled"]) && !truth(&e["untested"]) {
            return (
                line("? Eligibility unknown"),
                "No execution decision is available".into(),
                None,
            );
        }
        let (label, glyph) = if !truth(&e["enabled"]) {
            ("Disabled", "■")
        } else {
            match text(&e["state"]) {
                "ready" if truth(&e["untested"]) => ("Not tested", "…"),
                "checking" => ("Checking", "…"),
                "busy" => ("Busy", "▶"),
                "failing"
                    if e["lastCheck"]["passed"] != false && num(&e["recentFailures"]) >= 2. =>
                {
                    ("Recent task failures", "!")
                }
                "failing" => ("Failing", "!"),
                "down" => ("Unavailable", "✕"),
                "blocked" => ("Blocked", "■"),
                "disabled" => ("Disabled", "■"),
                "full" => ("At capacity", "■"),
                "exhausted" => ("Out of quota", "!"),
                _ => ("Unknown", "?"),
            }
        };
        return (
            line(format!("{glyph} {label}")),
            if truth(&e["reason"]) {
                text(&e["reason"]).into()
            } else {
                "No execution decision is available".into()
            },
            None,
        );
    }
    let age = if d["evidenceAgeS"].is_null() {
        None
    } else {
        let n = (num(&d["evidenceAgeS"]) + now - num(&d["evaluatedAt"])).max(0.);
        Some(format!(
            "observed {} ago",
            if n < 60. {
                format!("{}s", n.floor())
            } else if n < 3600. {
                format!("{}m", (n / 60.).floor())
            } else {
                format!("{}h", (n / 3600.).floor())
            }
        ))
    };
    let (label, detail) = match text(&d["state"]) {
        "ineligible" => (
            "! Unavailable",
            arr(&d["reasons"])
                .iter()
                .map(|r| eligibility_reason(text(&r["code"])))
                .collect::<Vec<_>>()
                .join("; "),
        ),
        "uncertain" => (
            "? Uncertain fallback",
            arr(&d["reasons"])
                .iter()
                .map(|r| eligibility_reason(text(&r["code"])))
                .collect::<Vec<_>>()
                .join("; "),
        ),
        _ => (
            "✓ Eligible",
            if text(&d["budget"]) == "exhausted" {
                "Paid execution allowed"
            } else {
                "Execution permitted"
            }
            .into(),
        ),
    };
    let mut parts = vec![detail];
    if truth(&e["untested"]) {
        parts.push("Not tested".into());
    }
    if e["state"] == "failing" {
        parts.push(
            if e["lastCheck"]["passed"] != false && num(&e["recentFailures"]) >= 2. {
                "Recent task failures".into()
            } else {
                "Failing".into()
            },
        );
        if truth(&e["reason"]) {
            parts.push(text(&e["reason"]).into());
        }
    }
    (
        line(label),
        parts
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · "),
        age,
    )
}
pub fn account_freshness(a: &V, now: f64) -> Option<String> {
    let captured = &a["capturedAt"];
    let historical = (!a["usedPct"].is_null() || !a["spendUsdWeek"].is_null())
        && (a["stale"] != false
            || a["eligibility"]["budget"] == "unknown"
            || captured.is_null()
            || !num(captured).is_finite()
            || num(captured) > now
            || (!a["resetsAt"].is_null() && num(&a["resetsAt"]) <= now)
            || (!captured.is_null() && now - num(captured) > 86400.));
    if !historical {
        return None;
    }
    Some(
        if captured.is_null()
            || !num(captured).is_finite()
            || num(captured) > now
            || a["eligibility"].is_null()
        {
            "Stale reading · check account usage".into()
        } else {
            let age = (now - num(captured)).max(0.);
            format!(
                "Reading {} old",
                if age < 60. {
                    format!("{}s", number(age.floor()))
                } else if age < 3600. {
                    format!("{}m", number((age / 60.).floor()))
                } else {
                    format!("{}h", number((age / 3600.).floor()))
                }
            )
        },
    )
}
pub fn capacity_note(e: &V, s: &V) -> Option<String> {
    if !truth(&e["limitedBy"]) {
        return None;
    }
    let m = &s["machine"];
    let cap = if e["limitedBy"] == "machine" {
        if m.is_null() || truth(&m["unlimited"]) {
            &V::Null
        } else if let Some(cap) = m.get("hardCap") {
            cap
        } else if num(&m["max"]) >= 9007199254740991. {
            &V::Null
        } else {
            &m["max"]
        }
    } else {
        arr(&s["hosts"])
            .iter()
            .find(|h| h["alias"] == e["host"])
            .map(|h| &h["maxTasks"])
            .unwrap_or(&V::Null)
    };
    let place = if e["limitedBy"] == "machine" {
        "this machine"
    } else {
        e["host"].as_str().unwrap_or("this host")
    };
    Some(if cap.is_null() {
        format!("Limited by {place}")
    } else {
        format!("Limited to {} by {place}", js_string(cap))
    })
}
fn eligibility_reason(s: &str) -> &str {
    match s {
        "budget_exhausted" => "Budget exhausted; paid execution is not allowed",
        "budget_missing" => "No budget observation is available",
        "budget_expired_or_unknown" => "Budget evidence has expired or is incomplete",
        "evidence_conflicting" => "Current observations disagree",
        "evidence_missing" => "Execution evidence is missing",
        "availability_unknown" => "Executor availability is not confirmed",
        "subscription_missing" => "No active subscription",
        "subscription_failed" => "Subscription is unavailable",
        "subscription_response_invalid" => "Subscription status could not be read",
        "authentication_failed" | "signed_out" => "Sign-in is required",
        "refresh_failed" => "Could not refresh execution evidence",
        "disabled" => "Disabled",
        "not_installed" => "Not installed",
        "blocked" => "Blocked by you",
        "broken" => "Executor is not working",
        "unavailable" => "Executor is unavailable",
        "planner" => "Reserved for planning",
        "not_configured" => "Not configured",
        "quota_failure" => "The executor reported a quota limit",
        _ => "Execution evidence needs attention",
    }
}
pub fn reason(s: &str) -> String {
    if let Some(label) = reason_label(s) {
        return label.into();
    }
    if let Some((state, usage)) = s.split_once(", used ") {
        let (used, pace) = usage
            .split_once("% / pace ")
            .map_or((usage, None), |(u, p)| (u, Some(p)));
        let used = if pace.is_some() {
            Some(used)
        } else {
            used.strip_suffix('%')
        };
        let valid = |s: &str| {
            let mut parts = s.split('.');
            let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
            digits(parts.next().unwrap_or(""))
                && parts.next().is_none_or(digits)
                && parts.next().is_none()
        };
        if let Some(used) = used.filter(|s| valid(s)) {
            let parsed_pace = match pace {
                None => Some(None),
                Some(s) => s.strip_suffix('%').filter(|s| valid(s)).map(Some),
            };
            if !state.is_empty()
                && state.bytes().all(|c| c.is_ascii_lowercase() || c == b' ')
                && let Some(label) = reason_label(state)
                && let Some(pace) = parsed_pace
            {
                return format!(
                    "{label} · {}% of quota used{}",
                    round(js_number(&V::String(used.into()))),
                    pace.map_or(String::new(), |p| format!(
                        " (planned {}%)",
                        round(js_number(&V::String(p.into())))
                    ))
                );
            }
        }
    }
    if s.contains("; ") {
        return s.split("; ").map(reason).collect::<Vec<_>>().join("; ");
    }
    if let Some(id) = s.strip_suffix(" busy").filter(|s| !s.is_empty()) {
        return format!("{} is busy", executor(id, &V::Null));
    }
    if s.is_empty() {
        "Routing details not recorded"
    } else {
        "Routing details available"
    }
    .into()
}
fn reason_label(s: &str) -> Option<&'static str> {
    Some(match s {
        "available" => "Available",
        "ok" => "Available capacity",
        "over budget" => "Quota budget reached",
        "not signed in" | "signed out" => "Sign-in needed",
        "Best available capacity" => "Best available capacity",
        "unknown" => "Usage not available",
        "unmetered" => "No quota limit",
        "on pace" => "On pace",
        "behind" => "Capacity available before reset",
        "ahead" => "Ahead of quota pace",
        "expiring" => "Quota resets soon",
        "near limit" => "Near quota limit",
        "exhausted" => "Out of quota",
        "busy" => "Busy with another task",
        "full" => "At capacity",
        "planner" => "Reserved for planning",
        "disabled" => "Turned off",
        "not configured" => "Setup needed",
        "not installed" => "Agent needs installing",
        "Blocked by you" => "Paused by you",
        _ => return None,
    })
}
pub fn cost(v: &V) -> String {
    let account = executor(text(&v["account"]), &V::Null);
    if v["deltaPct"].is_null() {
        return format!(
            "{account} · {}",
            if v["reason"] == "shared" {
                "quota shared with other runs; individual usage unavailable"
            } else {
                "quota readings unavailable"
            }
        );
    }
    let delta = num(&v["deltaPct"]);
    if delta == 0. {
        return format!("{account} · no measured quota increase");
    }
    let window = match text(&v["window"]) {
        "weekly" | "week" => "weekly quota",
        "daily" | "day" => "daily quota",
        "session" => "session quota",
        "5h" => "five-hour quota",
        _ => "quota",
    };
    format!("{account} · used {}% of {window}", round(delta))
}
