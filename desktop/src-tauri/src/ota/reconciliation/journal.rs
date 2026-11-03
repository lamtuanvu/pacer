//! Isolated reconciliation evidence. Journal contents are never authority.
use super::OtaError;
use crate::ota::platform_fs::{NativeLocks, PrivateDir};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum Phase {
    Prepared,
    EffectIntent,
    EffectObserved,
    Verified,
    Committed,
    Restored,
    RecoveryNeeded,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Journal {
    schema: u32,
    transaction_kind: String,
    transaction_id: String,
    phase: Phase,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum RecoveryOutcome {
    RecoveryNeeded,
}

impl Journal {
    fn validate(&self) -> Result<(), OtaError> {
        let id = &self.transaction_id;
        if self.schema != 1
            || self.transaction_kind != "service-reconciliation"
            || id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(OtaError::Invalid);
        }
        Ok(())
    }

    pub(super) fn decode(bytes: &[u8]) -> Result<Self, OtaError> {
        let journal: Self = serde_json::from_slice(bytes).map_err(|_| OtaError::Invalid)?;
        journal.validate()?;
        Ok(journal)
    }

    // No verified recovery authority exists yet. Even a purported terminal state
    // on disk cannot prove effects, readiness, commit, or ownership of the fence.
    pub(super) fn recovery_outcome(&self) -> RecoveryOutcome {
        RecoveryOutcome::RecoveryNeeded
    }
}

pub(super) struct JournalStore {
    directory: PrivateDir,
    _lock: NativeLocks,
}
impl JournalStore {
    pub(super) fn open(path: &Path) -> Result<Self, OtaError> {
        let directory = PrivateDir::open(path)?;
        let lock = directory.lock_named(".reconciliation-lock")?;
        Ok(Self {
            directory,
            _lock: lock,
        })
    }
    pub(super) fn create(&self, journal: &Journal) -> Result<(), OtaError> {
        journal.validate()?;
        let bytes = serde_json::to_vec(journal).map_err(|_| OtaError::Invalid)?;
        self.directory
            .write_new("reconciliation-journal.json", &bytes)
    }
    pub(super) fn load(&self) -> Result<Journal, OtaError> {
        Journal::decode(
            &self
                .directory
                .read("reconciliation-journal.json", 1_048_576)?,
        )
    }
}
