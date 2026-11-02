use pacer_foundation::js_semantics::JsTrim;
use saphyr_parser::{Event, Parser, ScalarStyle, Tag};
use serde_json::{Map, Value};
use std::ops::Range;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct EditError(pub String);

type Result<T> = std::result::Result<T, EditError>;

#[derive(Clone, Debug)]
struct Node {
    span: Range<usize>,
    core_end: usize,
    kind: Kind,
    // yaml checks only direct scalar keys, not resolved aliases or collections.
    scalar_key: Option<crate::yaml_value::Value>,
}

#[derive(Clone, Debug)]
enum Kind {
    Scalar(crate::yaml_value::Value),
    Seq(Vec<Node>, bool),
    Map(Vec<(Node, Node)>, bool),
}

impl Node {
    fn semantic_value(&self) -> crate::yaml_value::Value {
        use crate::yaml_value::Value as Y;
        match &self.kind {
            Kind::Scalar(v) => v.clone(),
            Kind::Seq(items, _) => Y::Array(items.iter().map(Node::semantic_value).collect()),
            Kind::Map(items, _) => Y::Object(
                items
                    .iter()
                    .map(|(k, v)| (k.semantic_value().string(), v.semantic_value()))
                    .collect(),
            ),
        }
    }
    fn value(&self) -> Value {
        self.semantic_value().to_json()
    }
    fn child(&self, key: &Value) -> Option<&Node> {
        match &self.kind {
            Kind::Map(items, _) => items
                .iter()
                .find(|(k, _)| k.value() == *key)
                .map(|(_, v)| v),
            Kind::Seq(items, _) => key.as_u64().and_then(|i| items.get(i as usize)),
            Kind::Scalar(_) => None,
        }
    }
    fn at(&self, path: &[Value]) -> Option<&Node> {
        let mut node = self;
        for key in path {
            node = node.child(key)?;
        }
        Some(node)
    }
    fn flow(&self) -> bool {
        matches!(&self.kind, Kind::Map(_, true) | Kind::Seq(_, true))
    }
}

struct Frame {
    start: usize,
    mapping: bool,
    anchor: usize,
    children: Vec<Node>,
}

fn byte_index(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map_or(text.len(), |(i, _)| i)
}

fn yaml_scalar(content: &str) -> crate::yaml_value::Value {
    use crate::yaml_value::Value as Y;
    match content {
        "null" | "Null" | "NULL" | "~" | "" => Y::Null,
        "true" | "True" | "TRUE" => Y::Bool(true),
        "false" | "False" | "FALSE" => Y::Bool(false),
        ".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => Y::Number(f64::INFINITY),
        "-.inf" | "-.Inf" | "-.INF" => Y::Number(f64::NEG_INFINITY),
        ".nan" | ".NaN" | ".NAN" => Y::Number(f64::NAN),
        _ => {
            let unsigned = content.strip_prefix(['+', '-']).unwrap_or(content);
            if unsigned.starts_with("0x") || unsigned.starts_with("0o") {
                let radix = if unsigned.starts_with("0x") { 16 } else { 8 };
                let digits = &unsigned[2..];
                if digits.is_empty()
                    || !digits.bytes().all(|byte| {
                        if radix == 16 {
                            byte.is_ascii_hexdigit()
                        } else {
                            matches!(byte, b'0'..=b'7')
                        }
                    })
                {
                    return Y::String(content.into());
                }
                return u64::from_str_radix(digits, radix)
                    .map(|v| Y::Number(v as f64 * if content.starts_with('-') { -1. } else { 1. }))
                    .unwrap_or_else(|_| Y::String(content.into()));
            }
            // Rust also parses bare inf/NaN. YAML's numeric grammar does not.
            if content
                .bytes()
                .any(|b| !matches!(b, b'0'..=b'9' | b'+' | b'-' | b'.' | b'e' | b'E'))
            {
                return Y::String(content.into());
            }
            content
                .parse::<f64>()
                .map(Y::Number)
                .unwrap_or_else(|_| Y::String(content.into()))
        }
    }
}

// yaml's core int keys use JavaScript parseInt without Bun's u64 limit.
// Preserve its nearest-even rounding using the first 53 significant bits.
fn core_radix_number(digits: &str, radix: u32) -> Option<f64> {
    let width = if radix == 16 { 4 } else { 3 };
    let mut mantissa = 0_u64;
    let mut bits = 0_usize;
    let mut round = false;
    let mut sticky = false;
    if digits.is_empty() {
        return None;
    }
    for byte in digits.bytes() {
        let digit = char::from(byte).to_digit(radix)?;
        for shift in (0..width).rev() {
            let bit = (digit >> shift) & 1;
            if bits == 0 && bit == 0 {
                continue;
            }
            bits += 1;
            if bits <= 53 {
                mantissa = mantissa * 2 + u64::from(bit);
            } else if bits == 54 {
                round = bit != 0;
            } else {
                sticky |= bit != 0;
            }
        }
    }
    if bits > 1024 {
        return Some(f64::INFINITY);
    }
    if round && (sticky || mantissa & 1 != 0) {
        mantissa += 1;
    }
    Some(mantissa as f64 * 2_f64.powi(bits.saturating_sub(53) as i32))
}

fn core_plain_scalar(content: &str) -> crate::yaml_value::Value {
    use crate::yaml_value::Value as Y;
    for (prefix, radix) in [("0x", 16), ("0o", 8)] {
        if let Some(digits) = content.strip_prefix(prefix) {
            return core_radix_number(digits, radix)
                .map_or_else(|| Y::String(content.into()), Y::Number);
        }
    }
    if content
        .strip_prefix(['+', '-'])
        .is_some_and(|text| text.starts_with("0x") || text.starts_with("0o"))
    {
        return Y::String(content.into());
    }
    yaml_scalar(content)
}

fn editor_scalar_key(
    content: &str,
    style: ScalarStyle,
    tag: Option<&Tag>,
) -> crate::yaml_value::Value {
    use crate::yaml_value::Value as Y;
    if let Some(tag) = tag {
        let value = core_plain_scalar(content);
        let unsigned = content.strip_prefix(['+', '-']).unwrap_or(content);
        let integer = !unsigned.is_empty() && unsigned.bytes().all(|byte| byte.is_ascii_digit())
            || content.starts_with("0x")
            || content.starts_with("0o");
        let suffix = if tag.is_yaml_core_schema() {
            Some(tag.suffix.as_str())
        } else if tag.handle.is_empty() {
            tag.suffix.strip_prefix("tag:yaml.org,2002:")
        } else {
            None
        };
        let valid = match suffix {
            Some("int") => value.is_number() && integer,
            Some("float") => value.is_number() && !integer,
            Some("bool") => value.is_boolean(),
            Some("null") => value.is_null(),
            _ => false,
        };
        if valid {
            value
        } else {
            Y::String(content.into())
        }
    } else if style == ScalarStyle::Plain {
        core_plain_scalar(content)
    } else {
        Y::String(content.into())
    }
}

