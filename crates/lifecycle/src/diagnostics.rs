//! The one-line runner diagnostic sanitization from endpoints/state.ts.
use crate::{Error, js, s};
use regex::Regex;
use serde_json::Value;
fn replace(text: String, pattern: &str, replacement: &str) -> Result<String, Error> {
    let re = Regex::new(pattern)
        .map_err(|_| Error::new("failed", "runner diagnostic redaction failed"))?;
    Ok(re.replace_all(&text, replacement).into_owned())
}
pub fn redact(text: &str, env: &Value) -> Result<String, Error> {
    let mut secrets: Vec<_> = env
        .as_object()
        .into_iter()
        .flat_map(|m| m.iter())
        .filter(|(key, _)| {
            let key = key.to_ascii_lowercase();
            ["key", "token", "secret", "password"]
                .iter()
                .any(|word| key.contains(word))
        })
        .map(|(_, value)| s(value))
        .filter(|secret| !secret.is_empty())
        .collect();
    secrets.sort_by_key(|secret| std::cmp::Reverse(secret.encode_utf16().count()));
    let mut out = text.to_owned();
    for secret in secrets {
        out = out.replace(secret, "[redacted]");
    }
    let ws = js::WHITESPACE;
    let non = js::NON_WHITESPACE;
    let non_comma = non.replace("]", ",;]");
    out = replace(
        out,
        &format!(r"(?i-u:authorization){ws}*[:=]{ws}*[^\r\n]*"),
        "Authorization: [redacted]",
    )?;
    out = replace(
        out,
        &format!(r"(?i-u:\bBearer){ws}+{non}+"),
        "Bearer [redacted]",
    )?;
    out = replace(
        out,
        r"(?i-u:\b(?:sk|pk|api[_-]?key|token))[_-][A-Za-z0-9_-]+",
        "[redacted]",
    )?;
    out = replace(
        out,
        &format!(r"((?i-u:api[_-]?key|access[_-]?token|password){ws}*[=:]{ws}*){non_comma}+"),
        "${1}[redacted]",
    )?;
    let first = out.split('\n').next().unwrap_or("");
    let first = first
        .strip_suffix('\r')
        .filter(|_| out.contains('\n'))
        .unwrap_or(first);
    let mut units: Vec<_> = first.encode_utf16().take(500).collect();
    if units.last().is_some_and(|u| (0xd800..=0xdbff).contains(u)) {
        units.pop();
    }
    Ok(String::from_utf16_lossy(&units))
}
