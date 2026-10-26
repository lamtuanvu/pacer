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
        entries: Vec<MapEntry>,
    },
    Seq {
        opening: Span,
        closing: Span,
        entries: Vec<Node>,
    },
}

struct MapEntry {
    key: String,
    key_span: Span,
    value: Node,
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
                let Node::Scalar {
                    value: key,
                    span: key_span,
                    ..
                } = parse_node(events, cursor)?
                else {
                    return None;
                };
                let value = parse_node(events, cursor)?;
                entries.push(MapEntry {
                    key,
                    key_span,
                    value,
                });
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
            let closing = events.get(*cursor)?.1;
            *cursor += 1;
            Some(Node::Seq {
                opening: *span,
                closing,
                entries,
            })
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
            let mut found = entries.iter().filter(|entry| entry.key == key);
            let child = &found.next()?.value;
            if found.next().is_some() {
                return None;
            }
            lookup(child, tail)
        }
        Node::Seq { entries, .. } => {
            lookup(entries.get(usize::try_from(head.as_u64()?).ok()?)?, tail)
        }
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
    if entries.iter().any(|entry| entry.key == key) {
        return None;
    }
    let open_start = char_to_byte(text, opening.start.index())?;
    let open_end = char_to_byte(text, opening.end.index())?;
    let close_start = char_to_byte(text, closing.start.index())?;
    if text.get(open_start..open_end)? != "{" || text.get(close_start..close_start + 1)? != "}" {
        return None;
    }
    let at = if let Some(last) = entries.last() {
        let Node::Scalar {
            style: ScalarStyle::Plain,
            span,
            ..
        } = &last.value
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

/// Delete one entry from a strict flow map. Other mapping layouts stay with
/// the TypeScript editor until their source ranges have byte-level goldens.
#[must_use]
pub fn delete_flow_entry(text: &str, path: &[Value]) -> Option<String> {
    let (key, parent_path) = path.split_last()?;
    let key = key.as_str()?;
    let root = parse_document(text)?;
    let Node::Map {
        opening,
        closing,
        entries,
    } = lookup(&root, parent_path)?
    else {
        return None;
    };
    let open = char_to_byte(text, opening.start.index())?;
    let content_start = char_to_byte(text, opening.end.index())?;
    let content_end = char_to_byte(text, closing.start.index())?;
    if text.get(open..content_start)? != "{" || text.get(content_end..content_end + 1)? != "}" {
        return None;
    }
    let mut positions = Vec::with_capacity(entries.len());
    let mut next_start = content_start;
    for entry in entries {
        let Node::Scalar {
            span,
            style: ScalarStyle::Plain,
            ..
        } = &entry.value
        else {
            return None;
        };
        let key_start = char_to_byte(text, entry.key_span.start.index())?;
        let key_end = char_to_byte(text, entry.key_span.end.index())?;
        let value_start = char_to_byte(text, span.start.index())?;
        let value_end = char_to_byte(text, span.end.index())?;
        if key_start != next_start
            || !safe_plain_string(&entry.key)
            || text.get(key_start..key_end)? != entry.key
            || text.get(key_end..value_start)? != ": "
        {
            return None;
        }
        positions.push((key_start, value_end));
        next_start = value_end;
        if next_start < content_end {
            if text.get(next_start..next_start + 2)? != ", " {
                return None;
            }
            next_start += 2;
        }
    }
    if next_start != content_end {
        return None;
    }
    let mut found = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.key == key);
    let Some((index, _)) = found.next() else {
        return Some(text.to_owned());
    };
    if found.next().is_some() {
        return None;
    }
    let (start, end) = if let Some(next) = positions.get(index + 1) {
        (positions[index].0, next.0)
    } else if index > 0 {
        (positions[index - 1].1, positions[index].1)
    } else {
        positions[index]
    };
    let mut output = text.to_owned();
    output.replace_range(start..end, "");
    Some(output)
}