fn scalar(
    text: &str,
    span: Range<usize>,
    content: &str,
    style: ScalarStyle,
    tag: Option<&Tag>,
) -> Node {
    let span = if matches!(style, ScalarStyle::Literal | ScalarStyle::Folded) {
        let indicator_end = text[..span.start].rfind('\n').unwrap_or(span.start);
        let line_start = text[..indicator_end].rfind('\n').map_or(0, |p| p + 1);
        let indicator = if style == ScalarStyle::Literal {
            '|'
        } else {
            '>'
        };
        let start = text[line_start..indicator_end]
            .rfind(indicator)
            .map_or(span.start, |p| line_start + p);
        start..span.end
    } else {
        span
    };
    let value = if style == ScalarStyle::Plain {
        let value = yaml_scalar(content);
        if let Some(tag) = tag {
            let valid = tag.is_yaml_core_schema()
                && match tag.suffix.as_str() {
                    "int" | "float" => value.is_number(),
                    "bool" => value.is_boolean(),
                    "null" => value.is_null(),
                    _ => false,
                };
            if valid {
                value
            } else {
                crate::yaml_value::Value::String(content.into())
            }
        } else {
            value
        }
    } else {
        crate::yaml_value::Value::String(content.into())
    };
    let tail = &text[span.clone()];
    let core_end = if tail.starts_with('\'') {
        let mut i = 1;
        let bytes = tail.as_bytes();
        while i < bytes.len() {
            if bytes[i] == b'\'' {
                if bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                i += 1;
                break;
            }
            i += 1;
        }
        span.start + i
    } else if let Some(stripped) = tail.strip_prefix('"') {
        let mut escaped = false;
        let mut i = 1;
        for c in stripped.chars() {
            i += c.len_utf8();
            if c == '"' && !escaped {
                break;
            }
            escaped = c == '\\' && !escaped;
            if c != '\\' {
                escaped = false;
            }
        }
        span.start + i
    } else if tail.starts_with('|') || tail.starts_with('>') {
        span.end
    } else {
        let line = tail.split('\n').next().unwrap_or(tail);
        let stop = line.find(" #").unwrap_or(line.len());
        span.start + line[..stop].trim_end_matches([' ', '\r']).len()
    };
    // Editor keys resolve using yaml's core schema, including explicit tags;
    // the strategy loader above deliberately follows Bun's distinct behavior.
    let scalar_key = editor_scalar_key(content, style, tag);
    Node {
        span,
        core_end,
        kind: Kind::Scalar(value),
        scalar_key: Some(scalar_key),
    }
}

