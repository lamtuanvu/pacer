//! Native desktop bridge: Mac-only helper processes and binding metadata.
//!
//! This crate was extracted from `pacer-server`'s `serve` layer so the native
//! host binding can live under its own dependency layer (layer 8). It owns the
//! paired-app startup, the Mac socket listener, trust and bundle verification,
//! helper process management, and the native identity/record surface used to
//! drive desktop updates.

pub mod identity;
mod js_trim;
mod native_bootstrap;
pub mod native_bundle;
pub mod native_context;
mod native_helper;
mod native_helper_diagnostics;
pub mod native_listener;
pub mod native_trust;
pub mod record;
pub mod service_argv;
pub mod service_owner;

pub use native_context::NativeContext;
