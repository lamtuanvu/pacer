pub mod detect;
pub mod engine;
pub mod journal;
#[cfg(target_os = "macos")]
pub mod platform;
pub use detect::{
    detect_takeover, detect_takeover_for_consent, read_consent, ConsentRecord, TakeoverCandidate,
};
