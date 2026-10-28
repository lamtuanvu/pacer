pub mod detect;
pub mod journal;
pub use detect::{detect_takeover, read_consent, ConsentRecord, TakeoverCandidate};