/// Rename one plain mapping key without re-emitting its surrounding document.
#[must_use]
pub fn rename_mapping_key(text: &str, path: &[Value], new_name: &str) -> Option<String> {
    let (key, parent_path) = path.split_last()?;
    let key = key.as_str()?;
    if !new_name.is_ascii()
        || !(safe_plain_string(new_name)
            || (safe_quoted_ascii(new_name) && new_name.contains(": ")))
    {
        return None;
    }
    let root = parse_document(text)?;
    let Node::Map { entries, .. } = lookup(&root, parent_path)? else {
        return None;
    };
    if entries.iter().any(|entry| entry.key == new_name) {
        return None;
    }
    let mut found = entries.iter().filter(|entry| entry.key == key);
    let entry = found.next()?;
    if found.next().is_some() {
        return None;
    }
    let start = char_to_byte(text, entry.key_span.start.index())?;
    let end = char_to_byte(text, entry.key_span.end.index())?;
    if start >= end || !key.is_ascii() || !safe_plain_string(key) || text.get(start..end)? != key {
        return None;
    }
    let replacement = render_scalar(&Value::String(new_name.to_owned()), ScalarStyle::Plain)?;
    let mut output = text.to_owned();
    output.replace_range(start..end, &replacement);
    Some(output)
}

/// Rewrite a flow sequence of plain strings, retaining its bracket padding.
/// Source comments, quoted items, and block sequences remain with TypeScript.
#[must_use]
pub fn replace_flow_list(text: &str, path: &[Value], values: &[Value]) -> Option<String> {
    let root = parse_document(text)?;
    let Node::Seq {
        opening,
        closing,
        entries,
    } = lookup(&root, path)?
    else {
        return None;
    };
    let open = char_to_byte(text, opening.start.index())?;
    let inner_start = open.checked_add(1)?;
    let inner_end = char_to_byte(text, closing.start.index())?;
    if text.get(open..inner_start)? != "[" || text.get(inner_end..inner_end + 1)? != "]" {
        return None;
    }
    let mut cursor = inner_start;
    let mut prefix = "";
    let mut suffix = "";
    for (index, entry) in entries.iter().enumerate() {
        let Node::Scalar {
            value,
            style: ScalarStyle::Plain,
            span,
        } = entry
        else {
            return None;
        };
        let start = char_to_byte(text, span.start.index())?;
        let end = char_to_byte(text, span.end.index())?;
        if !safe_plain_string(value) || text.get(start..end)? != value {
            return None;
        }
        if index == 0 {
            prefix = text.get(cursor..start)?;
            if !matches!(prefix, "" | " ") {
                return None;
            }
        } else if text.get(cursor..start)? != ", " {
            return None;
        }
        cursor = end;
    }
    if entries.is_empty() {
        if inner_start != inner_end {
            return None;
        }
    } else {
        suffix = text.get(cursor..inner_end)?;
        if !matches!(suffix, "" | " ") {
            return None;
        }
    }
    let rendered = values
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()?;
    if !rendered
        .iter()
        .all(|value| value.is_ascii() && safe_plain_string(value))
    {
        return None;
    }
    if entries.is_empty() && !rendered.is_empty()
        || rendered.is_empty() && (!prefix.is_empty() || !suffix.is_empty())
    {
        return None;
    }
    let replacement = if rendered.is_empty() {
        String::new()
    } else {
        format!("{prefix}{}{suffix}", rendered.join(", "))
    };
    let mut output = text.to_owned();
    output.replace_range(inner_start..inner_end, &replacement);
    Some(output)
}

struct BlockItemLine<'a> {
    start: usize,
    end: usize,
    indent: &'a str,
    newline: &'a str,
}

fn next_sibling_has_less_indent(text: &str, line: &BlockItemLine<'_>) -> bool {
    let Some(next) = text.get(line.end..).and_then(|rest| rest.lines().next()) else {
        return false;
    };
    !next.is_empty()
        && !next.trim_start().starts_with('#')
        && next.bytes().take_while(|byte| *byte == b' ').count() < line.indent.len()
}

