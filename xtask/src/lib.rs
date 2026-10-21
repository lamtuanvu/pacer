//! Workspace maintenance checks.
pub mod deps;
pub mod r#gen;
pub mod loc;
pub use r#gen::{generate, targets};
