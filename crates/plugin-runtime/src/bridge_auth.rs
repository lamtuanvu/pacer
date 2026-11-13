//! Core's credential on the reverse bridge (#918, ADR 0027).
//!
//! Every owner start draws a fresh 32-byte key that only the owner and its
//! Cores hold. The owner hands it to its own Core child as
//! [`HOST_SOCKET_KEY_ENV`], which Core removes from its environment before it
//! starts anything. Serve also publishes it as `run/host.key` (0600, in the
//! 0700 run directory) for the stdio connections that attach to it; an owning
//! connection's key never touches disk.
//!
//! A connection proves the key before its first request with a mutual
//! HMAC-SHA256 challenge ([`accept`], [`authenticate`]): the caller sends a
//! nonce, the owner answers with its own nonce and a proof over both, and the
//! caller answers with its proof. The key itself never crosses the socket, and
//! a caller never answers a forwarded capability request from an owner that
//! did not prove the key first.

use crate::bridge_listener::BridgeError;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    fmt, fs,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::Path,
    time::{Duration, SystemTime},
};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

/// The Core child's copy of the credential. Core removes it at startup.
pub const HOST_SOCKET_KEY_ENV: &str = "PACER_HOST_SOCKET_KEY";
/// Serve's published credential beside `host.sock`, for attaching connections.
pub const HOST_KEY_NAME: &str = "host.key";
/// Private JSON-RPC method of the challenge and the caller's proof.
pub const METHOD_AUTH: &str = "_host.auth";

const OWNER_PROOF: &str = "pacer-host-owner/v1";
const CORE_PROOF: &str = "pacer-host-core/v1";
const KEY_BYTES: usize = 32;
const AUTH_LINE_BYTES: u64 = 4096;
/// How long an accepted connection may take to prove the key.
pub(crate) const AUTH_DEADLINE: Duration = Duration::from_secs(10);
const UNAUTHORIZED: i64 = -32001;

/// One owner start's credential. `Debug` never prints it.
#[derive(Clone, PartialEq, Eq)]
pub struct OwnerKey([u8; KEY_BYTES]);

impl fmt::Debug for OwnerKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("OwnerKey(..)")
    }
}

impl OwnerKey {
    pub fn generate() -> io::Result<Self> {
        let mut key = [0; KEY_BYTES];
        getrandom::fill(&mut key)
            .map_err(|_| io::Error::other("no randomness for the owner key"))?;
        Ok(Self(key))
    }

    /// The lowercase hex form Core receives and `run/host.key` holds.
    pub fn to_hex(&self) -> String {
        hex(&self.0)
    }

    pub fn from_hex(text: &str) -> Option<Self> {
        let bytes = unhex(text)?;
        Some(Self(bytes.try_into().ok()?))
    }

    fn proof(&self, label: &str, caller: &str, owner: &str) -> Option<String> {
        Some(hex(&self
            .mac(label, caller, owner)?
            .finalize()
            .into_bytes()))
    }

    /// Constant-time: `verify_slice` compares the whole tag.
    fn verify(&self, label: &str, caller: &str, owner: &str, proof: &str) -> bool {
        let (Some(proof), Some(mac)) = (unhex(proof), self.mac(label, caller, owner)) else {
            return false;
        };
        mac.verify_slice(&proof).is_ok()
    }

    fn mac(&self, label: &str, caller: &str, owner: &str) -> Option<Hmac<Sha256>> {
        let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(&self.0).ok()?;
        mac.update(format!("{label}\0{caller}\0{owner}").as_bytes());
        Some(mac)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() != KEY_BYTES * 2 || !text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
        .collect()
}

fn nonce() -> Result<String, BridgeError> {
    Ok(OwnerKey::generate()?.to_hex())
}

/// Read serve's `run/host.key` as `uid`: a regular file, never a symlink,
/// owned by `uid` with no group or other access. Returns the key with the
/// file's modification time; `Ok(None)` when it is absent.
pub(crate) fn read_owner_key(
    run: &Path,
    uid: u32,
) -> Result<Option<(OwnerKey, SystemTime)>, &'static str> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::fcntl::OFlag::O_NOFOLLOW.bits())
        .open(run.join(HOST_KEY_NAME));
    let file = match file {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("host.key is unreadable"),
        Ok(file) => file,
    };
    let meta = file.metadata().map_err(|_| "host.key is unreadable")?;
    if !meta.is_file() || meta.uid() != uid || meta.mode() & 0o077 != 0 {
        return Err("host.key is not private to this user");
    }
    let written = meta.modified().map_err(|_| "host.key is unreadable")?;
    let mut text = String::new();
    file.take(AUTH_LINE_BYTES)
        .read_to_string(&mut text)
        .map_err(|_| "host.key is unreadable")?;
    let key = OwnerKey::from_hex(text.trim_end()).ok_or("host.key is malformed")?;
    Ok(Some((key, written)))
}

struct Frame(Value);

impl Frame {
    fn id(&self) -> Value {
        self.0.get("id").cloned().unwrap_or(Value::Null)
    }

