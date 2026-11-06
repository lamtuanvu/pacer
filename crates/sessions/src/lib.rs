//! Persisted local-session byte contracts. No operation or runtime caller is registered.
pub mod attach;

pub mod control;
pub mod files;
pub mod framing;
mod json_number;
pub mod masking;
pub mod offset;
pub mod operations;
pub mod plain;
pub mod recording;
pub mod session_args;
pub mod takeover;
pub mod targets;
pub mod version;
