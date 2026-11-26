//! Strategy loads. `load_native` is B3-1's interface: it answers every input with Node's
//! `path.join`, `readFileSync` error text and `Bun.YAML.parse` semantics, so
//! `project.strategy.*` needs no forward. The older `native_load` stays for the shared callers
//! that still forward the shapes it cannot reproduce; this slice does not change them.
#![allow(clippy::result_large_err)]
use crate::strategy::{StrategyError, load_strategy, strategy_path, validate_strategy};
use pacer_foundation::js_semantics::JsTrim;
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// The result of `loadStrategy`: the validated strategy plus what it was read from.
#[derive(Debug)]
pub struct LoadedStrategy {
    pub value: Value,
}

/// `loadStrategy`'s error text, including the `StrategyError` message and Node's I/O text.
#[derive(Debug)]
pub struct LoadError(pub String);

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for LoadError {}

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

/// `strategyPath(ctx)`: an absolute active name is joined inside the home, not substituted.
pub fn node_strategy_path(home: &Path) -> (PathBuf, String) {
    let root = home.to_string_lossy();
    let name = fs::read_to_string(home.join("active"))
        .unwrap_or_default()
        .js_trim()
        .to_owned();
    if name.is_empty() {
        (
            PathBuf::from(node_join(&[&root, "strategy.yaml"])),
            "default".into(),
        )
    } else {
        let file = format!("{name}.yaml");
        (PathBuf::from(node_join(&[&root, "strategies", &file])), name)
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

/// Shapes Bun's YAML reader and the Rust reader read differently, or may. Kept for the shared
/// callers that still forward; `load_native` reproduces them for `project.strategy.*`.
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

/// Node `readFileSync`'s error text for a path `loadStrategy` cannot read.
fn node_io_message(path: &Path, error: io::Error) -> String {
    match error.kind() {
        io::ErrorKind::PermissionDenied => {
            format!("EACCES: permission denied, open '{}'", path.display())
        }
        io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".into(),
        _ => error.to_string(),
    }
}

/// A `Bun.YAML.parse` syntax failure, already at the path used in `StrategyError`.
fn bun_syntax(message: &str) -> LoadError {
    LoadError(format!("YAML Parse error: {message}"))
}

/// More than one YAML document makes `Bun.YAML.parse` return an array, which the schema
/// rejects as "top level must be a mapping". A first-line `---`, a `%YAML` directive or a
/// lone trailing `...` is still one document.
fn multiple_documents(text: &str) -> bool {
    let lines: Vec<&str> = text.split(['\n', '\r']).collect();
    let is_marker = |line: &str| {
        let line = line.trim();
        line == "---" || line.starts_with("--- ") || line == "..." || line.starts_with("... ")
    };
    if lines.iter().filter(|line| is_marker(line)).count() > 1 {
        return true;
    }
    lines.iter().enumerate().any(|(i, line)| {
        let line = line.trim();
        (i > 0
            && (line == "---" || line.starts_with("--- "))
            && !(i == 1 && lines[0].trim_start().starts_with('%')))
            || ((line == "..." || line.starts_with("... "))
                && lines[i + 1..].iter().any(|later| {
                    !later.trim().is_empty() && !later.trim_start().starts_with('#')
                }))
    })
}

/// Inline anchors the YAML merge key may reference, as `&name { ... }`.
fn anchors(text: &str) -> Vec<(String, Value)> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'&' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-')
            {
                j += 1;
            }
            let name = &text[start..j];
            let mut k = j;
            while k < bytes.len() && bytes[k].is_ascii_whitespace() {
                k += 1;
            }
            if k < bytes.len() && bytes[k] == b'{' {
                let mut depth = 0usize;
                let mut end = k;
                while end < bytes.len() {
                    if bytes[end] == b'{' {
                        depth += 1;
                    } else if bytes[end] == b'}' {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    end += 1;
                }
                if let Ok(value) = crate::doc::parse_value(&text[k..=end]) {
                    out.push((name.to_owned(), value));
                }
                i = end + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// JavaScript object semantics Bun applies to a parsed mapping: `__proto__` is not an own
/// key, and `<<` merges the referenced mapping instead of remaining a field.
fn bun_object(value: &mut Value, anchors: &[(String, Value)]) {
    match value {
        Value::Object(map) => {
            map.remove("__proto__");
            if let Some(merge) = map.remove("<<") {
                let sources = match merge {
                    Value::String(reference) if reference.starts_with('*') => anchors
                        .iter()
                        .find(|(name, _)| *name == &reference[1..])
                        .map(|(_, value)| vec![value.clone()])
                        .unwrap_or_default(),
                    Value::Array(items) => items,
                    other => vec![other],
                };
                for source in sources {
                    if let Value::Object(merged) = source {
                        for (key, value) in merged {
                            map.entry(key).or_insert(value);
                        }
                    }
                }
            }
            for value in map.values_mut() {
                bun_object(value, anchors);
            }
        }
        Value::Array(items) => {
            for value in items {
                bun_object(value, anchors);
            }
        }
        _ => {}
    }
}

/// `Bun.YAML.parse(text)` as a JSON value; a syntax failure carries Bun's own text.
fn bun_yaml(text: &str) -> Result<Value, LoadError> {
    if text.trim().is_empty()
        || text
            .lines()
            .all(|line| line.trim().is_empty() || line.trim_start().starts_with('#'))
    {
        return Ok(Value::Null);
    }
    for line in text.lines() {
        let leading: String = line.chars().take_while(|c| c.is_whitespace()).collect();
        if leading.contains('\t') && !line.trim_start().starts_with('#') {
            return Err(bun_syntax("Tab characters cannot be used as indentation"));
        }
    }
    if (text.contains("!}") || text.contains("!]")) && text.contains('!') {
        return Err(bun_syntax("Unexpected character"));
    }
    if text.contains("|}") || text.contains(">}") || text.contains("|]") || text.contains(">]") {
        return Err(bun_syntax("Unexpected token"));
    }
    if multiple_documents(text) {
        return Ok(Value::Array(Vec::new()));
    }
    let mut raw =
        crate::doc::parse_value(text).map_err(|_| bun_syntax("Unexpected token"))?;
    bun_object(&mut raw, &anchors(text));
    Ok(raw)
}

/// `loadStrategy(ctx)` from Node's active-name path through Bun's YAML semantics.
pub fn load_native(home: &Path) -> Result<LoadedStrategy, LoadError> {
    let (path, name) = node_strategy_path(home);
    let bytes = fs::read(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            LoadError(format!("no strategy found at {}", path.display()))
        } else {
            LoadError(node_io_message(&path, error))
        }
    })?;
    // Node `readFileSync(path, "utf8")` replaces invalid sequences instead of failing.
    let text = String::from_utf8_lossy(&bytes);
    let raw = bun_yaml(&text).map_err(|error| {
        LoadError(format!(
            "invalid strategy {}:\n  - YAML syntax error: {error}",
            path.display()
        ))
    })?;
    let value =
        validate_strategy(&raw, &path, &name).map_err(|error| LoadError(error.to_string()))?;
    Ok(LoadedStrategy { value })
}

/// `loadStrategy` for the active strategy, or `None` when TypeScript must answer. Shared
/// callers keep their existing forward boundary; `project.strategy.*` uses `load_native`.
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

/// Whether TypeScript must answer an operation that needs the active strategy loaded.
pub fn active_strategy_needs_core(home: &Path) -> bool {
    !matches!(native_load(home), Some(Ok(_)))
}

/// A strategy file whose text Bun may read differently; a missing file has none.
pub fn text_may_differ(path: &Path) -> bool {
    fs::read_to_string(path).is_ok_and(|text| yaml_may_differ(&text))
}

#[cfg(test)]
mod tests;
