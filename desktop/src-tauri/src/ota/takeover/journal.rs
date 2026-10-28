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
    RetireRecovery,
    RestoreRegistration,
    LaunchOriginal,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverStep {
    pub action: TakeoverAction,
    pub intent_boot_id: String,
    #[serde(deserialize_with = "required_nullable")]
    pub completed: Option<AwakeStamp>,
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
    pub error: Option<String>,
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
fn allowed(from: TakeoverState, to: TakeoverState, no_effects: bool) -> bool {
    use TakeoverState::*;
    matches!(
        (from, to),
        (Prepared, Stopping)
            | (Stopping, Switched)
            | (Switched, Verifying)
            | (Verifying, Committed)
            | (Stopping | Switched | Verifying, Restoring)
            | (Restoring, Restored | RecoveryFailed)
    ) || (from == Prepared && ((to == Restored && no_effects) || (to == Restoring && !no_effects)))
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
                    && s.completed
                        .as_ref()
                        .is_none_or(|t| t.boot_id == s.intent_boot_id)
            }),
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
            j.steps.push(TakeoverStep {
                action,
                intent_boot_id: stamp.boot_id,
                completed: None,
            });
            Ok(())
        })
    }
    pub fn complete(&self, action: &TakeoverAction) -> Result<TakeoverJournal, OtaError> {
        let stamp = crate::ota::native::awake_now().map_err(|_| OtaError::Io)?;
        self.change(|j| {
            let step = j
                .steps
                .iter_mut()
                .rev()
                .find(|s| &s.action == action && s.completed.is_none())
                .ok_or(OtaError::Invalid)?;
            require(step.intent_boot_id == stamp.boot_id)?;
            step.completed = Some(stamp);
            Ok(())
        })
    }
    pub fn transition(&self, to: TakeoverState) -> Result<TakeoverJournal, OtaError> {
        self.change(|j| {
            require(allowed(j.state, to, j.steps.is_empty()))?;
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
            store.complete(&TakeoverAction::StopOriginal).err(),
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
            store.complete(&TakeoverAction::StopOriginal).unwrap().steps[0]
                .completed
                .is_some(),
            true
        );
        assert_eq!(
            store.complete(&TakeoverAction::StopOriginal).err(),
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
                .complete(&TakeoverAction::ArmRecovery)
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
    fn state_graph_rejects_illegal_edges() {
        assert!(allowed(
            TakeoverState::Prepared,
            TakeoverState::Stopping,
            false
        ));
        assert!(allowed(
            TakeoverState::Prepared,
            TakeoverState::Restored,
            true
        ));
        assert!(!allowed(
            TakeoverState::Prepared,
            TakeoverState::Restored,
            false
        ));
        assert!(allowed(
            TakeoverState::Stopping,
            TakeoverState::Switched,
            false
        ));
        assert!(allowed(
            TakeoverState::Switched,
            TakeoverState::Verifying,
            false
        ));
        assert!(allowed(
            TakeoverState::Verifying,
            TakeoverState::Committed,
            false
        ));
        for state in [
            TakeoverState::Stopping,
            TakeoverState::Switched,
            TakeoverState::Verifying,
        ] {
            assert!(allowed(state, TakeoverState::Restoring, false));
        }
        assert!(allowed(
            TakeoverState::Restoring,
            TakeoverState::Restored,
            false
        ));
        assert!(allowed(
            TakeoverState::Restoring,
            TakeoverState::RecoveryFailed,
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
                assert!(!allowed(from, to, false));
            }
        }
    }
}
