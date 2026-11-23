//! Paired front-door service ownership proof.
//!
//! Mirrors `pairedServiceOwner` in `src/update/desktop/native-service-owner.ts`.
//! Inputs come only from native code/process verification, never API claims. The
//! function is pure: it validates a bounded proof of the running paired
//! front-door and service and returns the shared ownership identity, or refuses
//! with `Code::NotAllowed`.

#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use pacer_foundation::api::{Code, CoreError};
use std::path::{Path, PathBuf};

use super::identity::parse_bundle_release;
use super::native_trust::ProcessIdentity;

/// A verified native core process (`NativeProcess` from `native-os.ts`).
#[derive(Clone, Debug)]
pub struct NativeProcess {
    pub process: ProcessIdentity,
    pub uid: u32,
    pub parent_pid: u32,
    pub executable: Option<PathBuf>,
}

/// A verified native peer (`NativePeer` from `native-os.ts`).
#[derive(Clone, Debug)]
pub struct NativePeer {
    pub process: ProcessIdentity,
    pub uid: u32,
    pub executable: PathBuf,
    pub audit_token_len: usize,
    pub role: NativeCodeRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeCodeRole {
    Desktop,
    Cli,
    Helper,
}

impl NativeCodeRole {
    fn is_cli(self) -> bool {
        matches!(self, NativeCodeRole::Cli)
    }
}

/// Identity that may be compared across process generations.
pub fn same_process(a: &ProcessIdentity, b: &ProcessIdentity) -> bool {
    a.pid == b.pid && a.boot_id == b.boot_id && a.birth == b.birth
}

fn denied() -> CoreError {
    CoreError::new(
        Code::NotAllowed,
        "Native paired service ownership unavailable",
    )
}

/// Canonical-path predicate from `native-service-owner.ts`: absolute,
/// normalized, bounded, no NUL and not translocated.
fn canonical(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let normalized: PathBuf = path.components().collect();
    if normalized.as_os_str() != path.as_os_str() {
        return false;
    }
    let Some(text) = path.to_str() else {
        return false;
    };
    text.len() <= 4096
        && !text.contains('\0')
        && !path
            .components()
            .any(|p| p.as_os_str() == "AppTranslocation")
}

/// Inputs to `pairedServiceOwner` (`PairedOwnerProof`).
#[derive(Clone, Debug)]
pub struct PairedOwnerProof {
    pub core: NativeProcess,
    pub front: NativePeer,
    pub own: ProcessIdentity,
    pub release: serde_json::Value,
    pub argv: Vec<String>,
    pub version: String,
    pub front_version: String,
    pub arch: String,
    pub uid: u64,
    pub port: u64,
}

/// The established paired service owner (`NativeServiceOwner`).
#[derive(Clone, Debug)]
pub struct NativeServiceOwner {
    pub process: ProcessIdentity,
    pub executable: PathBuf,
    pub argv: Vec<String>,
    pub transport: ProcessIdentity,
    pub app_path: PathBuf,
}

/// Validates a bounded paired service ownership proof and returns the shared
/// ownership identity, or refuses when any invariant fails.
pub fn paired_service_owner(proof: &PairedOwnerProof) -> Result<NativeServiceOwner, CoreError> {
    let PairedOwnerProof {
        core,
        front,
        own,
        release,
        argv,
        version,
        front_version,
        arch,
        uid,
        port,
    } = proof;
    if core.uid != *uid as u32
        || front.uid != *uid as u32
        || !(1..=65_535).contains(port)
        || !front.role.is_cli()
        || front.audit_token_len != 32
        || !same_process(&core.process, own)
        || core.parent_pid != front.process.pid
        || core.process.pid == front.process.pid
        || core.process.boot_id != front.process.boot_id
        || core.executable.as_deref().is_none_or(|p| !canonical(p))
        || !canonical(&front.executable)
    {
        return Err(denied());
    }
    for identity in [&core.process, &front.process] {
        if identity.pid <= 1 || identity.boot_id.is_empty() || identity.birth.is_empty() {
            return Err(denied());
        }
    }
    let core_exe = core.executable.as_deref().ok_or_else(denied)?;
    let resources = core_exe.parent().ok_or_else(denied)?;
    let contents = resources.parent().ok_or_else(denied)?;
    let app_path = contents.parent().ok_or_else(denied)?;
    if core_exe.file_name().and_then(|n| n.to_str()) != Some("pacer-core")
        || resources.file_name().and_then(|n| n.to_str()) != Some("Resources")
        || contents.file_name().and_then(|n| n.to_str()) != Some("Contents")
        || !app_path.to_string_lossy().ends_with(".app")
        || front.executable != resources.join("pacer")
    {
        return Err(denied());
    }
    let release = parse_bundle_release(release)?;
    if release.cli_layout != Some("paired".to_string())
        || release.version != *version
        || release.version != *front_version
        || release.arch != *arch
        || !release.protocol_majors.contains(&3)
    {
        return Err(denied());
    }
    if argv.first() != Some(&front.executable.to_string_lossy().to_string())
        || argv.get(1).map(String::as_str) != Some("serve")
        || !(argv.len() == 2
            || argv.len() == 4
                && argv.get(2).map(String::as_str) == Some("--port")
                && (argv.get(3).map(String::as_str) == Some(&port.to_string())
                    || argv.get(3).map(String::as_str) == Some("0")))
    {
        return Err(denied());
    }
    Ok(NativeServiceOwner {
        process: front.process.clone(),
        executable: front.executable.clone(),
        argv: argv.clone(),
        transport: core.process.clone(),
        app_path: app_path.to_path_buf(),
    })
}
