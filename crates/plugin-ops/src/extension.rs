//! The plugin registry as a native op sees it, before B0c moves it into Rust.
//!
//! Native ops need two things only the TypeScript plugin registry has until B0c:
//! the registry snapshot (`find` / `findAll`) and an extension-point call with
//! the options the TypeScript call site passes. [`ExtensionCalls`] is the
//! server's window onto `/_internal/plugins` (private kinds `snapshot` and
//! `extension`); [`find`] and [`find_all`] mirror `PluginRegistry.find` and
//! `findAll` over a supplied snapshot.
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use crate::public::Entry;
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;
use std::{future::Future, pin::Pin};

/// The current registry snapshot, as `PluginRegistry.refresh` then its entries.
pub type EntriesFuture<'a> = Pin<Box<dyn Future<Output = Result<Vec<Entry>, CoreError>> + Send + 'a>>;

/// The plugin registry as a native op sees it. Implemented by the server over
/// `/_internal/plugins` until B0c moves the registry into Rust; tests implement
/// it with fixtures.
pub trait ExtensionCalls: Send {
    /// `PluginRegistry.refresh` then its entries (private kind `snapshot`).
    fn entries<'a>(&'a mut self, ctx: &'a Ctx) -> EntriesFuture<'a>;
    /// The TS call site for `method`, with its options (private kind `extension`).
    fn call<'a>(&'a mut self, ctx: &'a Ctx, id: &'a str, method: &'a str, params: Value) -> OpFuture<'a>;
}

/// The contribution `point` on an entry, as the TS call site passes it: the
/// entry's `manifest.contributes[point]`, or `{}` when it is absent (a
/// contribution may be declared without an object body).
fn contribution(entry: &Entry, point: &str) -> Value {
    entry.manifest()["contributes"][point].clone()
}

fn is_enabled_contributor(entry: &Entry, point: &str) -> bool {
    entry.available()
        && entry
            .manifest()
            .get("contributes")
            .is_some_and(|contrib| contrib.get(point).is_some())
}

/// `PluginRegistry.find`: enabled entries contributing `point`, bundled first,
/// then `localeCompare` by id. Returns the first matching id, or `None`.
pub fn find(entries: &[Entry], point: &str, predicate: impl Fn(&Value) -> bool) -> Option<String> {
    let mut candidates: Vec<&Entry> = entries
        .iter()
        .filter(|e| is_enabled_contributor(e, point))
        .collect();
    candidates.sort_by(|a, b| {
        b.bundled
            .cmp(&a.bundled)
            .then_with(|| pacer_js_json::js_semantics::locale_compare(&a.id, &b.id))
    });
    candidates
        .into_iter()
        .find(|e| predicate(&contribution(e, point)))
        .map(|e| e.id.clone())
}

/// `PluginRegistry.findAll`: enabled entries contributing `point` that match,
/// ids in UTF-16 code-unit order (`Array.prototype.sort`).
pub fn find_all(entries: &[Entry], point: &str, predicate: impl Fn(&Value) -> bool) -> Vec<String> {
    let mut ids: Vec<String> = entries
        .iter()
        .filter(|e| is_enabled_contributor(e, point) && predicate(&contribution(e, point)))
        .map(|e| e.id.clone())
        .collect();
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    ids
}

#[cfg(test)]
mod tests;