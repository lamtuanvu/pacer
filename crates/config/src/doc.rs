//! A deliberately narrow, byte-preserving StrategyDoc emitter spike.
//!
//! No public operation calls this module yet. Unsupported edit classes return
//! `None` so a future selector can keep them with the TypeScript core.

use saphyr_parser::{Event, Parser, ScalarStyle, Span, SpannedEventReceiver};
use serde_json::Value;

struct Events<'a>(Vec<(Event<'a>, Span)>);

impl<'a> SpannedEventReceiver<'a> for Events<'a> {
    fn on_event(&mut self, event: Event<'a>, span: Span) {
        self.0.push((event, span));
    }
}

enum Node {
    Scalar {
        value: String,
        style: ScalarStyle,
        span: Span,
    },
    Map {
        opening: Span,
        closing: Span,
        entries: Vec<(String, Node)>,
    },
    Seq(Vec<Node>),
}

fn parse_node(events: &[(Event<'_>, Span)], cursor: &mut usize) -> Option<Node> {
    let (event, span) = events.get(*cursor)?;
    *cursor += 1;
    match event {
        Event::Scalar(value, style, 0, None) => Some(Node::Scalar {
            value: value.to_string(),
            style: *style,
            span: *span,
        }),
        Event::MappingStart(0, None) => {
            let mut entries = Vec::new();
            while !matches!(events.get(*cursor)?.0, Event::MappingEnd) {
                let Node::Scalar { value: key, .. } = parse_node(events, cursor)? else {
                    return None;
                };
                let value = parse_node(events, cursor)?;
                entries.push((key, value));
            }
            let closing = events.get(*cursor)?.1;
            *cursor += 1;
            Some(Node::Map {
                opening: *span,
                closing,
                entries,
            })
        }
        Event::SequenceStart(0, None) => {
            let mut entries = Vec::new();
            while !matches!(events.get(*cursor)?.0, Event::SequenceEnd) {
                entries.push(parse_node(events, cursor)?);
            }
            *cursor += 1;
            Some(Node::Seq(entries))
        }
        _ => None,
    }
}

fn lookup<'a>(node: &'a Node, path: &[Value]) -> Option<&'a Node> {
    let Some((head, tail)) = path.split_first() else {
        return Some(node);
    };
    match node {
        Node::Map { entries, .. } => {
            let key = head.as_str()?;
            let mut found = entries.iter().filter(|(candidate, _)| candidate == key);
            let (_, child) = found.next()?;
            if found.next().is_some() {
                return None;
            }
            lookup(child, tail)
        }
        Node::Seq(entries) => lookup(entries.get(usize::try_from(head.as_u64()?).ok()?)?, tail),
        Node::Scalar { .. } => None,
    }
}

fn parse_document(text: &str) -> Option<Node> {
    let mut parser = Parser::new_from_str(text);
    let mut events = Events(Vec::new());
    parser.load(&mut events, true).ok()?;
    if events
        .0
        .iter()
        .filter(|(event, _)| matches!(event, Event::DocumentStart(_)))
        .count()
        != 1
    {
        return None;
    }
    let mut cursor = events
        .0
        .iter()
        .position(|(event, _)| matches!(event, Event::DocumentStart(_)))?
        + 1;
    parse_node(&events.0, &mut cursor)
}

fn safe_plain_string(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-'))
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "null"
        )
}

fn safe_quoted_ascii(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_graphic() && !matches!(ch, '\\' | '\'' | '"') || ch == ' ')
}

fn render_scalar(value: &Value, style: ScalarStyle) -> Option<String> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    match value {
        Value::String(value) if style == ScalarStyle::SingleQuoted && safe_quoted_ascii(value) => {
            Some(format!("'{value}'"))
        }
        Value::String(value) if style == ScalarStyle::DoubleQuoted && safe_quoted_ascii(value) => {
            Some(format!("\"{value}\""))
        }
        Value::String(value) if style == ScalarStyle::Plain && safe_plain_string(value) => {
            Some(value.clone())
        }
        Value::String(value)
            if style == ScalarStyle::Plain
                && safe_quoted_ascii(value)
                && (matches!(
                    value.to_ascii_lowercase().as_str(),
                    "true" | "false" | "null"
                ) || value.contains(": ")
                    || value.contains(" # ")) =>
        {
            serde_json::to_string(value).ok()
        }
        Value::Bool(value) if style == ScalarStyle::Plain => Some(value.to_string()),
        Value::Null if style == ScalarStyle::Plain => Some("null".to_owned()),
        Value::Number(value)
            if style == ScalarStyle::Plain
                && (value.as_i64().is_some_and(|number| {
                    (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number)
                }) || value
                    .as_u64()
                    .is_some_and(|number| number <= MAX_SAFE_INTEGER as u64)) =>
        {
            Some(value.to_string())
        }
        Value::Number(value) if style == ScalarStyle::Plain && value.is_f64() => {
            let number = value.as_f64()?;
            let rendered = value.to_string();
            let fraction = rendered.split_once('.')?.1;
            (number.is_finite()
                && number.abs() <= 1_000_000.0
                && number.fract() != 0.0
                && (1..=6).contains(&fraction.len())
                && fraction.chars().all(|ch| ch.is_ascii_digit()))
            .then_some(rendered)
        }
        _ => None,
    }
}

