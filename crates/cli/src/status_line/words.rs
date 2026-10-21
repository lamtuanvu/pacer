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
pub fn compact_verdict_words(verdict: &str) -> &str {
    match verdict {
        "out" | "EXHAUSTED" => "out",
        "ahead" | "AHEAD" => "ahead",
        _ => "",
    }
}
