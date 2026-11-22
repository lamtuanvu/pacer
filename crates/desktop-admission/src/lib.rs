//! Shared desktop admission coordinator.
//!
//! Port of `src/update/desktop/coordinator.ts`: a crash-safe, physical-lock
//! SQLite coordinator guarding the `desktop-updates/admission.sqlite` file. The
//! coordinator owns the file's private entrances and the short synchronous
//! `BEGIN IMMEDIATE` transaction envelope; callers own the `admission` row
//! codec. Used by the plugin host's work-lease module and the desktop-update
//! store.
pub mod coordinator;

pub use coordinator::{AdmissionError, mutate, with_coordinator};
