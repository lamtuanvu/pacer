//! Task-scoped critical sections shared with the TypeScript host's task lock.
use crate::{StoreError, TaskStore};
use pacer_foundation::{
    Ctx,
    lock::{LockOptions, with_lock},
};
use serde_json::Value;
/// Only constructed while the shared task lock is held. Do not retain it across await.
pub struct LockedTask<'a> {
    store: &'a mut TaskStore,
    id: &'a str,
}
impl LockedTask<'_> {
    pub fn read(&mut self) -> Result<Value, StoreError> {
        self.store
            .read(self.id)?
            .ok_or_else(|| StoreError::UnknownTask(self.id.into()))
    }
    pub fn update(
        &mut self,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&mut Value),
    ) -> Result<Value, StoreError> {
        self.store.update_locked(self.id, expected_rev, now, mutate)
    }
}
impl TaskStore {
    /// Keep ownership checks, durable intent publication and a synchronous effect
    /// in one task critical section, using the existing operation lock namespace.
    pub fn with_task_lock<T, E: From<StoreError>>(
        &mut self,
        id: &str,
        action: impl FnOnce(&mut LockedTask<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        if !crate::is_task_id(id) {
            return Err(StoreError::InvalidRecord.into());
        }
        let ctx = Ctx::with(
            self.home.clone(),
            self.home.clone(),
            Default::default(),
            0.0,
        );
        with_lock(&ctx, &format!("task-{id}"), LockOptions::default(), || {
            action(&mut LockedTask { store: self, id })
        })
        .map_err(StoreError::from)
        .map_err(E::from)?
    }
}
