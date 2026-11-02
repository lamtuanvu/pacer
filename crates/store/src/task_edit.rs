//! Explicit task mutations keep exact UTF-16 strings with their values.
use crate::StoreError;
use pacer_js_json::{Utf16String, WireReply};
use serde_json::Value;

/// A transaction's editable task. The preview is for scalar decisions, not
/// lossless text copying; use `copy` or `subtree` to move existing values.
/// Each failed operation leaves its input unchanged. Return an error from the
/// callback to discard all prior edits in the transaction.
pub struct TaskEdit(WireReply);

impl TaskEdit {
    pub(crate) fn new(wire: WireReply) -> Self {
        Self(wire)
    }
    pub(crate) fn into_wire(self) -> WireReply {
        self.0
    }
    pub fn preview(&self) -> &Value {
        self.0.preview()
    }
    /// Snapshot a subtree with exact strings, rebased to its own root.
    pub fn subtree(&self, pointer: &str) -> Result<WireReply, StoreError> {
        Ok(self.0.subtree(pointer)?)
    }
    /// Replace a value or create an object member whose parent exists.
    /// Array positions must already exist; insertion uses `splice`.
    pub fn put(&mut self, pointer: &str, value: WireReply) -> Result<(), StoreError> {
        Ok(self.0.put(pointer, value)?)
    }
    /// Explicitly replace an existing string, even if its preview is unchanged.
    pub fn set_string(&mut self, pointer: &str, value: Utf16String) -> Result<(), StoreError> {
        Ok(self.0.set_string(pointer, value)?)
    }
    /// Remove an existing member/element; root removal is an error.
    pub fn remove(&mut self, pointer: &str) -> Result<(), StoreError> {
        Ok(self.0.remove(pointer)?)
    }
    /// Replace an array range with exact values. Bounds are strict, as in
    /// `WireReply::splice`; normalize JS splice inputs before calling.
    pub fn splice(
        &mut self,
        pointer: &str,
        start: usize,
        delete_count: usize,
        inserted: Vec<WireReply>,
    ) -> Result<(), StoreError> {
        Ok(self.0.splice(pointer, start, delete_count, inserted)?)
    }
    /// Snapshot the source before putting it at the destination; overlap is safe.
    pub fn copy(&mut self, from: &str, to: &str) -> Result<(), StoreError> {
        Ok(self.0.copy(from, to)?)
    }
}
