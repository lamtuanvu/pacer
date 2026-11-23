//! Native desktop control socket: verified sessions and in-process dispatch.
//!
//! The front door (when `PACER_NATIVE_DESKTOP_CONTROL=1`) accepts on the
//! native listener itself instead of handing the descriptor to Core. This
//! module provides the transport (`peer`, `frames`), the verified connection
//! state (`session`), and the accept/frame loop (`server`).
//!
//! Dispatch is passed in from `crates/server`: [`Dispatch`] runs each `op`
//! through the serve router in-process (preserving native-or-not-native
//! routing) and streams subscribed events; [`Guard`] reproduces the desktop's
//! `verifyPeer` audit-token check so no frame reaches an authority effect
//! before the kernel peer identity is confirmed.

pub mod adoption;
pub mod authority;
pub mod cleanup;
pub mod frames;
pub mod peer;
pub mod pipes;
pub mod server;
pub mod session;

pub use frames::{FrameKind, Hello, Request};
pub use peer::Peer;
pub use server::ControlServer;
pub use session::{Identity, Session};

use serde_json::Value;
use std::future::Future;
use tokio::sync::mpsc;

/// Runs verified native requests against the serve router.
///
/// `crates/server` implements this at wiring time so every op keeps its
/// existing native-or-not-yet-native routing; the control socket never makes
/// its own routing decisions.
pub trait Dispatch: Send + Sync {
    /// Run one op through the serve router, carrying the desktop client
    /// identity (the synthesized request presents the front-door bearer and
    /// the `X-Pacer-Client` headers the desktop's `dispatchOp` sent).
    fn call_op(
        &self,
        identity: &Identity,
        op: &str,
        params: Value,
    ) -> impl Future<Output = Result<Value, Value>> + Send;
    /// Subscribe to events at or after `since` (the SSE cursor). The
    /// returned receiver yields event values the caller forwards to the peer
    /// as native `event` frames.
    fn subscribe(
        &self,
        identity: &Identity,
        since: f64,
    ) -> impl Future<Output = Result<mpsc::Receiver<Value>, Value>> + Send;
}

/// Authenticates an accepted peer before any session is created.
///
/// This is the SECURITY-CRITICAL peer audit-token check (`LOCAL_PEERTOKEN`)
/// together with the hello challenge and peer-role validation. It must be
/// repeated on every dispatched frame (the desktop's `verifyPeer` call in
/// each `handle`), so [`server`] calls it again before each request effect.
pub trait Guard: Send + Sync {
    /// Verify the peer's kernel token and hello identity, returning the
    /// authenticated identity for dispatch.
    fn verify_peer(
        &self,
        peer: &Peer,
        hello: &Hello,
    ) -> impl Future<Output = Result<Identity, String>> + Send;
}
