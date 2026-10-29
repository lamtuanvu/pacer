//! Read-only view of this installation's native update journals, used only to pick
//! bundled shell copy while the service cannot serve the app.
//!
//! This module never writes, locks, renames or removes anything. It opens every path
//! component without following symlinks and accepts only private files and directories
//! owned by this user, the same checks the native update store applies. Any doubt about
//! a file returns `None`, so the caller keeps its existing page. A result selects copy
//! only. It is never authority for an update, recovery or service effect.
use pacer_desktop::ota::{
    adoption::{
        journal::{validate_manifest as validate_adoption, AdoptionJournal, AdoptionState},
        AdoptionManifest,
    },
    journal::{Journal, TransactionState},
    wire::{AdapterCommand, Installation, WireMessage},
    PreparedManifest,
};
use sha2::{Digest, Sha256};
use std::{
    ffi::CString,
    fs::{File, Metadata},
    io::Read,
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::MetadataExt},
    },
    path::{Component, Path, PathBuf},
    time::{Duration, SystemTime},
};

const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_INSTALLATIONS: usize = 64;
const MAX_TRANSACTIONS: usize = 256;
/// A restored journal explains a service outage only shortly after restoration.
/// An old rollback must not be blamed for an unrelated later outage.
pub const RESTORED_WINDOW: Duration = Duration::from_secs(15 * 60);