fn same_key(left: &Node, right: &Node) -> bool {
    match (&left.scalar_key, &right.scalar_key) {
        // f64 equality matches JS === here: NaN is never equal to itself.
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// Match yaml's prettifyError: columns and truncation count UTF-16 code units.
fn duplicate_key_error(text: &str, key: &Node) -> EditError {
    let mut offset = key.span.start;
    // Parser scalar spans include node properties; yaml reports the key itself.
    if matches!(key.kind, Kind::Scalar(_)) {
        while text[offset..].starts_with(['&', '!']) {
            let Some(width) = text[offset..].find(char::is_whitespace) else {
                break;
            };
            offset += width;
            let tail = &text[offset..];
            offset += tail.len() - tail.trim_start_matches(char::is_whitespace).len();
        }
    }
    let line = text[..offset].bytes().filter(|byte| *byte == b'\n').count() + 1;
    let line_start = text[..offset].rfind('\n').map_or(0, |at| at + 1);
    let column = text[line_start..offset].encode_utf16().count() + 1;
    let mut caret = column - 1;
    let end = text[line_start..]
        .find('\n')
        .map_or(text.len(), |at| line_start + at + 1);
    let mut current = text[line_start..end]
        .trim_end_matches(['\n', '\r'])
        .encode_utf16()
        .collect::<Vec<_>>();
    if caret >= 60 && current.len() > 80 {
        let start = (caret - 39).min(current.len() - 79);
        current = std::iter::once(0x2026)
            .chain(current[start..].iter().copied())
            .collect();
        caret -= start - 1;
    }
    if current.len() > 80 {
        current.truncate(79);
        current.push(0x2026);
    }
    let include_previous = line > 1
        && current[..caret.min(current.len())]
            .iter()
            .all(|c| *c == b' ' as u16);
    let mut excerpt = String::new();
    if include_previous {
        let previous_start = text[..line_start - 1].rfind('\n').map_or(0, |at| at + 1);
        let mut previous = text[previous_start..line_start]
            .encode_utf16()
            .collect::<Vec<_>>();
        if previous.len() > 80 {
            previous.truncate(79);
            previous.extend([0x2026, b'\n' as u16]);
        }
        excerpt.push_str(&String::from_utf16_lossy(&previous));
    }
    excerpt.push_str(&String::from_utf16_lossy(&current));
    EditError(format!(
        "Map keys must be unique at line {line}, column {column}:\n\n{excerpt}\n{}^\n",
        " ".repeat(caret)
    ))
}

fn parse(text: &str, unique_keys: bool) -> Result<Node> {
    let mut stack: Vec<Frame> = Vec::new();
    let mut root = None;
    let mut anchors = std::collections::HashMap::<usize, Node>::new();
    for event in Parser::new_from_str(text) {
        let (event, span) = event.map_err(|e| {
            let message = e.to_string();
            if message.starts_with("while parsing a flow sequence") && text.matches('[').count() > text.matches(']').count() {
                let line = text.bytes().filter(|byte| *byte == b'\n').count() + 1;
                return EditError(format!("Flow sequence in block collection must be sufficiently indented and end with a ] at line {line}, column 1:\n\n{}\n^\n", text));
            }
            if message.starts_with("while parsing a block mapping, did not find expected key") {
                let line = e.marker().line();
                let lines: Vec<&str> = text.split('\n').collect();
                if let Some(current) = lines.get(line.saturating_sub(1)) && current.trim_start_matches(' ').starts_with("- ") {
                    let previous = lines.get(line.saturating_sub(2)).copied().unwrap_or("");
                    let current = current.trim_end_matches('\r');
                    return EditError(format!("A block sequence may not be used as an implicit map key at line {line}, column 1:\n\n{previous}\n{current}\n^\n"));
                }
            }
            EditError(message)
        })?;
        let start = byte_index(text, span.start.index());
        let end = byte_index(text, span.end.index());
        let node = match event {
            Event::Scalar(content, style, anchor, tag) => {
                let node = scalar(text, start..end, &content, style, tag.as_deref());
                if anchor != 0 {
                    anchors.insert(anchor, node.clone());
                }
                Some(node)
            }
            Event::Alias(anchor) => anchors.get(&anchor).cloned().map(|mut node| {
                node.span = start..end;
                node.core_end = end;
                node.scalar_key = None;
                node
            }),
            Event::MappingStart(anchor, _) | Event::SequenceStart(anchor, _) => {
                stack.push(Frame {
                    start,
                    mapping: matches!(event, Event::MappingStart(..)),
                    anchor,
                    children: Vec::new(),
                });
                None
            }
            Event::MappingEnd | Event::SequenceEnd => {
                let frame = stack
                    .pop()
                    .ok_or_else(|| EditError("invalid YAML collection".into()))?;
                let flow = text[frame.start..].starts_with(if frame.mapping { '{' } else { '[' });
                if unique_keys && frame.mapping {
                    let pairs = frame.children.as_chunks::<2>().0;
                    for (index, pair) in pairs.iter().enumerate() {
                        if pairs[..index].iter().any(|old| same_key(&old[0], &pair[0])) {
                            return Err(duplicate_key_error(text, &pair[0]));
                        }
                    }
                }
                let kind = if frame.mapping {
                    Kind::Map(
                        frame
                            .children
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|pair| (pair[0].clone(), pair[1].clone()))
                            .collect(),
                        flow,
                    )
                } else {
                    Kind::Seq(frame.children, flow)
                };
                let core_end = if flow {
                    let closer = if frame.mapping { '}' } else { ']' };
                    text[frame.start..end]
                        .rfind(closer)
                        .map_or(end, |p| frame.start + p + 1)
                } else {
                    end - text[frame.start..end]
                        .chars()
                        .rev()
                        .take_while(|c| *c == ' ')
                        .count()
                };
                let node = Node {
                    span: frame.start..end,
                    core_end,
                    kind,
                    scalar_key: None,
                };
                if frame.anchor != 0 {
                    anchors.insert(frame.anchor, node.clone());
                }
                Some(node)
            }
            _ => None,
        };
        if let Some(node) = node {
            if let Some(frame) = stack.last_mut() {
                frame.children.push(node);
            } else {
                root = Some(node);
            }
        }
    }
    root.ok_or_else(|| EditError("empty strategy document".into()))
}

/// JSON representation for document consumers. Validation reads the lossless
/// tree with `parse_yaml_value`; non-finite numbers become null only here.
pub fn parse_value(text: &str) -> Result<Value> {
    parse_yaml_value(text).map(|value| value.to_json())
}
pub(crate) fn parse_yaml_value(text: &str) -> Result<crate::yaml_value::Value> {
    // Bun.YAML.parse accepts duplicate keys; only the YAML document editor refuses them.
    parse(text, false).map(|node| {
        let mut value = node.semantic_value();
        value.normalize();
        value
    })
}

fn key_text(key: &Value) -> String {
    key.as_str().map_or_else(|| key.to_string(), str::to_owned)
}
fn path_text(path: &[Value]) -> String {
    path.iter().map(key_text).collect::<Vec<_>>().join(".")
}

/// Source span editor for strategy YAML. Offsets are byte offsets, preserving
/// untouched comments, whitespace, line endings, and scalar spelling.
pub struct StrategyDoc {
    text: String,
}

impl StrategyDoc {
    pub fn new(text: impl Into<String>) -> Self {
        Self { text: text.into() }
    }
    pub fn as_str(&self) -> &str {
        &self.text
    }
    fn replace(&mut self, range: Range<usize>, value: &str) {
        self.text.replace_range(range, value);
    }
    fn newline(&self) -> &'static str {
        if self.text.contains("\r\n") {
            "\r\n"
        } else {
            "\n"
        }
    }
    fn column(&self, offset: usize) -> usize {
        offset - self.text[..offset].rfind('\n').map_or(0, |p| p + 1)
    }
    fn document(&self) -> Result<Node> {
        parse(&self.text, true)
    }
    pub fn get_in(&self, path: &[Value]) -> Result<Option<Value>> {
        Ok(self.document()?.at(path).map(Node::value))
    }
    pub fn set_in(&mut self, path: &[Value], value: &Value) -> Result<()> {
        if path.is_empty() {
            return Err(EditError("a strategy key is required".into()));
        }
        let doc = self.document()?;
        if let Some(old) = doc.at(path) {
            return self.replace_node_at(&doc, path, old, value, true);
        }
        let parent_path = &path[..path.len() - 1];
        let parent = doc.at(parent_path);
        if parent.is_none() && !parent_path.is_empty() {
            let mut map = Map::new();
            map.insert(key_text(path.last().unwrap_or(&Value::Null)), value.clone());
            return self.set_in(parent_path, &Value::Object(map));
        }
        let Some(Node {
            kind: Kind::Map(items, flow),
            span,
            ..
        }) = parent
        else {
            return Err(EditError(format!(
                "strategy key is not a mapping: {}",
                path_text(parent_path)
            )));
        };
        let key = key_text(path.last().unwrap_or(&Value::Null));
        let line = format!(
            "{}: {}",
            emit_scalar(&Value::String(key), None),
            emit(value, true, 0)
        );
        if *flow {
            let at = items.last().map_or(span.start + 1, |(_, v)| v.core_end);
            self.replace(
                at..at,
                &format!("{}{}", if items.is_empty() { "" } else { ", " }, line),
            );
        } else {
            let indent = items.first().map_or(0, |(k, _)| self.column(k.span.start));
            let end = span.end;
            let prefix = if end > 0 && !self.text[..end].ends_with('\n') {
                self.newline()
            } else {
                ""
            };
            self.replace(
                end..end,
                &format!("{prefix}{}{line}{}", " ".repeat(indent), self.newline()),
            );
        }
        Ok(())
    }
    fn replace_node_at(
        &mut self,
        doc: &Node,
        path: &[Value],
        old: &Node,
        value: &Value,
        preserve_scalar_style: bool,
    ) -> Result<()> {
        let parent = doc.at(&path[..path.len().saturating_sub(1)]);
        let flow = old.flow()
            || parent.is_some_and(Node::flow)
            || ((value.is_array() || value.is_object())
                && matches!(old.kind, Kind::Scalar(_))
                && preserve_scalar_style);
        let mut rendered = emit(value, flow, 0);
        if value.is_array()
            && old.flow()
            && !self.text[old.span.start..old.core_end].starts_with("[ ")
            && rendered.starts_with("[ ")
            && rendered.ends_with(" ]")
        {
            rendered = format!("[{}]", &rendered[2..rendered.len() - 2]);
        }
        if preserve_scalar_style && value.is_string() {
            let src = &self.text[old.span.clone()];
            rendered = emit_scalar(value, Some(src));
        }
        let empty_collection = value.as_array().is_some_and(Vec::is_empty)
            || value.as_object().is_some_and(Map::is_empty);
        let block = (value.is_array() || value.is_object()) && !flow && !empty_collection;
        let was_block = matches!(&old.kind, Kind::Map(_, false) | Kind::Seq(_, false));
        let line_start = self.text[..old.span.start].rfind('\n').map_or(0, |p| p + 1);
        let key_indent = self.text[line_start..]
            .chars()
            .take_while(|c| *c == ' ')
            .count();
        let indent = if block && !was_block {
            key_indent + 2
        } else {
            self.column(old.span.start)
        };
        rendered = rendered.replace('\n', &format!("{}{}", self.newline(), " ".repeat(indent)));
        if block && !was_block {
            rendered = format!("{}{}{rendered}", self.newline(), " ".repeat(indent));
        }
        if self.text[..old.core_end].ends_with('\n') {
            rendered.push_str(self.newline());
        }
        self.replace(old.span.start..old.core_end, &rendered);
        Ok(())
    }
    pub fn delete_in(&mut self, path: &[Value]) -> Result<()> {
        let doc = self.document()?;
        let parent = doc.at(&path[..path.len().saturating_sub(1)]);
        let Some(Node {
            kind: Kind::Map(items, flow),
            ..
        }) = parent
        else {
            return Err(EditError("strategy key is not a mapping".into()));
        };
        let Some(index) = items
            .iter()
            .position(|(k, _)| k.value() == *path.last().unwrap_or(&Value::Null))
        else {
            return Ok(());
        };
        if *flow {
            let (key, val) = &items[index];
            let start = if index > 0 && index + 1 == items.len() {
                items[index - 1].1.core_end
            } else {
                key.span.start
            };
            let end = if index + 1 < items.len() {
                items[index + 1].0.span.start
            } else {
                val.core_end
            };
            self.replace(start..end, "");
        } else if items.len() == 1 {
            let parent_path = &path[..path.len() - 1];
            let old = parent.ok_or_else(|| EditError("strategy key is not a mapping".into()))?;
            self.replace_node_at(&doc, parent_path, old, &Value::Object(Map::new()), false)?;
        } else {
            let (key, val) = &items[index];
            let start = key.span.start - self.column(key.span.start);
            let end = if val.span.start == val.core_end && index + 1 < items.len() {
                items[index + 1].0.span.start
            } else if self.text[val.span.end..].starts_with("\r\n") {
                val.span.end + 2
            } else if self.text[val.span.end..].starts_with('\n') {
                val.span.end + 1
            } else {
                val.span.end
            };
            self.replace(start..end, "");
        }
        Ok(())
    }
    pub fn add_mapping_entry(&mut self, section: &str, name: &str, value: &Value) -> Result<()> {
        let path = [Value::String(section.into()), Value::String(name.into())];
        if self.document()?.at(&path).is_some() {
            return Err(EditError(format!("{section}.{name} already exists")));
        }
        self.set_in(&path, value)
    }
    pub fn remove_mapping_entry(&mut self, section: &str, name: &str) -> Result<()> {
        self.delete_in(&[Value::String(section.into()), Value::String(name.into())])
    }
    pub fn set_scalar(&mut self, path: &[Value], value: &Value) -> Result<()> {
        self.set_in(path, value)
    }
    pub fn set_list(&mut self, path: &[Value], value: &[Value]) -> Result<()> {
        let doc = self.document()?;
        if let Some(Node {
            kind: Kind::Seq(items, false),
            span,
            core_end,
            ..
        }) = doc.at(path)
            && value.iter().all(Value::is_string)
            && items
                .iter()
                .all(|item| matches!(item.kind, Kind::Scalar(_)))
        {
            let mut remaining = items.clone();
            let mut lines = Vec::new();
            for entry in value {
                let retained = remaining
                    .iter()
                    .position(|item| item.value() == *entry)
                    .map(|i| remaining.remove(i));
                let rendered = if let Some(item) = retained {
                    let source = self.text[item.span.start..item.core_end].to_owned();
                    let after = &self.text[item.core_end..];
                    let comment = after
                        .split('\n')
                        .next()
                        .unwrap_or("")
                        .trim_end_matches('\r');
                    format!(
                        "{source}{}",
                        if comment.trim_start().starts_with('#') {
                            comment
                        } else {
                            ""
                        }
                    )
                } else {
                    emit_scalar(entry, None)
                };
                lines.push(format!("- {rendered}"));
            }
            let mut rendered = lines.join(&format!(
                "{}{}",
                self.newline(),
                " ".repeat(self.column(span.start))
            ));
            if self.text[..*core_end].ends_with('\n') {
                rendered.push_str(self.newline());
            }
            self.replace(span.start..*core_end, &rendered);
            return Ok(());
        }
        self.set_in(path, &Value::Array(value.to_vec()))
    }

    /// Remove mapping entries from a block sequence after their child lists
    /// have been edited. Surviving entries retain their source bytes.
    pub fn remove_sequence_indices(&mut self, path: &[Value], indices: &[usize]) -> Result<()> {
        let doc = self.document()?;
        let Some(Node {
            kind: Kind::Seq(items, false),
            ..
        }) = doc.at(path)
        else {
            return Err(EditError("strategy key is not a block list".into()));
        };
        for index in indices.iter().rev() {
            let item = items
                .get(*index)
                .ok_or_else(|| EditError("missing list item".into()))?;
            let start = self.text[..item.span.start]
                .rfind('\n')
                .map_or(0, |at| at + 1);
            let end = if let Some(next) = items.get(index + 1) {
                self.text[..next.span.start]
                    .rfind('\n')
                    .map_or(0, |at| at + 1)
            } else {
                item.span.end
            };
            self.replace(start..end, "");
        }
        // The TypeScript editor reserializes the surviving YAML nodes when
        // filtering a sequence. Its default flow collection padding is on.
        let updated = self.document()?;
        let Some(Node {
            kind: Kind::Seq(survivors, false),
            ..
        }) = updated.at(path)
        else {
            return Ok(());
        };
        let mut ranges = Vec::new();
        for item in survivors {
            if let Kind::Map(entries, _) = &item.kind {
                for (_, value) in entries {
                    if matches!(value.kind, Kind::Seq(_, true)) {
                        ranges.push((value.span.start..value.core_end, true));
                    } else if matches!(value.kind, Kind::Seq(_, false) | Kind::Map(_, false)) {
                        let before = &self.text[..value.span.start];
                        if let Some(newline) = before.rfind('\n') {
                            let line_end = newline
                                - usize::from(
                                    before.as_bytes().get(newline.wrapping_sub(1)) == Some(&b'\r'),
                                );
                            let colon = before[..line_end].trim_end_matches(' ').len();
                            if colon < line_end && before[..colon].ends_with(':') {
                                ranges.push((colon..line_end, false));
                            }
                        }
                    }
                }
            }
        }
        ranges.sort_by_key(|(range, _)| range.start);
        for (range, flow) in ranges.into_iter().rev() {
            if !flow {
                self.replace(range, "");
                continue;
            }
            let source = &self.text[range.clone()];
            if source.starts_with('[')
                && source.ends_with(']')
                && !source.starts_with("[ ")
                && source != "[]"
            {
                self.replace(range, &format!("[ {} ]", &source[1..source.len() - 1]));
            }
        }
        Ok(())
    }
    /// `routing.set` reuses the edited prefix nodes when its rule count changes.
    /// The TypeScript node serializer pads flow collections in those clones.
    pub fn set_sequence_preserving_prefix(
        &mut self,
        path: &[Value],
        values: &[Value],
    ) -> Result<()> {
        let doc = self.document()?;
        let Some(Node {
            kind: Kind::Seq(items, false),
            span,
            ..
        }) = doc.at(path)
        else {
            return self.set_list(path, values);
        };
        let indent = self.column(span.start);
        let mut rendered = String::new();
        for (index, value) in values.iter().enumerate() {
            if index < items.len() {
                let start = self.text[..items[index].span.start]
                    .rfind('\n')
                    .map_or(0, |at| at + 1);
                let end = if index + 1 < items.len() {
                    self.text[..items[index + 1].span.start]
                        .rfind('\n')
                        .map_or(0, |at| at + 1)
                } else {
                    span.end
                };
                let source = &self.text[start..end];
                for line in source.split_inclusive('\n') {
                    if let (Some(open), Some(close)) = (line.find('['), line.find(']'))
                        && close > open + 1
                        && !line[open + 1..].starts_with(' ')
                    {
                        rendered.push_str(&line[..open + 1]);
                        rendered.push(' ');
                        rendered.push_str(&line[open + 1..close]);
                        rendered.push(' ');
                        rendered.push_str(&line[close..]);
                        continue;
                    }
                    rendered.push_str(line);
                }
            } else {
                rendered.push_str(&" ".repeat(indent));
                rendered.push_str("- ");
                rendered.push_str(
                    &emit(value, false, 0).replace('\n', &format!("\n{}", " ".repeat(indent + 2))),
                );
                rendered.push('\n');
            }
        }
        let line_start = self.text[..span.start].rfind('\n').map_or(0, |at| at + 1);
        self.replace(line_start..span.end, &rendered);
        Ok(())
    }
    /// Apply the serializable node-clone transforms used by the strategy-doc
    /// conformance corpus. The resulting edit is still confined to the old
    /// node's source range, as in the TypeScript editor.
    pub fn replace_node(&mut self, path: &[Value], recipe: &Value) -> Result<()> {
        let doc = self.document()?;
        let kind = recipe.get("kind").and_then(Value::as_str).unwrap_or("");
        let old = doc
            .at(path)
            .ok_or_else(|| EditError(format!("missing strategy key: {}", path_text(path))))?;
        match kind {
            "yaml" => {
                let yaml = recipe.get("yaml").and_then(Value::as_str).unwrap_or("");
                let parsed = parse(yaml, true)?;
                let parent = doc.at(&path[..path.len().saturating_sub(1)]);
                if parent.is_some_and(Node::flow)
                    && matches!(parsed.kind, Kind::Map(..) | Kind::Seq(..))
                {
                    return self.replace_node_at(&doc, path, old, &parsed.value(), false);
                }
                let rendered = yaml.trim_end_matches(['\n', '\r']);
                let block = matches!(parsed.kind, Kind::Map(_, false) | Kind::Seq(_, false));
                let was_block = matches!(old.kind, Kind::Map(_, false) | Kind::Seq(_, false));
                let line_start = self.text[..old.span.start].rfind('\n').map_or(0, |p| p + 1);
                let key_indent = self.text[line_start..]
                    .chars()
                    .take_while(|c| *c == ' ')
                    .count();
                let indent = if block && !was_block {
                    key_indent + 2
                } else {
                    self.column(old.span.start)
                };
                let mut output =
                    rendered.replace('\n', &format!("{}{}", self.newline(), " ".repeat(indent)));
                if block && !was_block {
                    output = format!("{}{}{output}", self.newline(), " ".repeat(indent));
                }
                if self.text[..old.core_end].ends_with('\n') {
                    output.push_str(self.newline());
                }
                self.replace(old.span.start..old.core_end, &output);
                Ok(())
            }
            "append" | "insertAt" | "removeAt" => {
                let Kind::Seq(items, false) = &old.kind else {
                    return Err(EditError(format!(
                        "unsupported replacement transform: {kind}"
                    )));
                };
                let mut parts: Vec<String> = items
                    .iter()
                    .map(|item| {
                        let body = emit_clone(item, &self.text, false);
                        format!("- {body}")
                    })
                    .collect();
                if kind == "append" || kind == "insertAt" {
                    let value = recipe.get("value").unwrap_or(&Value::Null);
                    let child =
                        emit(value, false, 0).replace('\n', &format!("{}  ", self.newline()));
                    let body = format!("- {child}");
                    let at = if kind == "append" {
                        parts.len()
                    } else {
                        recipe.get("index").and_then(Value::as_u64).unwrap_or(0) as usize
                    };
                    parts.insert(at.min(parts.len()), body);
                } else {
                    let at = recipe.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    if at < parts.len() {
                        parts.remove(at);
                    }
                }
                let column = self.column(old.span.start);
                let mut output = if parts.is_empty() {
                    "[]".to_owned()
                } else {
                    parts.join(self.newline())
                };
                output = output.replace('\n', &format!("{}{}", self.newline(), " ".repeat(column)));
                if self.text[..old.core_end].ends_with('\n') {
                    output.push_str(self.newline());
                }
                self.replace(old.span.start..old.core_end, &output);
                Ok(())
            }
            "setEntries" => {
                let Kind::Map(items, false) = &old.kind else {
                    return Err(EditError(format!(
                        "unsupported replacement transform: {kind}"
                    )));
                };
                let Some(entries) = recipe.get("entries").and_then(Value::as_object) else {
                    return Err(EditError("replacement entries must be a mapping".into()));
                };
                if entries.keys().all(|key| {
                    items
                        .iter()
                        .any(|(k, _)| k.value() == Value::String(key.clone()))
                }) {
                    let mut replacements = Vec::new();
                    for (key, value) in entries {
                        if let Some((_, child)) = items
                            .iter()
                            .find(|(k, _)| k.value() == Value::String(key.clone()))
                        {
                            let raw = emit(value, child.flow(), 0);
                            replacements.push((child.span.start..child.core_end, raw));
                        }
                    }
                    replacements.sort_by_key(|item| std::cmp::Reverse(item.0.start));
                    for (span, raw) in replacements {
                        self.replace(span, &raw);
                    }
                    return Ok(());
                }
                let mut lines = Vec::new();
                for (key, value) in items {
                    let name = key_text(&key.value());
                    let mut line =
                        format!("{name}: {}", emit_clone(value, &self.text, value.flow()));
                    line.push_str(&inline_comment(value, &self.text));
                    lines.push(line);
                }
                for (key, value) in entries {
                    if items
                        .iter()
                        .any(|(k, _)| k.value() == Value::String(key.clone()))
                    {
                        continue;
                    }
                    let child = emit(value, false, 2);
                    if value.is_object() || value.is_array() {
                        lines.push(format!("{key}:{}  {child}", self.newline()));
                    } else {
                        lines.push(format!("{key}: {child}"));
                    }
                }
                let indent = self.column(old.span.start);
                let mut output = lines.join(self.newline());
                output = output.replace('\n', &format!("{}{}", self.newline(), " ".repeat(indent)));
                if self.text[..old.core_end].ends_with('\n') {
                    output.push_str(self.newline());
                }
                self.replace(old.span.start..old.core_end, &output);
                Ok(())
            }
            _ => Err(EditError(format!(
                "unsupported replacement transform: {kind}"
            ))),
        }
    }
    pub fn rename_key(&mut self, path: &[Value], name: &str) -> Result<()> {
        let doc = self.document()?;
        let parent = doc.at(&path[..path.len().saturating_sub(1)]);
        let Some(Node {
            kind: Kind::Map(items, _),
            ..
        }) = parent
        else {
            return Err(EditError("cannot rename strategy key".into()));
        };
        if items
            .iter()
            .any(|(k, _)| k.value() == Value::String(name.into()))
        {
            return Err(EditError("cannot rename strategy key".into()));
        }
        let key = items
            .iter()
            .find(|(k, _)| k.value() == *path.last().unwrap_or(&Value::Null))
            .map(|(k, _)| k);
        let Some(key) = key else {
            return Err(EditError("missing strategy key".into()));
        };
        self.replace(
            key.span.start..key.core_end,
            &emit_scalar(&Value::String(name.into()), None),
        );
        Ok(())
    }

    /// Add account kind to each legacy provider while keeping untouched source
    /// spans, including comments and scalar quoting.
    pub fn migrate_provider_kinds(&mut self, kinds: &Value) -> Result<()> {
        let doc = self.document()?;
        let Some(Node {
            kind: Kind::Map(providers, outer_flow),
            span: outer_span,
            core_end: outer_end,
            ..
        }) = doc.at(&[Value::String("providers".into())])
        else {
            return Err(EditError("providers must be a mapping".into()));
        };
        let mut edits: Vec<(Range<usize>, String)> = Vec::new();
        if *outer_flow {
            let open = outer_span.start;
            if self.text.as_bytes().get(open + 1) != Some(&b' ') {
                edits.push((open + 1..open + 1, " ".into()));
            }
            let close = outer_end - 1;
            if self.text.as_bytes().get(close - 1) != Some(&b' ') {
                edits.push((close..close, " ".into()));
            }
        }
        for (key, value) in providers {
            let name = key_text(&key.value());
            let kind = kinds
                .get(&name)
                .and_then(Value::as_str)
                .unwrap_or("endpoint");
            let Kind::Map(entries, flow) = &value.kind else {
                edits.push((value.span.clone(), format!("{{kind: {kind}}}")));
                continue;
            };
            if self.text[value.span.clone()].trim_start().starts_with('*') {
                let mut expanded = value.value();
                if let Some(map) = expanded.as_object_mut() {
                    map.remove("via");
                    map.insert("kind".into(), Value::String(kind.into()));
                }
                edits.push((value.span.clone(), emit(&expanded, true, 0)));
                continue;
            }
            let flow = *flow
                || self.text[value.span.clone()]
                    .split('\n')
                    .next()
                    .is_some_and(|line| line.contains('{') && line.contains('}'));
            if let Some((index, (via_key, via_value))) = entries
                .iter()
                .enumerate()
                .find(|(_, (k, _))| k.value() == Value::String("via".into()))
            {
                if flow {
                    let start = if index + 1 < entries.len() {
                        via_key.span.start
                    } else if index > 0 {
                        entries[index - 1].1.core_end
                    } else {
                        via_key.span.start
                    };
                    let end = if index + 1 < entries.len() {
                        entries[index + 1].0.span.start
                    } else {
                        via_value.core_end
                    };
                    edits.push((start..end, String::new()));
                } else {
                    let line_start = self.text[..via_key.span.start]
                        .rfind('\n')
                        .map_or(0, |i| i + 1);
                    let line_end = self.text[via_value.core_end..]
                        .find('\n')
                        .map_or(self.text.len(), |i| via_value.core_end + i + 1);
                    edits.push((line_start..line_end, String::new()));
                }
            }
            if flow {
                let before = self.text[value.span.start..value.core_end].trim_end();
                let closer = before
                    .rfind('}')
                    .map_or(value.core_end, |i| value.span.start + i);
                let open = value.span.start + self.text[value.span.clone()].find('{').unwrap_or(0);
                if !entries.is_empty() && self.text.as_bytes().get(open + 1) != Some(&b' ') {
                    edits.push((open + 1..open + 1, " ".into()));
                }
                let content_end = self.text[..closer].trim_end_matches(' ').len();
                edits.push((
                    content_end..content_end,
                    format!(
                        "{}kind: {kind}{}",
                        if entries.is_empty() { " " } else { ", " },
                        if content_end == closer { " " } else { "" }
                    ),
                ));
            } else {
                let indent = entries
                    .first()
                    .map_or(self.column(value.span.start) + 2, |(k, _)| {
                        self.column(k.span.start)
                    });
                edits.push((
                    value.span.end..value.span.end,
                    format!(
                        "{}{}kind: {kind}{}",
                        if self.text[..value.span.end].ends_with('\n') {
                            ""
                        } else {
                            self.newline()
                        },
                        " ".repeat(indent),
                        self.newline()
                    ),
                ));
            }
        }
        edits.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
        for (range, replacement) in edits {
            self.replace(range, &replacement);
        }
        Ok(())
    }
}

