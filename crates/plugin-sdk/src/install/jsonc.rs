//! JSONC editing with byte spans. JavaScript's offsets are UTF-16; the parser
//! works in bytes and converts only when rendering an error message.

use crate::install::{normalize_numbers, stringify, utf16_offset};
use serde_json::{Map, Value};
use std::fmt;

#[derive(Clone, Debug)]
pub struct JsoncError(pub String);

impl fmt::Display for JsoncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for JsoncError {}
impl From<JsoncError> for String {
    fn from(error: JsoncError) -> Self {
        error.0
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Object,
    Array,
    String,
    Literal,
}

#[derive(Clone)]
struct Member {
    key: String,
    key_start: usize,
    value: Node,
}

#[derive(Clone)]
struct Node {
    start: usize,
    end: usize,
    kind: Kind,
    members: Vec<Member>,
}

struct Parser<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            // UTF-16 skips one code unit for a BOM; in UTF-8 that is three bytes.
            pos: if text.starts_with('\u{feff}') { 3 } else { 0 },
        }
    }

    fn fail<T>(&self, message: &str) -> Result<T, JsoncError> {
        Err(JsoncError(format!(
            "{} at offset {}",
            message,
            utf16_offset(self.text, self.pos)
        )))
    }

    fn starts(&self, token: &str) -> bool {
        self.text[self.pos..].starts_with(token)
    }

    fn byte(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn skip(&mut self) -> Result<(), JsoncError> {
        while let Some(b) = self.byte() {
            if matches!(b, b' ' | b'\t' | b'\r' | b'\n') {
                self.pos += 1;
            } else if self.starts("//") {
                while let Some(c) = self.byte() {
                    if c == b'\n' {
                        break;
                    }
                    self.pos += 1;
                }
            } else if self.starts("/*") {
                let Some(end) = self.text[self.pos + 2..].find("*/") else {
                    return self.fail("unterminated comment");
                };
                self.pos = self.pos + 2 + end + 2;
            } else {
                break;
            }
        }
        Ok(())
    }

    fn read_string(&mut self) -> Result<String, JsoncError> {
        let start = self.pos;
        if self.byte() != Some(b'"') {
            return self.fail("invalid string");
        }
        self.pos += 1;
        while self.pos < self.text.len() {
            let b = self.byte().unwrap_or(0);
            if b == b'\\' {
                self.pos += 1;
                if self.pos < self.text.len() {
                    self.pos += self.text[self.pos..]
                        .chars()
                        .next()
                        .map_or(1, char::len_utf8);
                }
            } else if b == b'"' {
                self.pos += 1;
                return match serde_json::from_str::<String>(&self.text[start..self.pos]) {
                    Ok(s) => Ok(s),
                    Err(_) => self.fail("invalid string"),
                };
            } else {
                self.pos += self.text[self.pos..]
                    .chars()
                    .next()
                    .map_or(1, char::len_utf8);
            }
        }
        self.fail("unterminated string")
    }

    fn literal_end(&self) -> Option<usize> {
        let rest = &self.text[self.pos..];
        for keyword in ["true", "false", "null"] {
            if rest.starts_with(keyword) {
                return Some(keyword.len());
            }
        }
        let bytes = rest.as_bytes();
        let mut i = 0;
        if bytes.first() == Some(&b'-') {
            i = 1;
        }
        let digits = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits || (i > digits + 1 && bytes[digits] == b'0') {
            return None;
        }
        if i < bytes.len() && bytes[i] == b'.' {
            i += 1;
            let mut frac = 0;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
                frac += 1;
            }
            if frac == 0 {
                return None;
            }
        }
        if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
            i += 1;
            if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
                i += 1;
            }
            let mut exp = 0;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
                exp += 1;
            }
            if exp == 0 {
                return None;
            }
        }
        let token = &rest[..i];
        if matches!(token, "true" | "false" | "null") {
            return Some(i);
        }
        // A leading zero is only allowed for the literal "0" (handled above).
        if token.starts_with("0") && token.len() > 1 {
            return None;
        }
        Some(i)
    }

    fn value(&mut self) -> Result<Node, JsoncError> {
        self.skip()?;
        let start = self.pos;
        let b = self.byte();
        let mut members = Vec::new();
        let kind;
        match b {
            Some(b'{') | Some(b'[') => {
                kind = if b == Some(b'{') {
                    Kind::Object
                } else {
                    Kind::Array
                };
                let close = if kind == Kind::Object { b'}' } else { b']' };
                self.pos += 1;
                self.skip()?;
                while self.byte() != Some(close) {
                    if self.pos >= self.text.len() {
                        return self.fail("expected value");
                    }
                    if kind == Kind::Object {
                        let key_start = self.pos;
                        if self.byte() != Some(b'"') {
                            return self.fail("expected object key");
                        }
                        let key = self.read_string()?;
                        self.skip()?;
                        if self.byte() != Some(b':') {
                            return self.fail("expected colon");
                        }
                        self.pos += 1;
                        let value = self.value()?;
                        members.push(Member {
                            key,
                            key_start,
                            value,
                        });
                    } else {
                        self.value()?;
                    }
                    self.skip()?;
                    if self.byte() == Some(close) {
                        break;
                    }
                    if self.byte() != Some(b',') {
                        return self.fail("expected comma");
                    }
                    self.pos += 1;
                    self.skip()?;
                }
                self.pos += 1;
            }
            Some(b'"') => {
                kind = Kind::String;
                self.read_string()?;
            }
            Some(_) => {
                kind = Kind::Literal;
                let Some(end) = self.literal_end() else {
                    return self.fail("expected value");
                };
                self.pos += end;
            }
            None => return self.fail("expected value"),
        }
        Ok(Node {
            start,
            end: self.pos,
            kind,
            members,
        })
    }
}

