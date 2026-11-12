//! How a stdio connection finds and uses the home's live plugin owner (ADR 0027).
//!
//! Only serve binds `run/host.sock`, so a live socket there is the home's owner
//! lease. A stdio connection probes it once, before its Core child starts:
//! [`HomeOwner::Live`] means the connection attaches (its Core dials that socket
//! and the door owns no children); anything else means the connection owns its
//! children on its own connection socket ([`crate::ReverseBridge::bind_connection`]).
//! An attached door only stops lanes
//! on the owner, through the one-frame `_host.plugin.stop` primitive.

use crate::bridge_listener::{BRIDGE_MAX_LINE_BYTES, current_uid, peer_uid};
use crate::host_bridge::{HOST_SOCKET_NAME, METHOD_PLUGIN_STOP};
use serde_json::{Value, json};
use std::{
    fs, io,
    os::unix::{
        fs::{FileTypeExt, MetadataExt},
        net::UnixStream as StdUnixStream,
    },
    path::{Path, PathBuf},
    time::Duration,
};
use thiserror::Error;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

/// Covers the owner's two-second terminate grace with room for a busy lane.
const STOP_DEADLINE: Duration = Duration::from_secs(10);

/// What a stdio connection found at `$PACER_HOME/run/host.sock`.
#[derive(Debug, PartialEq, Eq)]
pub enum HomeOwner {
    /// A same-uid owner accepted the probe: attach to it.
    Live(PathBuf),
    /// No socket, or a stale one nobody answers.
    Absent,
    /// Something this user must not trust is there; never attach to it.
    Untrusted(&'static str),
}

/// The uid a probe requires of each layer it checks. In production all three
/// are the current user; tests vary one at a time to prove each check.
#[derive(Clone, Copy, Debug)]
pub struct OwnerTrust {
    /// Owner of the `run/` directory.
    pub run_dir: u32,
    /// Owner of the `host.sock` file.
    pub socket: u32,
    /// Peer credentials of the process accepting the connection.
    pub peer: u32,
}

impl OwnerTrust {
    pub fn user(uid: u32) -> Self {
        Self {
            run_dir: uid,
            socket: uid,
            peer: uid,
        }
    }
}

/// Probe `run/host.sock` as the current user.
pub fn probe_home_owner(pacer_home: &Path) -> HomeOwner {
    probe_home_owner_as(pacer_home, OwnerTrust::user(current_uid()))
}

/// Probe `run/host.sock`, trusting only the given uids for the directory, the
/// socket file and the peer that accepts the connection.
pub fn probe_home_owner_as(pacer_home: &Path, trust: OwnerTrust) -> HomeOwner {
    let run = pacer_home.join("run");
    let meta = match fs::symlink_metadata(&run) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return HomeOwner::Absent,
        Err(_) => return HomeOwner::Untrusted("run directory is unreadable"),
        Ok(meta) => meta,
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return HomeOwner::Untrusted("run is not a real directory");
    }
    if meta.uid() != trust.run_dir || meta.mode() & 0o077 != 0 {
        return HomeOwner::Untrusted("run directory is not private to this user");
    }
    let socket = run.join(HOST_SOCKET_NAME);
    let meta = match fs::symlink_metadata(&socket) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return HomeOwner::Absent,
        Err(_) => return HomeOwner::Untrusted("host.sock is unreadable"),
        Ok(meta) => meta,
    };
    if !meta.file_type().is_socket() {
        return HomeOwner::Untrusted("host.sock is not a socket");
    }
    if meta.uid() != trust.socket {
        return HomeOwner::Untrusted("host.sock belongs to another user");
    }
    let Ok(stream) = StdUnixStream::connect(&socket) else {
        return HomeOwner::Absent;
    };
    match peer_uid(&stream) {
        Ok(peer) if peer == trust.peer => HomeOwner::Live(socket),
        _ => HomeOwner::Untrusted("host.sock is served by another user"),
    }
}

/// Result of asking the attached owner to stop one plugin lane.
#[derive(Debug, PartialEq, Eq)]
pub enum StopOutcome {
    Stopped,
    NotRunning,
    /// Nothing answers on the socket any more. A dead owner supervises no child.
    OwnerGone,
}

#[derive(Debug, Error)]
pub enum AttachError {
    #[error("plugin process owner is served by another user")]
    Untrusted,
    #[error("plugin process owner timed out")]
    Timeout,
    #[error("plugin process owner sent a malformed reply")]
    Malformed,
    #[error("{0}")]
    Refused(String),
}

/// Ask the owner at `socket` to terminate `id`'s lane through `_host.plugin.stop`.
///
/// The peer uid is checked on every dial: the socket path may have been
/// replaced since the connection probed it.
pub async fn stop_on_owner(socket: &Path, id: &str) -> Result<StopOutcome, AttachError> {
    stop_on_owner_as(socket, id, current_uid()).await
}

/// [`stop_on_owner`], trusting only a peer running as `uid`.
pub async fn stop_on_owner_as(
    socket: &Path,
    id: &str,
    uid: u32,
) -> Result<StopOutcome, AttachError> {
    let Ok(stream) = UnixStream::connect(socket).await else {
        return Ok(StopOutcome::OwnerGone);
    };
    if peer_uid(&stream).ok() != Some(uid) {
        return Err(AttachError::Untrusted);
    }
    let exchange = async {
        let mut stream = BufReader::new(stream);
        let frame =
            json!({"jsonrpc":"2.0", "id":1, "method":METHOD_PLUGIN_STOP, "params":{"id":id}});
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| AttachError::Malformed)?;
        bytes.push(b'\n');
        if stream.get_mut().write_all(&bytes).await.is_err() {
            return Ok(StopOutcome::OwnerGone);
        }
        let mut line = Vec::new();
        let limit = u64::try_from(BRIDGE_MAX_LINE_BYTES).unwrap_or(u64::MAX);
        match (&mut stream).take(limit).read_until(b'\n', &mut line).await {
            Ok(0) | Err(_) => return Ok(StopOutcome::OwnerGone),
            Ok(_) => {}
        }
        let reply = serde_json::from_slice::<Value>(&line).map_err(|_| AttachError::Malformed)?;
        if let Some(error) = reply.get("error") {
            return Err(AttachError::Refused(
                error["message"]
                    .as_str()
                    .unwrap_or("plugin process owner refused stop")
                    .to_owned(),
            ));
        }
        match reply["result"]["stopped"].as_bool() {
            Some(true) => Ok(StopOutcome::Stopped),
            Some(false) => Ok(StopOutcome::NotRunning),
            None => Err(AttachError::Malformed),
        }
    };
    tokio::time::timeout(STOP_DEADLINE, exchange)
        .await
        .map_err(|_| AttachError::Timeout)?
}