fn char_to_byte(text: &str, index: usize) -> Option<usize> {
    if index == text.chars().count() {
        Some(text.len())
    } else {
        text.char_indices().nth(index).map(|(byte, _)| byte)
    }
}

fn scalar_end(text: &str, start: usize, span_end: usize, style: ScalarStyle) -> Option<usize> {
    let quote = match style {
        ScalarStyle::SingleQuoted => '\'',
        ScalarStyle::DoubleQuoted => '"',
        _ => return Some(span_end),
    };
    let raw = text.get(start..span_end)?;
    let rest = raw.strip_prefix(quote)?;
    let closing = rest.find(quote)?;
    if rest.get(..closing)?.contains('\\') {
        return None;
    }
    let tail = rest.get(closing + quote.len_utf8()..)?;
    if tail
        .chars()
        .next()
        .is_some_and(|ch| !ch.is_whitespace() && !matches!(ch, '#' | ',' | '}' | ']'))
    {
        return None;
    }
    Some(start + quote.len_utf8() + closing + quote.len_utf8())
}

/// Replace one existing scalar while retaining every other source byte.
/// The supported value grammar is intentionally smaller than `yaml`'s emitter.
#[must_use]
pub fn replace_existing_scalar(text: &str, path: &[Value], value: &Value) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let root = parse_document(text)?;
    let Node::Scalar { style, span, .. } = lookup(&root, path)? else {
        return None;
    };
    let replacement = render_scalar(value, *style)?;
    let start = char_to_byte(text, span.start.index())?;
    let span_end = char_to_byte(text, span.end.index())?;
    let end = scalar_end(text, start, span_end, *style)?;
    if start >= end || !text.is_char_boundary(start) || !text.is_char_boundary(end) {
        return None;
    }
    let mut output = text.to_owned();
    output.replace_range(start..end, &replacement);
    Some(output)
}

/// Insert one missing scalar into a flow mapping, preserving its other bytes.
/// Block mappings and collection values remain with the TypeScript editor.
#[must_use]
pub fn insert_missing_flow_scalar(text: &str, path: &[Value], value: &Value) -> Option<String> {
    let (key, parent_path) = path.split_last()?;
    let key = key.as_str()?;
    if !safe_plain_string(key) {
        return None;
    }
    let root = parse_document(text)?;
    let Node::Map {
        opening,
        closing,
        entries,
    } = lookup(&root, parent_path)?
    else {
        return None;
    };
    if entries.iter().any(|(existing, _)| existing == key) {
        return None;
    }
    let open_start = char_to_byte(text, opening.start.index())?;
    let open_end = char_to_byte(text, opening.end.index())?;
    let close_start = char_to_byte(text, closing.start.index())?;
    if text.get(open_start..open_end)? != "{" || text.get(close_start..close_start + 1)? != "}" {
        return None;
    }
    let at = if let Some((_, last)) = entries.last() {
        let Node::Scalar {
            style: ScalarStyle::Plain,
            span,
            ..
        } = last
        else {
            return None;
        };
        char_to_byte(text, span.end.index())?
    } else {
        open_end
    };
    if at != close_start
        || text
            .get(open_end..open_end + 1)?
            .chars()
            .next()?
            .is_whitespace()
    {
        return None;
    }
    let rendered = render_scalar(value, ScalarStyle::Plain)?;
    let mut output = text.to_owned();
    output.insert_str(
        at,
        &format!(
            "{}{key}: {rendered}",
            if entries.is_empty() { "" } else { ", " }
        ),
    );
    Some(output)
}