fn parse_root(text: &str) -> Result<Node, JsoncError> {
    let mut parser = Parser::new(text);
    parser.skip()?;
    if parser.byte() != Some(b'{') {
        return parser.fail("top level must be an object");
    }
    let root = parser.value()?;
    parser.skip()?;
    if parser.pos != text.len() {
        return parser.fail("unexpected text after root");
    }
    Ok(root)
}

/// Remove comments and trailing commas while keeping every other byte.
pub fn strip_jsonc(text: &str) -> String {
    let mut parser = Parser::new(text);
    let mut result = String::new();
    while parser.pos < text.len() {
        let start = parser.pos;
        if parser.byte() == Some(b'"') {
            if parser.read_string().is_ok() {
                result.push_str(&text[start..parser.pos]);
            }
        } else if parser.starts("//") || parser.starts("/*") {
            let _ = parser.skip();
            result.push(' ');
        } else if parser.byte() == Some(b',') {
            parser.pos += 1;
            let _ = parser.skip();
            if !matches!(parser.byte(), Some(b'}') | Some(b']')) {
                result.push(',');
            }
            parser.pos = start + 1;
        } else {
            let ch = text[parser.pos..].chars().next().unwrap_or('\0');
            result.push(ch);
            parser.pos += ch.len_utf8();
        }
    }
    result
}

fn decode(text: &str) -> Result<Value, JsoncError> {
    let stripped = strip_jsonc(text);
    match serde_json::from_str::<Value>(&stripped) {
        Ok(mut value) => {
            normalize_numbers(&mut value);
            Ok(value)
        }
        Err(error) => Err(JsoncError(error.to_string())),
    }
}

pub fn parse_jsonc(text: &str) -> Result<Value, JsoncError> {
    parse_root(text)?;
    decode(text)
}

fn member<'a>(node: &'a Node, key: &str) -> Option<&'a Member> {
    // JSON.parse uses the last occurrence of a duplicate key.
    node.members.iter().rev().find(|m| m.key == key)
}

fn lookup<'a>(root: &'a Node, path: &[String]) -> Option<&'a Node> {
    let mut node = root;
    for key in path {
        if node.kind != Kind::Object {
            return None;
        }
        node = &member(node, key)?.value;
    }
    Some(node)
}

pub fn get_member(text: &str, path: &[String]) -> Result<Option<Value>, JsoncError> {
    let root = parse_root(text)?;
    lookup(&root, path)
        .map(|node| decode(&text[node.start..node.end]))
        .transpose()
}

pub fn is_empty_object(text: &str, path: &[String]) -> Result<bool, JsoncError> {
    let root = parse_root(text)?;
    Ok(
        lookup(&root, path)
            .is_some_and(|node| node.kind == Kind::Object && node.members.is_empty()),
    )
}

