//! The one status vocabulary (`src/view-model/words.ts`): a label table per
//! concept, so every Rust surface words a verdict or an eligibility reason the
//! same way TypeScript does.

/// The one verdict table (`verdictLabels`, `src/view-model/words.ts`, ADR 0030):
/// every label, tone and glyph a verdict can take, upper and legacy lower case.
#[derive(Clone, Copy)]
pub struct PaceStatus {
    pub label: &'static str,
    pub tone: &'static str,
    pub glyph: &'static str,
}

const fn entry(label: &'static str, tone: &'static str, glyph: &'static str) -> PaceStatus {
    PaceStatus { label, tone, glyph }
}

fn verdict_label(verdict: &str) -> Option<PaceStatus> {
    Some(match verdict {
        "EXHAUSTED" | "out" => entry("Out of quota", "bad", "!"),
        "NEAR_LIMIT" => entry("Near limit", "warn", "!"),
        "AHEAD" | "ahead" => entry("Ahead of pace", "warn", "↑"),
        "BEHIND" | "behind" => entry("Behind pace", "good", "↓"),
        "EXPIRING" | "EXPIRING_SOON" => entry("Expiring soon", "warn", "!"),
        "OK" => entry("Available", "good", "✓"),
        "ON_PACE" | "on_pace" => entry("On pace", "good", "✓"),
        "UNMETERED" => entry("Unmetered", "good", "∞"),
        "UNKNOWN" | "unknown" => entry("Usage unknown", "neutral", "?"),
        _ => return None,
    })
}

/// `verdictWords`: the table's label; anything else is `"Unknown"`.
pub fn verdict_words(verdict: &str) -> &'static str {
    verdict_label(verdict).map_or("Unknown", |v| v.label)
}

const UNKNOWN_PACE: PaceStatus = entry("Usage unknown", "neutral", "?");

/// `paceStatus`: older payload spellings map to their canonical fact, then the one table.
pub fn pace_status(verdict: &str) -> PaceStatus {
    let canonical = match verdict {
        "BEHIND" => "behind",
        "ON_PACE" => "on_pace",
        "AHEAD" => "ahead",
        "EXHAUSTED" => "out",
        other => other,
    };
    verdict_label(canonical).unwrap_or(UNKNOWN_PACE)
}

/// `buildPlanner`'s verdict aliases (`src/api/read-model/capacity.ts`): the
/// canonical pace fact the planner meter reports.
pub fn pace_meter_verdict(verdict: &str) -> &'static str {
    match verdict {
        "BEHIND" | "EXPIRING" => "behind",
        "ON_PACE" | "OK" | "UNMETERED" => "on_pace",
        "AHEAD" | "NEAR_LIMIT" => "ahead",
        "EXHAUSTED" => "out",
        _ => "unknown",
    }
}

/// The eligibility reasons (`src/view-model/eligibility.ts`); an unknown code
/// reads as the default attention line.
pub fn eligibility_reason(code: &str) -> &'static str {
    match code {
        "budget_exhausted" => "Budget exhausted; paid overflow is off (allow_paid: false)",
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// The tables read byte-identically to the TypeScript wording, and the
    /// pace aliases land on the same descriptors `paceStatus` produces.
    #[test]
    fn tables_match_the_typescript_view_model() {
        assert_eq!(verdict_words("ON_PACE"), "On pace");
        assert_eq!(verdict_words("OK"), "Available");
        assert_eq!(verdict_words("UNMETERED"), "Unmetered");
        assert_eq!(verdict_words("UNKNOWN"), "Usage unknown");
        assert_eq!(verdict_words("EXPIRING"), "Expiring soon");
        assert_eq!(verdict_words("on_pace"), "On pace");
        assert_eq!(verdict_words("nope"), "Unknown");
        let pace = pace_status("OK");
        assert_eq!(
            (pace.label, pace.tone, pace.glyph),
            ("Available", "good", "✓")
        );
        let pace = pace_status("NEAR_LIMIT");
        assert_eq!(
            (pace.label, pace.tone, pace.glyph),
            ("Near limit", "warn", "!")
        );
        let pace = pace_status("EXHAUSTED");
        assert_eq!(
            (pace.label, pace.tone, pace.glyph),
            ("Out of quota", "bad", "!")
        );
        assert_eq!(pace_status("whatever").glyph, "?");
        assert_eq!(pace_meter_verdict("EXPIRING"), "behind");
        assert_eq!(pace_meter_verdict("OK"), "on_pace");
        assert_eq!(pace_meter_verdict("UNMETERED"), "on_pace");
        assert_eq!(pace_meter_verdict("mystery"), "unknown");
        assert_eq!(
            eligibility_reason("authentication_failed"),
            "Sign-in is required"
        );
        assert_eq!(
            eligibility_reason("machine_memory_pressure"),
            "Execution evidence needs attention"
        );
    }
}
