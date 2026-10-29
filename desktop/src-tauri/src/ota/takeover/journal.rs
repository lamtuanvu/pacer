use super::detect::TakeoverCandidate;
use crate::ota::platform_fs::{NativeLocks, PrivateDir};
use crate::ota::{required_nullable, AwakeStamp, OtaError, ProcessIdentity};
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const LIMIT: u64 = 1_048_576;
const MANIFEST: &str = "takeover-manifest.json";
const JOURNAL: &str = "takeover-journal.json";

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TakeoverState {
    Prepared,
    Stopping,
    Switched,
    Verifying,
    Committed,
    Restoring,
    Restored,
    RecoveryFailed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverManifest {
    pub schema: u32,
    pub transaction_kind: String,
    pub transaction_id: String,
    pub candidate: TakeoverCandidate,
    pub desktop: ProcessIdentity,
    pub bundled_cli: PathBuf,
    pub original_registration_b64: String,
    pub relink_terminal: bool,
    pub authorized_at: AwakeStamp,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TakeoverAction {
    ArmRecovery,
    StopOriginal,
    SwitchRegistration,
    LaunchManaged,
    Verify,
    RestoreRegistration,
    LaunchOriginal,
}

/// Whether a returned action succeeded. Present exactly when `completed` is.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum StepOutcome {
    Ok,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverStep {
    pub action: TakeoverAction,
    pub intent_boot_id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub completed: Option<AwakeStamp>,
    #[serde(deserialize_with = "required_nullable")]
    pub outcome: Option<StepOutcome>,
    #[serde(deserialize_with = "required_nullable")]
    pub uncertain: Option<AwakeStamp>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverJournal {
    pub schema: u32,
    pub transaction_kind: String,
    pub revision: u64,
    pub manifest_sha256: String,
    pub state: TakeoverState,
    pub steps: Vec<TakeoverStep>,
    #[serde(deserialize_with = "required_nullable")]
    pub error: Option<String>,
}

impl TakeoverState {
    pub fn terminal(self) -> bool {
        matches!(
            self,
            Self::Committed | Self::Restored | Self::RecoveryFailed
        )
    }
}

/// The latest finished transaction, as the desktop reports it at launch.
#[derive(Clone, Debug, PartialEq)]
pub struct FinishedTakeover {
    pub transaction_id: String,
    pub state: TakeoverState,
    pub error: Option<String>,
    pub candidate: TakeoverCandidate,
}

/// What the desktop must respect before it acts on the service.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TakeoverStatus {
    /// A transaction has made or may have made effects and has not finished.
    /// The helper or its recovery job owns the service until it does.
    pub pending: bool,
    /// The transactions that make the status pending.
    pub unfinished: Vec<UnfinishedTakeover>,
    pub latest: Option<FinishedTakeover>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnfinishedTakeover {
    pub transaction_id: String,
    /// False when the manifest or journal cannot be read or validated.
    pub readable: bool,
    /// Where a readable transaction was started.
    pub origin: Option<TakeoverOrigin>,
}

/// The app bundle and boot a transaction was authorized from, as recorded in
/// its manifest. The desktop runs recovery itself only for its own.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TakeoverOrigin {
    pub bundled_cli: PathBuf,
    pub boot_id: String,
}

struct Entry {
    tx: String,
    record: Result<(TakeoverManifest, TakeoverJournal), OtaError>,
    modified: std::time::SystemTime,
}

fn scan(home: &Path) -> Vec<Entry> {
    let Ok(home) = home.canonicalize() else {
        return Vec::new();
    };
    let root = home.join("desktop-updates/native/takeover");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Some(tx) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_id(&tx) {
            continue;
        }
        let modified = std::fs::metadata(root.join(&tx).join(JOURNAL))
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        found.push(Entry {
            record: read_unlocked(&home, &tx),
            tx,
            modified,
        });
    }
    found
}

/// Reads every takeover transaction under `home` without taking its lock. An
/// unreadable or invalid transaction is treated as pending, so the desktop
/// never acts on a service whose ownership it cannot establish.
pub fn status(home: &Path) -> TakeoverStatus {
    let mut status = TakeoverStatus::default();
    let mut latest: Option<(std::time::SystemTime, FinishedTakeover)> = None;
    for Entry {
        tx,
        record,
        modified,
    } in scan(home)
    {
        let Ok((manifest, journal)) = record else {
            status.unfinished.push(UnfinishedTakeover {
                transaction_id: tx,
                readable: false,
                origin: None,
            });
            continue;
        };
        if !journal.state.terminal() {
            // Nothing happened and no recovery job exists yet: a helper that
            // stopped before its first effect leaves the service untouched.
            if !(journal.state == TakeoverState::Prepared && journal.steps.is_empty()) {
                status.unfinished.push(UnfinishedTakeover {
                    transaction_id: tx,
                    readable: true,
                    origin: Some(TakeoverOrigin {
                        bundled_cli: manifest.bundled_cli.clone(),
                        boot_id: manifest.authorized_at.boot_id.clone(),
                    }),
                });
            }
            continue;
        }
        if latest.as_ref().is_none_or(|(time, _)| modified > *time) {
            latest = Some((
                modified,
                FinishedTakeover {
                    transaction_id: tx,
                    state: journal.state,
                    error: journal.error,
                    candidate: manifest.candidate,
                },
            ));
        }
    }
    status
        .unfinished
        .sort_by(|a, b| a.transaction_id.cmp(&b.transaction_id));
    status.pending = !status.unfinished.is_empty();
    status.latest = latest.map(|(_, finished)| finished);
    status
}

/// Whether a transaction can be removed once a newer one exists: it finished
/// with the original or the app's service in place, or it never took a step.
fn prunable(journal: &TakeoverJournal) -> bool {
    matches!(
        journal.state,
        TakeoverState::Committed | TakeoverState::Restored
    ) || (journal.state == TakeoverState::Prepared && journal.steps.is_empty())
}

/// Removes committed, restored and never-started transactions older than the
/// newest one, with their helper copies. Recovery-failed and unreadable
/// transactions stay as evidence, and so does any transaction whose recovery
/// job is loaded (or cannot be ruled out) or whose helper holds its lock.
/// Returns the number removed.
pub fn prune(home: &Path, recovery_loaded: impl Fn(&str) -> bool) -> usize {
    let entries = scan(home);
    let Some(newest) = entries
        .iter()
        .max_by_key(|entry| entry.modified)
        .map(|entry| entry.tx.clone())
    else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries {
        let finished = entry
            .record
            .as_ref()
            .is_ok_and(|(_, journal)| prunable(journal));
        if entry.tx == newest || !finished || recovery_loaded(&entry.tx) {
            continue;
        }
        // Hold the transaction lock and re-check the state before removing it.
        let Ok(store) = TakeoverStore::open(home, &entry.tx) else {
            continue;
        };
        if !store.journal().is_ok_and(|journal| prunable(&journal)) {
            continue;
        }
        let Ok(path) = TakeoverStore::path(home, &entry.tx) else {
            continue;
        };
        if std::fs::remove_dir_all(&path).is_ok() {
            removed += 1;
        }
        drop(store);
    }
    removed
}

fn read_unlocked(home: &Path, tx: &str) -> Result<(TakeoverManifest, TakeoverJournal), OtaError> {
    let directory = PrivateDir::open(&TakeoverStore::path(home, tx)?)?;
    let bytes = directory.read(MANIFEST, LIMIT)?;
    let manifest: TakeoverManifest =
        serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
    validate_manifest(&manifest)?;
    require(manifest.transaction_id == tx)?;
    let journal: TakeoverJournal =
        serde_json::from_slice(&directory.read(JOURNAL, LIMIT)?).map_err(|_| OtaError::Invalid)?;
    validate_journal(&journal, &manifest, &digest(&bytes))?;
    Ok((manifest, journal))
}

pub struct TakeoverStore {
    directory: PrivateDir,
    _lock: NativeLocks,
    manifest: TakeoverManifest,
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
/// Public reason codes are short kebab-case words joined by `:`, never paths.
pub fn valid_reason(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b':')
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn require(value: bool) -> Result<(), OtaError> {
    if value {
        Ok(())
    } else {
        Err(OtaError::Invalid)
    }
}
fn valid_path(path: &Path) -> bool {
    path.is_absolute()
        && path.components().all(|c| {
            matches!(
                c,
                std::path::Component::RootDir | std::path::Component::Normal(_)
            )
        })
}
fn validate_manifest(m: &TakeoverManifest) -> Result<(), OtaError> {
    let registration = base64::engine::general_purpose::STANDARD
        .decode(&m.original_registration_b64)
        .map_err(|_| OtaError::Invalid)?;
    require(
        m.schema == 1
            && m.transaction_kind == "takeover"
            && valid_id(&m.transaction_id)
            && !m.candidate.label.is_empty()
            && valid_hash(&m.candidate.registration_sha256)
            && digest(&registration) == m.candidate.registration_sha256
            && valid_path(&m.candidate.program)
            && valid_path(&m.candidate.canonical_program)
            && valid_path(&m.candidate.home)
            && valid_path(&m.bundled_cli)
            && m.candidate.port > 0
            && m.candidate.process.pid > 0
            && m.desktop.pid > 0
            && !m.authorized_at.boot_id.is_empty()
            && m.desktop.boot_id == m.authorized_at.boot_id
            && m.candidate.process.boot_id == m.authorized_at.boot_id,
    )
}
fn allowed(from: TakeoverState, to: TakeoverState, no_effects: bool, uncertain: bool) -> bool {
    use TakeoverState::*;
    (!uncertain || from == Restoring || to == Restoring)
        && (matches!(
            (from, to),
            (Prepared, Stopping)
                | (Stopping, Switched)
                | (Switched, Verifying)
                | (Verifying, Committed)
                | (Stopping | Switched | Verifying, Restoring)
                | (Restoring, Restored | RecoveryFailed)
        ) || (from == Prepared
            && ((to == Restored && no_effects) || (to == Restoring && !no_effects))))
}
fn validate_journal(j: &TakeoverJournal, m: &TakeoverManifest, hash: &str) -> Result<(), OtaError> {
    require(
        j.schema == 1
            && j.transaction_kind == "takeover"
            && j.manifest_sha256 == hash
            && valid_hash(&j.manifest_sha256)
            && j.steps.len() <= 4096
            && j.steps.iter().all(|s| {
                !s.intent_boot_id.is_empty()
                    && s.intent_boot_id.len() <= 128
                    && !(s.completed.is_some() && s.uncertain.is_some())
                    && s.completed.is_some() == s.outcome.is_some()
                    && s.uncertain.as_ref().is_none_or(|t| !t.boot_id.is_empty())
                    && s.completed
                        .as_ref()
                        .is_none_or(|t| t.boot_id == s.intent_boot_id)
            }),
    )?;
    require(match (j.state, &j.error) {
        (TakeoverState::RecoveryFailed, error) => error.as_deref().is_some_and(valid_reason),
        (TakeoverState::Restoring | TakeoverState::Restored, error) => {
            error.as_deref().is_none_or(valid_reason)
        }
        (_, error) => error.is_none(),
    })?;
    require(
        j.steps
            .iter()
            .filter(|s| s.completed.is_none() && s.uncertain.is_none())
            .count()
            <= 1,
    )?;
    require(
        !j.steps.iter().any(|s| s.uncertain.is_some())
            || matches!(
                j.state,
                TakeoverState::Prepared
                    | TakeoverState::Stopping
                    | TakeoverState::Switched
                    | TakeoverState::Verifying
                    | TakeoverState::Restoring
                    | TakeoverState::Restored
                    | TakeoverState::RecoveryFailed
            ),
    )?;
    if j.state == TakeoverState::Prepared {
        require(
            j.steps
                .iter()
                .all(|step| step.action == TakeoverAction::ArmRecovery),
        )?;
    }
    if j.state == TakeoverState::Restored && j.steps.is_empty() {
        return Ok(());
    }
    require(j.state != TakeoverState::Restored || !j.steps.is_empty())?;
    require(m.transaction_kind == "takeover")
}
impl TakeoverStore {
    fn path(home: &Path, tx: &str) -> Result<PathBuf, OtaError> {
        require(valid_id(tx))?;
        let home = home.canonicalize().map_err(|_| OtaError::Io)?;
        Ok(home.join("desktop-updates/native/takeover").join(tx))
    }
    pub fn create(home: &Path, manifest: &TakeoverManifest) -> Result<Self, OtaError> {
        validate_manifest(manifest)?;
        use std::os::unix::fs::DirBuilderExt;
        let parent = home
            .canonicalize()
            .map_err(|_| OtaError::Io)?
            .join("desktop-updates/native/takeover");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&parent)
            .map_err(|_| OtaError::Io)?;
        let path = Self::path(home, &manifest.transaction_id)?;
        require(!path.exists())?;
        let directory = PrivateDir::create(&path)?;
        let lock = directory.lock_named(".lock")?;
        let bytes = serde_json::to_vec(manifest).map_err(|_| OtaError::Invalid)?;
        require(bytes.len() <= LIMIT as usize)?;
        directory.write_new(MANIFEST, &bytes)?;
        let journal = TakeoverJournal {
            schema: 1,
            transaction_kind: "takeover".into(),
            revision: 0,
            manifest_sha256: digest(&bytes),
            state: TakeoverState::Prepared,
            steps: vec![],
            error: None,
        };
        directory.write_new(
            JOURNAL,
            &serde_json::to_vec(&journal).map_err(|_| OtaError::Invalid)?,
        )?;
        Ok(Self {
            directory,
            _lock: lock,
            manifest: manifest.clone(),
        })
    }
    pub fn open(home: &Path, tx: &str) -> Result<Self, OtaError> {
        let directory = PrivateDir::open(&Self::path(home, tx)?)?;
        let lock = directory.lock_named(".lock")?;
        let bytes = directory.read(MANIFEST, LIMIT)?;
        let manifest: TakeoverManifest =
            serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
        validate_manifest(&manifest)?;
        require(manifest.transaction_id == tx)?;
        let result = Self {
            directory,
            _lock: lock,
            manifest,
        };
        result.journal()?;
        Ok(result)
    }
    pub fn manifest(&self) -> &TakeoverManifest {
        &self.manifest
    }
    pub fn journal(&self) -> Result<TakeoverJournal, OtaError> {
        let manifest_bytes = self.directory.read(MANIFEST, LIMIT)?;
        let m: TakeoverManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|_| OtaError::Invalid)?;
        validate_manifest(&m)?;
        require(m == self.manifest)?;
        let journal: TakeoverJournal =
            serde_json::from_slice(&self.directory.read(JOURNAL, LIMIT)?)
                .map_err(|_| OtaError::Invalid)?;
        validate_journal(&journal, &m, &digest(&manifest_bytes))?;
        Ok(journal)
    }
    fn change(
        &self,
        edit: impl FnOnce(&mut TakeoverJournal) -> Result<(), OtaError>,
    ) -> Result<TakeoverJournal, OtaError> {
        let before = self.directory.read(JOURNAL, LIMIT)?;
        let mut journal = self.journal()?;
        edit(&mut journal)?;
        journal.revision = journal.revision.checked_add(1).ok_or(OtaError::Invalid)?;
        let manifest_bytes = self.directory.read(MANIFEST, LIMIT)?;
        validate_journal(&journal, &self.manifest, &digest(&manifest_bytes))?;
        let next = serde_json::to_vec(&journal).map_err(|_| OtaError::Invalid)?;
        require(next.len() <= LIMIT as usize)?;
        self.directory.replace_exact(JOURNAL, &before, &next)?;
        Ok(journal)
    }
    pub fn intend(&self, action: TakeoverAction) -> Result<TakeoverJournal, OtaError> {
        let stamp = crate::ota::native::awake_now().map_err(|_| OtaError::Io)?;
        self.change(|j| {
            require(!matches!(
                j.state,
                TakeoverState::Committed | TakeoverState::Restored | TakeoverState::RecoveryFailed
            ))?;
            require(
                j.steps
                    .iter()
                    .all(|s| s.completed.is_some() || s.uncertain.is_some()),
            )?;
            require(
                !j.steps.iter().any(|s| s.uncertain.is_some())
                    || j.state == TakeoverState::Restoring,
            )?;
            j.steps.push(TakeoverStep {
                action,
                intent_boot_id: stamp.boot_id,
                completed: None,
                outcome: None,
                uncertain: None,
            });
            Ok(())
        })
    }
    pub fn complete(
        &self,
        action: &TakeoverAction,
        outcome: StepOutcome,
    ) -> Result<TakeoverJournal, OtaError> {
        let stamp = crate::ota::native::awake_now().map_err(|_| OtaError::Io)?;
        self.change(|j| {
            let step = j
                .steps
                .iter_mut()
                .rev()
                .find(|s| &s.action == action && s.completed.is_none() && s.uncertain.is_none())
                .ok_or(OtaError::Invalid)?;
            require(step.intent_boot_id == stamp.boot_id)?;
            step.completed = Some(stamp);
            step.outcome = Some(outcome);
            Ok(())
        })
    }
    pub fn mark_uncertain(&self) -> Result<TakeoverJournal, OtaError> {
        // The store holds its exclusive .lock for its entire lifetime. A
        // recovery caller therefore knows the helper that wrote this intent
        // is gone, even if the intent was written during this boot.
        let stamp = crate::ota::native::awake_now().map_err(|_| OtaError::Io)?;
        self.change(|j| {
            let step = j
                .steps
                .iter_mut()
                .find(|s| s.completed.is_none() && s.uncertain.is_none())
                .ok_or(OtaError::Invalid)?;
            step.uncertain = Some(stamp);
            Ok(())
        })
    }
    pub fn transition(&self, to: TakeoverState) -> Result<TakeoverJournal, OtaError> {
        self.transition_with(to, None)
    }
    /// Transitions and, when `reason` is given, records it as the public
    /// error code. Only restoration states may carry a reason.
    pub fn transition_with(
        &self,
        to: TakeoverState,
        reason: Option<&str>,
    ) -> Result<TakeoverJournal, OtaError> {
        self.change(|j| {
            if let Some(reason) = reason {
                require(valid_reason(reason))?;
                j.error = Some(reason.to_owned());
            }
            require(
                j.steps
                    .iter()
                    .all(|s| s.completed.is_some() || s.uncertain.is_some())
                    || to == TakeoverState::Restoring,
            )?;
            require(allowed(
                j.state,
                to,
                j.steps.is_empty(),
                j.steps.iter().any(|s| s.uncertain.is_some()),
            ))?;
            j.state = to;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn manifest() -> TakeoverManifest {
        let registration = b"plist";
        let process = ProcessIdentity {
            pid: 123,
            boot_id: "boot".into(),
            birth: "one".into(),
        };
        TakeoverManifest {
            schema: 1,
            transaction_kind: "takeover".into(),
            transaction_id: "tx-one".into(),
            candidate: TakeoverCandidate {
                label: "com.pacer.serve".into(),
                registration_sha256: digest(registration),
                process: process.clone(),
                program: "/tmp/pacer".into(),
                canonical_program: "/tmp/pacer".into(),
                identity: crate::ota::bootstrap_identity::LegacyExecutable {
                    device: "1".into(),
                    inode: "2".into(),
                    size: 3,
                    modified_ns: "4".into(),
                    changed_ns: "5".into(),
                    sha256: "a".repeat(64),
                    cdhash: "b".repeat(40),
                },
                home: "/tmp/pacer-home".into(),
                port: 4317,
            },
            desktop: process,
            bundled_cli: "/tmp/app/pacer".into(),
            original_registration_b64: base64::engine::general_purpose::STANDARD
                .encode(registration),
            relink_terminal: false,
            authorized_at: AwakeStamp {
                boot_id: "boot".into(),
                millis: 1,
            },
        }
    }
    #[test]
    fn shared_fixture_is_a_valid_takeover_manifest() {
        let bytes = include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../test/fixtures/desktop-update/takeover-manifest.json"
        ));
        let manifest: TakeoverManifest = serde_json::from_slice(bytes).unwrap();
        assert_eq!(validate_manifest(&manifest), Ok(()));
    }
    #[test]
    fn store_rejects_invalid_manifest_and_journal() {
        let temp = tempfile::tempdir().unwrap();
        let mut m = manifest();
        m.schema = 2;
        assert_eq!(
            TakeoverStore::create(temp.path(), &m).err(),
            Some(OtaError::Invalid)
        );
        m.schema = 1;
        m.transaction_kind = "adoption".into();
        assert_eq!(
            TakeoverStore::create(temp.path(), &m).err(),
            Some(OtaError::Invalid)
        );
        m.transaction_kind = "takeover".into();
        let store = TakeoverStore::create(temp.path(), &m).unwrap();
        let path = TakeoverStore::path(temp.path(), &m.transaction_id).unwrap();
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path.join(JOURNAL)).unwrap()).unwrap();
        value["manifestSha256"] = serde_json::json!("0".repeat(64));
        std::fs::write(path.join(JOURNAL), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(store.journal().err(), Some(OtaError::Invalid));
        value["manifestSha256"] =
            serde_json::json!(digest(&std::fs::read(path.join(MANIFEST)).unwrap()));
        value["extra"] = serde_json::json!(true);
        std::fs::write(path.join(JOURNAL), serde_json::to_vec(&value).unwrap()).unwrap();
        assert_eq!(store.journal().err(), Some(OtaError::Invalid));
        value.as_object_mut().unwrap().remove("extra");
        for (field, replacement) in [
            ("schema", serde_json::json!(2)),
            ("transactionKind", serde_json::json!("adoption")),
        ] {
            let original = value[field].clone();
            value[field] = replacement;
            std::fs::write(path.join(JOURNAL), serde_json::to_vec(&value).unwrap()).unwrap();
            assert_eq!(store.journal().err(), Some(OtaError::Invalid));
            value[field] = original;
        }
    }
    #[test]
    fn complete_needs_intent_and_transitions_follow_graph() {
        let temp = tempfile::tempdir().unwrap();
        let store = TakeoverStore::create(temp.path(), &manifest()).unwrap();
        assert_eq!(
            store
                .complete(&TakeoverAction::StopOriginal, StepOutcome::Ok)
                .err(),
            Some(OtaError::Invalid)
        );
        assert_eq!(
            store.transition(TakeoverState::Committed).err(),
            Some(OtaError::Invalid)
        );
        assert_eq!(
            store.transition(TakeoverState::Stopping).unwrap().state,
            TakeoverState::Stopping
        );
        assert_eq!(
            store.transition(TakeoverState::Switched).unwrap().state,
            TakeoverState::Switched
        );
        assert_eq!(
            store.transition(TakeoverState::Verifying).unwrap().state,
            TakeoverState::Verifying
        );
        assert_eq!(
            store.transition(TakeoverState::Committed).unwrap().state,
            TakeoverState::Committed
        );
        assert_eq!(
            store.transition(TakeoverState::Restoring).err(),
            Some(OtaError::Invalid)
        );
    }
    #[test]
    fn intent_and_completion_are_durable_and_reopenable() {
        let temp = tempfile::tempdir().unwrap();
        let m = manifest();
        let store = TakeoverStore::create(temp.path(), &m).unwrap();
        store.transition(TakeoverState::Stopping).unwrap();
        let intent = store.intend(TakeoverAction::StopOriginal).unwrap();
        assert_eq!(intent.steps.len(), 1);
        assert_eq!(intent.steps[0].completed, None);
        assert_eq!(
            store
                .complete(&TakeoverAction::StopOriginal, StepOutcome::Ok)
                .unwrap()
                .steps[0]
                .completed
                .is_some(),
            true
        );
        assert_eq!(
            store
                .complete(&TakeoverAction::StopOriginal, StepOutcome::Ok)
                .err(),
            Some(OtaError::Invalid)
        );
        drop(store);
        let reopened = TakeoverStore::open(temp.path(), &m.transaction_id).unwrap();
        assert_eq!(reopened.journal().unwrap().revision, 3);
    }
    #[test]
    fn recovery_arm_is_journaled_while_prepared() {
        let temp = tempfile::tempdir().unwrap();
        let store = TakeoverStore::create(temp.path(), &manifest()).unwrap();
        assert_eq!(
            store.intend(TakeoverAction::ArmRecovery).unwrap().state,
            TakeoverState::Prepared
        );
        assert_eq!(
            store
                .complete(&TakeoverAction::ArmRecovery, StepOutcome::Ok)
                .unwrap()
                .steps
                .len(),
            1
        );
        assert_eq!(
            store.transition(TakeoverState::Restored).err(),
            Some(OtaError::Invalid)
        );
        assert_eq!(
            store.transition(TakeoverState::Restoring).unwrap().state,
            TakeoverState::Restoring
        );
    }
    #[test]
    fn outstanding_intent_is_unique_and_same_boot_can_be_uncertain_under_lock() {
        let temp = tempfile::tempdir().unwrap();
        let store = TakeoverStore::create(temp.path(), &manifest()).unwrap();
        store.intend(TakeoverAction::ArmRecovery).unwrap();
        assert_eq!(
            store.intend(TakeoverAction::ArmRecovery).err(),
            Some(OtaError::Invalid)
        );
        let journal = store.mark_uncertain().unwrap();
        assert!(journal.steps[0].uncertain.is_some());
        assert_eq!(
            store
                .complete(&TakeoverAction::ArmRecovery, StepOutcome::Ok)
                .err(),
            Some(OtaError::Invalid)
        );
        assert_eq!(
            store.transition(TakeoverState::Stopping).err(),
            Some(OtaError::Invalid)
        );
        store.transition(TakeoverState::Restoring).unwrap();
        assert_eq!(store.mark_uncertain().err(), Some(OtaError::Invalid));
    }
    #[test]
    fn stale_intent_is_durably_uncertain_and_requires_restoration() {
        let temp = tempfile::tempdir().unwrap();
        let m = manifest();
        let store = TakeoverStore::create(temp.path(), &m).unwrap();
        store.intend(TakeoverAction::ArmRecovery).unwrap();
        let path = TakeoverStore::path(temp.path(), &m.transaction_id)
            .unwrap()
            .join(JOURNAL);
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        value["steps"][0]["intentBootId"] = serde_json::json!("prior-boot");
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let journal = store.mark_uncertain().unwrap();
        assert!(journal.steps[0].uncertain.is_some());
        assert_eq!(
            store
                .complete(&TakeoverAction::ArmRecovery, StepOutcome::Ok)
                .err(),
            Some(OtaError::Invalid)
        );
        assert_eq!(
            store.transition(TakeoverState::Restored).err(),
            Some(OtaError::Invalid)
        );
        assert_eq!(
            store.transition(TakeoverState::Stopping).err(),
            Some(OtaError::Invalid)
        );
        store.transition(TakeoverState::Restoring).unwrap();
        drop(store);
        let reopened = TakeoverStore::open(temp.path(), &m.transaction_id).unwrap();
        assert!(reopened.journal().unwrap().steps[0].uncertain.is_some());
    }
    #[test]
    fn malformed_step_resolution_is_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let m = manifest();
        let store = TakeoverStore::create(temp.path(), &m).unwrap();
        store.intend(TakeoverAction::ArmRecovery).unwrap();
        let path = TakeoverStore::path(temp.path(), &m.transaction_id)
            .unwrap()
            .join(JOURNAL);
        let valid: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let mut missing = valid.clone();
        missing["steps"][0]
            .as_object_mut()
            .unwrap()
            .remove("uncertain");
        std::fs::write(&path, serde_json::to_vec(&missing).unwrap()).unwrap();
        assert_eq!(store.journal().err(), Some(OtaError::Invalid));
        let mut both = valid.clone();
        both["steps"][0]["completed"] =
            serde_json::json!({"bootId": valid["steps"][0]["intentBootId"], "millis": 1});
        both["steps"][0]["uncertain"] = serde_json::json!({"bootId": "prior-boot", "millis": 2});
        std::fs::write(&path, serde_json::to_vec(&both).unwrap()).unwrap();
        assert_eq!(store.journal().err(), Some(OtaError::Invalid));
        std::fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
        assert_eq!(store.journal().unwrap().steps.len(), 1);
    }
    #[test]
    fn reader_rejects_inconsistent_outcome_and_error() {
        let temp = tempfile::tempdir().unwrap();
        let m = manifest();
        let store = TakeoverStore::create(temp.path(), &m).unwrap();
        store.intend(TakeoverAction::ArmRecovery).unwrap();
        store
            .complete(&TakeoverAction::ArmRecovery, StepOutcome::Failed)
            .unwrap();
        let path = TakeoverStore::path(temp.path(), &m.transaction_id)
            .unwrap()
            .join(JOURNAL);
        let valid: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(valid["steps"][0]["outcome"], "failed");
        let reject = |value: &serde_json::Value| {
            std::fs::write(&path, serde_json::to_vec(value).unwrap()).unwrap();
            assert_eq!(store.journal().err(), Some(OtaError::Invalid), "{value}");
        };
        let mut missing = valid.clone();
        missing["steps"][0]
            .as_object_mut()
            .unwrap()
            .remove("outcome");
        reject(&missing);
        let mut unpaired = valid.clone();
        unpaired["steps"][0]["outcome"] = serde_json::Value::Null;
        reject(&unpaired);
        let mut unknown = valid.clone();
        unknown["steps"][0]["outcome"] = serde_json::json!("maybe");
        reject(&unknown);
        let mut early = valid.clone();
        early["error"] = serde_json::json!("arm-recovery:io");
        reject(&early);
        // `error` is required even when it is null.
        let mut absent = valid.clone();
        absent.as_object_mut().unwrap().remove("error");
        reject(&absent);
        let mut failed = valid.clone();
        failed["state"] = serde_json::json!("recovery-failed");
        reject(&failed);
        failed["error"] = serde_json::json!("/tmp/pacer-fixture/pacer");
        reject(&failed);
        std::fs::write(&path, serde_json::to_vec(&valid).unwrap()).unwrap();
        assert_eq!(
            store
                .transition_with(TakeoverState::Restoring, Some("arm-recovery:io"))
                .unwrap()
                .error
                .as_deref(),
            Some("arm-recovery:io")
        );
        assert_eq!(
            store
                .transition_with(TakeoverState::RecoveryFailed, Some("Bad Path/x"))
                .err(),
            Some(OtaError::Invalid)
        );
    }
    fn manifest_with_id(id: &str) -> TakeoverManifest {
        TakeoverManifest {
            transaction_id: id.into(),
            ..manifest()
        }
    }
    #[test]
    fn launch_status_reports_pending_and_the_latest_finished_transaction() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(status(temp.path()), TakeoverStatus::default());
        // A helper that stopped before its first effect leaves nothing pending.
        let idle = TakeoverStore::create(temp.path(), &manifest_with_id("tx-idle")).unwrap();
        drop(idle);
        assert_eq!(status(temp.path()), TakeoverStatus::default());
        // An effect without a final state is pending, even while its lock is held.
        let store = TakeoverStore::create(temp.path(), &manifest_with_id("tx-pending")).unwrap();
        store.intend(TakeoverAction::ArmRecovery).unwrap();
        let pending = status(temp.path());
        assert!(pending.pending);
        assert_eq!(pending.latest, None);
        store
            .complete(&TakeoverAction::ArmRecovery, StepOutcome::Ok)
            .unwrap();
        store.transition(TakeoverState::Stopping).unwrap();
        assert!(status(temp.path()).pending);
        store
            .transition_with(TakeoverState::Restoring, Some("stop-original:identity"))
            .unwrap();
        assert!(status(temp.path()).pending);
        store.transition(TakeoverState::Restored).unwrap();
        let finished = status(temp.path());
        assert!(!finished.pending);
        let latest = finished.latest.unwrap();
        assert_eq!(latest.transaction_id, "tx-pending");
        assert_eq!(latest.state, TakeoverState::Restored);
        assert_eq!(latest.error.as_deref(), Some("stop-original:identity"));
        assert_eq!(latest.candidate, manifest().candidate);
    }
    #[test]
    fn launch_status_prefers_the_newest_journal_and_treats_damage_as_pending() {
        let temp = tempfile::tempdir().unwrap();
        let older = TakeoverStore::create(temp.path(), &manifest_with_id("tx-older")).unwrap();
        older.intend(TakeoverAction::ArmRecovery).unwrap();
        older
            .complete(&TakeoverAction::ArmRecovery, StepOutcome::Failed)
            .unwrap();
        older
            .transition_with(TakeoverState::Restoring, Some("arm-recovery:io"))
            .unwrap();
        older
            .transition_with(
                TakeoverState::RecoveryFailed,
                Some("restore-registration:identity"),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let newer = TakeoverStore::create(temp.path(), &manifest_with_id("tx-newer")).unwrap();
        newer
            .transition_with(TakeoverState::Restored, Some("redetect:identity"))
            .unwrap();
        let latest = status(temp.path()).latest.unwrap();
        assert_eq!(
            (latest.transaction_id.as_str(), latest.state),
            ("tx-newer", TakeoverState::Restored)
        );
        let path = TakeoverStore::path(temp.path(), "tx-older")
            .unwrap()
            .join(JOURNAL);
        std::fs::write(&path, b"{").unwrap();
        let damaged = status(temp.path());
        assert!(damaged.pending);
        assert_eq!(
            damaged.unfinished,
            vec![UnfinishedTakeover {
                transaction_id: "tx-older".into(),
                readable: false,
                origin: None,
            }]
        );
    }
    #[test]
    fn launch_status_lists_each_unfinished_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let store = TakeoverStore::create(temp.path(), &manifest_with_id("tx-armed")).unwrap();
        // The helper recorded its intent to arm recovery and was killed before the job loaded.
        store.intend(TakeoverAction::ArmRecovery).unwrap();
        drop(store);
        assert_eq!(
            status(temp.path()).unfinished,
            vec![UnfinishedTakeover {
                transaction_id: "tx-armed".into(),
                readable: true,
                // The desktop recovers it only if this app started it in this boot.
                origin: Some(TakeoverOrigin {
                    bundled_cli: manifest().bundled_cli,
                    boot_id: manifest().authorized_at.boot_id,
                }),
            }]
        );
    }
    #[test]
    fn pruning_never_removes_the_newest_transaction_even_if_it_never_started() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        drop(TakeoverStore::create(home, &manifest_with_id("tx-unstarted")).unwrap());
        assert_eq!(prune(home, |_| false), 0);
        // A running helper holds the lock of a newer never-started transaction.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let running = TakeoverStore::create(home, &manifest_with_id("tx-running")).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        drop(TakeoverStore::create(home, &manifest_with_id("tx-newest")).unwrap());
        assert_eq!(prune(home, |_| false), 1);
        assert!(TakeoverStore::path(home, "tx-running").unwrap().exists());
        assert!(!TakeoverStore::path(home, "tx-unstarted").unwrap().exists());
        drop(running);
    }
    #[test]
    fn pruning_keeps_the_newest_transaction_and_recovery_failed_evidence() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let make = |id: &str, end: TakeoverState| {
            let store = TakeoverStore::create(home, &manifest_with_id(id)).unwrap();
            store.intend(TakeoverAction::ArmRecovery).unwrap();
            store
                .complete(&TakeoverAction::ArmRecovery, StepOutcome::Ok)
                .unwrap();
            if end == TakeoverState::Committed {
                store.transition(TakeoverState::Stopping).unwrap();
                store.transition(TakeoverState::Switched).unwrap();
                store.transition(TakeoverState::Verifying).unwrap();
                store.transition(TakeoverState::Committed).unwrap();
            } else {
                store
                    .transition_with(TakeoverState::Restoring, Some("verify:unavailable"))
                    .unwrap();
                store
                    .transition_with(
                        end,
                        (end == TakeoverState::RecoveryFailed)
                            .then_some("restore-registration:identity"),
                    )
                    .unwrap();
            }
            // The armed helper copy is removed with its transaction.
            std::fs::write(
                TakeoverStore::path(home, id)
                    .unwrap()
                    .join("pacer-update-helper"),
                b"helper",
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(20));
        };
        make("tx-committed", TakeoverState::Committed);
        make("tx-failed", TakeoverState::RecoveryFailed);
        make("tx-restored", TakeoverState::Restored);
        make("tx-loaded", TakeoverState::Restored);
        let pending = TakeoverStore::create(home, &manifest_with_id("tx-pending")).unwrap();
        pending.intend(TakeoverAction::ArmRecovery).unwrap();
        drop(pending);
        // A helper that stopped before its first step made no effects.
        drop(TakeoverStore::create(home, &manifest_with_id("tx-unstarted")).unwrap());
        // An unreadable transaction is evidence too.
        drop(TakeoverStore::create(home, &manifest_with_id("tx-damaged")).unwrap());
        std::fs::write(
            TakeoverStore::path(home, "tx-damaged")
                .unwrap()
                .join(JOURNAL),
            b"{",
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        make("tx-newest", TakeoverState::Restored);
        let removed = prune(home, |tx| tx == "tx-loaded");
        assert_eq!(removed, 3);
        for (id, kept) in [
            ("tx-committed", false),
            ("tx-restored", false),
            ("tx-unstarted", false),
            ("tx-failed", true),
            ("tx-loaded", true),
            ("tx-pending", true),
            ("tx-damaged", true),
            ("tx-newest", true),
        ] {
            assert_eq!(
                TakeoverStore::path(home, id).unwrap().exists(),
                kept,
                "{id}"
            );
        }
        assert_eq!(status(home).latest.unwrap().transaction_id, "tx-newest");
        // Once its recovery job is retired, the older transaction goes too.
        assert_eq!(prune(home, |_| false), 1);
        assert_eq!(prune(home, |_| false), 0);
    }
    #[test]
    fn state_graph_rejects_illegal_edges() {
        assert!(allowed(
            TakeoverState::Prepared,
            TakeoverState::Stopping,
            false,
            false
        ));
        assert!(allowed(
            TakeoverState::Prepared,
            TakeoverState::Restored,
            true,
            false
        ));
        assert!(!allowed(
            TakeoverState::Prepared,
            TakeoverState::Restored,
            false,
            false
        ));
        assert!(allowed(
            TakeoverState::Stopping,
            TakeoverState::Switched,
            false,
            false
        ));
        assert!(allowed(
            TakeoverState::Switched,
            TakeoverState::Verifying,
            false,
            false
        ));
        assert!(allowed(
            TakeoverState::Verifying,
            TakeoverState::Committed,
            false,
            false
        ));
        for state in [
            TakeoverState::Stopping,
            TakeoverState::Switched,
            TakeoverState::Verifying,
        ] {
            assert!(allowed(state, TakeoverState::Restoring, false, false));
        }
        assert!(allowed(
            TakeoverState::Restoring,
            TakeoverState::Restored,
            false,
            false
        ));
        assert!(allowed(
            TakeoverState::Restoring,
            TakeoverState::RecoveryFailed,
            false,
            false
        ));
        for from in [
            TakeoverState::Committed,
            TakeoverState::Restored,
            TakeoverState::RecoveryFailed,
        ] {
            for to in [
                TakeoverState::Prepared,
                TakeoverState::Stopping,
                TakeoverState::Switched,
                TakeoverState::Verifying,
                TakeoverState::Committed,
                TakeoverState::Restoring,
                TakeoverState::Restored,
                TakeoverState::RecoveryFailed,
            ] {
                assert!(!allowed(from, to, false, false));
            }
        }
    }
}
