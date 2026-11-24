//! Verified native desktop session state.
//!
//! A `Session` mirrors the desktop's `Connection`: it binds a peer to an
//! authenticated identity, a server-generated session id and the client's own
//! id, an incremental sequence (checked on every frame dispatch), readiness
//! (a desktop session becomes ready only after a valid `desktop-ready`
//! frame), and liveness. A peer that fails any check is dead.

use super::peer::Peer;
use std::sync::Arc;

/// An authenticated peer identity, reproduced when ops are dispatched to the
/// serve router.
#[derive(Clone, Debug)]
pub struct Identity {
    /// `desktop` or `helper`.
    pub role: String,
    /// The client-chosen id from the hello frame.
    pub client_id: String,
    /// The kernel peer token for the socket, when available.
    pub audit: Option<[u8; 32]>,
}

/// A live native control session.
pub struct Session {
    /// The bound peer.
    pub peer: Arc<Peer>,
    /// Server-generated connection id (matches `connection.sessionId`).
    pub session_id: String,
    /// Verified peer identity.
    pub identity: Identity,
    /// Last accepted frame sequence; the next frame must be `sequence + 1`.
    pub sequence: u64,
    /// Whether the session has sent a valid `desktop-ready` frame.
    pub ready: bool,
    /// Whether this session is dead and must be dropped.
    pub dead: bool,
}

impl Session {
    /// A fresh, not-yet-ready session for a verified peer.
    pub fn new(peer: Arc<Peer>, session_id: impl Into<String>, identity: Identity) -> Session {
        Session {
            peer,
            session_id: session_id.into(),
            identity,
            sequence: 0,
            ready: false,
            dead: false,
        }
    }

    /// Validate that `session_id` matches this session and `sequence` is the
    /// next expected one (`requestSchema` gate). Returns `false` when the
    /// frame must be rejected.
    pub fn accepts(&mut self, session_id: &str, sequence: u64) -> bool {
        if self.dead || self.session_id != session_id || sequence != self.sequence + 1 {
            return false;
        }
        self.sequence = sequence;
        true
    }

    /// Mark the session ready (`desktop-ready` accepted).
    pub fn make_ready(&mut self) {
        self.ready = true;
    }

    /// Mark the session dead.
    pub fn mark_dead(&mut self) {
        self.dead = true;
    }
}

#[cfg(test)]
#[path = "tests/session.rs"]
mod tests;
