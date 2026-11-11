//! ECMAScript behaviour the TypeScript account handlers depend on.
use regex::Regex;
use serde_json::Value;
use std::{
    cmp::Ordering,
    path::{Component, Path, PathBuf},
    sync::LazyLock,
};

/// `Object.prototype` members that a plain-object lookup such as `s.accounts[name]` finds.
const PROTOTYPE_KEYS: &[&str] = &[
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

pub(crate) fn prototype_key(name: &str) -> bool {
    PROTOTYPE_KEYS.contains(&name)
}

/// Keys that JavaScript objects enumerate before all other keys.
pub(crate) fn array_index(key: &str) -> bool {
    key.parse::<u32>()
        .is_ok_and(|n| n < u32::MAX && n.to_string() == key)
}

pub(crate) fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `/^[a-z0-9][a-z0-9-]*$/`
pub(crate) fn account_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub(crate) fn locale_compare(a: &str, b: &str) -> Ordering {
    icu_collator::CollatorBorrowed::new_root(Default::default()).compare(a, b)
}

fn number(v: &Value) -> String {
    let n = v.as_f64().unwrap_or(0.0);
    if !n.is_finite() {
        "null".into()
    } else if n == 0.0 {
        "0".into()
    } else {
        ryu_js::Buffer::new().format(n).to_owned()
    }
}

/// `Object.keys` order: array indices ascending, then insertion order.
pub(crate) fn keys(m: &serde_json::Map<String, Value>) -> Vec<&String> {
    let mut indices: Vec<_> = m.keys().filter(|k| array_index(k)).collect();
    indices.sort_by_key(|k| k.parse::<u32>().unwrap_or(0));
    indices
        .iter()
        .copied()
        .chain(m.keys().filter(|k| !array_index(k)))
        .collect()
}

/// `JSON.stringify(value)` or, with an indent, `JSON.stringify(value, null, indent)`.
pub(crate) fn stringify(v: &Value, indent: usize) -> String {
    fn go(v: &Value, indent: usize, depth: usize, out: &mut String) {
        let pad = |out: &mut String, depth: usize| {
            if indent > 0 {
                out.push('\n');
                out.push_str(&" ".repeat(indent * depth));
            }
        };
        match v {
            Value::Number(_) => out.push_str(&number(v)),
            Value::Array(items) if !items.is_empty() => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    pad(out, depth + 1);
                    go(item, indent, depth + 1, out);
                }
                pad(out, depth);
                out.push(']');
            }
            Value::Object(m) if !m.is_empty() => {
                out.push('{');
                for (i, k) in keys(m).into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    pad(out, depth + 1);
                    out.push_str(&Value::String(k.clone()).to_string());
                    out.push(':');
                    if indent > 0 {
                        out.push(' ');
                    }
                    go(&m[k], indent, depth + 1, out);
                }
                pad(out, depth);
                out.push('}');
            }
            _ => out.push_str(&v.to_string()),
        }
    }
    let mut out = String::new();
    go(v, indent, 0, &mut out);
    out
}

const WS: &str = r"\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}";

pub(crate) static REDACTIONS: LazyLock<Vec<(Regex, &'static str)>> = LazyLock::new(|| {
    [
        (
            format!(r"(?-u:(?i:authorization))[{WS}]*[:=][{WS}]*[^\r\n]*"),
            "Authorization: [redacted]",
        ),
        (
            format!(r"(?-u:\b)(?-u:(?i:bearer))[{WS}]+[^{WS}]+"),
            "Bearer [redacted]",
        ),
        (
            r"(?-u:\b)(?-u:(?i:sk|pk|api[_-]?key|token))[_-](?-u:[A-Za-z0-9_-])+".to_owned(),
            "[redacted]",
        ),
        (
            format!(
                r"((?-u:(?i:api[_-]?key|access[_-]?token|password))[{WS}]*[=:][{WS}]*)[^{WS},;]+"
            ),
            "${1}[redacted]",
        ),
    ]
    .into_iter()
    .filter_map(|(pattern, replacement)| Some((Regex::new(&pattern).ok()?, replacement)))
    .collect()
});

/// `redactEndpointMessage(text)` without caller-supplied secrets: the credential
/// patterns, then the first 4,000 UTF-16 units.
pub(crate) fn redact(text: &str) -> String {
    let mut text = text.to_owned();
    for (pattern, replacement) in REDACTIONS.iter() {
        text = pattern.replace_all(&text, *replacement).into_owned();
    }
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 4000
        })
        .collect()
}

/// Node `path.resolve(p)`: absolute against the working directory, lexically normalized.
pub(crate) fn resolve(p: &Path) -> PathBuf {
    let base = if p.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))
    };
    let mut out = PathBuf::from("/");
    for part in base.join(p).components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(name) => out.push(name),
            _ => {}
        }
    }
    out
}

/// `home.replace(/^~(?=\/|$)/, ctx.home)`, then `resolve`.
pub(crate) fn expand_home(home: &str, user_home: &Path) -> PathBuf {
    let text = match home.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            format!("{}{rest}", user_home.display())
        }
        _ => home.to_owned(),
    };
    resolve(Path::new(&text))
}
