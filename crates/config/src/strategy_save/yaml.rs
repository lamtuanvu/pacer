//! Bun.YAML.stringify(raw, null, 2) for the proven plain-scalar subset.
use serde_json::Value as Json;
use serde_yaml::{Mapping, Value as Yaml};

const MAX_RENDER_BYTES: usize = 256 * 1024;
const MAX_INDENT: usize = 32;

fn key(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 128
        && text.bytes().enumerate().all(|(index, b)| {
            b.is_ascii_lowercase() || b == b'_' || (index > 0 && (b.is_ascii_digit() || b == b'-'))
        })
}

fn scalar(value: &Yaml) -> Option<String> {
    match value {
        Yaml::String(text)
            if key(text)
                && !matches!(
                    text.as_str(),
                    "null" | "true" | "false" | "yes" | "no" | "on" | "off"
                ) =>
        {
            Some(text.clone())
        }
        Yaml::Number(number) => number
            .as_i64()
            .filter(|number| *number >= 0)
            .map(|number| number.to_string()),
        _ => None,
    }
}

fn mapping_entry(out: &mut String, key_value: &Yaml, value: &Yaml, indent: usize) -> Option<()> {
    let name = key_value.as_str().filter(|name| key(name))?;
    out.push_str(name);
    out.push(':');
    if let Some(value) = scalar(value) {
        out.push(' ');
        out.push_str(&value);
        out.push('\n');
    } else {
        out.push_str(" \n");
        emit(out, value, indent + 2)?;
    }
    Some(())
}

fn emit(out: &mut String, value: &Yaml, indent: usize) -> Option<()> {
    if indent > MAX_INDENT || out.len() > MAX_RENDER_BYTES {
        return None;
    }
    match value {
        Yaml::Mapping(map) if !map.is_empty() => {
            for (name, value) in map {
                out.push_str(&" ".repeat(indent));
                mapping_entry(out, name, value, indent)?;
                if out.len() > MAX_RENDER_BYTES {
                    return None;
                }
            }
        }
        Yaml::Sequence(items) if !items.is_empty() => {
            for item in items {
                out.push_str(&" ".repeat(indent));
                out.push_str("- ");
                if let Some(text) = scalar(item) {
                    out.push_str(&text);
                    out.push('\n');
                } else if let Yaml::Mapping(map) = item {
                    let mut entries = map.iter();
                    let (name, value) = entries.next()?;
                    if entries.next().is_some() {
                        return None;
                    }
                    mapping_entry(out, name, value, indent + 2)?;
                } else {
                    return None;
                }
                if out.len() > MAX_RENDER_BYTES {
                    return None;
                }
            }
        }
        _ => return None,
    }
    Some(())
}

fn set(root: &mut Mapping, path: &str, value: &Json) -> Option<()> {
    let next = serde_yaml::to_value(value).ok()?;
    if path == "routing" {
        root.insert(Yaml::String(path.to_owned()), next);
        return Some(());
    }
    if !matches!(
        path,
        "pacing.policy" | "pacing.planner_reserve" | "pacing.order"
    ) {
        return None;
    }
    let pacing = root
        .entry(Yaml::String("pacing".to_owned()))
        .or_insert_with(|| Yaml::Mapping(Mapping::new()))
        .as_mapping_mut()?;
    pacing.insert(Yaml::String(path.strip_prefix("pacing.")?.to_owned()), next);
    Some(())
}

/// Return `None` unless every edited value and resulting YAML shape has the
/// same serialization as the TypeScript oracle's accepted plain-scalar subset.
pub(super) fn render_draft(source: &str, draft: &Json) -> Option<String> {
    if source.len() > 256 * 1024
        || !source.is_ascii()
        || source.contains(['&', '*', '!'])
        || source.contains("<<")
    {
        return None;
    }
    // The oracle currently proves reserialization from flow-style source
    // collections. Block-style inputs stay with Bun until their byte golden lands.
    if source.lines().any(|line| {
        line.bytes()
            .next()
            .is_some_and(|byte| byte == b' ' || byte == b'\t')
            && !line.trim_start().starts_with('#')
    }) {
        return None;
    }
    if draft
        .get("unset")
        .is_some_and(|value| value.as_array().is_none_or(|items| !items.is_empty()))
    {
        return None;
    }
    let mut raw: Yaml = serde_yaml::from_str(source).ok()?;
    let root = raw.as_mapping_mut()?;
    if let Some(changes) = draft.get("set") {
        for (path, value) in changes.as_object()? {
            set(root, path, value)?;
        }
    }
    let mut result = String::new();
    emit(&mut result, &raw, 0)?;
    Some(result)
}
