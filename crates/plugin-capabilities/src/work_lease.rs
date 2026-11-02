//! Shared desktop admission rows. SQLite's stable inode and transaction own the
//! lock, matching the TS coordinator; ambiguous detached work remains pending.
use crate::{BrokerError, native_command::denied};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};
pub struct WorkLease {
    home: PathBuf,
    id: String,
    owner: String,
}
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
fn mutate<T>(
    home: &Path,
    action: impl FnOnce(&mut Value) -> Result<T, BrokerError>,
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
        if p.exists() {
            private(&p, false)?;
        }
    }
    // SQLite NOFOLLOW also rejects symlinked ancestors such as macOS /var.
    // Resolve the already-checked private directory, retaining inode checks on
    // the logical state path before and after every transaction.
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
    let text: Option<String> = tx
        .query_row("SELECT state FROM admission WHERE id=1", [], |r| r.get(0))
        .optional()
        .map_err(|_| denied())?;
    let mut state = if let Some(text) = text {
        serde_json::from_str::<Value>(&text).map_err(|_| denied())?
    } else {
        json!({"schema":1,"reservation":null,"leases":[]})
    };
    if !valid_state(&state) {
        return Err(denied());
    }
    let result = action(&mut state)?;
    tx.execute("INSERT INTO admission(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state",[state.to_string()]).map_err(|_|denied())?;
    let current = private(&path, false)?;
    if current.dev() != pinned.dev() || current.ino() != pinned.ino() {
        return Err(denied());
    }
    tx.commit().map_err(|_| denied())?;
    Ok(result)
}
impl WorkLease {
    pub fn complete_remote(
        home: &Path,
        nonce: &str,
        alias: &str,
        remote: &str,
    ) -> Result<(), BrokerError> {
        mutate(home, |s| {
            let leases = s["leases"].as_array_mut().ok_or_else(denied)?;
            if leases.iter().any(|l| {
                l["id"] == nonce && (l["remote"]["host"] != alias || l["remote"]["dir"] != remote)
            }) {
                return Err(denied());
            }
            leases.retain(|l| l["id"] != nonce);
            Ok(())
        })
    }
    pub fn begin(home: &Path, id: &str, label: &str) -> Result<Self, BrokerError> {
        static OWNER: OnceLock<String> = OnceLock::new();
        let owner = OWNER
            .get_or_init(|| uuid::Uuid::new_v4().to_string())
            .clone();
        let lease = uuid::Uuid::new_v4().to_string();
        mutate(home, |s| {
            if !s["reservation"].is_null() {
                return Err(BrokerError::Effect(
                    "Desktop update maintenance is reserved".into(),
                ));
            }
            s["leases"].as_array_mut().ok_or_else(denied)?.push(json!({"id":lease,"blocker":{"kind":"session","id":id,"label":label},"owner":owner,"process":null,"state":"pending"}));
            Ok(())
        })?;
        Ok(Self {
            home: home.into(),
            id: lease,
            owner,
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn bind_orca(
        &self,
        dispatch: &str,
        terminal: Option<&str>,
        incarnation: Option<&str>,
    ) -> Result<(), BrokerError> {
        mutate(&self.home, |s| {
            let lease = s["leases"]
                .as_array_mut()
                .ok_or_else(denied)?
                .iter_mut()
                .find(|l| l["id"] == self.id && l["owner"] == self.owner)
                .ok_or_else(denied)?;
            lease["orca"] = json!({"dispatchId":dispatch,"terminal":terminal});
            if let Some(i) = incarnation {
                lease["orca"]["incarnationId"] = json!(i);
            }
            Ok(())
        })
    }
    pub fn attach_remote(&self, local: &str, alias: &str, remote: &str) -> Result<(), BrokerError> {
        mutate(&self.home, |s| {
            let lease = s["leases"]
                .as_array_mut()
                .ok_or_else(denied)?
                .iter_mut()
                .find(|l| l["id"] == self.id && l["owner"] == self.owner)
                .ok_or_else(denied)?;
            lease["runDir"] = json!(local);
            lease["remote"] = json!({"host":alias,"dir":remote});
            Ok(())
        })
    }
    pub fn finish(&self) -> Result<(), BrokerError> {
        mutate(&self.home, |s| {
            let leases = s["leases"].as_array_mut().ok_or_else(denied)?;
            if leases
                .iter()
                .any(|l| l["id"] == self.id && l["owner"] != self.owner)
            {
                return Err(denied());
            }
            leases.retain(|l| l["id"] != self.id);
            Ok(())
        })
    }
    pub fn finish_orca(&self, reply: &Value) -> Result<bool, BrokerError> {
        mutate(&self.home, |s| {
            let leases = s["leases"].as_array_mut().ok_or_else(denied)?;
            let Some(lease) = leases.iter().find(|l| l["id"] == self.id) else {
                return Ok(false);
            };
            let binding = &lease["orca"];
            let r = &reply["result"];
            let valid = binding.is_object()
                && reply["ok"] == true
                && r["dispatchId"] == binding["dispatchId"]
                && matches!(r["state"].as_str(), Some("stopped" | "released"))
                && r["processAction"] == "closed_agent_terminal"
                && r.get("close")
                    .is_none_or(|c| c["handle"] == binding["terminal"] && c["ptyKilled"] == true);
            if valid {
                leases.retain(|l| l["id"] != self.id);
            }
            Ok(valid)
        })
    }
}

fn valid_uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 36
            && [8, 13, 18, 23].iter().all(|i| s.as_bytes()[*i] == b'-')
            && uuid::Uuid::parse_str(s).is_ok()
            && (s == "00000000-0000-0000-0000-000000000000"
                || s.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff")
                || (matches!(s.as_bytes()[14], b'1'..=b'8')
                    && matches!(
                        s.as_bytes()[19].to_ascii_lowercase(),
                        b'8' | b'9' | b'a' | b'b'
                    )))
    })
}
fn nonempty(v: &Value) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty())
}
fn valid_state(s: &Value) -> bool {
    if s["schema"].as_f64() != Some(1.0)
        || s.get("reservation")
            .is_none_or(|r| !r.is_null() && !r.is_string())
    {
        return false;
    }
    s["leases"].as_array().is_some_and(|leases| {
        leases.iter().all(|l| {
            valid_uuid(&l["id"])
                && valid_uuid(&l["owner"])
                && matches!(
                    l["blocker"]["kind"].as_str(),
                    Some("task" | "session" | "launch" | "operation")
                )
                && nonempty(&l["blocker"]["id"])
                && l["blocker"]["label"].is_string()
                && matches!(l["state"].as_str(), Some("pending" | "active"))
                && l.get("process").is_some_and(|p| {
                    p.is_null()
                        || (p.is_object()
                            && crate::js_semantics::safe_u64(&p["pid"]).is_some_and(|n| n > 0)
                            && nonempty(&p["bootId"])
                            && nonempty(&p["birth"]))
                })
                && l.get("runDir").is_none_or(Value::is_string)
                && l.get("launched").is_none_or(Value::is_boolean)
                && l.get("remote")
                    .is_none_or(|r| r["host"].is_string() && r["dir"].is_string())
                && l.get("orca").is_none_or(|o| {
                    o["dispatchId"].is_string()
                        && o.get("terminal")
                            .is_some_and(|t| t.is_null() || t.is_string())
                        && o.get("incarnationId").is_none_or(Value::is_string)
                })
        })
    })
}
