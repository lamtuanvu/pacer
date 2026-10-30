//! Layout declarations are trusted only after native app/code signature checks.
use super::native_trust::ProcessDetails;
use std::{io, path::PathBuf};

#[derive(Clone, Debug)]
pub struct NativeBundle {
    pub app: PathBuf,
    pub front: PathBuf,
    pub core: PathBuf,
    pub version: String,
    pub owner: super::native_trust::ProcessIdentity,
}
fn app_path(front: &std::path::Path) -> io::Result<PathBuf> {
    use std::path::Component;
    let denied = || io::Error::other("native paired bundle unavailable");
    let normalized: PathBuf = front.components().collect();
    if !front.is_absolute()
        || normalized.as_os_str() != front.as_os_str()
        || front.to_str().is_none()
        || front.components().any(|part| {
            matches!(part, Component::ParentDir | Component::CurDir)
                || part.as_os_str() == "AppTranslocation"
        })
    {
        return Err(denied());
    }
    let resources = front.parent().ok_or_else(denied)?;
    let contents = resources.parent().ok_or_else(denied)?;
    let app = contents.parent().ok_or_else(denied)?;
    if front.file_name().is_none_or(|name| name != "pacer")
        || resources.file_name().is_none_or(|name| name != "Resources")
        || contents.file_name().is_none_or(|name| name != "Contents")
        || app.extension().is_none_or(|name| name != "app")
    {
        return Err(denied());
    }
    Ok(app.to_owned())
}

fn owned_json(path: &std::path::Path) -> io::Result<serde_json::Value> {
    use std::{
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let denied = || io::Error::other("native metadata unavailable");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != nix::unistd::getuid().as_raw()
        || metadata.mode() & 0o022 != 0
        || metadata.nlink() != 1
        || metadata.len() > 65536
    {
        return Err(denied());
    }
    let mut bytes = Vec::new();
    file.take(65537).read_to_end(&mut bytes)?;
    if bytes.len() > 65536 {
        return Err(denied());
    }
    serde_json::from_slice(&bytes).map_err(|_| denied())
}

fn owned_path(path: &std::path::Path, directory: bool, executable: bool) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let metadata = path.symlink_metadata()?;
    if metadata.file_type().is_symlink()
        || metadata.uid() != nix::unistd::getuid().as_raw()
        || metadata.mode() & 0o022 != 0
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file() || metadata.nlink() != 1
        }
        || executable && metadata.mode() & 0o100 == 0
        || path.canonicalize()? != path
    {
        return Err(io::Error::other("native bundle ownership unavailable"));
    }
    Ok(())
}

impl NativeBundle {
    pub fn verified(trust: &super::native_trust::NativeTrust, version: &str) -> io::Result<Self> {
        use super::native_trust::NativeRole;
        let owner = trust.verify_current()?;
        let app = app_path(&owner.executable)?;
        for directory in [&app, &app.join("Contents"), &app.join("Contents/Resources")] {
            owned_path(directory, true, false)?;
        }
        trust.verify_static(&app, NativeRole::Desktop)?;
        let metadata_path = app.join("Contents/Resources/pacer-release.json");
        let metadata = owned_json(&metadata_path)?;
        let bundle = paired_layout(&owner, version, &metadata)?;
        for file in [&bundle.front, &bundle.core] {
            owned_path(file, false, true)?;
            trust.verify_static(file, NativeRole::Cli)?;
        }
        trust.verify_static(&app, NativeRole::Desktop)?;
        if owner != trust.verify_current()? || owned_json(&metadata_path)? != metadata {
            return Err(io::Error::other(
                "native bundle changed during verification",
            ));
        }
        Ok(bundle)
    }
}
pub fn paired_layout(
    owner: &ProcessDetails,
    version: &str,
    metadata: &serde_json::Value,
) -> io::Result<NativeBundle> {
    let denied = || io::Error::other("native paired bundle unavailable");
    let app = app_path(&owner.executable)?;
    if owner.uid != nix::unistd::getuid().as_raw()
        || owner.process.pid <= 1
        || owner.process.boot_id.is_empty()
        || owner.process.birth.is_empty()
        || version.is_empty()
        || metadata["schema"] != 1
        || metadata["bundleId"] != super::native_trust::IDENTIFIERS.app
        || metadata["version"] != version
        || metadata["arch"] != std::env::consts::ARCH
        || metadata["cliLayout"] != "paired"
        || metadata["admissionProtocol"] != 1
        || metadata["nativeTransportAbi"] != 1
        || metadata["rollbackCompatible"] != true
        || !metadata["protocolMajors"]
            .as_array()
            .is_some_and(|values| values.contains(&serde_json::json!(3)))
    {
        return Err(denied());
    }
    Ok(NativeBundle {
        app,
        front: owner.executable.clone(),
        core: owner.executable.with_file_name("pacer-core"),
        version: version.to_owned(),
        owner: owner.process.clone(),
    })
}

#[cfg(test)]
#[path = "native_bundle_tests.rs"]
mod tests;