fn emit_scalar(value: &Value, original: Option<&str>) -> String {
    match value {
        Value::String(s) => {
            if original.is_some_and(|text| text.starts_with('>')) {
                let body = s.trim_end_matches('\n');
                return format!(">-\n{body}");
            }
            if s.contains('\n') || original.is_some_and(|text| text.starts_with('|')) {
                return format!("|\n{}", s.trim_end_matches('\n'));
            }
            if original.is_some_and(|text| text.starts_with('\'')) {
                return format!("'{}'", s.replace('\'', "''"));
            }
            if original.is_some_and(|text| text.starts_with('"')) {
                return serde_json::to_string(s).unwrap_or_default();
            }
            if s.is_empty()
                || s.parse::<f64>().is_ok()
                || matches!(s.as_str(), "true" | "false" | "null" | "~")
                || s.parse::<f64>().is_ok()
                || s.contains(": ")
                || s.contains(" #")
                || s.starts_with([
                    '{', '[', '-', '?', ':', '#', '!', '&', '*', '|', '>', '%', '@', '`',
                ])
            {
                return serde_json::to_string(s).unwrap_or_default();
            }
            s.to_owned()
        }
        Value::Number(number) => crate::js_semantics::number_text(number),
        _ => value.to_string(),
    }
}

fn emit_bun_scalar(value: &Value) -> String {
    if let Value::Number(number) = value
        && let Some(n) = number.as_f64()
        && n.fract() == 0.0
        && n.abs() < 1e21
    {
        if n == 0.0 && n.is_sign_negative() {
            return "-0".into();
        }
        return crate::js_semantics::number_text(number);
    }
    if let Value::String(s) = value {
        let lower = s.to_ascii_lowercase();
        let canonical_case = s.as_str() == lower
            || s.as_str() == s.to_ascii_uppercase()
            || s.as_str() == capitalize_ascii(&lower);
        let unsigned = s.strip_prefix('+').unwrap_or(s);
        let reserved = (canonical_case
            && matches!(
                lower.as_str(),
                "true" | "false" | "null" | "~" | "yes" | "no" | "on" | "off" | "y" | "n"
            ))
            || s.parse::<f64>().is_ok_and(f64::is_finite)
            || numeric_prefix_ambiguous(s)
            || (unsigned.get(2..).is_some_and(|digits| {
                !digits.is_empty()
                    && digits.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                    && digits.bytes().filter(|b| *b == b'-').count() <= 1
            }) && (unsigned.starts_with("0x") || unsigned.starts_with("0X")))
            || (unsigned.get(2..).is_some_and(|digits| {
                !digits.is_empty()
                    && digits
                        .bytes()
                        .all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-'))
                    && digits.bytes().filter(|b| *b == b'-').count() <= 1
            }) && (unsigned.starts_with("0o") || unsigned.starts_with("0O")))
            || matches!(lower.as_str(), ".inf" | ".nan")
            || matches!(s.as_str(), "." | "...");
        let syntax = s.is_empty()
            || s.js_trim() != s
            || s.starts_with([
                '{', '[', '-', '?', ':', '#', '!', '&', '*', '|', '>', '<', '%', '@', '`',
            ])
            || s.ends_with(':')
            || s.contains(": ")
            || s.chars().any(|ch| {
                ((ch as u32) <= 0x1f || ch == '\u{7f}' || ch == '\u{85}')
                    || matches!(
                        ch,
                        '\'' | '"'
                            | '#'
                            | ','
                            | '['
                            | ']'
                            | '{'
                            | '}'
                            | '`'
                            | '\u{2028}'
                            | '\u{2029}'
                    )
            });
        if reserved || syntax {
            return bun_quoted(s);
        }
        return s.clone();
    }
    emit_scalar(value, None)
}

