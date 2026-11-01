use saphyr_parser::{Event, Parser, ScalarStyle};
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
}

#[derive(Clone, Debug)]
enum Kind {
    Scalar(Value),
    Seq(Vec<Node>, bool),
    Map(Vec<(Node, Node)>, bool),
}

impl Node {
    fn value(&self) -> Value {
        match &self.kind {
            Kind::Scalar(v) => v.clone(),
            Kind::Seq(items, _) => Value::Array(items.iter().map(Node::value).collect()),
            Kind::Map(items, _) => Value::Object(
                items
                    .iter()
                    .filter_map(|(k, v)| k.value().as_str().map(|key| (key.to_owned(), v.value())))
                    .collect(),
            ),
        }
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
    children: Vec<Node>,
}

fn byte_index(text: &str, char_index: usize) -> usize {
    text.char_indices()
        .nth(char_index)
        .map_or(text.len(), |(i, _)| i)
}

fn scalar(text: &str, span: Range<usize>, content: &str, style: ScalarStyle) -> Node {
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
        match content {
            "null" | "Null" | "NULL" | "~" | "" => Value::Null,
            "true" | "True" | "TRUE" => Value::Bool(true),
            "false" | "False" | "FALSE" => Value::Bool(false),
            _ => content
                .parse::<i64>()
                .map(Value::from)
                .or_else(|_| content.parse::<f64>().map(Value::from))
                .unwrap_or_else(|_| Value::String(content.into())),
        }
    } else {
        Value::String(content.into())
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
    Node {
        span,
        core_end,
        kind: Kind::Scalar(value),
    }
}

fn parse(text: &str) -> Result<Node> {
    let mut stack: Vec<Frame> = Vec::new();
    let mut root = None;
    for event in Parser::new_from_str(text) {
        let (event, span) = event.map_err(|e| {
            let message = e.to_string();
            if message.starts_with("while parsing a flow sequence") && text.matches('[').count() > text.matches(']').count() {
                let line = text.bytes().filter(|byte| *byte == b'\n').count() + 1;
                return EditError(format!("Flow sequence in block collection must be sufficiently indented and end with a ] at line {line}, column 1:\n\n{}\n^\n", text));
            }
            EditError(message)
        })?;
        let start = byte_index(text, span.start.index());
        let end = byte_index(text, span.end.index());
        let node = match event {
            Event::Scalar(content, style, _, _) => Some(scalar(text, start..end, &content, style)),
            Event::MappingStart(_, _) | Event::SequenceStart(_, _) => {
                stack.push(Frame {
                    start,
                    mapping: matches!(event, Event::MappingStart(..)),
                    children: Vec::new(),
                });
                None
            }
            Event::MappingEnd | Event::SequenceEnd => {
                let frame = stack
                    .pop()
                    .ok_or_else(|| EditError("invalid YAML collection".into()))?;
                let flow = text[frame.start..].starts_with(if frame.mapping { '{' } else { '[' });
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
                Some(Node {
                    span: frame.start..end,
                    core_end,
                    kind,
                })
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
        parse(&self.text)
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
                let parsed = parse(yaml)?;
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
                || matches!(s.as_str(), "true" | "false" | "null" | "~")
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
        _ => value.to_string(),
    }
}

fn emit(value: &Value, flow: bool, indent: usize) -> String {
    match value {
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
                        .map(|v| emit(v, true, indent))
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
                    emit_scalar(&Value::String(k.clone()), None),
                    emit(v, true, indent)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Value::Array(items) => items
            .iter()
            .map(|v| {
                let child = emit(v, false, indent + 2);
                if v.is_object() {
                    format!("- {}", child)
                } else if v.is_array() {
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
                let key = emit_scalar(&Value::String(k.clone()), None);
                let child = emit(v, false, indent + 2);
                if v.is_array() || v.is_object() {
                    format!("{key}:\n{}{}", " ".repeat(indent + 2), child)
                } else {
                    format!("{key}: {child}")
                }
            })
            .collect::<Vec<_>>()
            .join(&format!("\n{}", " ".repeat(indent))),
        _ => emit_scalar(value, None),
    }
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
        Kind::Scalar(value) => emit_scalar(value, Some(&source[node.span.start..node.core_end])),
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
