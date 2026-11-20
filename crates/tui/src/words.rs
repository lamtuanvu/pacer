//! The status vocabulary the dashboard words itself with (`src/view-model/words.ts`
//! and `src/view-model/eligibility.ts`). The dashboard is an API client
//! (ARCH-1, CRATE-4): it carries its own copy of the tables instead of
//! depending on the engine, and the tests pin every entry to
//! `pacer_engine::words` through a dev-dependency.

/// The descriptor `paceStatus` returns (`src/view-model/words.ts`): older
/// payload spellings map to their canonical fact, then the one verdict table.
#[derive(Clone, Copy)]
pub struct PaceStatus {
    pub label: &'static str,
    pub tone: &'static str,
    pub glyph: &'static str,
}

const fn entry(label: &'static str, tone: &'static str, glyph: &'static str) -> PaceStatus {
    PaceStatus { label, tone, glyph }
}

const UNKNOWN_PACE: PaceStatus = entry("Usage unknown", "neutral", "?");

pub fn pace_status(verdict: &str) -> PaceStatus {
    let canonical = match verdict {
        "BEHIND" => "behind",
        "ON_PACE" => "on_pace",
        "AHEAD" => "ahead",
        "EXHAUSTED" => "out",
        other => other,
    };
    match canonical {
        "EXHAUSTED" | "out" => entry("Out of quota", "bad", "!"),
        "NEAR_LIMIT" => entry("Near limit", "warn", "!"),
        "AHEAD" | "ahead" => entry("Ahead of pace", "warn", "↑"),
        "BEHIND" | "behind" => entry("Behind pace", "good", "↓"),
        "EXPIRING" | "EXPIRING_SOON" => entry("Expiring soon", "warn", "!"),
        "OK" => entry("Available", "good", "✓"),
        "ON_PACE" | "on_pace" => entry("On pace", "good", "✓"),
        "UNMETERED" => entry("Unmetered", "good", "∞"),
        _ => UNKNOWN_PACE,
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
mod tests {
    use super::*;

    /// The dev-dependency pins the tables: every entry reads exactly as
    /// `pacer_engine::words` does, so the dashboard words a verdict or a
    /// reason the same way the engine and the TypeScript view model do.
    #[test]
    fn tables_match_the_engine_word_tables() {
        use engine::words as engine_words;

        for verdict in [
            "behind",
            "on_pace",
            "ahead",
            "out",
            "unknown",
            "BEHIND",
            "ON_PACE",
            "OK",
            "AHEAD",
            "NEAR_LIMIT",
            "EXHAUSTED",
            "UNMETERED",
            "EXPIRING",
            "EXPIRING_SOON",
            "UNKNOWN",
            "",
            "machine_load",
            "whatever",
        ] {
            let tui = pace_status(verdict);
            let expected = engine_words::pace_status(verdict);
            assert_eq!(
                (tui.label, tui.tone, tui.glyph),
                (expected.label, expected.tone, expected.glyph),
                "pace_status({verdict})"
            );
        }
        for code in [
            "budget_exhausted",
            "budget_missing",
            "budget_expired_or_unknown",
            "evidence_conflicting",
            "evidence_missing",
            "availability_unknown",
            "subscription_missing",
            "subscription_failed",
            "subscription_response_invalid",
            "authentication_failed",
            "signed_out",
            "refresh_failed",
            "disabled",
            "not_installed",
            "blocked",
            "broken",
            "unavailable",
            "planner",
            "not_configured",
            "quota_failure",
            "",
            "machine_load",
            "nope",
        ] {
            assert_eq!(
                eligibility_reason(code),
                engine_words::eligibility_reason(code),
                "eligibility_reason({code})"
            );
        }
    }
}
