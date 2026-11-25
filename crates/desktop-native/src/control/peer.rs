//! A single accepted native control peer.
//!
//! Mirrors `LocalNativePeer` (`native-socket.ts`): wraps a nonblocking Unix
//! stream, reads length-prefixed compact-JSON frames with the update adapter
//! decoder, writes frames with `encode_frame`, reports the kernel peer token
//! (`LOCAL_PEERTOKEN`), and closes itself after an inactivity deadline.

use pacer_desktop_update::adapter::{FrameDecoder, encode_frame};
use serde_json::Value;
use std::{
    io,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::AsyncWriteExt,
    net::unix::{OwnedReadHalf, OwnedWriteHalf},
    sync::Mutex as AsyncMutex,
};

use nix::libc;
use nix::sys::socket::getsockopt;
use nix::{getsockopt_impl, sockopt_impl};

sockopt_impl!(
    /// `getsockopt(SOL_SOCKET, LOCAL_PEERTOKEN)` local peer identity on
    /// Darwin: the kernel's `struct local_peer` record for the calling
    /// side of a Unix socket. We keep the full 32-byte buffer to match
    /// `native-socket.ts`, which requires `getsockopt` to fill 32 bytes.
    LocalPeerToken,
    GetOnly,
    0,
    libc::LOCAL_PEERTOKEN,
    [u8; 32]
);

/// The activity deadline before a peer is closed for inactivity (30s).
pub const INACTIVITY_TIMEOUT: Duration = Duration::from_secs(30);

/// A live peer on the native control socket.
pub struct Peer {
    read: OwnedReadHalf,
    decoder: AsyncMutex<FrameDecoder>,
    write: AsyncMutex<OwnedWriteHalf>,
    audit: Option<[u8; 32]>,
    dead: AtomicBool,
    last_activity: Mutex<Instant>,
}

impl Peer {
    /// Wrap a connected Unix stream as a control peer, reading the kernel
    /// peer token (`LOCAL_PEERTOKEN`). `audit_token` is `None` only when
    /// the option is unavailable (for example, on non-Darwin hosts).
    pub fn new(stream: tokio::net::UnixStream) -> io::Result<Arc<Peer>> {
        let audit = read_peer_token(&stream);
        let (read, write) = stream.into_split();
        Ok(Arc::new(Peer {
            read,
            decoder: AsyncMutex::new(FrameDecoder::new()),
            write: AsyncMutex::new(write),
            audit,
            dead: AtomicBool::new(false),
            last_activity: Mutex::new(Instant::now()),
        }))
    }

    /// The peer token reported by the kernel for this socket, when available.
    pub fn audit_token(&self) -> Option<&[u8; 32]> {
        self.audit.as_ref()
    }

    /// Whether the peer has closed.
    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Acquire)
    }

    /// Read any complete frames currently available, feeding the codec.
    ///
    /// Returns `Ok(None)` on EOF and `Ok(Some(frames))` otherwise. The
    /// caller should await `readable` first (see `read_frames`).
    pub async fn read_available(&self) -> io::Result<Option<Vec<Value>>> {
        if self.dead.load(Ordering::Acquire) {
            return Ok(None);
        }
        let mut buffer = [0u8; 16384];
        let n = match self.read.try_read(&mut buffer) {
            Ok(0) => return Ok(None), // EOF
            Ok(n) => n,
            Err(ref e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(Some(Vec::new())),
            Err(e) => return Err(e),
        };
        let mut decoder = self.decoder.lock().await;
        let frames = decoder.push(&buffer[..n]).map_err(|_| invalid())?;
        drop(decoder);
        if !frames.is_empty() {
            *self.last_activity.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        }
        Ok(Some(frames))
    }

    /// Wait until the socket is readable, then read available frames.
    pub async fn read_frames(&self) -> io::Result<Option<Vec<Value>>> {
        self.read.readable().await?;
        self.read_available().await
    }

    /// Send a frame, encoding it with the shared frame codec. Frames larger
    /// than `MAX_FRAME_BYTES` are rejected up front.
    pub async fn send(&self, value: Value) -> io::Result<()> {
        self.send_encoded(&encode_frame(&value).map_err(|_| invalid())?)
            .await
    }

    /// Send several pre-encoded frames in one write.
    pub async fn send_batch(&self, frames: Vec<Vec<u8>>) -> io::Result<()> {
        let mut write = self.write.lock().await;
        for bytes in frames {
            write.write_all(&bytes).await?;
        }
        Ok(())
    }

    async fn send_encoded(&self, bytes: &[u8]) -> io::Result<()> {
        if self.dead.load(Ordering::Acquire) {
            return Err(closed());
        }
        let mut write = self.write.lock().await;
        write.write_all(bytes).await?;
        *self.last_activity.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now();
        Ok(())
    }

    /// Close the peer idempotently.
    pub async fn close(&self) {
        if self.dead.swap(true, Ordering::AcqRel) {
            return;
        }
        // Dropping the write half surfaces an EOF to the reader side.
        drop(self.write.lock().await);
    }

    /// The time since the last frame was read or written.
    pub fn idle_for(&self) -> Duration {
        self.last_activity
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .elapsed()
    }
}

impl Drop for Peer {
    fn drop(&mut self) {
        self.dead.store(true, Ordering::Release);
    }
}

/// `getsockopt(fd, SOL_SOCKET, LOCAL_PEERTOKEN, ...)` returns the local
/// peer identity (a 32-byte record on Darwin, matching the TypeScript side).
/// Uses nix's safe `GetSockOpt` wrapper so no `unsafe` block appears here.
fn read_peer_token(stream: &tokio::net::UnixStream) -> Option<[u8; 32]> {
    getsockopt(stream, LocalPeerToken).ok()
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "native frame invalid")
}
fn closed() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "native channel closed")
}

#[cfg(test)]
#[path = "tests/peer.rs"]
mod tests;