fn block_item_line<'a>(
    text: &'a str,
    entry: &'a Node,
) -> Option<(&'a str, ScalarStyle, BlockItemLine<'a>)> {
    let Node::Scalar { value, style, span } = entry else {
        return None;
    };
    let value_start = char_to_byte(text, span.start.index())?;
    let start = text.get(..value_start)?.rfind('\n').map_or(0, |at| at + 1);
    let end = value_start + text.get(value_start..)?.find('\n')? + 1;
    let prefix = text.get(start..value_start)?;
    let indent = prefix.strip_suffix("- ")?;
    if !indent.chars().all(|ch| ch == ' ') || indent.is_empty() {
        return None;
    }
    let newline = if text.get(start..end)?.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let body_end = end - newline.len();
    let source = match style {
        ScalarStyle::Plain if safe_plain_string(value) => value.clone(),
        ScalarStyle::DoubleQuoted if safe_quoted_ascii(value) => format!("\"{value}\""),
        _ => return None,
    };
    let value_end = value_start.checked_add(source.len())?;
    if text.get(value_start..value_end)? != source {
        return None;
    }
    let trailing = text.get(value_end..body_end)?;
    if !trailing.is_empty() && !trailing.starts_with(" #") {
        return None;
    }
    Some((
        value,
        *style,
        BlockItemLine {
            start,
            end,
            indent,
            newline,
        },
    ))
}

/// Preserve a surviving block-list item and update one neighboring plain item.
/// Other list layouts continue to use TypeScript's comment-aware YAML editor.
#[must_use]
pub fn replace_block_list(text: &str, path: &[Value], values: &[Value]) -> Option<String> {
    let root = parse_document(text)?;
    let Node::Seq {
        opening, entries, ..
    } = lookup(&root, path)?
    else {
        return None;
    };
    let open = char_to_byte(text, opening.start.index())?;
    if text.get(open..open + 1)? == "[" || entries.is_empty() || values.len() != 2 {
        return None;
    }
    let first_value = values[0].as_str()?;
    let second_value = values[1].as_str()?;
    if !second_value.is_ascii() || !safe_plain_string(second_value) {
        return None;
    }
    let (old_first, first_style, first_line) = block_item_line(text, &entries[0])?;
    if old_first != first_value {
        return None;
    }
    let mut output = text.to_owned();
    if entries.len() == 1 && first_style == ScalarStyle::Plain {
        if !next_sibling_has_less_indent(text, &first_line) {
            return None;
        }
        output.insert_str(
            first_line.end,
            &format!(
                "{}- {second_value}{}",
                first_line.indent, first_line.newline
            ),
        );
        return Some(output);
    }
    if entries.len() == 2 && first_style == ScalarStyle::DoubleQuoted {
        let (old_second, second_style, second_line) = block_item_line(text, &entries[1])?;
        if second_style != ScalarStyle::Plain
            || old_second == second_value
            || second_line.start != first_line.end
            || second_line.indent != first_line.indent
            || second_line.newline != first_line.newline
        {
            return None;
        }
        output.replace_range(
            second_line.start..second_line.end,
            &format!(
                "{}- {second_value}{}",
                second_line.indent, second_line.newline
            ),
        );
        return Some(output);
    }
    None
}