fn capitalize_ascii(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
        None => String::new(),
    }
}

fn numeric_prefix_ambiguous(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 2 || !matches!(bytes[0], b'+' | b'-' | b'.' | b'0'..=b'9') {
        return false;
    }
    let mut signs = 0;
    let mut dots = 0;
    let mut exponents = 0;
    for byte in bytes {
        match byte {
            b'0'..=b'9' => {}
            b'+' | b'-' => signs += 1,
            b'.' => dots += 1,
            b'e' | b'E' => exponents += 1,
            _ => return false,
        }
    }
    dots <= 1
        && exponents <= 1
        && signs
            <= if matches!(bytes[0], b'+' | b'-') {
                2
            } else {
                1
            }
}

fn bun_quoted(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\0' => out.push_str("\\0"),
            '\u{7}' => out.push_str("\\a"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{b}' => out.push_str("\\v"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\u{85}' => out.push_str("\\N"),
            '\u{1b}' => out.push_str("\\e"),
            '\u{2028}' => out.push_str("\\L"),
            '\u{2029}' => out.push_str("\\P"),
            ch if ((ch as u32) <= 0x1f || ch == '\u{7f}') && (ch as u32) <= 0xff => {
                out.push_str(&format!("\\x{:02x}", ch as u32))
            }
            ch => out.push(ch),
        }
    }
    out.push('"');
    out
}

