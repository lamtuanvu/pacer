//! Desktop update state store (port of `src/update/desktop/store.ts`,
//! `types.ts`, `policy.ts`, `adoption-state.ts` and `adoption-store.ts`,
//! schema 1).
//!
//! Operates on a private per-installation JSON file under `desktop-updates/`
//! and a `desktop_adoptions` table in the shared `admission.sqlite`, both
//! guarded by the shared admission coordinator for crash-safe, serialized
//! compare-and-swap writes. Records and adoption rows round-trip byte-for-byte
//! with the TypeScript writer through `pacer-js-json`'s `stringify`.
pub mod adapter;
pub mod adoption_runtime;
pub mod adoption_state;
pub mod adoption_store;
pub mod policy;
pub mod runtime;
pub mod store;
pub mod types;

pub use adoption_store::{
    begin_adoption, cancel_adoption, list_adoptions, read_adoption, read_terminal_adoption,
    replay_adoption_request, transition_adoption,
};
pub use policy::{cancel_restart, check_due, checks_enabled, request_restart, update_status};
pub use store::{read_update, write_update};
pub use types::{UpdateRecord, parse_update_record, request_fingerprint};
