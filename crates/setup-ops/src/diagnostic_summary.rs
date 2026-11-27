//! `diagnosticSummary` of `src/view-model/diagnostics.ts`: the plain-language line the
//! setup gate shows for a doctor check. Patterns keep JavaScript's ASCII `\w` and `\b`.
use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

fn pattern(text: &str) -> Regex {
    #[allow(clippy::expect_used)]
    Regex::new(text).expect("fixed diagnostic pattern")
}

static LINK_MAX: LazyLock<Regex> = LazyLock::new(|| pattern(r"max ([0-9.]+) ms"));
static TECHNICAL: LazyLock<Regex> = LazyLock::new(|| {
    pattern(
        r"--(?-u:[\w-])+|/v[0-9]/|(?-u:\b)[A-Z_]+=[^ ]|/(?:Users|Volumes|home)/|(?-u:\b\w*)Error:",
    )
});
static PENDING: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)timed out|permission[^\n\r\x{2028}\x{2029}]*pending"));
static DENIED: LazyLock<Regex> =
    LazyLock::new(|| pattern(r"(?i)access denied|operation not permitted|permission denied"));
static STALE: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)stale usage"));
static UNSIGNED: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)code object is not signed"));
static PERMISSION: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)permission|access denied"));
static MISSING: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)not found|ENOENT|missing"));
static TIMEOUT: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)timeout|timed out"));
static REFUSED: LazyLock<Regex> = LazyLock::new(|| pattern(r"(?i)connection refused|unavailable"));

fn state_dump(detail: &str) -> bool {
    detail.contains("installed: true") || detail.contains("installed: false")
}

fn service_summary(detail: &str) -> String {
    let problems: Vec<&str> = [
        ("installed: false", "The service is not installed"),
        ("running: false", "The service is not running"),
        (
            "healthy: false",
            "The service did not pass its health check",
        ),
        (
            "binary matches current: false",
            "The service uses a different installed version",
        ),
    ]
    .into_iter()
    .filter(|(flag, _)| detail.contains(flag))
    .map(|(_, message)| message)
    .collect();
    if problems.is_empty() {
        "The installed service is running, healthy and uses the current version.".into()
    } else {
        format!("{}.", problems.join(". "))
    }
}

/// The fixed sentence for a known check, when its name and detail have one.
fn known(name: &str, detail: &str, level: &str, configured: bool) -> Option<String> {
    let ok = level == "ok";
    let pick = |yes: &str, no: &str| Some(if ok { yes } else { no }.to_owned());
    if name == "Service" && state_dump(detail) {
        return Some(service_summary(detail));
    }
    if name.starts_with("CLI ") {
        if detail.contains("missing launch flags") {
            return Some("The installed agent does not advertise required launch options.".into());
        }
        if detail.contains("--help failed") {
            return Some(
                "The agent’s help command failed, so launch compatibility could not be checked."
                    .into(),
            );
        }
    }
    if name.starts_with("Install ") || name.starts_with("Skill ") {
        return pick(
            "Managed integration files are intact. This does not verify a live agent session.",
            "Managed integration files are missing or changed.",
        );
    }
    if name.starts_with("Integration freshness ") && state_dump(detail) {
        return Some(
            if ok {
                "Installed integration files match this version of Pacer."
            } else if detail.contains("installed: false") {
                "The integration is not installed."
            } else {
                "The installed integration files are out of date or changed."
            }
            .to_owned(),
        );
    }
    if name == "Claude config folder" && detail.contains("Selected account settings:") {
        return Some(
            if level == "warn" {
                "The service’s account folder differs from the selected planner account."
            } else {
                "The selected account folder was found. A planner session may use different settings."
            }
            .to_owned(),
        );
    }
    if name == "Claude guard scope" {
        return Some("The delegation guard covers supported agent launches. Direct edits and some indirect launches are outside its coverage.".into());
    }
    if name == "Claude handler probes" && ok {
        return Some("The built-in handler tests passed in isolated fixtures. Live planner invocation remains unverified.".into());
    }
    if name == "Claude host invocation" {
        return Some("No live planner invocation evidence was collected. Configuration and fixture tests cannot confirm it.".into());
    }
    let hooks = name == "Claude hook configuration";
    let messages = name == "Claude message hooks";
    if (hooks || messages) && level == "warn" && configured {
        return Some("The hooks are configured, but the service’s account folder differs from the selected planner account.".into());
    }
    if hooks && (detail.contains("SessionStart") || detail.contains("PreToolUse")) {
        return pick(
            "Session context and delegation hooks are configured. Live invocation remains unverified.",
            "Required planner hooks are missing, disabled or point to a different integration.",
        );
    }
    if messages {
        return Some(
            if configured || detail.contains("message hooks are configured") {
                "Planner message hooks are configured."
            } else {
                "A planner message hook is missing or disabled."
            }
            .to_owned(),
        );
    }
    None
}

