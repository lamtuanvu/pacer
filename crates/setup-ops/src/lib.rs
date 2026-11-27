//! Native setup and doctor operation handlers: the setup gate and checklist, the setup
//! doctor and its diagnostic summary, and the approval-only setup mutations.
//!
//! Moved from `pacer-config-ops` (B6-2) so later slices do not grow that crate. This
//! crate is layer 8 and depends on `pacer-config-ops` for shared helpers.
pub mod diagnostic_summary;
pub mod doctor_ops;
pub mod setup_checklist;
pub mod setup_gate;
pub mod setup_ops;
