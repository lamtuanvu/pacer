//! The planner transaction builder: C12a's `PreparedPlannerBuilder` plus the
//! host-backed context the TypeScript `PlannerBuilder` carries (`types.ts:1-9`).

use pacer_plugin::install::{
    PlanEnv, PlannerCommandResult, PlannerRecord, PreparedPlannerBuilder, RunOptions, UndoOp,
};
use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

/// Boxed future alias (the SDK's own `BoxFuture` is crate-private).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// `context.list(dir, glob)` — resolves to paths via `capability.fs.list`.
pub type ListFn = Arc<
    dyn Fn(String, String) -> BoxFuture<'static, Result<Vec<String>, String>> + Send + Sync,
>;

/// POSIX path join, matching `node:path.join` for the absolute home paths the
/// planner deals in (never platform separators).
pub fn join(a: &str, b: &str) -> String {
    if b.is_empty() {
        return a.to_string();
    }
    let b = b.trim_start_matches('/');
    if a.is_empty() {
        return b.to_string();
    }
    let base = a.trim_end_matches('/');
    if base.is_empty() {
        return format!("/{b}");
    }
    format!("{base}/{b}")
}

pub struct PlannerContext {
    pub home: String,
    pub env: BTreeMap<String, String>,
    pub binary: Option<String>,
    pub list: ListFn,
}

/// A borrowed planner transaction: the C12a builder plus the per-agent context.
pub struct PlannerBuilder<'a> {
    pub tx: &'a mut PreparedPlannerBuilder,
    pub context: PlannerContext,
}

impl PlannerBuilder<'_> {
    pub async fn read(&mut self, path: &str) -> Result<Option<String>, String> {
        self.tx.plan.read(path).await.map_err(|e| e.0)
    }

    pub async fn edit<F>(&mut self, path: &str, edit: F, undo: Vec<UndoOp>) -> Result<bool, String>
    where
        F: FnOnce(Option<&str>) -> Result<String, String>,
    {
        self.tx
            .plan
            .edit(path, edit, undo, None)
            .await
            .map_err(|e| e.0)
    }

    pub async fn move_aside(&mut self, path: &str) -> Result<(), String> {
        self.tx.plan.move_aside(path).await.map_err(|e| e.0)
    }

    pub async fn run(
        &mut self,
        argv: &[String],
        undo: Option<&[String]>,
        options: RunOptions,
    ) -> Result<(), String> {
        self.tx.run(argv, undo, options).await.map_err(|e| e.0)
    }

    pub async fn run_raw(
        &mut self,
        argv: &[String],
        undo: Option<&[String]>,
    ) -> Result<PlannerCommandResult, String> {
        self.tx.run_raw(argv, undo).await.map_err(|e| e.0)
    }

    pub fn notes(&mut self) -> &mut Vec<String> {
        &mut self.tx.plan.notes
    }

    pub fn record(&self) -> &PlannerRecord {
        &self.tx.plan.record
    }

    pub fn record_mut(&mut self) -> &mut PlannerRecord {
        &mut self.tx.plan.record
    }

    pub fn env(&self) -> &PlanEnv {
        &self.tx.plan.env
    }
}
