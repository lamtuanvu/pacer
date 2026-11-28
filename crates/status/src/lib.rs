//! Live status for the native cutover (B12): evidence reconcile/merge, usage
//! reads and refresh, the usage store, and the account inputs (auth marks,
//! folders, sign-in, remote usage, endpoints) that feed the native status
//! computation, ported one-to-one from the TypeScript implementation
//! (`src/usage`, `src/engine/evidence.ts`, `src/endpoints`, `src/remote`).
//! Inputs and outputs are `serde_json::Value` in the TypeScript JSON shapes.

#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

pub mod endpoint;
pub mod evidence;
pub mod folders;
pub mod freshness;
pub mod refresh;
mod freshness_generated;
pub mod marks;
pub mod remote_usage;
pub mod signin;
pub mod trace;
pub mod usage;
pub mod usage_spec;
pub mod usage_store;
