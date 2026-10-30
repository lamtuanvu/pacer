use std::path::{Path, PathBuf};

#[derive(Default, serde::Deserialize)]
pub(crate) enum CliLayout {
    #[default]
    #[serde(skip)]
    Legacy,
    #[serde(rename = "paired")]
    Paired,
}

/// None means a development/Linux launch; an invalid macOS bundle is an error,
/// never permission to execute an unrelated PATH installation.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseMetadata {
    schema: u8,
    bundle_id: String,
    version: String,
    arch: String,
    protocol_majors: Vec<u32>,
    admission_protocol: u32,
    rollback_compatible: bool,
    #[serde(default)]
    cli_layout: CliLayout,
}

pub fn packaged_cli(executable: &Path) -> Result<Option<PathBuf>, String> {
    let Some(macos) = executable.parent() else {
        return Ok(None);
    };
    let Some(contents) = macos.parent() else {
        return Ok(None);
    };
    let Some(app) = contents.parent() else {
        return Ok(None);
    };
    if macos.file_name().is_none_or(|n| n != "MacOS")
        || contents.file_name().is_none_or(|n| n != "Contents")
        || app.extension().is_none_or(|n| n != "app")
    {
        return Ok(None);
    }
    validate_bundle(contents).map(Some)
}

fn validate_bundle(contents: &Path) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;
    let error = || "The bundled pacer installation is incomplete or incompatible".to_string();
    for dir in [
        contents.to_path_buf(),
        contents.join("MacOS"),
        contents.join("Resources"),
    ] {
        let metadata = std::fs::symlink_metadata(dir).map_err(|_| error())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(error());
        }
    }
    for file in [
        "MacOS/pacer",
        "Resources/pacer",
        "Resources/pacer-update-helper",
        "Info.plist",
        "Resources/pacer-release.json",
    ] {
        let metadata = std::fs::symlink_metadata(contents.join(file)).map_err(|_| error())?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || (!file.ends_with(".json")
                && !file.ends_with(".plist")
                && metadata.permissions().mode() & 0o111 == 0)
        {
            return Err(error());
        }
    }
    let metadata: ReleaseMetadata = serde_json::from_slice(
        &std::fs::read(contents.join("Resources/pacer-release.json")).map_err(|_| error())?,
    )
    .map_err(|_| error())?;
    if metadata.schema != 1
        || metadata.bundle_id != crate::ota::trust::APP_ID
        || metadata.version != env!("CARGO_PKG_VERSION")
        || metadata.arch != std::env::consts::ARCH
        || !metadata.protocol_majors.contains(&3)
        || metadata.admission_protocol != 1
        || !metadata.rollback_compatible
    {
        return Err(error());
    }
    if matches!(metadata.cli_layout, CliLayout::Paired) {
        let core = std::fs::symlink_metadata(contents.join("Resources/pacer-core"))
            .map_err(|_| error())?;
        if !core.is_file()
            || core.file_type().is_symlink()
            || core.permissions().mode() & 0o111 == 0
        {
            return Err(error());
        }
    }
    let info = plist::Value::from_file(contents.join("Info.plist")).map_err(|_| error())?;
    let info = info.as_dictionary().ok_or_else(error)?;
    for (key, expected) in [
        ("CFBundleIdentifier", crate::ota::trust::APP_ID),
        ("CFBundleExecutable", "pacer"),
        ("CFBundleVersion", env!("CARGO_PKG_VERSION")),
        ("CFBundleShortVersionString", env!("CARGO_PKG_VERSION")),
    ] {
        if info.get(key).and_then(plist::Value::as_string) != Some(expected) {
            return Err(error());
        }
    }
    contents
        .join("Resources/pacer")
        .canonicalize()
        .map_err(|_| error())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!(
            "pacer-package-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let app = root.join("pacer.app/Contents");
        std::fs::create_dir_all(app.join("MacOS")).unwrap();
        std::fs::create_dir_all(app.join("Resources")).unwrap();
        for path in [
            "MacOS/pacer",
            "Resources/pacer",
            "Resources/pacer-update-helper",
        ] {
            std::fs::write(app.join(path), b"fixture").unwrap();
            std::fs::set_permissions(app.join(path), std::fs::Permissions::from_mode(0o755))
                .unwrap();
        }
        let version = env!("CARGO_PKG_VERSION");
        std::fs::write(app.join("Info.plist"), format!(r#"<plist version="1.0"><dict><key>CFBundleExecutable</key><string>pacer</string><key>CFBundleIdentifier</key><string>dev.pacer.desktop</string><key>CFBundleShortVersionString</key><string>{version}</string><key>CFBundleVersion</key><string>{version}</string></dict></plist>"#)).unwrap();
        std::fs::write(app.join("Resources/pacer-release.json"), serde_json::to_vec(&serde_json::json!({
            "schema": 1, "bundleId": "dev.pacer.desktop", "version": version,
            "arch": std::env::consts::ARCH, "protocolMajors": [3], "admissionProtocol": 1, "rollbackCompatible": true,
        })).unwrap()).unwrap();
        Fixture(root)
    }
    #[test]
    fn paired_bundle_requires_a_real_executable_core() {
        for mode in [
            "missing",
            "nonexecutable",
            "symlink",
            "valid",
            "unknown-layout",
        ] {
            let f = fixture();
            let contents = f.0.join("pacer.app/Contents");
            let metadata = contents.join("Resources/pacer-release.json");
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
            value["cliLayout"] = serde_json::json!(if mode == "unknown-layout" {
                "other"
            } else {
                "paired"
            });
            std::fs::write(&metadata, serde_json::to_vec(&value).unwrap()).unwrap();
            let core = contents.join("Resources/pacer-core");
            if mode == "symlink" {
                symlink(contents.join("Resources/pacer"), &core).unwrap();
            } else if mode != "missing" {
                std::fs::write(&core, b"fixture core").unwrap();
                std::fs::set_permissions(
                    &core,
                    std::fs::Permissions::from_mode(if mode == "nonexecutable" {
                        0o600
                    } else {
                        0o755
                    }),
                )
                .unwrap();
            }
            assert_eq!(
                packaged_cli(&contents.join("MacOS/pacer")).is_ok(),
                mode == "valid",
                "{mode}"
            );
        }
    }
    #[test]
    fn packaged_cli_uses_resources_and_never_the_shell() {
        let f = fixture();
        let binary = f.0.join("pacer.app/Contents/MacOS/pacer");
        assert_eq!(
            packaged_cli(&binary).unwrap(),
            Some(
                f.0.join("pacer.app/Contents/Resources/pacer")
                    .canonicalize()
                    .unwrap()
            )
        );
    }
    #[test]
    fn incomplete_or_redirected_bundle_is_an_error_not_a_path_fallback() {
        let f = fixture();
        let binary = f.0.join("pacer.app/Contents/MacOS/pacer");
        let cli = f.0.join("pacer.app/Contents/Resources/pacer");
        std::fs::remove_file(&cli).unwrap();
        assert!(packaged_cli(&binary).is_err());
        symlink(&binary, &cli).unwrap();
        assert!(packaged_cli(&binary).is_err());
    }
    #[test]
    fn changed_release_metadata_cannot_select_a_packaged_cli() {
        let f = fixture();
        let binary = f.0.join("pacer.app/Contents/MacOS/pacer");
        let metadata = f.0.join("pacer.app/Contents/Resources/pacer-release.json");
        let original: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
        for (key, value) in [
            ("version", serde_json::json!("999.0.0")),
            ("arch", serde_json::json!("other")),
            ("protocolMajors", serde_json::json!([2])),
            ("admissionProtocol", serde_json::json!(0)),
        ] {
            let mut changed = original.clone();
            changed[key] = value;
            std::fs::write(&metadata, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(packaged_cli(&binary).is_err(), "{key}");
        }
    }
    #[test]
    fn ordinary_executable_remains_a_development_launch() {
        assert_eq!(packaged_cli(Path::new("/tmp/dev/pacer")).unwrap(), None);
    }
    #[cfg(not(feature = "ota-fixture"))]
    #[test]
    fn release_bundle_refuses_fixture_identifiers() {
        let fixture_app = crate::ota::trust::FIXTURE_IDENTIFIERS.app;
        let f = fixture();
        let binary = f.0.join("pacer.app/Contents/MacOS/pacer");
        let metadata = f.0.join("pacer.app/Contents/Resources/pacer-release.json");
        let mut value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&metadata).unwrap()).unwrap();
        value["bundleId"] = serde_json::json!(fixture_app);
        std::fs::write(&metadata, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(packaged_cli(&binary).is_err());
        let f = fixture();
        let binary = f.0.join("pacer.app/Contents/MacOS/pacer");
        let info = f.0.join("pacer.app/Contents/Info.plist");
        let text = std::fs::read_to_string(&info).unwrap().replace(
            "<string>dev.pacer.desktop</string>",
            &format!("<string>{fixture_app}</string>"),
        );
        std::fs::write(&info, text).unwrap();
        assert!(packaged_cli(&binary).is_err());
    }
}
