pub fn tone_for(value: &str) -> &str {
    match value {
        "bad" | "EXHAUSTED" | "out" => "bad",
        "warn" | "AHEAD" | "NEAR_LIMIT" | "EXPIRING" | "EXPIRING_SOON" | "ahead" => "warn",
        "good" | "OK" | "ON_PACE" | "BEHIND" | "UNMETERED" | "behind" | "on_pace" => "good",
        "info" => "info",
        _ => "neutral",
    }
}
pub fn mode_words(mode: &str) -> String {
    let mut chars = mode.chars();
    chars.next().map_or_else(String::new, |c| {
        format!("{}{}", c.to_uppercase(), chars.as_str().to_lowercase())
    })
}
pub const OFFLINE_WORDS: &str = "pacer not running · pacer serve";
/// The service owns this fact; older snapshots must not imply an open mode.
pub fn policy_words(policy: &serde_json::Value, compact: bool) -> String {
    if policy.is_null() {
        return if compact {
            "policy:unknown"
        } else {
            "policy: unknown"
        }
        .into();
    }
    let mode = policy["mode"].as_str().unwrap_or("unknown");
    let count = &policy["plugins"];
    if compact {
        format!("policy:{mode}/{count}")
    } else if mode == "closed" {
        format!("policy: closed ({count} plugins)")
    } else {
        format!("policy: {mode}")
    }
}
pub fn compact_verdict_words(verdict: &str) -> &str {
    match verdict {
        "out" | "EXHAUSTED" => "out",
        "ahead" | "AHEAD" => "ahead",
        _ => "",
    }
}
