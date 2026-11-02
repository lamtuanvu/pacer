use crate::{AdmissionError, AdmissionState, PreparedAdmission};
use pacer_foundation::{
    Ctx,
    lock::{LockOptions, with_lock},
};
use pacer_js_json::WireReply;
use pacer_store::{StoreError, TaskEdit};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum MutationError {
    #[error("task changed")]
    Conflict { task: WireReply },
    #[error(transparent)]
    Admission(#[from] AdmissionError),
}
impl AdmissionState {
    /// Operation admission checks the SQLite revision under the task lock before
    /// validation, liveness probes or effects, matching taskMutation in TS.
    /// Effects and success/conflict results retain exact task text; previews
    /// are only for decisions, never sources for a stored-value copy.
    pub fn mutate(
        &mut self,
        id: &str,
        expected_rev: f64,
        now: f64,
        effect: impl FnOnce(&rusqlite::Connection, &mut TaskEdit) -> Result<(), AdmissionError>,
    ) -> Result<WireReply, MutationError> {
        if !expected_rev.is_finite()
            || expected_rev.fract() != 0.0
            || !(1.0..=9_007_199_254_740_991.0).contains(&expected_rev)
        {
            return Err(AdmissionError("expect_rev must be a positive safe integer".into()).into());
        }
        match self
            .tasks
            .edit_admitted(id, expected_rev as i64, now, |db, t| {
                effect(db, t).map_err(|e| StoreError::Admission(e.0))
            }) {
            Ok(value) => Ok(value),
            Err(StoreError::Conflict) => {
                let mut task = self
                    .tasks
                    .read_wire(id)
                    .map_err(AdmissionError::from)?
                    .unwrap_or_else(|| WireReply::new(Value::Null));
                // Keep read()'s default without turning the conflict into a lossy snapshot.
                if task.preview().is_object()
                    && task.preview().get("rev").is_none_or(Value::is_null)
                {
                    task.put("/rev", WireReply::new(serde_json::json!(1)))
                        .map_err(StoreError::from)
                        .map_err(AdmissionError::from)?;
                }
                Err(MutationError::Conflict { task })
            }
            Err(error) => Err(AdmissionError::from(error).into()),
        }
    }
    /// Existing-task counterpart: policy/artifact preparation finishes first,
    /// then the revision and receipt are checked under the final writer lock.
    pub fn mutate_prepared(
        &mut self,
        receipt: &mut PreparedAdmission,
        id: &str,
        expected_rev: i64,
        now: f64,
        context: impl FnMut() -> Result<Value, AdmissionError>,
        effect: impl FnOnce(&Value, &mut TaskEdit) -> Result<(), AdmissionError>,
    ) -> Result<WireReply, AdmissionError> {
        receipt.consume_checked(
            context,
            |_| Ok(()),
            |input, guard| {
                Ok(self
                    .tasks
                    .edit_admitted(id, expected_rev, now, |_, current| {
                        guard().map_err(|e| StoreError::Admission(e.0))?;
                        effect(input, current).map_err(|e| StoreError::Admission(e.0))
                    })?)
            },
        )
    }
    /// Consume only after policy preparation; the final guard runs inside the
    /// same IMMEDIATE transaction that inserts the task and its work lineage.
    pub fn create_prepared(
        &mut self,
        receipt: &mut PreparedAdmission,
        now: f64,
        context: impl FnMut() -> Result<Value, AdmissionError>,
        task: impl FnOnce(&Value) -> Result<Value, AdmissionError>,
    ) -> Result<Value, AdmissionError> {
        let options = receipt.work_options();
        let home = self.tasks.home_path().to_path_buf();
        let ctx = Ctx::with(home.clone(), home, Default::default(), now);
        with_lock(&ctx, "project-strategies", LockOptions::default(), || {
            receipt.consume_checked(
                context,
                |_| Ok(()),
                |input, guard| {
                    let task = task(input)?;
                    let parent = input["workParent"].as_str();
                    self.tasks.insert_with(&task, now, |db| {
                        guard().map_err(|e| StoreError::Admission(e.0))?;
                        if let Some(options) = options.as_ref() {
                            crate::state::register(db, &task, options, parent, now)
                                .map_err(|e| StoreError::Admission(e.0))?;
                        }
                        Ok(())
                    })?;
                    Ok(task)
                },
            )
        })?
    }
}
