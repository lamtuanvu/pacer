//! The host's own summary of a turn's context, built through the same read
//! pipeline as the tools. Port of `src/assistant/digest.ts`.

use crate::assistant_ops::{redact::Redactor, tools::{ReadOps, run_read_tool}};
use pacer_foundation::Ctx;
use serde_json::Value;

/// At most ~2,000 tokens of summary.
pub const DIGEST_MAX_CHARS: usize = 8_000;

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() > max {
        let mut out: String = text.chars().take(max - 1).collect();
        out.push('…');
        out
    } else {
        text.to_owned()
    }
}

fn scope_line(scope: &Value) -> String {
    match scope.get("kind").and_then(Value::as_str) {
        Some("dispatch") => format!(
            "Scope: dispatch, last {} days.",
            scope.get("days").and_then(Value::as_f64).unwrap_or(0.0)
        ),
        Some("task") => format!(
            "Scope: task {}.",
            scope.get("id").and_then(Value::as_str).unwrap_or_default()
        ),
        _ => format!(
            "Scope: repository {}.",
            scope.get("repo").and_then(Value::as_str).unwrap_or_default()
        ),
    }
}

/// The chosen account's row of the `budget` tool, in plain words. Never a live
/// reading, and never a key: it comes from the already-redacted tool result.
fn budget_line(content: &str, account: Option<&str>) -> String {
    let view: Value = match serde_json::from_str(content) {
        Ok(view) => view,
        Err(_) => return "not readable.".to_owned(),
    };
    let accounts = view.get("accounts").and_then(Value::as_array);
    let row = account.and_then(|name| {
        accounts
            .and_then(|rows| rows.iter().find(|a| a["name"].as_str() == Some(name)))
    });
    let Some(row) = row else {
        return format!("{} has no cached reading.", account.unwrap_or("The chosen account"));
    };
    let name = account.unwrap_or("The chosen account");
    let mut facts: Vec<String> = Vec::new();
    if let Some(verdict) = row["verdict"].as_str() {
        facts.push(format!("verdict {verdict}"));
    }
    if let Some(used) = row["usedPct"].as_f64() {
        facts.push(format!("used {used}"));
    }
    if let Some(pace) = row["pacePct"].as_f64() {
        facts.push(format!("pace {pace}"));
    }
    if let Some(window) = row["window"].as_str() {
        facts.push(format!("window {window}"));
    }
    if let Some(resets) = row["resetsAt"].as_str() {
        facts.push(format!("resets {resets}"));
    } else if let Some(resets) = row["resetsAt"].as_i64() {
        facts.push(format!("resets {resets}"));
    }
    if row["stale"].as_bool() == Some(true) {
        facts.push("stale".to_owned());
    }
    if facts.is_empty() {
        format!("{name}: no cached reading.")
    } else {
        format!("{name}: {}.", facts.join(", "))
    }
}

/// Build the digest: a failing read leaves that part out, and the digest never
/// fails the turn.
pub async fn build_digest(
    ctx: &Ctx,
    scope: &Value,
    redactor: &Redactor,
    account: Option<&str>,
    reads: &mut dyn ReadOps,
) -> String {
    let mut parts = vec![scope_line(scope)];
    for (label, tool) in [("Snapshot", "snapshot"), ("Budget", "budget")] {
        let out = run_read_tool(ctx, tool, &serde_json::json!({}), scope, redactor, reads).await;
        if !out.ok {
            parts.push(format!("{label}: unavailable."));
            continue;
        }
        if label == "Budget" {
            parts.push(format!("Budget: {}", budget_line(&out.content, account)));
        } else {
            parts.push(format!("{label}: {}", out.content));
        }
    }
    clip(&parts.join("\n"), DIGEST_MAX_CHARS)
}
