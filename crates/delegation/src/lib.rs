//! Native task delegation, managed-work lifecycle and message turns. The front
//! doors inject the external runtime (plugins, runner spawn and supervision) so
//! the op crates keep their strict layer ordering (G2).
#![allow(clippy::result_large_err)]

pub mod answer;
pub mod delegate;
pub mod runtime;
pub mod send;
pub mod turns;
pub mod work;

pub use delegate::DelegateInput;
pub use runtime::Runtime;