/// Identifies this desktop's installation in a manifest target.
pub struct ThisInstallation {
    pub home: PathBuf,
    pub app: PathBuf,
    pub port: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    InProgress,
    Committed,
    Restored,
    RecoveryFailed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Update,
    Adoption,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Latest {
    pub kind: Kind,
    pub outcome: Outcome,
    pub modified: SystemTime,
}

impl Latest {
    /// The shell copy this record supports. A restored adoption has no bundled page,
    /// so it keeps the existing one.
    pub fn copy(&self, now: SystemTime) -> Option<crate::logic::JournalCopy> {
        match (self.kind, self.outcome) {
            (_, Outcome::RecoveryFailed) => Some(crate::logic::JournalCopy::RecoveryFailed),
            (Kind::Update, Outcome::Restored) => now
                .duration_since(self.modified)
                .ok()
                .filter(|age| *age <= RESTORED_WINDOW)
                .map(|_| crate::logic::JournalCopy::Restored),
            _ => None,
        }
    }
}

/// Unreadable, foreign or inconsistent state. Callers fall back to their existing page.
#[derive(Debug)]
struct Uncertain;
type Checked<T> = Result<T, Uncertain>;

fn require(value: bool) -> Checked<()> {
    if value {
        Ok(())
    } else {
        Err(Uncertain)
    }
}
fn euid() -> u32 {
    unsafe { libc::geteuid() }
}
fn identifier(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn open_at(dir: &File, name: &str, flags: i32) -> std::io::Result<File> {
    let name = CString::new(name).map_err(|_| std::io::ErrorKind::InvalidInput)?;
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(unsafe { File::from_raw_fd(fd) })
    }
}
/// The entry's own type, without following a symlink.
fn entry_type(dir: &File, name: &str) -> Checked<libc::mode_t> {
    let name = CString::new(name).map_err(|_| Uncertain)?;
    let mut stat: libc::stat = unsafe { std::mem::zeroed() };
    let status = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut stat,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    require(status == 0)?;
    Ok(stat.st_mode & libc::S_IFMT)
}
fn metadata(file: &File) -> Checked<Metadata> {
    file.metadata().map_err(|_| Uncertain)
}
fn private_dir(dir: &File) -> Checked<()> {
    let meta = metadata(dir)?;
    require(meta.is_dir() && meta.uid() == euid() && meta.mode() & 0o7777 == 0o700)
}
fn same(a: &Metadata, b: &Metadata) -> Checked<()> {
    require(a.dev() == b.dev() && a.ino() == b.ino())
}
/// Walks from `/` without following any symlink, like the native store.
fn open_path(path: &Path) -> Checked<File> {
    require(path.is_absolute())?;
    let mut dir = File::open("/").map_err(|_| Uncertain)?;
    for component in path.components() {
        match component {
            Component::RootDir => {}
            Component::Normal(part) => {
                let part = std::str::from_utf8(part.as_bytes()).map_err(|_| Uncertain)?;
                dir = open_at(&dir, part, libc::O_DIRECTORY).map_err(|_| Uncertain)?;
            }
            _ => return Err(Uncertain),
        }
    }
    Ok(dir)
}
fn child_dir(dir: &File, name: &str) -> Checked<File> {
    let child = open_at(dir, name, libc::O_DIRECTORY).map_err(|_| Uncertain)?;
    private_dir(&child)?;
    Ok(child)
}

/// A private, single-link file of this user. `Ok(None)` only when it does not exist.
fn read_private(dir: &File, name: &str) -> Checked<Option<(Vec<u8>, SystemTime)>> {
    let file = match open_at(dir, name, 0) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(Uncertain),
    };
    let before = metadata(&file)?;
    require(
        before.is_file()
            && before.nlink() == 1
            && before.uid() == euid()
            && before.mode() & 0o7777 == 0o600
            && before.len() <= MAX_FILE_BYTES,
    )?;
    let mut bytes = Vec::new();
    (&file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Uncertain)?;
    let after = metadata(&file)?;
    same(&before, &after)?;
    require(
        bytes.len() as u64 == before.len()
            && after.len() == before.len()
            && after.mtime() == before.mtime()
            && after.mtime_nsec() == before.mtime_nsec()
            && after.ctime() == before.ctime()
            && after.ctime_nsec() == before.ctime_nsec(),
    )?;
    let modified = before.modified().map_err(|_| Uncertain)?;
    Ok(Some((bytes, modified)))
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

/// `$PACER_HOME/desktop-updates/native`, or `Ok(None)` when no update was ever prepared.
fn native_root(this: &ThisInstallation) -> Checked<Option<File>> {
    require(this.home.canonicalize().map_err(|_| Uncertain)? == this.home)?;
    let home = open_path(&this.home)?;
    let meta = metadata(&home)?;
    require(meta.is_dir() && meta.uid() == euid() && meta.mode() & 0o7022 == 0)?;
    let mut dir = home;
    for name in ["desktop-updates", "native"] {
        match open_at(&dir, name, libc::O_DIRECTORY) {
            Ok(child) => {
                private_dir(&child)?;
                dir = child;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(Uncertain),
        }
    }
    Ok(Some(dir))
}

fn matches_this(target: &Installation, this: &ThisInstallation) -> bool {
    Path::new(&target.app_path) == this.app
        && Path::new(&target.pacer_home) == this.home
        && target.port == this.port
        && target.owner_uid == u64::from(euid())
}

enum Manifest {
    Update(PreparedManifest),
    Adoption(AdoptionManifest),
}
struct Record {
    manifest: Manifest,
    outcome: Outcome,
    modified: SystemTime,
}

/// One transaction directory. `Ok(None)` when it is not a transaction (no manifest).
fn read_transaction(dir: &File, installation: &str, transaction: &str) -> Checked<Option<Record>> {
    let update = read_private(dir, "prepared.json")?;
    let adoption = read_private(dir, "adoption-prepared.json")?;
    match (update, adoption) {
        (None, None) => Ok(None),
        (Some((bytes, prepared)), None) => {
            let manifest: PreparedManifest =
                serde_json::from_slice(&bytes).map_err(|_| Uncertain)?;
            AdapterCommand::Install {
                binding: manifest.binding.clone(),
                target: manifest.target.clone(),
                candidate: manifest.candidate.clone(),
            }
            .validate()
            .map_err(|_| Uncertain)?;
            require(
                manifest.schema == 1
                    && manifest.target.id == installation
                    && manifest.binding.installation_id == installation
                    && manifest.transaction_id() == transaction,
            )?;
            let (outcome, modified) = match read_private(dir, "journal.json")? {
                // The manifest precedes the journal; until then the transaction is preparing.
                None => (Outcome::InProgress, prepared),
                Some((journal, modified)) => {
                    let journal: Journal =
                        serde_json::from_slice(&journal).map_err(|_| Uncertain)?;
                    journal
                        .validate(&manifest, &digest(&bytes))
                        .map_err(|_| Uncertain)?;
                    let outcome = match journal.state {
                        TransactionState::Committed => Outcome::Committed,
                        TransactionState::Restored => Outcome::Restored,
                        TransactionState::RecoveryFailed => Outcome::RecoveryFailed,
                        _ => Outcome::InProgress,
                    };
                    (outcome, modified)
                }
            };
            Ok(Some(Record {
                manifest: Manifest::Update(manifest),
                outcome,
                modified,
            }))
        }
        (None, Some((bytes, prepared))) => {
            let manifest: AdoptionManifest =
                serde_json::from_slice(&bytes).map_err(|_| Uncertain)?;
            validate_adoption(&manifest).map_err(|_| Uncertain)?;
            require(
                manifest.source.target.id == installation
                    && manifest.binding.installation_id == installation
                    && manifest.transaction_id() == transaction,
            )?;
            let (outcome, modified) = match read_private(dir, "adoption-journal.json")? {
                None => (Outcome::InProgress, prepared),
                Some((journal, modified)) => {
                    let journal: AdoptionJournal =
                        serde_json::from_slice(&journal).map_err(|_| Uncertain)?;
                    journal
                        .validate(&manifest, &digest(&bytes))
                        .map_err(|_| Uncertain)?;
                    let outcome = match journal.state {
                        AdoptionState::Committed => Outcome::Committed,
                        AdoptionState::Restored => Outcome::Restored,
                        AdoptionState::RecoveryFailed => Outcome::RecoveryFailed,
                        _ => Outcome::InProgress,
                    };
                    (outcome, modified)
                }
            };
            Ok(Some(Record {
                manifest: Manifest::Adoption(manifest),
                outcome,
                modified,
            }))
        }
        (Some(_), Some(_)) => Err(Uncertain),
    }
}

/// Lists subdirectory names. A symlink or an unexpected entry type makes the read uncertain;
/// regular files and names that cannot be transaction ids are not transactions.
fn subdirectories(dir: &File, path: &Path, limit: usize) -> Checked<Vec<String>> {
    same(&metadata(dir)?, &metadata(&open_path(path)?)?)?;
    let mut names = Vec::new();
    for entry in std::fs::read_dir(path).map_err(|_| Uncertain)? {
        let entry = entry.map_err(|_| Uncertain)?;
        let Ok(name) = entry.file_name().into_string() else {
            return Err(Uncertain);
        };
        if !identifier(&name) {
            continue;
        }
        match entry_type(dir, &name)? {
            libc::S_IFDIR => names.push(name),
            libc::S_IFREG => continue,
            _ => return Err(Uncertain),
        }
        require(names.len() <= limit)?;
    }
    names.sort();
    Ok(names)
}

fn records(this: &ThisInstallation) -> Checked<Vec<Record>> {
    let Some(native) = native_root(this)? else {
        return Ok(Vec::new());
    };
    let native_path = this.home.join("desktop-updates/native");
    let mut found = Vec::new();
    for installation in subdirectories(&native, &native_path, MAX_INSTALLATIONS)? {
        let installation_dir = child_dir(&native, &installation)?;
        let installation_path = native_path.join(&installation);
        for transaction in subdirectories(&installation_dir, &installation_path, MAX_TRANSACTIONS)?
        {
            let dir = child_dir(&installation_dir, &transaction)?;
            if let Some(record) = read_transaction(&dir, &installation, &transaction)? {
                let target = match &record.manifest {
                    Manifest::Update(manifest) => &manifest.target,
                    Manifest::Adoption(manifest) => &manifest.source.target,
                };
                // A valid transaction of another installation is not about this desktop.
                if matches_this(target, this) {
                    found.push(record);
                }
            }
        }
    }
    Ok(found)
}

/// The most recently written update or adoption transaction for this installation.
/// `None` when there is none, when two records tie, or when anything is uncertain.
pub fn latest(this: &ThisInstallation) -> Option<Latest> {
    let records = records(this).ok()?;
    let newest = records.iter().map(|record| record.modified).max()?;
    let mut newest = records.iter().filter(|record| record.modified == newest);
    let record = newest.next()?;
    if newest.next().is_some() {
        return None;
    }
    Some(Latest {
        kind: match record.manifest {
            Manifest::Update(_) => Kind::Update,
            Manifest::Adoption(_) => Kind::Adoption,
        },
        outcome: record.outcome,
        modified: record.modified,
    })
}

/// Whether the helper launched this desktop to restore the previous version: the ticket's
/// transaction belongs to this installation, is restoring or restored, and this desktop
/// is its old release rather than the candidate.
pub fn restoration_launch(
    this: &ThisInstallation,
    installation: &str,
    transaction: &str,
    desktop_version: &str,
) -> bool {
    let check = || -> Checked<bool> {
        require(identifier(installation) && identifier(transaction))?;
        let native = native_root(this)?.ok_or(Uncertain)?;
        let dir = child_dir(&child_dir(&native, installation)?, transaction)?;
        let record = read_transaction(&dir, installation, transaction)?.ok_or(Uncertain)?;
        let Manifest::Update(manifest) = &record.manifest else {
            return Ok(false);
        };
        Ok(matches_this(&manifest.target, this)
            && matches!(record.outcome, Outcome::InProgress | Outcome::Restored)
            && restoring_state(&dir, &manifest)?
            && desktop_version == manifest.target.version
            && desktop_version != manifest.candidate.version)
    };
    check().unwrap_or(false)
}

fn restoring_state(dir: &File, manifest: &PreparedManifest) -> Checked<bool> {
    let (bytes, _) = read_private(dir, "journal.json")?.ok_or(Uncertain)?;
    let journal: Journal = serde_json::from_slice(&bytes).map_err(|_| Uncertain)?;
    let prepared = read_private(dir, "prepared.json")?.ok_or(Uncertain)?.0;
    journal
        .validate(manifest, &digest(&prepared))
        .map_err(|_| Uncertain)?;
    Ok(matches!(
        journal.state,
        TransactionState::Restoring | TransactionState::Restored
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn takeover_manifest_is_not_update_or_adoption() {
        let bytes = include_bytes!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../test/fixtures/desktop-update/takeover-manifest.json"));
        assert!(serde_json::from_slice::<PreparedManifest>(bytes).is_err());
        assert!(serde_json::from_slice::<AdoptionManifest>(bytes).is_err());
        let fixture = fixture();
        let path = private_dirs(&fixture, "inst", "fixture-tx");
        write(&path.join("adoption-prepared.json"), bytes);
        let dir = open_path(&path).unwrap();
        assert!(read_transaction(&dir, "inst", "fixture-tx").is_err());
    }
    use pacer_desktop::ota::{
        journal::OriginalBundleProof,
        wire::{AuthorizationKind, InstallAuthorization},
        AwakeStamp,
    };
    use serde_json::{json, Value};
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        this: ThisInstallation,
    }
    fn mode(path: &Path, mode: u32) {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    fn fixture() -> Fixture {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let home = root.join("home");
        std::fs::create_dir(&home).unwrap();
        mode(&home, 0o700);
        let this = ThisInstallation {
            home,
            app: root.join("pacer.app"),
            port: 7433,
        };
        Fixture {
            _temp: temp,
            root,
            this,
        }
    }
    fn private_dirs(fixture: &Fixture, installation: &str, transaction: &str) -> PathBuf {
        let mut path = fixture.this.home.clone();
        for part in ["desktop-updates", "native", installation, transaction] {
            path = path.join(part);
            if !path.exists() {
                std::fs::create_dir(&path).unwrap();
                mode(&path, 0o700);
            }
        }
        path
    }
    fn write(path: &Path, bytes: &[u8]) {
        std::fs::write(path, bytes).unwrap();
        mode(path, 0o600);
    }
    fn fixture_json() -> Value {
        serde_json::from_str(include_str!(
            "../../../test/fixtures/desktop-update/journal.json"
        ))
        .unwrap()
    }
    /// A valid update transaction for `fixture`'s installation in `state`.
    fn update(
        fixture: &Fixture,
        installation: &str,
        transaction: &str,
        state: TransactionState,
    ) -> PathBuf {
        let mut value = fixture_json();
        let prepared = &mut value["prepared"];
        prepared["binding"]["installationId"] = json!(installation);
        prepared["binding"]["transactionId"] = json!(transaction);
        prepared["target"]["id"] = json!(installation);
        prepared["target"]["appPath"] = json!(fixture.this.app.to_str().unwrap());
        prepared["target"]["pacerHome"] = json!(fixture.this.home.to_str().unwrap());
        prepared["target"]["port"] = json!(fixture.this.port);
        prepared["target"]["ownerUid"] = json!(euid());
        prepared["oldServiceExecutable"] = json!(format!(
            "{}/Contents/Resources/pacer",
            fixture.this.app.display()
        ));
        let manifest: PreparedManifest = serde_json::from_value(prepared.clone()).unwrap();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let mut journal: Journal = serde_json::from_value(value["journal"].clone()).unwrap();
        journal.manifest_sha256 = digest(&bytes);
        journal.state = state;
        if matches!(
            state,
            TransactionState::Installing | TransactionState::Restoring
        ) {
            journal.authorization = Some(InstallAuthorization {
                binding: manifest.binding.clone(),
                kind: AuthorizationKind::AuthorizeInstall,
                reservation_id: transaction.into(),
                journal_sha256: digest(&bytes),
            });
        }
        if state == TransactionState::Restored {
            journal.unchanged_original = Some(OriginalBundleProof {
                sha256: manifest.old_bundle_backup.sha256.clone(),
                observed_at: AwakeStamp {
                    boot_id: "boot-one".into(),
                    millis: 10,
                },
            });
        }
        journal.validate(&manifest, &digest(&bytes)).unwrap();
        let dir = private_dirs(fixture, installation, transaction);
        write(&dir.join("prepared.json"), &bytes);
        write(
            &dir.join("journal.json"),
            &serde_json::to_vec(&journal).unwrap(),
        );
        dir
    }
    fn touch(path: &Path, seconds_ago: u64) {
        let file = File::options().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(seconds_ago))
            .unwrap();
    }
    fn latest_outcome(fixture: &Fixture) -> Option<Outcome> {
        latest(&fixture.this).map(|latest| latest.outcome)
    }

    #[test]
    fn missing_update_state_selects_nothing() {
        let fixture = fixture();
        assert_eq!(latest(&fixture.this), None);
        private_dirs(&fixture, "inst", "downloads");
        assert_eq!(latest(&fixture.this), None);
    }

    #[test]
    fn newest_terminal_transaction_selects_the_copy() {
        let fixture = fixture();
        let failed = update(&fixture, "inst", "tx-1", TransactionState::RecoveryFailed);
        touch(&failed.join("journal.json"), 60);
        let found = latest(&fixture.this).unwrap();
        assert_eq!(found.outcome, Outcome::RecoveryFailed);
        assert_eq!(
            found.copy(SystemTime::now()),
            Some(crate::logic::JournalCopy::RecoveryFailed)
        );
        // A newer restored transaction replaces it, but only while the restoration is recent.
        let restored = update(&fixture, "inst", "tx-2", TransactionState::Restored);
        touch(&restored.join("journal.json"), 30);
        let found = latest(&fixture.this).unwrap();
        assert_eq!(found.outcome, Outcome::Restored);
        assert_eq!(
            found.copy(SystemTime::now()),
            Some(crate::logic::JournalCopy::Restored)
        );
        assert_eq!(
            found.copy(SystemTime::now() + RESTORED_WINDOW + Duration::from_secs(60)),
            None
        );
        // A newer transaction still in progress means no terminal copy applies.
        let preparing = private_dirs(&fixture, "inst", "tx-3");
        std::fs::copy(
            failed.join("prepared.json"),
            preparing.join("prepared.json"),
        )
        .unwrap();
        assert_eq!(
            latest(&fixture.this),
            None,
            "mismatched manifest is uncertain"
        );
        std::fs::remove_file(preparing.join("prepared.json")).unwrap();
        update(&fixture, "inst", "tx-3", TransactionState::Installing);
        assert_eq!(latest_outcome(&fixture), Some(Outcome::InProgress));
        assert_eq!(latest(&fixture.this).unwrap().copy(SystemTime::now()), None);
    }

    #[test]
    fn other_installations_are_ignored_and_ties_are_uncertain() {
        let fixture = fixture();
        let other = Fixture {
            _temp: tempfile::tempdir().unwrap(),
            root: fixture.root.clone(),
            this: ThisInstallation {
                home: fixture.this.home.clone(),
                app: fixture.root.join("Other.app"),
                port: fixture.this.port,
            },
        };
        let mine = update(&fixture, "inst", "tx-1", TransactionState::Restored);
        let theirs = update(&other, "other", "tx-9", TransactionState::RecoveryFailed);
        touch(&mine.join("journal.json"), 120);
        touch(&theirs.join("journal.json"), 1);
        assert_eq!(latest_outcome(&fixture), Some(Outcome::Restored));
        assert_eq!(latest_outcome(&other), Some(Outcome::RecoveryFailed));
        let second = update(&fixture, "inst", "tx-2", TransactionState::RecoveryFailed);
        let when = std::fs::metadata(mine.join("journal.json"))
            .unwrap()
            .modified()
            .unwrap();
        File::options()
            .write(true)
            .open(second.join("journal.json"))
            .unwrap()
            .set_modified(when)
            .unwrap();
        assert_eq!(latest(&fixture.this), None);
    }

    #[test]
    fn unsafe_or_invalid_files_fail_closed_without_changing_them() {
        let cases: [(&str, fn(&Path)); 7] = [
            ("group-readable journal", |dir| {
                mode(&dir.join("journal.json"), 0o640)
            }),
            ("non-private transaction directory", |dir| mode(dir, 0o755)),
            ("hard-linked journal", |dir| {
                std::fs::hard_link(dir.join("journal.json"), dir.join("copy")).unwrap()
            }),
            ("symlinked journal", |dir| {
                std::fs::rename(dir.join("journal.json"), dir.join("real")).unwrap();
                symlink(dir.join("real"), dir.join("journal.json")).unwrap();
            }),
            ("malformed journal", |dir| {
                write(&dir.join("journal.json"), b"{")
            }),
            ("journal for another manifest", |dir| {
                let mut journal: Value =
                    serde_json::from_slice(&std::fs::read(dir.join("journal.json")).unwrap())
                        .unwrap();
                journal["manifestSha256"] = json!("0".repeat(64));
                write(
                    &dir.join("journal.json"),
                    &serde_json::to_vec(&journal).unwrap(),
                );
            }),
            ("both manifest kinds", |dir| {
                std::fs::copy(
                    dir.join("prepared.json"),
                    dir.join("adoption-prepared.json"),
                )
                .unwrap();
                mode(&dir.join("adoption-prepared.json"), 0o600);
            }),
        ];
        for (name, damage) in cases {
            let fixture = fixture();
            let dir = update(&fixture, "inst", "tx-1", TransactionState::RecoveryFailed);
            assert_eq!(
                latest_outcome(&fixture),
                Some(Outcome::RecoveryFailed),
                "{name}"
            );
            damage(&dir);
            let before: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(latest(&fixture.this), None, "{name}");
            let after: Vec<_> = std::fs::read_dir(&dir)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            assert_eq!(before, after, "{name}: the read created or removed files");
            assert!(
                !dir.join(".lock").exists(),
                "{name}: the read created a lock"
            );
        }
    }

    #[test]
    fn symlinked_state_directories_fail_closed() {
        let fixture = fixture();
        let dir = update(&fixture, "inst", "tx-1", TransactionState::RecoveryFailed);
        let moved = fixture.root.join("moved");
        std::fs::rename(&dir, &moved).unwrap();
        symlink(&moved, &dir).unwrap();
        assert_eq!(latest(&fixture.this), None);

        let fixture = self::fixture();
        update(&fixture, "inst", "tx-1", TransactionState::RecoveryFailed);
        let updates = fixture.this.home.join("desktop-updates");
        let moved = fixture.root.join("updates");
        std::fs::rename(&updates, &moved).unwrap();
        symlink(&moved, &updates).unwrap();
        assert_eq!(latest(&fixture.this), None);
    }

    /// A valid adoption transaction for `fixture`'s installation in `state`.
    fn adoption(fixture: &Fixture, transaction: &str, state: AdoptionState) -> PathBuf {
        use pacer_desktop::ota::{
            adoption::journal::UnchangedRegistration,
            control::{AdoptionRequestReceipt, AdoptionSource},
            wire::Ownership,
            AssetIdentity,
        };
        let mut value = fixture_json();
        value["prepared"]["binding"]["installationId"] = json!("inst");
        value["prepared"]["binding"]["transactionId"] = json!(transaction);
        let old: PreparedManifest = serde_json::from_value(value["prepared"].clone()).unwrap();
        let mut target = old.target.clone();
        target.id = "inst".into();
        target.app_path = fixture.this.app.to_str().unwrap().into();
        target.pacer_home = fixture.this.home.to_str().unwrap().into();
        target.port = fixture.this.port;
        target.owner_uid = euid().into();
        target.ownership = Ownership::Attached;
        let mut recovery_job = old.recovery_job.clone();
        recovery_job.helper.relative_path = "pacer-update-helper".into();
        let manifest = AdoptionManifest {
            schema: 1,
            transaction_kind: "adoption".into(),
            binding: old.binding.clone(),
            source: AdoptionSource {
                new_service_executable: format!("{}/Contents/Resources/pacer", target.app_path),
                target,
                native_session_id: old.native_session_id.clone(),
                desktop_client_id: "desktop-client".into(),
                boot_id: old.requester_boot_id.clone(),
                desktop: old.old_desktop.clone(),
                service: old.old_service.clone(),
                service_version: old.old_service_version.clone(),
                old_service_executable: "/opt/pacer/bin/pacer".into(),
            },
            request: AdoptionRequestReceipt {
                request_id: "adopt-request".into(),
                fingerprint: "e".repeat(64),
            },
            expected_new_installation_id: "f".repeat(64),
            managed_launch_id: "a".repeat(64),
            original_launch_id: "b".repeat(64),
            old_registration: AssetIdentity {
                relative_path: "old-registration.plist".into(),
                sha256: "c".repeat(64),
            },
            new_registration: AssetIdentity {
                relative_path: "new-registration.plist".into(),
                sha256: "d".repeat(64),
            },
            recovery_job,
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        let journal = AdoptionJournal {
            schema: 1,
            transaction_kind: "adoption".into(),
            revision: 0,
            manifest_sha256: digest(&bytes),
            state,
            authorization: None,
            steps: vec![],
            verification_started: None,
            restoration_started: None,
            restoration_history: vec![],
            recovery_reconnects: vec![],
            verification_proof: None,
            restoration_proof: None,
            unchanged_registration: (state == AdoptionState::Restored).then(|| {
                UnchangedRegistration {
                    sha256: manifest.old_registration.sha256.clone(),
                    observed_at: AwakeStamp {
                        boot_id: "boot-one".into(),
                        millis: 10,
                    },
                }
            }),
            error: None,
            restoration_cause: None,
        };
        journal.validate(&manifest, &digest(&bytes)).unwrap();
        let dir = private_dirs(fixture, "inst", transaction);
        write(&dir.join("adoption-prepared.json"), &bytes);
        write(
            &dir.join("adoption-journal.json"),
            &serde_json::to_vec(&journal).unwrap(),
        );
        dir
    }

    #[test]
    fn adoption_journals_follow_the_same_rule() {
        let fixture = fixture();
        let failed = adoption(&fixture, "tx-1", AdoptionState::RecoveryFailed);
        let found = latest(&fixture.this).unwrap();
        assert_eq!(
            (found.kind, found.outcome),
            (Kind::Adoption, Outcome::RecoveryFailed)
        );
        assert_eq!(
            found.copy(SystemTime::now()),
            Some(crate::logic::JournalCopy::RecoveryFailed)
        );
        // The bundled restored page describes an update, so a restored adoption keeps the default.
        touch(&failed.join("adoption-journal.json"), 60);
        adoption(&fixture, "tx-2", AdoptionState::Restored);
        let found = latest(&fixture.this).unwrap();
        assert_eq!(found.outcome, Outcome::Restored);
        assert_eq!(found.copy(SystemTime::now()), None);
        // Unsafe adoption files fail closed too.
        mode(&failed.join("adoption-journal.json"), 0o644);
        assert_eq!(latest(&fixture.this), None);
        let invalid = self::fixture();
        let dir = private_dirs(&invalid, "inst", "tx-1");
        write(&dir.join("adoption-prepared.json"), b"{\"schema\":1}");
        assert_eq!(latest(&invalid.this), None, "invalid adoption manifest");
    }

    #[test]
    fn restoration_launch_needs_the_old_release_of_a_restoring_transaction() {
        let fixture = fixture();
        update(&fixture, "inst", "tx-1", TransactionState::Restoring);
        // The fixture's old release is 1.0.0; the candidate is 1.1.0.
        assert!(restoration_launch(&fixture.this, "inst", "tx-1", "1.0.0"));
        assert!(!restoration_launch(&fixture.this, "inst", "tx-1", "1.1.0"));
        assert!(!restoration_launch(&fixture.this, "inst", "tx-2", "1.0.0"));
        assert!(!restoration_launch(
            &fixture.this,
            "../inst",
            "tx-1",
            "1.0.0"
        ));
        let installing = self::fixture();
        update(&installing, "inst", "tx-1", TransactionState::Installing);
        assert!(!restoration_launch(
            &installing.this,
            "inst",
            "tx-1",
            "1.0.0"
        ));
        let other = ThisInstallation {
            home: fixture.this.home.clone(),
            app: fixture.root.join("Other.app"),
            port: fixture.this.port,
        };
        assert!(!restoration_launch(&other, "inst", "tx-1", "1.0.0"));
    }
}
