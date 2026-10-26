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
    Map(Vec<(String, Node)>),
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
            *cursor += 1;
            Some(Node::Map(entries))
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
        Node::Map(entries) => {
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

fn safe_plain_string(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "true" | "false" | "null"
        )
}

fn render_plain(value: &Value) -> Option<String> {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    match value {
        Value::String(value) if safe_plain_string(value) => Some(value.clone()),
        Value::Bool(value) => Some(value.to_string()),
        Value::Null => Some("null".to_owned()),
        Value::Number(value)
            if value
                .as_i64()
                .is_some_and(|number| (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&number))
                || value
                    .as_u64()
                    .is_some_and(|number| number <= MAX_SAFE_INTEGER as u64) =>
        {
            Some(value.to_string())
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

/// Replace one existing plain scalar while retaining every other source byte.
/// The supported value grammar is intentionally smaller than `yaml`'s emitter.
#[must_use]
pub fn replace_existing_plain_scalar(text: &str, path: &[Value], value: &Value) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let replacement = render_plain(value)?;
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
    let root = parse_node(&events.0, &mut cursor)?;
    let Node::Scalar {
        style: ScalarStyle::Plain,
        span,
        ..
    } = lookup(&root, path)?
    else {
        return None;
    };
    let start = char_to_byte(text, span.start.index())?;
    let end = char_to_byte(text, span.end.index())?;
    if start >= end || !text.is_char_boundary(start) || !text.is_char_boundary(end) {
        return None;
    }
    let mut output = text.to_owned();
    output.replace_range(start..end, &replacement);
    Some(output)
}