fn line_indent(text: &str, pos: usize) -> &str {
    let start = text[..pos].rfind('\n').map_or(0, |i| i + 1);
    let prefix = &text[start..pos];
    let len = prefix
        .bytes()
        .take_while(|b| matches!(b, b'\t' | b' '))
        .count();
    &prefix[..len]
}

fn render(value: &Value, indent: &str) -> String {
    stringify(value).replace('\n', &format!("\n{indent}"))
}

pub fn set_member(text: &str, path: &[String], value: Value) -> Result<String, JsoncError> {
    if path.is_empty() {
        return Err(JsoncError("member path must not be empty".into()));
    }
    let root = parse_root(text)?;
    let mut obj = &root;
    let last = path.len() - 1;
    for i in 0..path.len() {
        if obj.kind != Kind::Object {
            return Err(JsoncError("parent must be an object".into()));
        }
        if let Some(existing) = member(obj, &path[i]) {
            if i < last {
                obj = &existing.value;
                continue;
            }
            let indent = line_indent(text, existing.key_start);
            return Ok(format!(
                "{}{}{}",
                &text[..existing.value.start],
                render(&value, indent),
                &text[existing.value.end..]
            ));
        }
        let mut nested = value.clone();
        for key in path[i + 1..].iter().rev() {
            let mut map = Map::new();
            map.insert(key.clone(), nested);
            nested = Value::Object(map);
        }
        let first = obj.members.first();
        let line_start = first.map_or(0, |f| text[..f.key_start].rfind('\n').map_or(0, |i| i + 1));
        let indent = match first {
            Some(f)
                if text[line_start..f.key_start]
                    .bytes()
                    .all(|b| matches!(b, b'\t' | b' ')) =>
            {
                text[line_start..f.key_start].to_string()
            }
            _ => format!("{}  ", line_indent(text, obj.start)),
        };
        let key = stringify(&Value::String(path[i].clone()));
        let entry = format!("{key}: {}", render(&nested, &indent));
        if first.is_none() {
            let closing_indent = line_indent(text, obj.start);
            return Ok(format!(
                "{}{{\n{indent}{entry}\n{closing_indent}}}{}",
                &text[..obj.start],
                &text[obj.end..]
            ));
        }
        return Ok(format!(
            "{}\n{indent}{entry},{}",
            &text[..obj.start + 1],
            &text[obj.start + 1..]
        ));
    }
    Err(JsoncError("invalid member path".into()))
}

pub fn remove_member(text: &str, path: &[String]) -> Result<String, JsoncError> {
    if path.is_empty() {
        return Err(JsoncError("member path must not be empty".into()));
    }
    let root = parse_root(text)?;
    let Some(parent) = lookup(&root, &path[..path.len() - 1]) else {
        return Ok(text.to_string());
    };
    if parent.kind != Kind::Object {
        return Ok(text.to_string());
    }
    let key = &path[path.len() - 1];
    let Some(index) = parent.members.iter().rposition(|m| &m.key == key) else {
        return Ok(text.to_string());
    };
    let target = &parent.members[index];
    if parent.members.len() == 1 {
        return Ok(format!(
            "{}{{}}{}",
            &text[..parent.start],
            &text[parent.end..]
        ));
    }
    let mut parser = Parser::new(text);
    parser.pos = target.value.end;
    parser.skip()?;
    let (start, end);
    if parser.byte() == Some(b',') {
        let newline = text[..target.key_start].rfind('\n');
        start = match newline {
            Some(n)
                if text[n + 1..target.key_start]
                    .bytes()
                    .all(|b| matches!(b, b'\t' | b' ')) =>
            {
                n
            }
            _ => target.key_start,
        };
        let mut after = parser.pos + 1;
        let line_end = text[after..]
            .find('\n')
            .map(|i| after + i)
            .unwrap_or(text.len());
        let remainder = &text[after..line_end];
        let trimmed = remainder.trim_start_matches(['\t', ' ']);
        if trimmed.starts_with("//") {
            after = line_end;
        }
        end = after;
    } else {
        start = parent.members[index - 1].value.end;
        end = target.value.end;
    }
    Ok(format!("{}{}", &text[..start], &text[end..]))
}
