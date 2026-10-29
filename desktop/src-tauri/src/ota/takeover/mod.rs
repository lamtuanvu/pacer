pub mod detect;
pub mod engine;
pub mod journal;
#[cfg(target_os = "macos")]
pub mod platform;
pub use detect::{detect_takeover, read_consent, ConsentRecord, TakeoverCandidate};
