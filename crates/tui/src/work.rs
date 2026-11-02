//! Task-tree presentation from the loaded task resource; no executor control.
use crate::{layout::*, model::*, render::*};
use serde_json::Value as V;
pub fn skipped(d: &V, w: usize) -> Vec<Row> {
    if d["managedSkip"].is_null() || !d["work"].is_null() {
        return vec![];
    }
    let reason = match text(&d["managedSkip"]["reason"]) {
        "interactive" => {
            "its executor runs in an interactive session, where pacer cannot block sub-agents."
        }
        "unsupported" => "its executors cannot have their own sub-agents blocked yet.",
        "unverified" => "pacer has not confirmed it can block sub-agents for its executors yet.",
        "refused" => {
            "pacer could not confirm sub-agent control when the task started, so it runs on its own."
        }
        _ => "no executor that pacer can check for sub-agent control is available.",
    };
    wrap(&format!("Can't coordinate sub-agents here: {reason}"), w, 2)
        .into_iter()
        .map(|s| Row::new(line(s)))
        .collect()
}
pub fn rows(d: &V, w: usize) -> Vec<Row> {
    if d["work"].is_null() {
        return vec![];
    }
    let tree = &d["workTree"];
    let mut rows = vec![h("Work tree", None, None)];
    if truth(&d["work"]["allowDelegation"]) {
        rows.extend(
            wrap("This task can coordinate sub-agents.", w, 2)
                .into_iter()
                .map(|s| Row::new(line(s))),
        );
    }
    if tree.is_null() {
        rows.push(Row::new(line("Work history unavailable")));
        return rows;
    }
    let totals = &tree["totals"];
    rows.push(Row::new(line(format!(
        "{} tasks · {} running · {} queued · {} s recorded",
        js_string(&totals["tasks"]),
        js_string(&totals["running"]),
        js_string(&totals["queued"]),
        round(num(&totals["executionSeconds"]))
    ))));
    let duration = |v: &V| {
        if v.is_null() {
            "unknown".into()
        } else {
            format!("{} s", round(num(v)))
        }
    };
    rows.push(Row::new(line(format!(
        "Dependency wait {} · child wait {} · capacity wait {}",
        duration(&totals["dependencyWaitSeconds"]),
        duration(&totals["childWaitSeconds"]),
        duration(&totals["capacityWaitSeconds"])
    ))));
    for pool in arr(&totals["usagePools"]) {
        let usage = if pool["observedDeltaPct"].is_null() {
            "usage unknown".into()
        } else {
            format!(
                "{}% observed shared usage",
                ryu_js::Buffer::new().format_to_fixed(num(&pool["observedDeltaPct"]), 1)
            )
        };
        rows.push(Row::new(line(format!(
            "{}: {usage}{}",
            text(&pool["account"]),
            if truth(&pool["unknownAttempts"]) {
                format!(" · {} unmeasured", js_string(&pool["unknownAttempts"]))
            } else {
                String::new()
            }
        ))));
    }
    for node in arr(&tree["nodes"]) {
        let depth = num(&node["depth"]) as usize;
        let prefix = format!(
            "{}{}",
            "  ".repeat(depth.min(6)),
            if depth > 0 { "↳ " } else { "" }
        );
        let status = status(node).concat();
        let status = status.split_once(' ').map(|(_, s)| s).unwrap_or(&status);
        let review = if node["review"].is_null() {
            ""
        } else if truth(&node["review"]["accepted"]) {
            " · accepted"
        } else {
            " · rejected"
        };
        let text = format!(
            "{prefix}{} · {status}{review}{}{}",
            text(&node["title"]),
            if truth(&node["model"]) {
                format!(" · requested {}", text(&node["model"]))
            } else {
                " · model unknown".into()
            },
            if truth(&node["actualModel"]) {
                format!(" · observed {}", text(&node["actualModel"]))
            } else {
                String::new()
            }
        );
        rows.extend(wrap(&text, w, 2).into_iter().map(|s| Row::new(line(s))));
        let indent = "  ".repeat((depth + 1).min(7));
        if !arr(&node["dependencies"]).is_empty() {
            rows.push(Row::new(line(format!(
                "{indent}depends on {}",
                arr(&node["dependencies"])
                    .iter()
                    .map(crate::model::text)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))));
        }
        if truth(&node["retryEligibility"]["reason"])
            && matches!(
                crate::model::text(&node["state"]),
                "failed" | "partial" | "limit" | "stopped" | "needs_input"
            )
        {
            rows.push(Row::new(line(format!(
                "{indent}Retry unavailable: {}",
                crate::model::text(&node["retryEligibility"]["reason"])
            ))));
        }
        for decision in arr(&node["decisions"]) {
            let choices = arr(&decision["proposal"]["choices"]);
            let choice = choices
                .iter()
                .find(|c| c["id"] == decision["selectedCandidateId"])
                .or(choices.first())
                .unwrap_or(&V::Null);
            let attempt = arr(&node["attempts"])
                .get((num(&decision["attempt"]) as usize).saturating_sub(1))
                .unwrap_or(&V::Null);
            let text = format!(
                "{indent}attempt {}: {} · {} · requested {} · observed {}{}",
                js_string(&decision["attempt"]),
                crate::model::text(&decision["engine"]["id"]),
                choice["reason"].as_str().unwrap_or("no selection"),
                attempt["model"].as_str().unwrap_or("unknown"),
                attempt["actualModel"].as_str().unwrap_or("unknown"),
                if truth(&decision["fallback"]) {
                    format!(
                        " · fallback {}",
                        crate::model::text(&decision["fallback"]["reason"])
                    )
                } else {
                    String::new()
                }
            );
            rows.extend(wrap(&text, w, 2).into_iter().map(|s| Row::new(line(s))));
        }
    }
    rows
}
