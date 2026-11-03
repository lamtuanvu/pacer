//! Orca task-attempt, policy and session owners over execution and capability resources; no registry or RPC admission.
pub use pacer_plugin_capabilities::*;
pub use pacer_plugin_execution::{
    native_git, native_remote, native_run, native_worktree, remote_transport,
};
pub mod orca_attempt;
pub mod orca_policy;
mod orca_prompt;
pub use orca_attempt::{
    OrcaAttempt, OrcaAttemptSpec, OrcaLiveOwner, OrcaPlacement, checked_worktree,
};
pub mod native_orca;
pub use native_git::{NativeGit, VerifiedBundle, remote_preflight};
pub use native_orca::{
    NativeOrca, NativeOrcaLive, NativeOrcaStatus, OrcaLiveControl, OrcaSessionOwner,
};
pub use native_remote::{NativeRemote, RemoteHost, RemoteIntent, RemoteOperation};
pub use native_run::{NativeRun, RunLaunch, RunLaunchFile};
pub use native_worktree::NativeWorktree;
pub use remote_transport::RemoteTransport;
