//! Session gate tests, transcribed from the desktop's `Connection` checks
//! (`frame.sessionId === connection.sessionId && frame.sequence ===
//! connection.sequence + 1 && !dead`).
#![allow(clippy::unwrap_used)]
use super::super::peer::Peer;
use super::super::session::{Identity, Session};

fn identity() -> Identity {
    Identity {
        role: "desktop".to_owned(),
        client_id: "cli".to_owned(),
        audit: None,
        executable: None,
        pid: None,
    }
}

/// A session whose peer starts dead so tests can focus on the gate itself.
async fn fresh_session() -> Session {
    let (a, _b) = tokio::net::UnixStream::pair().unwrap();
    let peer = Peer::new(a).unwrap();
    Session::new(peer, "ses-1".to_owned(), identity())
}

#[tokio::test]
async fn accepts_enforces_session_and_monotonic_sequence() {
    let mut session = fresh_session().await;
    // First accepted frame must be sequence 1.
    assert!(session.accepts("ses-1", 1));
    // Sequence must strictly increment: the next expected is exactly 2.
    assert!(session.accepts("ses-1", 2));
    // Wrong session id fails.
    assert!(!session.accepts("other", 3));
    // Replay: a lower or equal sequence fails.
    assert!(!session.accepts("ses-1", 2));
    assert!(!session.accepts("ses-1", 1));
    // Current is 2; consuming 3 then replaying 3 is rejected as frozen.
    assert!(session.accepts("ses-1", 3));
    assert!(!session.accepts("ses-1", 3));
}

#[tokio::test]
async fn accepts_starts_at_sequence_one() {
    let mut session = fresh_session().await;
    // Zero is rejected (sequences begin at 1).
    assert!(!session.accepts("ses-1", 0));
}

#[tokio::test]
async fn dead_session_rejects_everything() {
    let mut session = fresh_session().await;
    assert!(session.accepts("ses-1", 1));
    session.mark_dead();
    assert!(!session.accepts("ses-1", 2));
}

#[tokio::test]
async fn readiness_is_latched() {
    let mut session = fresh_session().await;
    assert!(!session.ready);
    session.make_ready();
    assert!(session.ready);
}
