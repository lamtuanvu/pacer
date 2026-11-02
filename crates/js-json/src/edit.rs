//! Explicit edits move the scalar preview and its exact strings together.
use crate::{Utf16String, WireReply};
use serde_json::Value;

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

fn pointer(tokens: &[String]) -> String {
    tokens
        .iter()
        .map(|token| format!("/{}", token.replace('~', "~0").replace('/', "~1")))
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

fn at<'a>(mut value: &'a Value, tokens: &[String]) -> Result<&'a Value, EditError> {
    for token in tokens {
        value = match value {
            Value::Object(map) => map.get(token).ok_or(EditError::NotFound)?,
            Value::Array(array) => array.get(index(token)?).ok_or(EditError::OutOfBounds)?,
            _ => return Err(EditError::WrongType),
        };
    }
    Ok(value)
}

fn at_mut<'a>(mut value: &'a mut Value, tokens: &[String]) -> Result<&'a mut Value, EditError> {
    for token in tokens {
        value = match value {
            Value::Object(map) => map.get_mut(token).ok_or(EditError::NotFound)?,
            Value::Array(array) => array.get_mut(index(token)?).ok_or(EditError::OutOfBounds)?,
            _ => return Err(EditError::WrongType),
        };
    }
    Ok(value)
}

fn relative<'a>(path: &'a str, base: &str) -> Option<&'a str> {
    path.strip_prefix(base)
        .filter(|suffix| suffix.is_empty() || suffix.starts_with('/'))
}

impl WireReply {
    /// Copy a subtree with its exact UTF-16 strings. The empty pointer copies
    /// the whole document; malformed escapes and noncanonical array indices fail.
    pub fn subtree(&self, path: &str) -> Result<Self, EditError> {
        let tokens = tokens(path)?;
        let preview = at(&self.preview, &tokens)?.clone();
        let base = pointer(&tokens);
        let strings = self
            .strings
            .iter()
            .filter_map(|(path, text)| {
                relative(path, &base).map(|suffix| (suffix.into(), text.clone()))
            })
            .collect();
        Ok(Self { preview, strings })
    }

    /// Replace the root or an existing array element, or create/replace an
    /// object member whose parent exists. Array insertion uses `splice`.
    /// Invalid edits leave the complete reply unchanged.
    pub fn put(&mut self, path: &str, value: Self) -> Result<(), EditError> {
        let tokens = tokens(path)?;
        if tokens.is_empty() {
            *self = value;
            return Ok(());
        }
        let mut next = self.clone();
        let (key, parents) = tokens.split_last().ok_or(EditError::InvalidPointer)?;
        let Self { preview, strings } = value;
        match at_mut(&mut next.preview, parents)? {
            Value::Object(map) => {
                map.insert(key.clone(), preview);
            }
            Value::Array(array) => {
                *array.get_mut(index(key)?).ok_or(EditError::OutOfBounds)? = preview;
            }
            _ => return Err(EditError::WrongType),
        }
        let base = pointer(&tokens);
        next.strings
            .retain(|path, _| relative(path, &base).is_none());
        next.strings.extend(
            strings
                .into_iter()
                .map(|(suffix, text)| (format!("{base}{suffix}"), text)),
        );
        *self = next;
        Ok(())
    }

    /// Replace an existing string, including with literal U+FFFD when its
    /// preview equals the previous string. A missing or non-string path fails.
    pub fn set_string(&mut self, path: &str, text: Utf16String) -> Result<(), EditError> {
        if !at(&self.preview, &tokens(path)?)?.is_string() {
            return Err(EditError::WrongType);
        }
        let mut value = Self::new(Value::String(String::from_utf16_lossy(text.units())));
        value.strings.insert(String::new(), text);
        self.put(path, value)
    }

    /// Remove an existing object member or array element. Array strings move
    /// with their elements. Removing the root is rejected; use `put` to replace it.
    pub fn remove(&mut self, path: &str) -> Result<(), EditError> {
        let tokens = tokens(path)?;
        let (key, parents) = tokens.split_last().ok_or(EditError::RootRemoval)?;
        match at(&self.preview, parents)? {
            Value::Array(_) => return self.splice(&pointer(parents), index(key)?, 1, vec![]),
            Value::Object(map) if map.contains_key(key) => {}
            Value::Object(_) => return Err(EditError::NotFound),
            _ => return Err(EditError::WrongType),
        }
        let mut next = self.clone();
        if let Value::Object(map) = at_mut(&mut next.preview, parents)? {
            map.shift_remove(key);
        }
        let base = pointer(&tokens);
        next.strings
            .retain(|path, _| relative(path, &base).is_none());
        *self = next;
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
        let tokens = tokens(path)?;
        let array = at(&self.preview, &tokens)?
            .as_array()
            .ok_or(EditError::WrongType)?;
        if start > array.len() || delete_count > array.len() - start {
            return Err(EditError::OutOfBounds);
        }
        (array.len() - delete_count)
            .checked_add(inserted.len())
            .ok_or(EditError::OutOfBounds)?;
        let mut next = self.clone();
        let array = at_mut(&mut next.preview, &tokens)?
            .as_array_mut()
            .ok_or(EditError::WrongType)?;
        array.splice(
            start..start + delete_count,
            inserted.iter().map(|value| value.preview.clone()),
        );
        let base = pointer(&tokens);
        let prefix = format!("{base}/");
        for (path, text) in std::mem::take(&mut next.strings) {
            let Some(suffix) = path.strip_prefix(&prefix) else {
                next.strings.insert(path, text);
                continue;
            };
            let end = suffix.find('/').unwrap_or(suffix.len());
            let old = index(&suffix[..end])?;
            let new = if old < start {
                old
            } else if old >= start + delete_count {
                old - delete_count + inserted.len()
            } else {
                continue;
            };
            next.strings
                .insert(format!("{prefix}{new}{}", &suffix[end..]), text);
        }
        for (offset, value) in inserted.into_iter().enumerate() {
            next.strings.extend(
                value
                    .strings
                    .into_iter()
                    .map(|(suffix, text)| (format!("{prefix}{}{suffix}", start + offset), text)),
            );
        }
        *self = next;
        Ok(())
    }

    /// Snapshot the exact source before replacing the destination. Source and
    /// destination may overlap; destination semantics are those of `put`.
    pub fn copy(&mut self, from: &str, to: &str) -> Result<(), EditError> {
        let value = self.subtree(from)?;
        self.put(to, value)
    }
}
