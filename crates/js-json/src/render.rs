//! Iterative rendering with the existing bytes: scalar strings and keys through
//! serde, lone-surrogate ones as lowercase `\uXXXX`, Overflow as `null`.
//! Projection metadata never affects the output.
use crate::ast::{Kind, Node, Units};
use std::fmt;

/// JSON text of exact UTF-16 units; lone surrogates become `\uXXXX`.
pub(crate) fn utf16_json(units: &[u16]) -> String {
    let mut out = String::from("\"");
    for unit in char::decode_utf16(units.iter().copied()) {
        match unit {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok(c) if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            Ok(c) => out.push(c),
            Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
        }
    }
    out.push('"');
    out
}

fn string(units: &[u16], out: &mut String) -> Result<(), serde_json::Error> {
    match String::from_utf16(units) {
        Ok(text) => out.push_str(&serde_json::to_string(&text)?),
        Err(_) => out.push_str(&utf16_json(units)),
    }
    Ok(())
}

enum Frame<'a> {
    Array(std::slice::Iter<'a, Node>, bool),
    Object(std::slice::Iter<'a, (Units, Node)>, bool),
}

pub(crate) fn render(root: &Node) -> Result<String, serde_json::Error> {
    let mut out = String::new();
    let mut stack = Vec::new();
    let mut next = Some(root);
    loop {
        if let Some(node) = next.take() {
            match &node.kind {
                Kind::Null | Kind::Overflow { .. } => out.push_str("null"),
                Kind::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                Kind::Number(n) => out.push_str(&serde_json::to_string(n)?),
                Kind::String(units) => string(units, &mut out)?,
                Kind::Array(items) => {
                    out.push('[');
                    stack.push(Frame::Array(items.iter(), true));
                }
                Kind::Object(members) => {
                    out.push('{');
                    stack.push(Frame::Object(members.iter(), true));
                }
            }
        }
        let Some(frame) = stack.last_mut() else {
            return Ok(out);
        };
        match frame {
            Frame::Array(items, first) => match items.next() {
                Some(item) => {
                    if !std::mem::take(first) {
                        out.push(',');
                    }
                    next = Some(item);
                }
                None => {
                    out.push(']');
                    stack.pop();
                }
            },
            Frame::Object(members, first) => match members.next() {
                Some((key, item)) => {
                    if !std::mem::take(first) {
                        out.push(',');
                    }
                    string(key, &mut out)?;
                    out.push(':');
                    next = Some(item);
                }
                None => {
                    out.push('}');
                    stack.pop();
                }
            },
        }
    }
}

/// Debug writes the iterative rendering; its spelling is not a contract.
impl fmt::Debug for Node {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match render(self) {
            Ok(text) => f.write_str(&text),
            Err(_) => f.write_str("<unrenderable>"),
        }
    }
}