    fn is_auth(&self) -> bool {
        self.0.get("method").and_then(Value::as_str) == Some(METHOD_AUTH)
    }

    fn text(&self, part: &str, name: &str) -> Option<&str> {
        self.0.get(part)?.get(name)?.as_str()
    }
}

/// One bounded line: `None` when the peer hung up first, `Some(None)` when it
/// is not a JSON line.
async fn read_frame<S: AsyncRead + Unpin>(
    reader: &mut BufReader<S>,
) -> io::Result<Option<Option<Frame>>> {
    let mut line = Vec::new();
    if (&mut *reader)
        .take(AUTH_LINE_BYTES)
        .read_until(b'\n', &mut line)
        .await?
        == 0
    {
        return Ok(None);
    }
    Ok(Some(
        line.strip_suffix(b"\n")
            .and_then(|line| serde_json::from_slice::<Value>(line).ok())
            .map(Frame),
    ))
}

async fn write_frame<S: AsyncWrite + Unpin>(stream: &mut S, frame: &Value) -> io::Result<()> {
    let mut bytes = serde_json::to_vec(frame).map_err(io::Error::other)?;
    bytes.push(b'\n');
    stream.write_all(&bytes).await
}

/// Owner side: the connection's first two frames must be the caller's
/// challenge and its proof. Anything else is refused with `unauthorized` and
/// the caller must drop the connection. `Ok(false)` means the peer hung up
/// before proving anything, as a liveness probe does.
pub(crate) async fn accept<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut BufReader<S>,
    key: &OwnerKey,
) -> Result<bool, BridgeError> {
    let challenge = match read_frame(reader).await? {
        None => return Ok(false),
        Some(None) => return refuse(reader, Value::Null).await,
        Some(Some(frame)) => frame,
    };
    let caller = match challenge.text("params", "nonce") {
        Some(nonce) if challenge.is_auth() && unhex(nonce).is_some() => nonce.to_owned(),
        _ => return refuse(reader, challenge.id()).await,
    };
    let owner = nonce()?;
    let Some(proof) = key.proof(OWNER_PROOF, &caller, &owner) else {
        return refuse(reader, challenge.id()).await;
    };
    let reply =
        json!({"jsonrpc":"2.0", "id":challenge.id(), "result":{"nonce":owner, "proof":proof}});
    write_frame(reader.get_mut(), &reply).await?;
    let answer = match read_frame(reader).await? {
        None => return Ok(false),
        Some(None) => return refuse(reader, Value::Null).await,
        Some(Some(frame)) => frame,
    };
    let proven = answer.is_auth()
        && answer
            .text("params", "proof")
            .is_some_and(|proof| key.verify(CORE_PROOF, &caller, &owner, proof));
    if !proven {
        return refuse(reader, answer.id()).await;
    }
    Ok(true)
}

async fn refuse<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut BufReader<S>,
    id: Value,
) -> Result<bool, BridgeError> {
    let refusal =
        json!({"jsonrpc":"2.0", "id":id, "error":{"code":UNAUTHORIZED, "message":"unauthorized"}});
    let _ = write_frame(reader.get_mut(), &refusal).await;
    Err(BridgeError::UntrustedCaller)
}

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("plugin process owner closed the connection")]
    Gone,
    #[error("plugin process owner refused this caller: {0}")]
    Refused(String),
    #[error("plugin process owner did not prove the home's credential")]
    Unproven,
}

/// Caller side of [`accept`]: check that the owner proves `key`, then prove it.
/// The caller sends its requests on the same stream afterwards.
pub async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(
    reader: &mut BufReader<S>,
    key: &OwnerKey,
) -> Result<(), AuthError> {
    let caller = nonce().map_err(|_| AuthError::Gone)?;
    let challenge =
        json!({"jsonrpc":"2.0", "id":"auth", "method":METHOD_AUTH, "params":{"nonce":caller}});
    write_frame(reader.get_mut(), &challenge)
        .await
        .map_err(|_| AuthError::Gone)?;
    let reply = match read_frame(reader).await {
        Ok(Some(Some(reply))) => reply,
        Ok(Some(None)) => return Err(AuthError::Unproven),
        Ok(None) | Err(_) => return Err(AuthError::Gone),
    };
    if let Some(message) = reply.text("error", "message") {
        return Err(AuthError::Refused(message.to_owned()));
    }
    let (Some(owner), Some(proof)) = (reply.text("result", "nonce"), reply.text("result", "proof"))
    else {
        return Err(AuthError::Unproven);
    };
    if unhex(owner).is_none() || !key.verify(OWNER_PROOF, &caller, owner, proof) {
        return Err(AuthError::Unproven);
    }
    let proof = key
        .proof(CORE_PROOF, &caller, owner)
        .ok_or(AuthError::Unproven)?;
    let answer = json!({"jsonrpc":"2.0", "method":METHOD_AUTH, "params":{"proof":proof}});
    write_frame(reader.get_mut(), &answer)
        .await
        .map_err(|_| AuthError::Gone)
}

#[cfg(test)]
mod tests;
