// Ports of the agent identity helpers used by the status line.
pub fn agent_key(agent: &str) -> Option<&str> {
    match agent {
        "claude" => Some("claude-code"),
        "antigravity" => Some("agy"),
        "claude-code" | "codex" | "cursor" | "agy" | "byteplus" | "local" | "opencode"
        | "gemini" => Some(agent),
        _ => None,
    }
}
pub fn agent_info(agent: &str) -> (&str, &str) {
    match agent_key(agent) {
        Some("claude-code") => ("Claude", "D97757"),
        Some("codex") => ("Codex", "fafafa"),
        Some("cursor") => ("Cursor", "fafafa"),
        Some("agy") => ("Antigravity", "4285F4"),
        Some("byteplus") => ("BytePlus", "3C8CFF"),
        Some("local") => ("Local model", "fafafa"),
        Some("opencode") => ("OpenCode", "fafafa"),
        Some("gemini") => ("Gemini", "8E75B2"),
        _ => (agent, "fafafa"),
    }
}
pub fn runner_agent(id: &str) -> &str {
    id.split('@')
        .next()
        .unwrap_or_default()
        .split('#')
        .next()
        .unwrap_or_default()
}
