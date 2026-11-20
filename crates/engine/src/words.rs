//! The one status vocabulary (`src/view-model/words.ts`): a label table per
//! concept, so every Rust surface words a verdict or an eligibility reason the
//! same way TypeScript does.

/// `verdicts` (`src/view-model/words.ts`); anything else is `"Unknown"`.
pub fn verdict_words(verdict: &str) -> &'static str {
    match verdict {
        "ON_PACE" | "OK" | "UNMETERED" => "Available",
        "AHEAD" => "Ahead of pace",
        "BEHIND" => "Behind pace",
        "EXPIRING" | "EXPIRING_SOON" => "Expiring soon",
        "NEAR_LIMIT" => "Near limit",
        "EXHAUSTED" => "Out of quota",
        "behind" => "Behind pace",
        "on_pace" => "On pace",
        "ahead" => "Ahead of pace",
        "out" => "Out of quota",
        "unknown" => "Usage unknown",
        _ => "Unknown",
    }
}

/// The descriptor `paceStatus` returns (`src/view-model/words.ts`): verdict
/// aliases to a canonical pace fact, then its label, tone and glyph.
#[derive(Clone, Copy)]
pub struct PaceStatus {
    pub label: &'static str,
    pub tone: &'static str,
    pub glyph: &'static str,
}

const UNKNOWN_PACE: PaceStatus = PaceStatus {
    label: "Usage unknown",
    tone: "neutral",
    glyph: "?",
};

pub fn pace_status(verdict: &str) -> PaceStatus {
    let canonical = match verdict {
        "BEHIND" => "behind",
        "ON_PACE" => "on_pace",
        "OK" => "on_pace",
        "AHEAD" => "ahead",
        "NEAR_LIMIT" => "ahead",
        "EXHAUSTED" => "out",
        other => other,
    };
    match canonical {
        "behind" => PaceStatus {
            label: "Behind pace",
            tone: "good",
            glyph: "↓",
        },
        "on_pace" => PaceStatus {
            label: "On pace",
            tone: "good",
            glyph: "✓",
        },
        "ahead" => PaceStatus {
            label: "Ahead of pace",
            tone: "warn",
            glyph: "↑",
        },
        "out" => PaceStatus {
            label: "Out of quota",
            tone: "bad",
            glyph: "!",
        },
        "UNMETERED" => PaceStatus {
            label: "Unmetered",
            tone: "good",
            glyph: "∞",
        },
        "EXPIRING" | "EXPIRING_SOON" => PaceStatus {
            label: "Expiring soon",
            tone: "warn",
            glyph: "!",
        },
        _ => UNKNOWN_PACE,
    }
}

/// `buildPlanner`'s verdict aliases (`src/api/read-model/capacity.ts`): the
/// canonical pace fact the planner meter reports.
pub fn pace_meter_verdict(verdict: &str) -> &'static str {
    match verdict {
        "BEHIND" | "EXPIRING" => "behind",
        "ON_PACE" | "OK" => "on_pace",
        "AHEAD" | "NEAR_LIMIT" => "ahead",
        "EXHAUSTED" => "out",
        _ => "unknown",
    }
}

/// The eligibility reasons (`src/view-model/eligibility.ts`); an unknown code
/// reads as the default attention line.
pub fn eligibility_reason(code: &str) -> &'static str {
    match code {
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

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// The tables read byte-identically to the TypeScript wording, and the
    /// pace aliases land on the same descriptors `paceStatus` produces.
    #[test]
    fn tables_match_the_typescript_view_model() {
        assert_eq!(verdict_words("ON_PACE"), "Available");
        assert_eq!(verdict_words("OK"), "Available");
        assert_eq!(verdict_words("UNMETERED"), "Available");
        assert_eq!(verdict_words("EXPIRING"), "Expiring soon");
        assert_eq!(verdict_words("on_pace"), "On pace");
        assert_eq!(verdict_words("nope"), "Unknown");
        let pace = pace_status("OK");
        assert_eq!(
            (pace.label, pace.tone, pace.glyph),
            ("On pace", "good", "✓")
        );
        let pace = pace_status("NEAR_LIMIT");
        assert_eq!(
            (pace.label, pace.tone, pace.glyph),
            ("Ahead of pace", "warn", "↑")
        );
        let pace = pace_status("EXHAUSTED");
        assert_eq!(
            (pace.label, pace.tone, pace.glyph),
            ("Out of quota", "bad", "!")
        );
        assert_eq!(pace_status("whatever").glyph, "?");
        assert_eq!(pace_meter_verdict("EXPIRING"), "behind");
        assert_eq!(pace_meter_verdict("OK"), "on_pace");
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
