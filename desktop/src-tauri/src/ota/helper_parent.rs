//! NEW helper bootstrap proof for the sealed Rust front/Bun core relationship.
use super::super::{
    native::ProcessDetails,
    OtaError,
};
#[cfg(target_os = "macos")]
use super::super::trust::{CodeRole, ReleaseTrust};
use std::path::{Path, PathBuf};

fn paired_app(
    front: &ProcessDetails,
    core: &ProcessDetails,
    uid: u32,
) -> Result<PathBuf, OtaError> {
    let canonical_spelling = |path: &Path| {
        let normalized: PathBuf = path.components().collect();
        path.is_absolute()
            && normalized.as_os_str() == path.as_os_str()
            && path.to_str().is_some()
            && path.as_os_str().as_encoded_bytes().len() <= 4096
            && path.components().all(|part| {
                matches!(
                    part,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                ) && part.as_os_str() != "AppTranslocation"
            })
    };
    if front.uid != uid
        || core.uid != uid
        || front.identity.pid <= 1
        || core.identity.pid <= 1
        || front.identity.pid == core.identity.pid
        || core.parent_pid != front.identity.pid
        || front.identity.boot_id.is_empty()
        || front.identity.boot_id != core.identity.boot_id
        || front.identity.birth.is_empty()
        || core.identity.birth.is_empty()
        || !canonical_spelling(&front.executable)
        || !canonical_spelling(&core.executable)
    {
        return Err(OtaError::Identity);
    }
    let resources = front.executable.parent().ok_or(OtaError::Identity)?;
    let contents = resources.parent().ok_or(OtaError::Identity)?;
    let app = contents.parent().ok_or(OtaError::Identity)?;
    if front
        .executable
        .file_name()
        .is_none_or(|name| name != "pacer")
        || resources.file_name().is_none_or(|name| name != "Resources")
        || contents.file_name().is_none_or(|name| name != "Contents")
        || app.extension().is_none_or(|name| name != "app")
        || core.executable != resources.join("pacer-core")
    {
        return Err(OtaError::Identity);
    }
    Ok(app.to_owned())
}

fn paired_metadata(metadata: &serde_json::Value, version: &str) -> Result<(), OtaError> {
    if version.is_empty()
        || metadata["schema"] != 1
        || metadata["bundleId"] != super::super::trust::APP_ID
        || metadata["version"] != version
        || metadata["arch"] != std::env::consts::ARCH
        || metadata["cliLayout"] != "paired"
        || metadata["admissionProtocol"] != 1
        || metadata["nativeTransportAbi"] != 1
        || metadata["rollbackCompatible"] != true
        || !metadata["protocolMajors"].as_array().is_some_and(|values| {
            values.contains(&serde_json::json!(3))
                && values
                    .iter()
                    .all(|value| value.as_u64().is_some_and(|major| major > 0))
        })
    {
        return Err(OtaError::Identity);
    }
    Ok(())
}

/// The actual parent is observed from the kernel; no bootstrap field names the core.
#[cfg(target_os = "macos")]
pub(super) fn verify(
    front: &ProcessDetails,
    parent: u32,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    use super::super::{native, platform_fs};
    use std::os::unix::fs::MetadataExt;
    let observed = native::process_details(parent)
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    let core = trust.verify_process(&observed.identity, CodeRole::Cli)?;
    let core = core.details();
    let app = paired_app(front, core, unsafe { libc::geteuid() })?;
    // Canonical, owned, nonredirected components and exact executable siblings.
    for (path, directory) in [
        (&app, true),
        (&app.join("Contents"), true),
        (&app.join("Contents/Resources"), true),
        (&front.executable, false),
        (&core.executable, false),
    ] {
        let metadata = path.symlink_metadata().map_err(|_| OtaError::Identity)?;
        if path.canonicalize().map_err(|_| OtaError::Identity)? != *path
            || metadata.file_type().is_symlink()
            || metadata.uid() != front.uid
            || metadata.mode() & 0o022 != 0
            || if directory {
                !metadata.is_dir()
            } else {
                !metadata.is_file() || metadata.nlink() != 1 || metadata.mode() & 0o100 == 0
            }
        {
            return Err(OtaError::Identity);
        }
    }
    trust.verify_static(&app, CodeRole::Desktop)?;
    let metadata_path = app.join("Contents/Resources/pacer-release.json");
    let bytes = platform_fs::read_owned_file(&metadata_path, 65536)?;
    let metadata = serde_json::from_slice(&bytes).map_err(|_| OtaError::Identity)?;
    paired_metadata(&metadata, env!("CARGO_PKG_VERSION"))?;
    trust.verify_static(&front.executable, CodeRole::Cli)?;
    trust.verify_static(&core.executable, CodeRole::Cli)?;
    trust.verify_static(&app, CodeRole::Desktop)?;
    // Revalidate both incarnations, paths and the sealed declaration after all I/O.
    if trust
        .verify_process(&front.identity, CodeRole::Cli)?
        .details()
        != front
        || trust
            .verify_process(&core.identity, CodeRole::Cli)?
            .details()
            != core
        || native::process_details(parent)
            .map_err(|_| OtaError::Identity)?
            .as_ref()
            != Some(core)
        || unsafe { libc::getppid() } as u32 != parent
        || platform_fs::read_owned_file(&metadata_path, 65536)? != bytes
    {
        return Err(OtaError::Identity);
    }
    Ok(())
}

#[cfg(test)]
#[path = "helper_parent_tests.rs"]
mod tests;
