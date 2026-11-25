//! Shared desktop admission coordinator.
//!
//! Port of `src/update/desktop/{coordinator,admission,reconciliation-fence,
//! blockers,process-identity}.ts`: a crash-safe, physical-lock SQLite
//! coordinator guarding the `desktop-updates/admission.sqlite` file, plus the
//! idle reservation, reconciliation fence and work-blocker gate. The
//! coordinator owns the file's private entrances and the short synchronous
//! `BEGIN IMMEDIATE` transaction envelope. Used by the plugin host's work-lease
//! module and the desktop-update store.
pub mod blockers;
pub mod coordinator;
pub mod fence;
pub mod process_identity;
pub mod reservation;
pub mod state;

pub use coordinator::{AdmissionError, mutate, with_coordinator};
pub use process_identity::ProcessIdentity;
pub use reservation::Reservation;
