//! Bounded release transport and authenticated complete-package validation.
use super::{
    wire::{Arch, Candidate},
    OtaError,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    io::{Read, Write},
    path::{Component, Path},
};

pub const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_FEED_BYTES: u64 = 256 * 1024;
pub fn arch_name(arch: Arch) -> &'static str {
    match arch {
        Arch::Aarch64 => "aarch64",
        Arch::X86_64 => "x86_64",
    }
}
fn stable_version(value: &str) -> Result<semver::Version, OtaError> {
    let version = semver::Version::parse(value).map_err(|_| OtaError::Invalid)?;
    if !version.pre.is_empty() || !version.build.is_empty() || version.to_string() != value {
        return Err(OtaError::Invalid);
    }
    Ok(version)
}
fn artifact_url(version: &str, arch: Arch) -> String {
    format!("https://github.com/lamtuanvu/pacer/releases/download/v{version}/desktop-pacer-{version}-darwin-{}.app.tar.gz", arch_name(arch))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeedPlatform {
    url: String,
    signature: String,
    sha256: String,
    bundle_id: String,
    protocol_majors: Vec<u64>,
    admission_protocol: u64,
    rollback_compatible: bool,
}
#[derive(Deserialize)]
struct Feed {
    schema: u32,
    version: String,
    #[serde(default)]
    notes: String,
    platforms: std::collections::HashMap<String, FeedPlatform>,
}

pub fn candidate_from_feed(
    bytes: &[u8],
    current: &str,
    arch: Arch,
) -> Result<Option<Candidate>, OtaError> {
    if bytes.len() as u64 > MAX_FEED_BYTES {
        return Err(OtaError::Invalid);
    }
    let feed: Feed = serde_json::from_slice(bytes).map_err(|_| OtaError::Invalid)?;
    if feed.schema != 1 || feed.notes.len() > 32_768 {
        return Err(OtaError::Invalid);
    }
    if stable_version(&feed.version)? <= stable_version(current)? {
        return Ok(None);
    }
    let platform = feed
        .platforms
        .get(&format!("darwin-{}", arch_name(arch)))
        .ok_or(OtaError::Invalid)?;
    if platform.bundle_id != super::trust::APP_ID
        || platform.protocol_majors != [3]
        || platform.admission_protocol != 1
        || !platform.rollback_compatible
        || platform.url != artifact_url(&feed.version, arch)
        || platform.signature.is_empty()
        || platform.signature.len() > 8192
        || platform.sha256.len() != 64
        || !platform
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(OtaError::Invalid);
    }
    Ok(Some(Candidate {
        version: feed.version,
        arch,
        sha256: platform.sha256.clone(),
        signature: platform.signature.clone(),
        url: platform.url.clone(),
        protocol_majors: platform.protocol_majors.clone(),
        rollback_compatible: true,
        notes: feed.notes,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageMetadata {
    schema: u32,
    version: String,
    arch: String,
    bundle_id: String,
    protocol_majors: Vec<u64>,
    admission_protocol: u64,
    native_transport_abi: u64,
    rollback_compatible: bool,
    fixture: bool,
    #[serde(default)]
    cli_layout: crate::packaging::CliLayout,
}
fn extract_package(bytes: &[u8], directory: &Path, candidate: &Candidate) -> Result<(), OtaError> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let io_error = |_| OtaError::Io;
    if bytes.is_empty()
        || bytes.len() as u64 > MAX_ARTIFACT_BYTES
        || std::fs::read_dir(directory)
            .map_err(io_error)?
            .next()
            .is_some()
    {
        return Err(OtaError::Invalid);
    }
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut seen = HashSet::new();
    let mut expanded = 0u64;
    // Read raw entries so tar never expands PAX/GNU metadata before our bounds.
    // Releases contain only regular files and directories.
    for entry in archive.entries().map_err(io_error)?.raw(true) {
        let mut entry = entry.map_err(io_error)?;
        let path = entry.path().map_err(io_error)?.into_owned();
        let raw = path.to_str().ok_or(OtaError::Invalid)?;
        if raw
            .trim_end_matches('/')
            .split('/')
            .any(|part| part == "." || part == ".." || part.is_empty())
        {
            return Err(OtaError::Invalid);
        }
        let components: Vec<_> = path.components().collect();
        if components.first() != Some(&Component::Normal(std::ffi::OsStr::new("pacer.app")))
            || components
                .iter()
                .any(|p| !matches!(p, Component::Normal(_)))
            || !seen.insert(path.clone())
            || seen.len() > 100_000
        {
            return Err(OtaError::Invalid);
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(OtaError::Invalid);
        }
        let mode = entry.header().mode().map_err(io_error)?;
        if mode & 0o7022 != 0 {
            return Err(OtaError::Invalid);
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or(OtaError::Invalid)?;
        if expanded > MAX_EXPANDED_BYTES {
            return Err(OtaError::Invalid);
        }
        let target = directory.join(&path);
        if kind.is_dir() {
            std::fs::create_dir_all(&target).map_err(io_error)?;
        } else {
            std::fs::create_dir_all(target.parent().ok_or(OtaError::Invalid)?).map_err(io_error)?;
            let mut output = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&target)
                .map_err(io_error)?;
            std::io::copy(&mut entry, &mut output).map_err(io_error)?;
            output
                .set_permissions(std::fs::Permissions::from_mode(mode & 0o777))
                .map_err(io_error)?;
            output.sync_all().map_err(io_error)?;
        }
    }
    let contents = directory.join("pacer.app/Contents");
    let read_small = |path: &Path| -> Result<Vec<u8>, OtaError> {
        let mut file = std::fs::File::open(path).map_err(io_error)?;
        let mut bytes = Vec::new();
        (&mut file)
            .take(65_537)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() > 65_536 {
            return Err(OtaError::Invalid);
        }
        Ok(bytes)
    };
    let metadata: PackageMetadata =
        serde_json::from_slice(&read_small(&contents.join("Resources/pacer-release.json"))?)
            .map_err(|_| OtaError::Invalid)?;
    if metadata.schema != 1
        || metadata.version != candidate.version
        || metadata.arch != arch_name(candidate.arch)
        || metadata.bundle_id != super::trust::APP_ID
        || metadata.protocol_majors != candidate.protocol_majors
        || metadata.admission_protocol != 1
        || metadata.native_transport_abi != 1
        || !metadata.rollback_compatible
        || !candidate.rollback_compatible
        || metadata.fixture != cfg!(feature = "ota-fixture")
    {
        return Err(OtaError::Invalid);
    }
    let info = plist::Value::from_reader(std::io::Cursor::new(read_small(
        &contents.join("Info.plist"),
    )?))
    .map_err(|_| OtaError::Invalid)?;
    let info = info.as_dictionary().ok_or(OtaError::Invalid)?;
    for (key, value) in [
        ("CFBundleExecutable", "pacer"),
        ("CFBundleIdentifier", super::trust::APP_ID),
        ("CFBundleVersion", candidate.version.as_str()),
        ("CFBundleShortVersionString", candidate.version.as_str()),
    ] {
        if info.get(key).and_then(plist::Value::as_string) != Some(value) {
            return Err(OtaError::Invalid);
        }
    }
    let mut components = vec![
        ("MacOS/pacer", 2),
        ("Resources/pacer", 2),
        ("Resources/pacer-update-helper", 2),
        ("Frameworks/libpacer-native.dylib", 6),
    ];
    if matches!(metadata.cli_layout, crate::packaging::CliLayout::Paired) {
        components.push(("Resources/pacer-core", 2));
    }
    for (name, kind) in components {
        let path = contents.join(name);
        let mut header = [0u8; 32];
        std::fs::File::open(&path)
            .map_err(io_error)?
            .read_exact(&mut header)
            .map_err(io_error)?;
        let cpu = match candidate.arch {
            Arch::Aarch64 => 0x0100_000c,
            Arch::X86_64 => 0x0100_0007,
        };
        if header[..4] != [0xcf, 0xfa, 0xed, 0xfe]
            || u32::from_le_bytes(header[4..8].try_into().unwrap()) != cpu
            || u32::from_le_bytes(header[12..16].try_into().unwrap()) != kind
            || std::fs::metadata(path)
                .map_err(io_error)?
                .permissions()
                .mode()
                & 0o111
                == 0
        {
            return Err(OtaError::Invalid);
        }
    }
    Ok(())
}

async fn read_response(
    response: reqwest::Response,
    limit: u64,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Vec<u8>, OtaError> {
    use futures_util::StreamExt;
    let response = response.error_for_status().map_err(|_| OtaError::Io)?;
    let total = response.content_length();
    if total.is_some_and(|size| size > limit) {
        return Err(OtaError::Invalid);
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| OtaError::Io)?;
        if (bytes.len() as u64)
            .checked_add(chunk.len() as u64)
            .is_none_or(|size| size > limit)
        {
            return Err(OtaError::Invalid);
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, total);
    }
    if total.is_some_and(|size| size != bytes.len() as u64) {
        return Err(OtaError::Invalid);
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn assess_execution(app: &Path) -> Result<(), OtaError> {
    use std::{
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    // Apple's documented Gatekeeper assessment. Never changes system policy,
    // quarantine attributes or approval rules, and never launches package code.
    let mut child = Command::new("/usr/sbin/spctl")
        .args(["--assess", "--type", "execute"])
        .arg(app)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| OtaError::Unavailable)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    Ok(())
                } else {
                    Err(OtaError::Identity)
                }
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(OtaError::Io);
            }
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(OtaError::Timeout);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(target_os = "macos")]
pub struct NativeUpdater {
    updater: tauri_plugin_updater::Updater,
    trust: super::trust::ReleaseTrust,
    target: super::wire::Installation,
}
#[cfg(target_os = "macos")]
pub struct VerifiedPackage {
    bytes: Vec<u8>,
    extracted: tempfile::TempDir,
    candidate: Candidate,
}
#[cfg(target_os = "macos")]
impl VerifiedPackage {
    pub fn app_path(&self) -> std::path::PathBuf {
        self.extracted.path().join("pacer.app")
    }
    pub fn candidate(&self) -> &Candidate {
        &self.candidate
    }
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}
#[cfg(target_os = "macos")]
impl NativeUpdater {
    /// Caller obtains this installation exclusively from the authenticated native channel.
    pub(crate) fn new<R: tauri::Runtime>(
        app: &tauri::AppHandle<R>,
        trust: super::trust::ReleaseTrust,
        target: super::wire::Installation,
    ) -> Result<Self, OtaError> {
        use tauri_plugin_updater::UpdaterExt;
        let installed = stable_version(&target.version)?;
        let updater = app
            .updater_builder()
            .executable_path(Path::new(&target.app_path).join("Contents/MacOS/pacer"))
            .pubkey(trust.public_key())
            .target(format!("darwin-{}", arch_name(target.arch)))
            .version_comparator(move |_, release| release.version > installed)
            .endpoints(vec![super::trust::STABLE_FEED
                .parse()
                .map_err(|_| OtaError::Invalid)?])
            .map_err(|_| OtaError::Invalid)?
            .build()
            .map_err(|_| OtaError::Invalid)?;
        Ok(Self {
            updater,
            trust,
            target,
        })
    }
    fn client(&self) -> Result<reqwest::Client, OtaError> {
        reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(120))
            .redirect(reqwest::redirect::Policy::limited(5))
            .user_agent(concat!("pacer-desktop/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| OtaError::Io)
    }
    pub async fn check(&self) -> Result<Option<Candidate>, OtaError> {
        if let Some(fixture) = self.trust.fixture_policy() {
            fixture.validate_live().map_err(|_| OtaError::Identity)?;
            let feed = super::platform_fs::PrivateDir::open(&fixture.root.join("feed"))?
                .read("stable.json", MAX_FEED_BYTES)?;
            return candidate_from_feed(&feed, &self.target.version, self.target.arch);
        }
        let response = self
            .client()?
            .get(super::trust::STABLE_FEED)
            .send()
            .await
            .map_err(|_| OtaError::Io)?;
        let bytes = read_response(response, MAX_FEED_BYTES, |_, _| {}).await?;
        candidate_from_feed(&bytes, &self.target.version, self.target.arch)
    }
    fn restore(&self, candidate: &Candidate) -> Result<tauri_plugin_updater::Update, OtaError> {
        if candidate.arch != self.target.arch
            || candidate.url != artifact_url(&candidate.version, candidate.arch)
            || stable_version(&candidate.version)? <= stable_version(&self.target.version)?
        {
            return Err(OtaError::Invalid);
        }
        self.updater.restore_update(serde_json::json!({"version":candidate.version,"notes":candidate.notes,"platforms":{
            format!("darwin-{}",arch_name(candidate.arch)):{"url":candidate.url,"signature":candidate.signature}
        }})).map_err(|_|OtaError::Invalid)?.ok_or(OtaError::Invalid)
    }
    pub async fn download(
        &self,
        candidate: &Candidate,
        private_directory: &Path,
        progress: impl FnMut(u64, Option<u64>),
    ) -> Result<VerifiedPackage, OtaError> {
        self.restore(candidate)?; // Reject incompatible URL/target before making a request.
        if let Some(fixture) = self.trust.fixture_policy() {
            fixture.validate_live().map_err(|_| OtaError::Identity)?;
            let directory = super::platform_fs::PrivateDir::open(&fixture.root.join("artifacts"))?;
            let bytes = directory.read(
                &format!(
                    "desktop-pacer-{}-darwin-{}.app.tar.gz",
                    candidate.version,
                    arch_name(candidate.arch)
                ),
                MAX_ARTIFACT_BYTES,
            )?;
            let mut progress = progress;
            progress(bytes.len() as u64, Some(bytes.len() as u64));
            return self.verify(bytes, candidate, private_directory);
        }
        let response = self
            .client()?
            .get(&candidate.url)
            .send()
            .await
            .map_err(|_| OtaError::Io)?;
        let bytes = read_response(response, MAX_ARTIFACT_BYTES, progress).await?;
        self.verify(bytes, candidate, private_directory)
    }
    pub fn verify(
        &self,
        bytes: Vec<u8>,
        candidate: &Candidate,
        private_directory: &Path,
    ) -> Result<VerifiedPackage, OtaError> {
        use super::trust::CodeRole;
        if bytes.len() as u64 > MAX_ARTIFACT_BYTES
            || format!("{:x}", Sha256::digest(&bytes)) != candidate.sha256
        {
            return Err(OtaError::Invalid);
        }
        if self
            .trust
            .fixture_policy()
            .is_some_and(|fixture| !fixture.permits_path(private_directory))
        {
            return Err(OtaError::Identity);
        }
        self.restore(candidate)?
            .verify(&bytes)
            .map_err(|_| OtaError::Identity)?;
        let extracted = tempfile::Builder::new()
            .prefix("verified-package-")
            .tempdir_in(private_directory)
            .map_err(|_| OtaError::Io)?;
        extract_package(&bytes, extracted.path(), candidate)?;
        let app = extracted.path().join("pacer.app");
        self.trust.verify_static(&app, CodeRole::Desktop)?;
        self.trust
            .verify_static(&app.join("Contents/Resources/pacer"), CodeRole::Cli)?;
        self.trust.verify_static(
            &app.join("Contents/Resources/pacer-update-helper"),
            CodeRole::Helper,
        )?;
        self.trust
            .verify_native_shim(&app.join("Contents/Frameworks/libpacer-native.dylib"))?;
        if self.trust.fixture_policy().is_none() {
            assess_execution(&app)?;
        }
        Ok(VerifiedPackage {
            bytes,
            extracted,
            candidate: candidate.clone(),
        })
    }
    /// The platform must reverify its reservation and destination immediately before calling.
    /// Installation remains the pinned upstream implementation with no-elevation compiled in.
    pub(crate) fn install(&self, package: &VerifiedPackage) -> Result<(), OtaError> {
        self.restore(&package.candidate)?
            .install(&package.bytes)
            .map_err(|_| OtaError::Io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn feed() -> serde_json::Value {
        json!({"schema":1,"version":"0.2.4","notes":"hello","platforms":{
            "darwin-aarch64":{"url":"https://github.com/lamtuanvu/pacer/releases/download/v0.2.4/desktop-pacer-0.2.4-darwin-aarch64.app.tar.gz","signature":"signed","sha256":"a".repeat(64),"bundleId":"dev.pacer.desktop","protocolMajors":[3],"admissionProtocol":1,"rollbackCompatible":true}
        }})
    }
    fn candidate() -> Candidate {
        Candidate {
            version: "0.2.4".into(),
            arch: Arch::Aarch64,
            sha256: "a".repeat(64),
            signature: "signed".into(),
            url: feed()["platforms"]["darwin-aarch64"]["url"]
                .as_str()
                .unwrap()
                .into(),
            protocol_majors: vec![3],
            rollback_compatible: true,
            notes: "hello".into(),
        }
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn system_execution_assessment_rejects_an_unsigned_bundle_without_running_it() {
        let temp = tempfile::tempdir().unwrap();
        let app = temp.path().join("unsigned.app");
        std::fs::create_dir(&app).unwrap();
        assert_eq!(assess_execution(&app), Err(OtaError::Identity));
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn configured_plugin_cannot_replace_pinned_key_and_signed_version() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        use tauri::test::{mock_builder, mock_context, noop_assets};
        // Public upstream test vector: payload "test", signed version2.0.0. No private key.
        let key=STANDARD.encode("untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe");
        let signature=STANDARD.encode("untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==");
        let mut context = mock_context(noop_assets());
        context
            .config_mut()
            .plugins
            .0
            .insert("updater".into(), json!({"pubkey":"wrong-untrusted-key"}));
        let app = mock_builder()
            .plugin(
                tauri_plugin_updater::Builder::new()
                    .pubkey("wrong-untrusted-key")
                    .build(),
            )
            .build(context)
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let app_path = dir.path().join("pacer.app");
        std::fs::create_dir_all(app_path.join("Contents/MacOS")).unwrap();
        let target = super::super::wire::Installation {
            id: "test".into(),
            app_path: app_path.to_str().unwrap().into(),
            bundle_id: "dev.pacer.desktop".into(),
            owner_uid: unsafe { libc::geteuid() } as u64,
            arch: Arch::Aarch64,
            pacer_home: dir.path().to_str().unwrap().into(),
            port: 4317,
            service_label: "com.pacer.serve".into(),
            ownership: super::super::wire::Ownership::Managed,
            version: "0.2.3".into(),
        };
        let trust = super::super::trust::ReleaseTrust::from_production(&key, Some("ABCDE12345"), None).unwrap();
        let updater = NativeUpdater::new(app.handle(), trust, target).unwrap();
        let mut candidate = candidate();
        candidate.version = "2.0.0".into();
        candidate.signature = signature;
        candidate.url = artifact_url(&candidate.version, candidate.arch);
        updater
            .restore(&candidate)
            .unwrap()
            .verify(b"test")
            .unwrap();
        assert!(updater
            .restore(&candidate)
            .unwrap()
            .verify(b"tampered")
            .is_err());
        candidate.version = "2.0.1".into();
        candidate.url = artifact_url(&candidate.version, candidate.arch);
        assert!(updater
            .restore(&candidate)
            .unwrap()
            .verify(b"test")
            .is_err());
    }
    #[test]
    fn feed_only_offers_new_stable_complete_release_for_this_architecture() {
        assert_eq!(
            candidate_from_feed(
                &serde_json::to_vec(&feed()).unwrap(),
                "0.2.3",
                Arch::Aarch64
            )
            .unwrap(),
            Some(candidate())
        );
        assert_eq!(
            candidate_from_feed(
                &serde_json::to_vec(&feed()).unwrap(),
                "0.2.4",
                Arch::Aarch64
            )
            .unwrap(),
            None
        );
        assert_eq!(
            candidate_from_feed(
                &serde_json::to_vec(&feed()).unwrap(),
                "0.3.0",
                Arch::Aarch64
            )
            .unwrap(),
            None
        );
        assert!(
            candidate_from_feed(&serde_json::to_vec(&feed()).unwrap(), "0.2.3", Arch::X86_64)
                .is_err()
        );
        for (key, value) in [
            ("url", json!("https://evil.example/pacer")),
            ("bundleId", json!("other")),
            ("admissionProtocol", json!(0)),
            ("protocolMajors", json!([2])),
            ("rollbackCompatible", json!(false)),
            ("sha256", json!("invalid")),
        ] {
            let mut value_feed = feed();
            value_feed["platforms"]["darwin-aarch64"][key] = value;
            assert!(
                candidate_from_feed(
                    &serde_json::to_vec(&value_feed).unwrap(),
                    "0.2.3",
                    Arch::Aarch64
                )
                .is_err(),
                "{key}"
            );
        }
        let mut prerelease = feed();
        prerelease["version"] = json!("0.2.4-beta.1");
        assert!(candidate_from_feed(
            &serde_json::to_vec(&prerelease).unwrap(),
            "0.2.3",
            Arch::Aarch64
        )
        .is_err());
    }
    fn package(
        extra: Option<(&str, tar::EntryType)>,
        metadata_change: Option<(&str, serde_json::Value)>,
    ) -> Vec<u8> {
        package_with_shim(extra, metadata_change, Some((0x0100_000c, 6)))
    }
    fn package_with_shim(
        extra: Option<(&str, tar::EntryType)>,
        metadata_change: Option<(&str, serde_json::Value)>,
        shim: Option<(u32, u32)>,
    ) -> Vec<u8> {
        let mut archive = tar::Builder::new(Vec::new());
        let mut add = |path: &str, bytes: &[u8], kind: tar::EntryType| {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o755);
            header.set_entry_type(kind);
            if kind.is_symlink() {
                header.set_link_name("/tmp").unwrap();
            }
            header.set_cksum();
            archive.append_data(&mut header, path, bytes).unwrap();
        };
        let mut binary = [0u8; 32];
        binary[..8].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]);
        binary[12..16].copy_from_slice(&2u32.to_le_bytes());
        for name in [
            "MacOS/pacer",
            "Resources/pacer",
            "Resources/pacer-update-helper",
        ] {
            add(
                &format!("pacer.app/Contents/{name}"),
                &binary,
                tar::EntryType::Regular,
            );
        }
        if let Some((cpu, kind)) = shim {
            binary[4..8].copy_from_slice(&cpu.to_le_bytes());
            binary[12..16].copy_from_slice(&kind.to_le_bytes());
            add(
                "pacer.app/Contents/Frameworks/libpacer-native.dylib",
                &binary,
                tar::EntryType::Regular,
            );
        }
        let mut metadata = json!({"schema":1,"version":"0.2.4","arch":"aarch64","bundleId":"dev.pacer.desktop","protocolMajors":[3],"admissionProtocol":1,"rollbackCompatible":true,"nativeTransportAbi":1,"fixture":cfg!(feature="ota-fixture")});
        if let Some((key, value)) = metadata_change {
            metadata[key] = value;
        }
        add(
            "pacer.app/Contents/Resources/pacer-release.json",
            &serde_json::to_vec(&metadata).unwrap(),
            tar::EntryType::Regular,
        );
        add("pacer.app/Contents/Info.plist",br#"<plist version="1.0"><dict><key>CFBundleExecutable</key><string>pacer</string><key>CFBundleIdentifier</key><string>dev.pacer.desktop</string><key>CFBundleVersion</key><string>0.2.4</string><key>CFBundleShortVersionString</key><string>0.2.4</string></dict></plist>"#,tar::EntryType::Regular);
        if let Some((path, kind)) = extra {
            if path == "pacer.app/Contents/Resources/pacer-core" && kind.is_file() {
                binary[12..16].copy_from_slice(&2u32.to_le_bytes());
                add(path, &binary, kind);
            } else { add(path, b"", kind); }
        }
        let bytes = archive.into_inner().unwrap();
        let mut compressed =
            flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut compressed, &bytes).unwrap();
        compressed.finish().unwrap()
    }
    #[test]
    fn paired_package_requires_a_native_core_and_known_layout() {
        let core = "pacer.app/Contents/Resources/pacer-core";
        for (extra, valid) in [(None, false), (Some((core, tar::EntryType::Regular)), true), (Some((core, tar::EntryType::Directory)), false)] {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(extract_package(&package(extra, Some(("cliLayout", json!("paired")))), dir.path(), &candidate()).is_ok(), valid);
        }
        let dir = tempfile::tempdir().unwrap();
        assert!(extract_package(&package(None, Some(("cliLayout", json!("other")))), dir.path(), &candidate()).is_err());
        for layout in [serde_json::Value::Null, json!(1), json!("")] {
            let dir = tempfile::tempdir().unwrap();
            assert!(extract_package(&package(None, Some(("cliLayout", layout))), dir.path(), &candidate()).is_err());
        }
    }
    #[test]
    fn complete_package_metadata_is_checked_before_any_candidate_execution() {
        let dir = tempfile::tempdir().unwrap();
        extract_package(&package(None, None), dir.path(), &candidate()).unwrap();
        assert!(dir
            .path()
            .join("pacer.app/Contents/Resources/pacer")
            .is_file());
        for (key, value) in [
            ("version", json!("0.2.5")),
            ("fixture", json!(!cfg!(feature = "ota-fixture"))),
            ("admissionProtocol", json!(0)),
            ("rollbackCompatible", json!(false)),
            ("arch", json!("x86_64")),
        ] {
            let dir = tempfile::tempdir().unwrap();
            assert!(
                extract_package(&package(None, Some((key, value))), dir.path(), &candidate())
                    .is_err(),
                "{key}"
            );
        }
    }
    #[test]
    fn native_library_is_required_and_must_be_the_correct_abi_architecture_and_type() {
        for shim in [None, Some((0x0100_0007, 6)), Some((0x0100_000c, 2))] {
            let dir = tempfile::tempdir().unwrap();
            assert!(extract_package(
                &package_with_shim(None, None, shim),
                dir.path(),
                &candidate()
            )
            .is_err());
        }
        for abi in [json!(0), json!(2), serde_json::Value::Null] {
            let dir = tempfile::tempdir().unwrap();
            assert!(extract_package(
                &package(None, Some(("nativeTransportAbi", abi))),
                dir.path(),
                &candidate()
            )
            .is_err());
        }
    }
    #[test]
    fn archive_rejects_links_extra_roots_and_duplicate_entries() {
        for extra in [
            ("pacer.app/redirect", tar::EntryType::Symlink),
            ("another.app/file", tar::EntryType::Regular),
            ("pacer.app/Contents/MacOS/pacer", tar::EntryType::Regular),
        ] {
            let dir = tempfile::tempdir().unwrap();
            assert!(
                extract_package(&package(Some(extra), None), dir.path(), &candidate()).is_err()
            );
        }
    }
    #[test]
    fn archive_rejects_extension_headers_before_they_can_allocate_or_rewrite_paths() {
        let compressed = package(None, None);
        let mut normal = Vec::new();
        flate2::read::GzDecoder::new(compressed.as_slice())
            .read_to_end(&mut normal)
            .unwrap();
        let payload = b"17 comment=value\n";
        let mut header = tar::Header::new_ustar();
        header.set_path("pacer.app/metadata").unwrap();
        header.set_entry_type(tar::EntryType::XHeader);
        header.set_size(payload.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        let mut raw = header.as_bytes().to_vec();
        raw.extend(payload);
        raw.resize(1024, 0);
        raw.extend(normal);
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&raw).unwrap();
        let bytes = encoder.finish().unwrap();
        let dir = tempfile::tempdir().unwrap();
        assert!(extract_package(&bytes, dir.path(), &candidate()).is_err());
    }
    #[tokio::test]
    async fn response_stream_enforces_actual_size_even_without_content_length() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 1024];
                stream.read(&mut request).unwrap();
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n123456789")
                    .unwrap();
            }
        });
        let response = reqwest::get(format!("http://{address}")).await.unwrap();
        assert_eq!(
            read_response(response, 9, |_, _| {}).await.unwrap(),
            b"123456789"
        );
        let response = reqwest::get(format!("http://{address}")).await.unwrap();
        assert!(read_response(response, 8, |_, _| {}).await.is_err());
        server.join().unwrap();
    }
}
