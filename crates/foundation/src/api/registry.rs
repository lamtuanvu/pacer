use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    pin::Pin,
};

use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{Code, CoreError};
use crate::Ctx;

pub type OpFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>>;

pub struct NativeOp {
    pub name: &'static str,
    pub call: for<'a> fn(&'a Ctx, Value) -> OpFuture<'a>,
}

// Native operation handlers use CoreError by value throughout their boundary.
#[allow(clippy::result_large_err)]
pub fn params<T: DeserializeOwned>(value: Value) -> Result<T, CoreError> {
    serde_json::from_value(value)
        .map_err(|error| CoreError::new(Code::InvalidInput, format!("params: {error}")))
}

/// An internal registry. Forward selections only remove native handlers.
pub struct Registry<'a> {
    ops: BTreeMap<&'static str, &'a NativeOp>,
    all_names: BTreeSet<&'static str>,
}

impl<'a> Registry<'a> {
    pub fn new(ops: &'a [NativeOp], forward: &str) -> Self {
        let forwarded: Vec<&str> = forward
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        let mut registered = BTreeMap::new();
        let mut all_names = BTreeSet::new();
        for op in ops {
            all_names.insert(op.name);
            if !forwarded.contains(&"*") && !forwarded.contains(&op.name) {
                registered.insert(op.name, op);
            }
        }
        Self {
            ops: registered,
            all_names,
        }
    }

    pub fn get(&self, name: &str) -> Option<&NativeOp> {
        self.ops.get(name).copied()
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.ops.keys().copied().collect()
    }

    /// Unknown-op hints expose the complete public operation set, including
    /// native handlers selected for TypeScript forwarding.
    pub fn unknown_op(&self, name: &str, forwarded_names: &[&str]) -> CoreError {
        CoreError::unknown_op(
            name,
            self.all_names
                .iter()
                .copied()
                .chain(forwarded_names.iter().copied()),
        )
    }
}
