use super::{Code, CoreError};
use crate::Ctx;
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{collections::BTreeMap, future::Future, pin::Pin};

pub type OpFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>>;

/// Domain-owned callback; registration does not execute it.
#[derive(Clone, Copy)]
pub struct NativeOp {
    pub name: &'static str,
    pub call: for<'a> fn(&'a Ctx, Value) -> OpFuture<'a>,
}

/// Decode generated params. Validation message wording may differ from zod.
// Keep the agreed public CoreError value contract; object data makes it large.
#[allow(clippy::result_large_err)]
pub fn params<T: DeserializeOwned>(value: Value) -> Result<T, CoreError> {
    serde_json::from_value(value)
        .map_err(|error| CoreError::new(Code::InvalidInput, format!("params: {error}")))
}

/// An immutable selection of native operations. The caller supplies the startup
/// forwarding setting; foundation never reads environment or logs it.
pub struct Registry {
    ops: BTreeMap<&'static str, NativeOp>,
}

impl Registry {
    /// Comma-separated exact names (trimmed), or `*`, force forwarding.
    /// Duplicate registrations retain the last callback for that name.
    pub fn new(ops: &[NativeOp], forward: &str) -> Self {
        let forward: Vec<_> = forward.split(',').map(str::trim).collect();
        let ops = ops
            .iter()
            .filter(|op| !forward.contains(&"*") && !forward.contains(&op.name))
            .map(|op| (op.name, *op))
            .collect();
        Self { ops }
    }

    pub fn get(&self, name: &str) -> Option<&NativeOp> {
        self.ops.get(name)
    }

    /// Selected native names only, in deterministic lexical order. Public op-name
    /// union and unknown-op hints remain the server's responsibility.
    pub fn names(&self) -> Vec<&'static str> {
        self.ops.keys().copied().collect()
    }
}
