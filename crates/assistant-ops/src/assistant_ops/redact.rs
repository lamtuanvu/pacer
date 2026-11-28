//! Redaction shared by the tool pipeline and the answer stream.
//!
//! Port of `src/assistant/redact.ts` (`createRedactor`). Exact configured
//! secrets, key-shaped strings, PEM blocks, bearer/JWT/authorization headers,
//! high-entropy long tokens and the home path never reach the model or a card.
//! pacer's own identifiers and commit SHAs are allowed through so the assistant
//! can still quote them. Idempotent.

use regex::Regex;
use serde_json::Value;
use std::{collections::HashMap, sync::OnceLock};

const REDACTED: &str = "[redacted]";

fn all_allow() -> &'static Vec<Regex> {
    static ALLOW: OnceLock<Vec<Regex>> = OnceLock::new();
    ALLOW.get_or_init(|| {
        [
            r"^t-\d{8}-\d{6}-[0-9a-f]{4}$",
            r"^[0-9a-f]{40}$",
            r"^[0-9a-f]{64}$",
            r"^(?:task|att|req|run|conv|turn|work)[-_][A-Za-z0-9_-]{4,}$",
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
        ]
        .iter()
        .map(|p| Regex::new(p).unwrap_or_else(|e| panic!("invalid allow pattern: {e}")))
        .collect()
    })
}

fn allowed(token: &str) -> bool {
    all_allow().iter().any(|re| re.is_match(token))
}

/// Shannon entropy per character; filters long but ordinary words and paths.
fn entropy(text: &str) -> f64 {
    let mut counts: HashMap<char, usize> = HashMap::new();
    for ch in text.chars() {
        *counts.entry(ch).or_insert(0) += 1;
    }
    let len = text.chars().count();
    if len == 0 {
        return 0.0;
    }
    let mut h = 0.0;
    for n in counts.values() {
        let p = *n as f64 / len as f64;
        h -= p * p.log2();
    }
    h
}

/// Replaces exact secret values, key-shaped strings, PEM blocks and the home
/// path. `new` uses the process home; `new_with_home` is for sandboxed tests.
pub struct Redactor {
    secrets: Vec<String>,
    home: String,
    pem: Regex,
    auth_header: Regex,
    bearer: Regex,
    jwt: Regex,
    key_prefix: Regex,
    assignment: Regex,
    long_token: Regex,
}

impl Redactor {
    pub fn new(secrets: Vec<String>) -> Self {
        let home = std::env::var("HOME").unwrap_or_default();
        Self::new_with_home(secrets, home)
    }

    pub fn new_with_home(secrets: Vec<String>, home: String) -> Self {
        let regex = |pattern: &str| {
            Regex::new(pattern).unwrap_or_else(|e| panic!("invalid redaction pattern: {e}"))
        };
        Self {
            // Longest first, so an exact secret is not partially replaced by a
            // shorter one that happens to be its prefix.
            secrets: {
                let mut unique: Vec<String> = secrets.into_iter().filter(|s| s.len() >= 4).collect();
                unique.sort();
                unique.dedup();
                unique.sort_by(|a, b| b.len().cmp(&a.len()));
                unique
            },
            home,
            pem: regex(
                r"-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE|PUBLIC KEY)-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)",
            ),
            auth_header: regex(r"(?i)\bauthorization\s*[:=]\s*[^\r\n]*"),
            bearer: regex(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{8,}"),
            jwt: regex(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b"),
            key_prefix: regex(
                r"\b(?:sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|pk_(?:live|test)_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,})\b",
            ),
            assignment: regex(
                r#"(?i)((?:api[_-]?key|access[_-]?token|secret|password|passwd|token)["']?\s*[=:]\s*["']?)[^\s"',;]{4,}"#,
            ),
            long_token: regex(r"[A-Za-z0-9_+/=-]{32,}"),
        }
    }

    pub fn text(&self, input: &str) -> String {
        let mut out = input.to_owned();
        for secret in &self.secrets {
            out = out.replace(secret, REDACTED);
        }
        let out = self.pem.replace_all(&out, REDACTED);
        let out = self.auth_header.replace_all(&out, "Authorization: [redacted]");
        let out = self.bearer.replace_all(&out, "Bearer [redacted]");
        let out = self.jwt.replace_all(&out, REDACTED);
        let out = self.key_prefix.replace_all(&out, REDACTED);
        let out = self.assignment.replace_all(&out, "$1[redacted]");
        let out = self.long_token.replace_all(&out, |caps: &regex::Captures| {
            let token = &caps[0];
            let keep = allowed(token)
                || token.chars().all(|c| c.is_ascii_alphabetic())
                || (token.contains('/') && !token.chars().any(|c| c.is_ascii_digit()))
                || entropy(token) < 3.6;
            if keep {
                token.to_owned()
            } else {
                REDACTED.to_owned()
            }
        });
        if self.home.len() > 1 {
            out.replace(&self.home, "~")
        } else {
            out.into_owned()
        }
    }

    /// Redact every string value, recursively, leaving keys and non-strings
    /// untouched (matching `createRedactor.json`).
    pub fn json(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.json(item)).collect()),
            Value::Object(map) => Value::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), self.json(value)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }
}
