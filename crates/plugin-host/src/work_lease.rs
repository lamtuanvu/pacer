//! Shared desktop-update admission rows (mirror of `src/update/desktop/admission.ts`).
//! SQLite's stable inode and transaction own the lock, matching the TS
//! coordinator; ambiguous detached work remains pending. This shadows the TS
//! `begin*WorkSync` family until the P4d cutover, so TypeScript remains the
//! executor owner for now.
mod state;
use crate::BrokerError;
use rusqlite::{Connection, OptionalExtension, types::ValueRef};
use serde_json::Value;
use state::{AdmissionState, Lease, Orca, Remote, Units, same};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

/// Blocker kind matching the TS admission schema exactly
/// (`BlockerKind` in `src/update/desktop/types.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlockerKind {
    Task,
    Session,
    Launch,
    Operation,
}

impl BlockerKind {
    /// The exact lowercase string used by the TS `blockerSchema` enum.
    pub fn as_str(self) -> &'static str {
        match self {
            BlockerKind::Task => "task",
            BlockerKind::Session => "session",
            BlockerKind::Launch => "launch",
            BlockerKind::Operation => "operation",
        }
    }
}

/// Blocker input matching the TS `blockerSchema` shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Blocker {
    pub kind: BlockerKind,
    pub id: String,
    pub label: String,
}

fn denied() -> BrokerError {
    BrokerError::Invalid("desktop work lease")
}

/// Validates a file (or directory when `directory`) is private to the current
/// user: mode has no group/other bits and the owner is us, and it is the real
/// object (a symlink is rejected via `symlink_metadata` rather than followed).
fn private(path: &Path, directory: bool) -> Result<fs::Metadata, BrokerError> {
    let m = fs::symlink_metadata(path).map_err(|_| denied())?;
    if (if directory { !m.is_dir() } else { !m.is_file() })
        || m.mode() & 0o077 != 0
        || m.uid() != nix::unistd::Uid::current().as_raw()
    {
        return Err(denied());
    }
    Ok(m)
}

