//! `loadStrategy` failures Rust reproduces (`src/config/strategy.ts`): a missing file, schema
//! problems and `validateStrategy`'s own errors. YAML syntax and I/O errors carry Bun or Node
//! text, and some YAML shapes read differently in Bun, so callers forward them.
use pacer_config::strategy::{StrategyError, load_strategy, strategy_path};
use serde_json::Value;
use std::{fs, path::Path};

/// Node's posix `path.join`: join the non-empty parts with `/`, then drop empty and `.`
/// segments and resolve `..` lexically. The parts here never end with a separator.
fn node_join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|part| !part.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    let absolute = joined.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." if out.last().is_some_and(|last| *last != "..") => {
                out.pop();
            }
            ".." if absolute => {}
            other => out.push(other),
        }
    }
    let body = out.join("/");
    match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".into(),
        (false, false) => body,
    }
}

/// Rust's `Path::join` keeps `.`, `..` and repeated separators, and an absolute active name
/// replaces the home; `strategyPath` reads and reports the `path.join` result.
fn built_like_node(home: &Path, path: &Path, name: &str) -> bool {
    let Some(home) = home.to_str() else {
        return false;
    };
    let expected = if name == "default" && path == Path::new(home).join("strategy.yaml") {
        node_join(&[home, "strategy.yaml"])
    } else {
        node_join(&[home, "strategies", &format!("{name}.yaml")])
    };
    path.to_str() == Some(expected.as_str())
}

/// Shapes Bun's YAML reader and the Rust reader read differently, or may: tabs, document
/// markers after the first line, merge keys, `__proto__` keys, block or tag indicators next
/// to flow collections, and anchors (Bun's stringify writes a shared node as an alias).
pub(crate) fn yaml_may_differ(text: &str) -> bool {
    let markers = text
        .split(['\n', '\r', '\u{85}', '\u{2028}', '\u{2029}'])
        .enumerate()
        .any(|(i, line)| {
            ["---", "..."].iter().any(|marker| {
                line.strip_prefix(marker)
                    .is_some_and(|rest| rest.is_empty() || rest.starts_with(' '))
                    && (i > 0 || *marker == "...")
            })
        });
    markers
        || text.contains(['\t', '&'])
        || text.contains("<<")
        || text.contains("__proto__")
        || (text.contains(['[', '{']) && text.contains(['|', '>', '!']))
}

/// Whether TypeScript must produce the reply for this strategy load failure.
fn needs_core(error: &StrategyError) -> bool {
    match error {
        StrategyError::Missing(_) | StrategyError::Other(_) => false,
        StrategyError::Invalid { problems, .. } => problems
            .iter()
            .any(|problem| problem.starts_with("YAML syntax error: ")),
        StrategyError::Io(_) => true,
    }
}

/// `loadStrategy` for the active strategy, or `None` when TypeScript must answer: Rust builds
/// another path, the failure carries Bun or Node text, or Bun may read the text differently.
pub fn native_load(home: &Path) -> Option<Result<Value, StrategyError>> {
    let (path, name) = strategy_path(home).ok()?;
    if !built_like_node(home, &path, &name) {
        return None;
    }
    let loaded = load_strategy(home);
    if loaded.as_ref().is_err_and(needs_core) || text_may_differ(&path) {
        return None;
    }
    Some(loaded)
}

/// A strategy file whose text Bun may read differently; a missing file has none.
pub(crate) fn text_may_differ(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|text| yaml_may_differ(&text))
}

#[cfg(test)]
mod tests;
