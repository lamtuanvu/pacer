//! Explicit edits on the exact document. Every lookup uses the exact AST, never
//! the preview; a failed edit leaves content and projection unchanged.
use crate::ast::{Kind, Node};
use crate::{Utf16String, WireReply};

/// An invalid edit leaves the original reply unchanged.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum EditError {
    #[error("invalid JSON pointer or array index")]
    InvalidPointer,
    #[error("JSON pointer does not identify a value")]
    NotFound,
    #[error("JSON value has the wrong type for this edit")]
    WrongType,
    #[error("array edit is out of bounds")]
    OutOfBounds,
    #[error("the document root cannot be removed")]
    RootRemoval,
}

fn tokens(pointer: &str) -> Result<Vec<String>, EditError> {
    if pointer.is_empty() {
        return Ok(vec![]);
    }
    let rest = pointer.strip_prefix('/').ok_or(EditError::InvalidPointer)?;
    rest.split('/')
        .map(|part| {
            let mut decoded = String::new();
            let mut chars = part.chars();
            while let Some(c) = chars.next() {
                decoded.push(if c == '~' {
                    match chars.next() {
                        Some('0') => '~',
                        Some('1') => '/',
                        _ => return Err(EditError::InvalidPointer),
                    }
                } else {
                    c
                });
            }
            Ok(decoded)
        })
        .collect()
}

fn index(token: &str) -> Result<usize, EditError> {
    if token.is_empty()
        || (token.len() > 1 && token.starts_with('0'))
        || !token.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(EditError::InvalidPointer);
    }
    token.parse().map_err(|_| EditError::OutOfBounds)
}

/// An object token matches the member whose key units equal its UTF-16
/// encoding; a lone-surrogate key is retained but never addressable.
fn key_is(key: &[u16], token: &str) -> bool {
    token.encode_utf16().eq(key.iter().copied())
}

fn step<'a>(node: &'a Node, token: &str) -> Result<&'a Node, EditError> {
    match &node.kind {
        Kind::Object(members) => members
            .iter()
            .find(|(key, _)| key_is(key, token))
            .map(|(_, node)| node)
            .ok_or(EditError::NotFound),
        Kind::Array(items) => items.get(index(token)?).ok_or(EditError::OutOfBounds),
        _ => Err(EditError::WrongType),
    }
}

fn at<'a>(mut node: &'a Node, tokens: &[String]) -> Result<&'a Node, EditError> {
    for token in tokens {
        node = step(node, token)?;
    }
    Ok(node)
}

fn at_mut<'a>(mut node: &'a mut Node, tokens: &[String]) -> Result<&'a mut Node, EditError> {
    for token in tokens {
        node = match &mut node.kind {
            Kind::Object(members) => members
                .iter_mut()
                .find(|(key, _)| key_is(key, token))
                .map(|(_, node)| node)
                .ok_or(EditError::NotFound)?,
            Kind::Array(items) => items.get_mut(index(token)?).ok_or(EditError::OutOfBounds)?,
            _ => return Err(EditError::WrongType),
        };
    }
    Ok(node)
}

/// Exact lookup with the edit pointer grammar.
pub(crate) fn lookup<'a>(root: &'a Node, path: &str) -> Result<&'a Node, EditError> {
    at(root, &tokens(path)?)
}

/// serde's `Value::pointer_mut` grammar, evaluated on the exact document.
pub(crate) fn serde_pointer_mut<'a>(root: &'a mut Node, pointer: &str) -> Option<&'a mut Node> {
    if pointer.is_empty() {
        return Some(root);
    }
    if !pointer.starts_with('/') {
        return None;
    }
    let mut node = root;
    for token in pointer
        .split('/')
        .skip(1)
        .map(|token| token.replace("~1", "/").replace("~0", "~"))
    {
        node = match &mut node.kind {
            Kind::Object(members) => members
                .iter_mut()
                .find(|(key, _)| key_is(key, &token))
                .map(|(_, node)| node)?,
            Kind::Array(items) => {
                if token.starts_with('+') || (token.starts_with('0') && token.len() != 1) {
                    return None;
                }
                items.get_mut(token.parse::<usize>().ok()?)?
            }
            _ => return None,
        };
    }
    Some(node)
}

impl WireReply {
    /// Read exact UTF-16 text using the same pointer grammar as explicit edits.
    /// The lookup ignores the preview projection.
    pub fn string_at(&self, path: &str) -> Result<Utf16String, EditError> {
        match &lookup(&self.root, path)?.kind {
            Kind::String(units) => Ok(Utf16String::from_units(units.clone())),
            _ => Err(EditError::WrongType),
        }
    }