fn block_mapping_line<'a>(text: &'a str, entry: &MapEntry) -> Option<BlockItemLine<'a>> {
    let key_start = char_to_byte(text, entry.key_span.start.index())?;
    let key_end = char_to_byte(text, entry.key_span.end.index())?;
    let start = text.get(..key_start)?.rfind('\n').map_or(0, |at| at + 1);
    let end = key_start + text.get(key_start..)?.find('\n')? + 1;
    let indent = text.get(start..key_start)?;
    if indent.is_empty()
        || !indent.chars().all(|ch| ch == ' ')
        || !entry.key.is_ascii()
        || !safe_plain_string(&entry.key)
        || text.get(key_start..key_end)? != entry.key
    {
        return None;
    }
    let Node::Map {
        opening, closing, ..
    } = &entry.value
    else {
        return None;
    };
    let value_start = char_to_byte(text, opening.start.index())?;
    let value_end = char_to_byte(text, closing.start.index())?.checked_add(1)?;
    if text.get(key_end..value_start)? != ": "
        || text.get(value_start..value_start + 1)? != "{"
        || text.get(value_end - 1..value_end)? != "}"
    {
        return None;
    }
    let newline = if text.get(start..end)?.ends_with("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let trailing = text.get(value_end..end - newline.len())?;
    if !trailing.is_empty() && !trailing.starts_with(" #") {
        return None;
    }
    Some(BlockItemLine {
        start,
        end,
        indent,
        newline,
    })
}

fn safe_inline_atom(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '/'))
        && !matches!(value, "true" | "false" | "null")
}

fn render_inserted_inline_map(value: &Value) -> Option<String> {
    let object = value.as_object()?;
    let keys = object.keys().map(String::as_str).collect::<Vec<_>>();
    if keys != ["kind", "usage"] && keys != ["agent", "account", "model"] {
        return None;
    }
    let mut fields = Vec::with_capacity(object.len());
    for (key, value) in object {
        let atom = value.as_str()?;
        if !safe_inline_atom(atom) {
            return None;
        }
        fields.push(format!("{key}: {atom}"));
    }
    Some(format!("{{ {} }}", fields.join(", ")))
}

/// Append one supported inline mapping value to a simple block map.
/// A future public selector must also prove the input object's field order:
/// `serde_json::Value` may not retain the transport's original key order.
#[must_use]
pub fn insert_block_mapping_entry(text: &str, path: &[Value], value: &Value) -> Option<String> {
    let (key, parent_path) = path.split_last()?;
    let key = key.as_str()?;
    if !key.is_ascii() || !safe_plain_string(key) {
        return None;
    }
    let root = parse_document(text)?;
    let Node::Map {
        opening, entries, ..
    } = lookup(&root, parent_path)?
    else {
        return None;
    };
    let open = char_to_byte(text, opening.start.index())?;
    if text.get(open..open + 1)? == "{"
        || entries.len() != 1
        || entries.iter().any(|entry| entry.key == key)
    {
        return None;
    }
    let last = block_mapping_line(text, &entries[0])?;
    if !next_sibling_has_less_indent(text, &last) {
        return None;
    }
    let rendered = render_inserted_inline_map(value)?;
    let mut output = text.to_owned();
    output.insert_str(
        last.end,
        &format!("{}{key}: {rendered}{}", last.indent, last.newline),
    );
    Some(output)
}

/// Delete one supported block-map line, retaining surrounding source bytes.
#[must_use]
pub fn delete_block_mapping_entry(text: &str, path: &[Value]) -> Option<String> {
    let (key, parent_path) = path.split_last()?;
    let key = key.as_str()?;
    let root = parse_document(text)?;
    let Node::Map {
        opening, entries, ..
    } = lookup(&root, parent_path)?
    else {
        return None;
    };
    let open = char_to_byte(text, opening.start.index())?;
    if text.get(open..open + 1)? == "{" || !(1..=2).contains(&entries.len()) {
        return None;
    }
    let mut found = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| entry.key == key);
    let (index, entry) = found.next()?;
    if found.next().is_some() || index != 0 {
        return None;
    }
    let line = block_mapping_line(text, entry)?;
    let mut output = text.to_owned();
    if entries.len() == 1 {
        output.replace_range(
            line.start..line.end,
            &format!("{}{{}}{}", line.indent, line.newline),
        );
    } else {
        let next = block_mapping_line(text, &entries[1])?;
        if next.start != line.end || next.indent != line.indent || next.newline != line.newline {
            return None;
        }
        output.replace_range(line.start..line.end, "");
    }
    Some(output)
}
