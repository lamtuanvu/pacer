//! Desktop update state store (port of `src/update/desktop/store.ts` and
//! `types.ts`, schema 1).
//!
//! Operates on a private per-installation JSON file under `desktop-updates/`,
//! guarded by the shared admission coordinator for crash-safe, serialized
//! compare-and-swap writes. Records round-trip byte-for-byte with the
//! TypeScript writer through `pacer-js-json`'s `stringify`.
pub mod store;
pub mod types;

pub use store::{read_update, write_update};
pub use types::{UpdateRecord, parse_update_record, request_fingerprint};
