use std::{collections::BTreeMap, future::Future, pin::Pin};

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::{
    Ctx,
    api::error::{Code, CoreError},
};

pub type OpFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>>;

/// A native operation contributes only a name and a typed call boundary.
#[derive(Clone, Copy)]
pub struct NativeOp {
    pub name: &'static str,
    pub call: for<'a> fn(&'a Ctx, Value) -> OpFuture<'a>,
}

pub fn params<T: DeserializeOwned>(value: Value) -> Result<T, CoreError> {
    serde_json::from_value(value)
        .map_err(|error| CoreError::new(Code::InvalidInput, format!("params: {error}")))
}

/// A startup snapshot of operations still owned by Rust.
pub struct Registry {
    ops: BTreeMap<&'static str, NativeOp>,
}

impl Registry {
    pub fn new(ops: &[NativeOp], forward: &str) -> Self {
        let forced: Vec<&str> = forward.split(',').map(str::trim).collect();
        let ops = ops
            .iter()
            .filter(|op| !forced.contains(&"*") && !forced.contains(&op.name))
            .map(|op| (op.name, *op))
            .collect();
        Self { ops }
    }

    pub fn get(&self, name: &str) -> Option<&NativeOp> {
        self.ops.get(name)
    }

    pub fn names(&self) -> Vec<&'static str> {
        self.ops.keys().copied().collect()
    }
}