fn emit_style(value: &Value, flow: bool, indent: usize, bun: bool) -> String {
    let scalar = |value: &Value| {
        if bun {
            emit_bun_scalar(value)
        } else {
            emit_scalar(value, None)
        }
    };
    match value {
        Value::String(s)
            if flow && (s.contains(['{', '}', '[', ']', ',', '\n', '\r']) || s.trim() != s) =>
        {
            if s.contains('"') && !s.contains('\'') && !s.chars().any(char::is_control) {
                format!("'{s}'")
            } else {
                serde_json::to_string(s).unwrap_or_default()
            }
        }
        Value::Array(items) if items.is_empty() => "[]".into(),
        Value::Object(items) if items.is_empty() => "{}".into(),
        Value::Array(items) if flow => {
            if items.is_empty() {
                "[]".into()
            } else {
                format!(
                    "[ {} ]",
                    items
                        .iter()
                        .map(|v| emit_style(v, true, indent, bun))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        }
        Value::Object(items) if flow => format!(
            "{{ {} }}",
            items
                .iter()
                .map(|(k, v)| format!(
                    "{}: {}",
                    scalar(&Value::String(k.clone())),
                    emit_style(v, true, indent, bun)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                let child = emit_style(v, false, indent + 2, bun);
                if v.is_object() {
                    format!("- {}", child)
                } else if v.is_array() && !bun {
                    format!("-\n{}{}", " ".repeat(indent + 2), child)
                } else {
                    format!("- {child}")
                }
            })
            .collect::<Vec<_>>()
            .join(&format!("\n{}", " ".repeat(indent))),
        Value::Object(items) => items
            .iter()
            .map(|(k, v)| {
                let key = scalar(&Value::String(k.clone()));
                let child = emit_style(v, false, indent + 2, bun);
                if v.is_array() || v.is_object() {
                    format!("{key}:\n{}{}", " ".repeat(indent + 2), child)
                } else {
                    format!("{key}: {child}")
                }
            })
            .collect::<Vec<_>>()
            .join(&format!("\n{}", " ".repeat(indent))),
        _ => scalar(value),
    }
}

fn emit(value: &Value, flow: bool, indent: usize) -> String {
    emit_style(value, flow, indent, false)
}

/// Bun.YAML.stringify(value, null, 2) as used by strategy.save for the
/// normalized mapping/list shapes accepted by the strategy validator.
pub fn stringify_bun(value: &Value) -> String {
    let mut value = value.clone();
    crate::normalize_json(&mut value);
    let emitted = emit_style(&value, false, 0, true);
    emitted
        .split('\n')
        .map(|line| {
            if line.ends_with(':') {
                format!("{line} ")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn inline_comment(node: &Node, source: &str) -> String {
    let end = match &node.kind {
        Kind::Map(items, false) => items
            .last()
            .map_or(node.core_end, |(_, value)| value.core_end),
        Kind::Seq(items, false) => items.last().map_or(node.core_end, |value| value.core_end),
        _ => node.core_end,
    };
    let tail = source[end..]
        .split('\n')
        .next()
        .unwrap_or("")
        .trim_end_matches('\r');
    if tail.trim_start().starts_with('#') {
        tail.to_owned()
    } else {
        String::new()
    }
}

fn emit_clone(node: &Node, source: &str, flow: bool) -> String {
    match &node.kind {
        Kind::Scalar(value) => {
            if value.as_f64().is_some_and(|n| !n.is_finite()) {
                source[node.span.start..node.core_end].to_owned()
            } else {
                emit_scalar(
                    &value.to_json(),
                    Some(&source[node.span.start..node.core_end]),
                )
            }
        }
        Kind::Seq(items, _) if flow => {
            if items.is_empty() {
                return "[]".into();
            }
            format!(
                "[ {} ]",
                items
                    .iter()
                    .map(|item| emit_clone(item, source, item.flow()))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Kind::Map(items, _) if flow => {
            if items.is_empty() {
                return "{}".into();
            }
            format!(
                "{{ {} }}",
                items
                    .iter()
                    .map(|(k, v)| format!(
                        "{}: {}",
                        emit_clone(k, source, false),
                        emit_clone(v, source, v.flow())
                    ))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }
        Kind::Seq(items, _) => {
            if items.is_empty() {
                return "[]".into();
            }
            items
                .iter()
                .map(|item| {
                    format!(
                        "- {}{}",
                        emit_clone(item, source, item.flow()),
                        inline_comment(item, source)
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        Kind::Map(items, _) => {
            if items.is_empty() {
                return "{}".into();
            }
            items
                .iter()
                .map(|(k, v)| {
                    let child = emit_clone(v, source, v.flow());
                    if v.flow() || matches!(v.kind, Kind::Scalar(_)) {
                        format!(
                            "{}: {}{}",
                            emit_clone(k, source, false),
                            child,
                            inline_comment(v, source)
                        )
                    } else {
                        format!("{}:\n  {child}", emit_clone(k, source, false))
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}

/// Bun emits non-finite YAML scalars, whereas JSON serialization emits null.
/// Keep the value tree intact while recursively formatting collections.
pub(crate) fn stringify_yaml_bun(value: &crate::yaml_value::Value) -> String {
    use crate::yaml_value::Value as Y;
    fn emit(value: &Y, indent: usize) -> String {
        match value {
            Y::Number(n) if *n == 0. && n.is_sign_negative() => "-0".into(),
            Y::Number(n) if !n.is_finite() => {
                if n.is_nan() {
                    ".nan".into()
                } else if n.is_sign_negative() {
                    "-.inf".into()
                } else {
                    ".inf".into()
                }
            }
            Y::Array(items) if !items.is_empty() => items
                .iter()
                .map(|v| {
                    let child = emit(v, indent + 2);
                    format!("- {child}")
                })
                .collect::<Vec<_>>()
                .join(&format!("\n{}", " ".repeat(indent))),
            Y::Object(items) if !items.is_empty() => items
                .iter()
                .map(|(k, v)| {
                    let key = emit_bun_scalar(&Value::String(k.clone()));
                    let child = emit(v, indent + 2);
                    if v.is_array() || v.is_object() {
                        format!("{key}:\n{}{child}", " ".repeat(indent + 2))
                    } else {
                        format!("{key}: {child}")
                    }
                })
                .collect::<Vec<_>>()
                .join(&format!("\n{}", " ".repeat(indent))),
            _ => emit_bun_scalar(&value.to_json()),
        }
    }
    let mut value = value.clone();
    value.normalize();
    emit(&value, 0)
        .split('\n')
        .map(|line| {
            if line.ends_with(':') {
                format!("{line} ")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
