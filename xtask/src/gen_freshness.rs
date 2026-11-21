//! Freshness-constants target (ADR 0030 decision 5): `src/usage/freshness.constants.json`
//! becomes `crates/limits-protocol/src/freshness.rs` in the generated crate, so Rust
//! reads the same thresholds as `src/usage/freshness.ts` instead of hard-coding copies.
use std::{
    fs,
    path::{Path, PathBuf},
};

/// The constants file and the Rust file generated from it.
pub fn target() -> (PathBuf, PathBuf) {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(Path::new("."));
    (
        root.join("src/usage/freshness.constants.json"),
        root.join("crates/limits-protocol/src/freshness.rs"),
    )
}

/// One `pub const` per JSON key, in file order: `SCREAMING_SNAKE_CASE`, `i64` for
/// `*S` (unix seconds) and `f64` for `*Pct` (a percentage).
pub fn generate(input: &Path) -> Result<String, String> {
    let text = fs::read_to_string(input).map_err(|e| format!("{}: {e}", input.display()))?;
    let constants: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if constants.is_empty() {
        return Err(format!("{}: no constants", input.display()));
    }
    let mut code = String::from(super::HEADER);
    code.push_str("//! Usage freshness thresholds shared with `src/usage/freshness.ts` (ADR 0030 decision 5).\n\n");
    code.push_str(
        "#![allow(clippy::all, clippy::unwrap_used, clippy::expect_used, missing_docs)]\n\n",
    );
    for (key, value) in &constants {
        let name = constant_name(key).map_err(|e| format!("{}: {key}: {e}", input.display()))?;
        let typed = constant(key, value).map_err(|e| format!("{}: {key}: {e}", input.display()))?;
        code.push_str(&format!("pub const {name}: {typed};\n"));
    }
    super::rustfmt(&code)
}

/// The typed literal: `{ty} = {literal}`.
fn constant(key: &str, value: &serde_json::Value) -> Result<String, String> {
    if key.ends_with("Pct") {
        let n = value
            .as_f64()
            .ok_or_else(|| format!("{value} is not a number"))?;
        Ok(format!("f64 = {n:?}"))
    } else if key.ends_with('S') {
        let n = value
            .as_i64()
            .ok_or_else(|| format!("{value} is not a whole number of seconds"))?;
        Ok(format!("i64 = {n}"))
    } else {
        Err("keys end in S (seconds) or Pct (percentage)".into())
    }
}

fn constant_name(key: &str) -> Result<String, String> {
    let first = key.chars().next().ok_or("empty key")?;
    if !first.is_ascii_lowercase() {
        return Err("keys start with a lowercase letter".into());
    }
    let mut name = String::new();
    for ch in key.chars() {
        if ch.is_ascii_uppercase() {
            name.push('_');
            name.push(ch);
        } else if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            name.push(ch.to_ascii_uppercase());
        } else {
            return Err("keys are camelCase".into());
        }
    }
    Ok(name)
}

#[cfg(test)]
#[path = "gen_freshness_tests.rs"]
mod tests;