    /// Copy a subtree with its exact UTF-16 strings. The empty pointer copies
    /// the whole document; malformed escapes and noncanonical array indices fail.
    /// A subtree detached from below a withheld ancestor stays withheld until
    /// it is explicitly replaced.
    pub fn subtree(&self, path: &str) -> Result<Self, EditError> {
        let mut node = &self.root;
        let mut withheld = node.opaque;
        for token in tokens(path)? {
            node = step(node, &token)?;
            withheld |= node.opaque;
        }
        let mut root = node.clone();
        root.opaque = withheld;
        Ok(Self::from_node(root))
    }

    /// Replace the root or an existing array element, or create/replace an
    /// object member whose parent exists. Array insertion uses `splice`.
    /// The inserted value keeps its own projection metadata; a deeper
    /// destination never withholds it. Invalid edits leave the reply unchanged.
    pub fn put(&mut self, path: &str, value: Self) -> Result<(), EditError> {
        let tokens = tokens(path)?;
        let Some((key, parents)) = tokens.split_last() else {
            *self = value;
            return Ok(());
        };
        match &mut at_mut(&mut self.root, parents)?.kind {
            Kind::Object(members) => {
                let node = value.into_root();
                match members.iter_mut().find(|(k, _)| key_is(k, key)) {
                    Some((_, slot)) => *slot = node,
                    None => members.push((key.encode_utf16().collect(), node)),
                }
            }
            Kind::Array(items) => {
                *items.get_mut(index(key)?).ok_or(EditError::OutOfBounds)? = value.into_root();
            }
            _ => return Err(EditError::WrongType),
        }
        self.reproject();
        Ok(())
    }

    /// Replace an existing string, including with literal U+FFFD when its
    /// preview equals the previous string. A missing or non-string path fails.
    pub fn set_string(&mut self, path: &str, text: Utf16String) -> Result<(), EditError> {
        if !matches!(lookup(&self.root, path)?.kind, Kind::String(_)) {
            return Err(EditError::WrongType);
        }
        self.put(path, Self::from_node(Node::new(Kind::String(text.0))))
    }

    /// Remove an existing object member or array element. Array metadata moves
    /// with its element. Removing the root is rejected; use `put` to replace it.
    pub fn remove(&mut self, path: &str) -> Result<(), EditError> {
        let tokens = tokens(path)?;
        let (key, parents) = tokens.split_last().ok_or(EditError::RootRemoval)?;
        match &mut at_mut(&mut self.root, parents)?.kind {
            Kind::Array(_) => return self.splice_at(parents, index(key)?, 1, vec![]),
            Kind::Object(members) => {
                let position = members
                    .iter()
                    .position(|(k, _)| key_is(k, key))
                    .ok_or(EditError::NotFound)?;
                members.remove(position);
            }
            _ => return Err(EditError::WrongType),
        }
        self.reproject();
        Ok(())
    }

    /// Replace `delete_count` elements starting at `start` with exact replies.
    /// Both bounds are strict: start may equal length only for insertion, and
    /// deletion may not extend past length. Callers normalize JS splice inputs.
    /// No mutation is published if the pointer, type or bounds are invalid.
    pub fn splice(
        &mut self,
        path: &str,
        start: usize,
        delete_count: usize,
        inserted: Vec<Self>,
    ) -> Result<(), EditError> {
        self.splice_at(&tokens(path)?, start, delete_count, inserted)
    }

    fn splice_at(
        &mut self,
        tokens: &[String],
        start: usize,
        delete_count: usize,
        inserted: Vec<Self>,
    ) -> Result<(), EditError> {
        let Kind::Array(items) = &mut at_mut(&mut self.root, tokens)?.kind else {
            return Err(EditError::WrongType);
        };
        if start > items.len() || delete_count > items.len() - start {
            return Err(EditError::OutOfBounds);
        }
        (items.len() - delete_count)
            .checked_add(inserted.len())
            .ok_or(EditError::OutOfBounds)?;
        let removed: Vec<Node> = items
            .splice(
                start..start + delete_count,
                inserted.into_iter().map(Self::into_root),
            )
            .collect();
        drop(removed);
        self.reproject();
        Ok(())
    }

    /// Snapshot the exact source before replacing the destination. Source and
    /// destination may overlap; destination semantics are those of `put`.
    pub fn copy(&mut self, from: &str, to: &str) -> Result<(), EditError> {
        let value = self.subtree(from)?;
        self.put(to, value)
    }
}