/// Runs a mutation inside the desktop `admission.sqlite` transaction, with the
/// same file-permission, inode and sidecar checks as the TS coordinator.
fn mutate<T>(
    home: &Path,
    action: impl FnOnce(&mut AdmissionState) -> Result<T, BrokerError>,
) -> Result<T, BrokerError> {
    let dir = home.join("desktop-updates");
    match fs::DirBuilder::new().mode(0o700).create(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(denied()),
    }
    private(&dir, true)?;
    let path = dir.join("admission.sqlite");
    match OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
    {
        Ok(file) => {
            file.sync_all().map_err(|_| denied())?;
            fs::File::open(&dir)
                .and_then(|f| f.sync_all())
                .map_err(|_| denied())?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(denied()),
    }
    let pinned = private(&path, false)?;
    for suffix in ["-journal", "-wal", "-shm"] {
        let p = PathBuf::from(format!("{}{suffix}", path.display()));
        match fs::symlink_metadata(&p) {
            Ok(_) => {
                private(&p, false)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(denied()),
        }
    }
    // Resolve the already-checked private directory, retaining inode checks on
    // the logical state path around the transaction. SQLite NOFOLLOW also
    // rejects symlinked ancestors such as macOS /var.
    let database_path = fs::canonicalize(&dir)
        .map_err(|_| denied())?
        .join("admission.sqlite");
    let mut db = Connection::open_with_flags(
        &database_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .map_err(|_| denied())?;
    db.busy_timeout(Duration::from_secs(5))
        .map_err(|_| denied())?;
    db.pragma_update(None, "synchronous", "FULL")
        .map_err(|_| denied())?;
    let current = private(&path, false)?;
    if current.dev() != pinned.dev() || current.ino() != pinned.ino() {
        return Err(denied());
    }
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|_| denied())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)").map_err(|_|denied())?;
    // Row bytes are decoded like Bun (maximal-subpart U+FFFD for invalid
    // UTF-8); non-TEXT rows reject like TS (plan §3.2). The row classification
    // and text are owned here so no `ValueRef` borrow escapes the closure.
    let value: Option<Option<String>> = tx
        .query_row("SELECT state FROM admission WHERE id=1", [], |r| {
            match r.get_ref(0)? {
                ValueRef::Text(bytes) => Ok(Some(String::from_utf8_lossy(bytes).into_owned())),
                ValueRef::Blob(_) | ValueRef::Null | ValueRef::Integer(_) | ValueRef::Real(_) => {
                    Ok(None)
                }
            }
        })
        .optional()
        .map_err(|_| denied())?;
    let mut state = match value {
        Some(Some(text)) => AdmissionState::decode(&text).ok_or_else(denied)?,
        Some(None) => return Err(denied()),
        None => AdmissionState::empty(),
    };
    let result = action(&mut state)?;
    let rendered = state.render().map_err(|_| denied())?;
    tx.execute(
        "INSERT INTO admission(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",
        [rendered],
    )
    .map_err(|_| denied())?;
    let current = private(&path, false)?;
    if current.dev() != pinned.dev() || current.ino() != pinned.ino() {
        return Err(denied());
    }
    tx.commit().map_err(|_| denied())?;
    Ok(result)
}

impl Blocker {
    fn into_units(self) -> (super::BlockerKind, Units, Units) {
        (
            self.kind,
            self.id.encode_utf16().collect(),
            self.label.encode_utf16().collect(),
        )
    }
}

/// Begins a new desktop work lease with an explicit blocker. This is the core
/// admission entry point; `begin` delegates here with `BlockerKind::Session`.
pub fn begin_blocker(home: &Path, blocker: Blocker) -> Result<WorkLease, BrokerError> {
    if blocker.id.is_empty() {
        return Err(BrokerError::Invalid("desktop work blocker"));
    }
    static OWNER: OnceLock<String> = OnceLock::new();
    let owner = OWNER
        .get_or_init(|| uuid::Uuid::new_v4().to_string())
        .clone();
    let lease = uuid::Uuid::new_v4().to_string();
    mutate(home, |s| {
        if s.reservation.is_some() {
            return Err(BrokerError::Effect(
                "Desktop update maintenance is reserved".into(),
            ));
        }
        let (kind, id, label) = blocker.clone().into_units();
        s.leases.push(Lease {
            id: lease.clone(),
            blocker: state::Blocker { kind, id, label },
            owner: owner.clone(),
            process: None,
            state: state::Phase::Pending,
            run_dir: None,
            remote: None,
            launched: None,
            orca: None,
            appended: Vec::new(),
        });
        Ok(())
    })?;
    Ok(WorkLease {
        home: home.into(),
        id: lease,
        owner,
    })
}

/// A desktop work lease. TypeScript remains the executor owner; this type lets
/// the native shadow record the same pending/active state and release rules.
pub struct WorkLease {
    home: PathBuf,
    id: String,
    owner: String,
}

impl WorkLease {
    /// Begins a desktop work lease with a `session` blocker (the historical
    /// default). Use `begin_blocker` for the other kinds.
    pub fn begin(home: &Path, id: &str, label: &str) -> Result<Self, BrokerError> {
        begin_blocker(
            home,
            Blocker {
                kind: BlockerKind::Session,
                id: id.into(),
                label: label.into(),
            },
        )
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn complete_remote(
        home: &Path,
        nonce: &str,
        alias: &str,
        remote: &str,
    ) -> Result<(), BrokerError> {
        mutate(home, |s| {
            let leases = &mut s.leases;
            if leases.iter().any(|l| {
                l.id == nonce
                    && l.remote
                        .as_ref()
                        .is_none_or(|r| !same(&r.host, alias) || !same(&r.dir, remote))
            }) {
                return Err(denied());
            }
            leases.retain(|l| l.id != nonce);
            Ok(())
        })
    }

    pub fn bind_orca(
        &self,
        dispatch: &str,
        terminal: Option<&str>,
        incarnation: Option<&str>,
    ) -> Result<(), BrokerError> {
        mutate(&self.home, |s| {
            let lease = s
                .leases
                .iter_mut()
                .find(|l| l.id == self.id && l.owner == self.owner)
                .ok_or_else(denied)?;
            lease.set_orca(Orca {
                dispatch_id: dispatch.encode_utf16().collect(),
                terminal: terminal.map(|t| t.encode_utf16().collect()),
                incarnation_id: incarnation.map(|i| i.encode_utf16().collect()),
            });
            Ok(())
        })
    }

    pub fn attach_remote(&self, local: &str, alias: &str, remote: &str) -> Result<(), BrokerError> {
        mutate(&self.home, |s| {
            let lease = s
                .leases
                .iter_mut()
                .find(|l| l.id == self.id && l.owner == self.owner)
                .ok_or_else(denied)?;
            lease.set_run_dir(local.encode_utf16().collect());
            lease.set_remote(Remote {
                host: alias.encode_utf16().collect(),
                dir: remote.encode_utf16().collect(),
            });
            Ok(())
        })
    }

    pub fn finish(&self) -> Result<(), BrokerError> {
        mutate(&self.home, |s| {
            let leases = &mut s.leases;
            if leases
                .iter()
                .any(|l| l.id == self.id && l.owner != self.owner)
            {
                return Err(denied());
            }
            leases.retain(|l| l.id != self.id);
            Ok(())
        })
    }

    pub fn finish_orca(&self, reply: &Value) -> Result<bool, BrokerError> {
        mutate(&self.home, |s| {
            let leases = &mut s.leases;
            let Some(position) = leases.iter().position(|l| l.id == self.id) else {
                return Ok(false);
            };
            let valid = leases[position].orca.as_ref().is_some_and(|orca| {
                let r = &reply["result"];
                reply["ok"] == true
                    && r["dispatchId"]
                        .as_str()
                        .is_some_and(|d| same(&orca.dispatch_id, d))
                    && matches!(r["state"].as_str(), Some("stopped" | "released"))
                    && r["processAction"] == "closed_agent_terminal"
                    && closure_proof(r.get("close"), orca.terminal.as_deref())
            });
            if valid {
                leases.retain(|l| l.id != self.id);
            }
            Ok(valid)
        })
    }
}

fn closure_proof(close: Option<&Value>, terminal: Option<&[u16]>) -> bool {
    let Some(close) = close else { return true };
    let falsy = match close {
        Value::Null => true,
        Value::Bool(value) => !value,
        Value::Number(value) => value.as_f64() == Some(0.0),
        Value::String(value) => value.is_empty(),
        Value::Array(_) | Value::Object(_) => false,
    };
    falsy
        || (close
            .get("handle")
            .is_some_and(|handle| match (handle, terminal) {
                (Value::Null, None) => true,
                (Value::String(h), Some(t)) => same(t, h),
                _ => false,
            })
            && close["ptyKilled"] == true)
}
