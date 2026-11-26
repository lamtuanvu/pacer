//! Native task delegation, managed-work lifecycle, message turns and cleanup effects.
//!
//! The runtime traits in [`runtime`] are the only way this crate reaches plugin calls,
//! runner spawn and supervision. `pacer-server` owns their implementations; op crates
//! receive native effects through their existing trait slots.
#![allow(clippy::result_large_err)]

pub mod answer;
pub mod ask;
pub mod cleanup;
pub mod delegate;
pub mod retry;
pub mod runtime;

pub use delegate::DelegateInput;
pub use runtime::Runtime;
