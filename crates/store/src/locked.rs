//! Task-scoped critical sections shared with the TypeScript host's task lock.
use crate::{StoreError, TaskEdit, TaskStore};
use pacer_foundation::{
    Ctx,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::WireReply;
use serde_json::Value;
/// Only constructed while the shared task lock is held. Do not retain it across await.
pub struct LockedTask<'a> {
    store: &'a mut TaskStore,
    id: &'a str,
}
impl LockedTask<'_> {
    /// Read the exact task snapshot while this task lock is held.
    pub fn read_wire(&mut self) -> Result<WireReply, StoreError> {
        self.store
            .read_wire(self.id)?
            .ok_or_else(|| StoreError::UnknownTask(self.id.into()))
    }
    /// Edit exact task text under this already-held task lock and the store's
    /// revision transaction. The returned reply is lossless.
    pub fn edit(
        &mut self,
        expected_rev: i64,
        now: f64,
        mutate: impl FnOnce(&mut TaskEdit) -> Result<(), StoreError>,
    ) -> Result<WireReply, StoreError> {
        self.store.edit_locked(self.id, expected_rev, now, mutate)
    }
    pub fn read(&mut self) -> Result<Value, StoreError> {
        self.store
            .read(self.id)?
            .ok_or_else(|| StoreError::UnknownTask(self.id.into()))
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
