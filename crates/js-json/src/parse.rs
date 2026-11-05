use super::WireReply;
use crate::ast::{Kind, Node, Units};
use serde_json::{Value, value::RawValue};
use std::collections::HashMap;

/// Deepest node depth (root 0) the previous parser accepted. A node one level
/// deeper is the root of a subtree withheld from the preview.
const LIMIT: usize = 128;
/// Objects this small find duplicate keys by a linear scan.
const INDEXED: usize = 8;

fn inconsistent() -> serde_json::Error {
    serde::de::Error::custom("JSON scanner disagrees with validated grammar")
}

/// One open container on the builder stack.
enum Open {
    Array(Vec<Node>),
    Object {
        members: Vec<(Units, Node)>,
        /// Transient duplicate index, built once the object stops being small.
        index: Option<HashMap<Units, usize>>,
        key: Units,
    },
}

impl Open {
    /// A duplicate key keeps its first position and takes the last value; the
    /// replaced value is disposed by the iterative Node drop.
    fn attach(&mut self, node: Node) {
        match self {
            Self::Array(items) => items.push(node),
            Self::Object {
                members,
                index,
                key,
            } => {
                let key = std::mem::take(key);
                let slot = match index {
                    Some(index) => index.get(&key).copied(),
                    None => members.iter().position(|(k, _)| *k == key),
                };
                if let Some((_, value)) = slot.and_then(|i| members.get_mut(i)) {
                    *value = node;
                    return;
                }
                if let Some(index) = index {
                    index.insert(key.clone(), members.len());
                }
                members.push((key, node));
                if index.is_none() && members.len() >= INDEXED {
                    *index = Some(
                        members
                            .iter()
                            .enumerate()
                            .map(|(i, (k, _))| (k.clone(), i))
                            .collect(),
                    );
                }
            }
        }
    }

    fn close(self) -> Node {
        Node::new(match self {
            Self::Array(items) => Kind::Array(items),
            Self::Object { members, .. } => Kind::Object(members),
        })
    }
}

struct Scanner<'a> {
    text: &'a str,
    pos: usize,
}

impl Scanner<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.as_bytes().get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn eat(&mut self, byte: u8) -> Result<(), serde_json::Error> {
        self.skip_whitespace();
        if self.peek() != Some(byte) {
            return Err(inconsistent());
        }
        self.pos += 1;
        Ok(())
    }

    /// Exact UTF-16 units of the string starting at the current quote.
    fn string(&mut self) -> Result<Units, serde_json::Error> {
        self.eat(b'"')?;
        let start = self.pos;
        let bytes = self.text.as_bytes();
        let mut escaped = false;
        loop {
            match bytes.get(self.pos) {
                Some(b'"') => break,
                Some(b'\\') => {
                    escaped = true;
                    self.pos += 2;
                }
                Some(_) => self.pos += 1,
                None => return Err(inconsistent()),
            }
        }
        let body = self.text.get(start..self.pos).ok_or_else(inconsistent)?;
        self.pos += 1;
        if !escaped {
            return Ok(body.encode_utf16().collect());
        }
        let mut chars = body.chars();
        let mut out = vec![];
        while let Some(c) = chars.next() {
            if c != '\\' {
                out.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                continue;
            }
            out.push(match chars.next().ok_or_else(inconsistent)? {
                'u' => {
                    let hex = chars.by_ref().take(4).collect::<String>();
                    u16::from_str_radix(&hex, 16).map_err(|_| inconsistent())?
                }
                '"' => 34,
                '\\' => 92,
                '/' => 47,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                _ => return Err(inconsistent()),
            });
        }
        Ok(out)
    }

    /// The serde Number of the token, or Overflow when serde rejects it as
    /// out of range and its binary64 value is infinite.
    fn number(&mut self) -> Result<Kind, serde_json::Error> {
        let start = self.pos;
        while matches!(
            self.peek(),
            Some(b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E')
        ) {
            self.pos += 1;
        }
        let token = self.text.get(start..self.pos).ok_or_else(inconsistent)?;
        match serde_json::from_str::<Value>(token) {
            Ok(Value::Number(number)) => Ok(Kind::Number(number)),
            Ok(_) => Err(inconsistent()),
            Err(error) => match token.parse::<f64>() {
                Ok(n) if n.is_infinite() => Ok(Kind::Overflow {
                    negative: n.is_sign_negative(),
                }),
                _ => Err(error),
            },
        }
    }

    fn literal(&mut self, text: &str, kind: Kind) -> Result<Kind, serde_json::Error> {
        if !self
            .text
            .get(self.pos..)
            .is_some_and(|rest| rest.starts_with(text))
        {
            return Err(inconsistent());
        }
        self.pos += text.len();
        Ok(kind)
    }

    /// Open a member: its key and the colon before the value.
    fn key(&mut self) -> Result<Units, serde_json::Error> {
        let key = self.string()?;
        self.eat(b':')?;
        Ok(key)
    }

    fn document(mut self) -> Result<Node, serde_json::Error> {
        let mut stack: Vec<Open> = Vec::new();
        loop {
            self.skip_whitespace();
            let kind = match self.peek().ok_or_else(inconsistent)? {
                b'[' => {
                    self.pos += 1;
                    self.skip_whitespace();
                    if self.peek() == Some(b']') {
                        self.pos += 1;
                        Kind::Array(vec![])
                    } else {
                        stack.push(Open::Array(vec![]));
                        continue;
                    }
                }
                b'{' => {
                    self.pos += 1;
                    self.skip_whitespace();
                    if self.peek() == Some(b'}') {
                        self.pos += 1;
                        Kind::Object(vec![])
                    } else {
                        let key = self.key()?;
                        stack.push(Open::Object {
                            members: vec![],
                            index: None,
                            key,
                        });
                        continue;
                    }
                }
                b'"' => Kind::String(self.string()?),
                b'n' => self.literal("null", Kind::Null)?,
                b't' => self.literal("true", Kind::Bool(true))?,
                b'f' => self.literal("false", Kind::Bool(false))?,
                _ => self.number()?,
            };
            let mut node = Node::new(kind);
            // Close every container this value completes, then open the next value.
            loop {
                node.opaque = stack.len() == LIMIT + 1;
                let Some(top) = stack.last_mut() else {
                    return Ok(node);
                };
                top.attach(node);
                self.skip_whitespace();
                match self.peek() {
                    Some(b',') => {
                        self.pos += 1;
                        if let Open::Object { key, .. } = top {
                            *key = self.key()?;
                        }
                        break;
                    }
                    Some(b']' | b'}') => {
                        self.pos += 1;
                        node = stack.pop().ok_or_else(inconsistent)?.close();
                    }
                    _ => return Err(inconsistent()),
                }
            }
        }
    }
}

impl WireReply {
    /// Parse strict RFC 8259 JSON as `JSON.parse` does, at any depth. Nodes
    /// deeper than the previous parser's limit are retained exactly but
    /// withheld from the preview; see `preview_omits`.
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        // serde's ignore path: the same grammar, no depth or number-range limit.
        serde_json::from_str::<&RawValue>(text)?;
        let root = Scanner { text, pos: 0 }.document()?;
        Ok(Self::from_node(root))
    }
}
