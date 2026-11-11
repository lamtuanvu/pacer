//! JavaScript JSON string preservation at native state and wire boundaries.
mod ast;
mod compare;
mod edit;
pub mod js_semantics;
mod parse;
pub mod quoted;
mod render;
mod stringify;
use ast::{Kind, Node};
pub use edit::EditError;
use serde::{Serialize, Serializer};
use serde_json::{Number, Value, value::RawValue};
use std::fmt;
pub use stringify::{number_string, stringify};

/// A JavaScript string is a sequence of UTF-16 code units. In particular, slice
/// may retain one half of a surrogate pair; converting through Rust str loses it.
#[derive(Clone, Debug)]
pub struct Utf16String(Vec<u16>);
impl Utf16String {
    /// Keep JavaScript code units, including isolated surrogates, unchanged.
    pub fn from_units(units: Vec<u16>) -> Self {
        Self(units)
    }
    pub fn slice(text: &str, start: usize, end: usize) -> Self {
        Self(
            text.encode_utf16()
                .skip(start)
                .take(end.saturating_sub(start))
                .collect(),
        )
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
    fn json(&self) -> String {
        render::utf16_json(&self.0)
    }
}
impl Serialize for Utf16String {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let raw = RawValue::from_string(self.json()).map_err(serde::ser::Error::custom)?;
        raw.serialize(s)
    }
}
/// A reply is an exact JSON document with a cached preview for admission
/// bookkeeping. Conversion to Value is explicitly fallible.
///
/// The preview is a projection: lone-surrogate strings are lossy, Overflow
/// numbers are null, members whose key is not scalar text are omitted, and a
/// parsed subtree deeper than the previous parser's limit is withheld as null.
/// Values supplied through `new` are always fully visible.
pub struct WireReply {
    root: Node,
    preview: Value,
    omits: bool,
    lossy: bool,
}
impl WireReply {
    /// The supplied Value becomes the preview unchanged, at any depth.
    pub fn new(value: Value) -> Self {
        Self {
            root: Node::from_value(&value),
            preview: value,
            omits: false,
            lossy: false,
        }
    }
    pub(crate) fn from_node(root: Node) -> Self {
        let ast::Projection {
            value,
            omits,
            lossy,
        } = ast::project(&root);
        Self {
            root,
            preview: value,
            omits,
            lossy,
        }
    }
    /// Re-project after a successful mutation; the old preview is disposed iteratively.
    pub(crate) fn reproject(&mut self) {
        let projection = ast::project(&self.root);
        ast::dispose(std::mem::replace(&mut self.preview, projection.value));
        self.omits = projection.omits;
        self.lossy = projection.lossy;
    }
    pub(crate) fn into_root(mut self) -> Node {
        std::mem::replace(&mut self.root, Node::new(Kind::Null))
    }
    /// Replace an existing string addressed with serde's pointer grammar; any
    /// other target is a silent no-op. An opaque ancestor still withholds it.
    pub fn replace(&mut self, pointer: &str, value: Utf16String) {
        if let Some(node) = edit::serde_pointer_mut(&mut self.root, pointer)
            && matches!(node.kind, Kind::String(_))
        {
            *node = Node::new(Kind::String(value.0));
            self.reproject();
        }
    }
    /// A metadata preview; see the type documentation for what it withholds.
    pub fn preview(&self) -> &Value {
        &self.preview
    }
    /// True iff the current preview loses content: a withheld subtree that is
    /// not null or Overflow, or a visible member whose key is not scalar text.
    pub fn preview_omits(&self) -> bool {
        self.omits
    }
    /// The full Value, moved out of the preview. Fails while a lone-surrogate
    /// string remains or the preview withholds content.
    pub fn into_value(mut self) -> Result<Value, serde_json::Error> {
        if self.lossy {
            return Err(serde::de::Error::custom(
                "a lone UTF-16 surrogate string cannot be represented as a Value",
            ));
        }
        if self.omits {
            return Err(serde::de::Error::custom(
                "withheld projection: the preview omits retained JSON content",
            ));
        }
        Ok(std::mem::take(&mut self.preview))
    }
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        render::render(&self.root)
    }
    /// A finite number as binary64, or Overflow as a signed infinity. Uses the
    /// edit pointer grammar; anything else, including a bad pointer, is None.
    pub fn number_at(&self, path: &str) -> Option<f64> {
        match &edit::lookup(&self.root, path).ok()?.kind {
            Kind::Number(n) => n.as_f64(),
            Kind::Overflow { negative: true } => Some(f64::NEG_INFINITY),
            Kind::Overflow { negative: false } => Some(f64::INFINITY),
            _ => None,
        }
    }
    /// The import number rule: JSON.parse reads doubles and JSON.stringify
    /// writes negative zero as 0. Zero becomes integer 0 and any other finite
    /// number a binary64 Number; Overflow is unchanged.
    pub fn normalize_js_numbers(&mut self) {
        let mut stack = vec![&mut self.root];
        while let Some(node) = stack.pop() {
            match &mut node.kind {
                Kind::Number(n) => {
                    if let Some(f) = n.as_f64() {
                        if f == 0.0 {
                            *n = Number::from(0u64);
                        } else if let Some(f) = Number::from_f64(f) {
                            *n = f;
                        }
                    }
                }
                Kind::Array(items) => stack.extend(items.iter_mut()),
                Kind::Object(members) => stack.extend(members.iter_mut().map(|(_, n)| n)),
                _ => {}
            }
        }
        self.reproject();
    }
}
impl Drop for WireReply {
    fn drop(&mut self) {
        ast::dispose(std::mem::take(&mut self.preview));
    }
}
impl Clone for WireReply {
    fn clone(&self) -> Self {
        Self {
            root: self.root.clone(),
            preview: ast::clone_value(&self.preview),
            omits: self.omits,
            lossy: self.lossy,
        }
    }
}
/// Debug writes the iterative rendering; its spelling is not a contract.
impl fmt::Debug for WireReply {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "WireReply({:?})", self.root)
    }
}
impl Serialize for WireReply {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let raw = RawValue::from_string(self.to_json().map_err(serde::ser::Error::custom)?)
            .map_err(serde::ser::Error::custom)?;
        raw.serialize(s)
    }
}