fn measured(name: &str, detail: &str) -> Option<String> {
    if name == "Link latency"
        && let Some(found) = LINK_MAX.captures(detail)
    {
        return Some(format!(
            "The slowest of three service reads took {} ms (target: under 50 ms).",
            &found[1]
        ));
    }
    if name == "macOS code signing" && UNSIGNED.is_match(detail) {
        return Some("The installed Pacer command has no code signature.".into());
    }
    if name == "Removable volume access" {
        if PENDING.is_match(detail) {
            return Some(
                "The volume access check timed out. A macOS permission prompt may be waiting."
                    .into(),
            );
        }
        if DENIED.is_match(detail) {
            return Some(
                "macOS denied access to a registered repository on a removable volume.".into(),
            );
        }
        if detail.ends_with("accessible") {
            return Some("The registered repository on the removable volume is accessible.".into());
        }
    }
    if name.starts_with("Usage ") {
        if detail == "UNKNOWN" {
            return Some("No usable budget reading is available.".into());
        }
        if STALE.is_match(detail) {
            return Some("The last budget reading is out of date.".into());
        }
        if ["OK", "AHEAD", "BEHIND", "EXHAUSTED"].contains(&detail) {
            return Some("A budget reading is available.".into());
        }
    }
    None
}

/// Plain messages keep their cause; only raw implementation output gets a summary.
fn technical(detail: &str) -> Option<&'static str> {
    if !TECHNICAL.is_match(detail) {
        return None;
    }
    Some(if PERMISSION.is_match(detail) {
        "Access was denied while running this check."
    } else if MISSING.is_match(detail) {
        "A required file or command could not be found."
    } else if TIMEOUT.is_match(detail) {
        "The check timed out before it could confirm the result."
    } else if REFUSED.is_match(detail) {
        "The service or integration could not be reached."
    } else {
        "The check returned technical output. Open Technical details for the reported result."
    })
}

pub fn diagnostic_summary(check: &Value) -> String {
    let text = |key: &str| check.get(key).and_then(Value::as_str).unwrap_or("");
    let (name, detail, level) = (text("name"), text("detail"), text("level"));
    known(name, detail, level, text("evidence") == "configured")
        .or_else(|| measured(name, detail))
        .or_else(|| technical(detail).map(str::to_owned))
        .unwrap_or_else(|| detail.to_owned())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    fn summary(name: &str, level: &str, detail: &str) -> String {
        diagnostic_summary(&json!({"name": name, "level": level, "detail": detail}))
    }

    #[test]
    fn service_state_dumps_read_as_sentences() {
        assert_eq!(
            summary(
                "Service",
                "warn",
                "installed: false; running: false; healthy: true; binary matches current: true"
            ),
            "The service is not installed. The service is not running."
        );
        assert_eq!(
            summary(
                "Service",
                "ok",
                "installed: true; running: true; healthy: true; binary matches current: true"
            ),
            "The installed service is running, healthy and uses the current version."
        );
    }

    #[test]
    fn raw_output_is_summarized_and_plain_text_is_kept() {
        assert_eq!(
            summary("Other", "warn", "TypeError: permission lost"),
            "Access was denied while running this check."
        );
        assert_eq!(
            summary("Other", "warn", "failed with --flag"),
            "The check returned technical output. Open Technical details for the reported result."
        );
        assert_eq!(summary("Other", "warn", "plain words"), "plain words");
        assert_eq!(
            summary("Link latency", "warn", "/v2/snapshot max 61.5 ms across 3"),
            "The slowest of three service reads took 61.5 ms (target: under 50 ms)."
        );
    }
}
