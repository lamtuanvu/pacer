//! Task admission contracts. No served operation calls this crate yet.
mod brief;
mod capacity;

pub use brief::{AdmissionError, parse_delegate_brief, validate_input};
pub use capacity::{SlotLimits, queue_capacity, slot_use};
