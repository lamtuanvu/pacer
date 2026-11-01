//! Native plugin registry shell. The TypeScript host owns plugins until the P4d cutover.

mod admission;
mod config;
mod manifest;
mod process;
mod registry;

pub use admission::{AdmissionError, CallAdmission};
pub use config::{PluginGrant, PluginsConfig};
pub use manifest::{ManifestError, ParsedManifest, host_range_accepts, parse_manifest};
pub use process::{
    MAX_LINE_BYTES, PluginProcess, ProcessError, ProcessFrame, SpawnSpec, frame, parse_frame,
};
pub use registry::{HostMode, PluginState, Registry, RegistryError};
