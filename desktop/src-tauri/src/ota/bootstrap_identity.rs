//! Transaction-scoped legacy identity. Nothing here grants normal OTA trust.

use super::{native::ProcessIdentity, wire::Arch, OtaError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyRelease {
    version: String,
    arch: Arch,
    sha256: String,
    admission_exclusion: bool,
}
#[derive(Debug, Serialize, PartialEq)]
pub struct LegacyReleaseInspection {
    pub supported: bool,
    pub reason: &'static str,
    pub version: Option<String>,
}
pub fn inspect_legacy_release(
    sha256: &str,
    arch: Arch,
    destination: &str,
) -> Result<LegacyReleaseInspection, OtaError> {
    let destination = semver::Version::parse(destination).map_err(|_| OtaError::Invalid)?;
    let releases: Vec<LegacyRelease> = serde_json::from_str(include_str!(
        "../../../../src/update/desktop/bootstrap/releases.json"
    ))
    .map_err(|_| OtaError::Invalid)?;
    let Some(release) = releases
        .into_iter()
        .find(|entry| entry.sha256 == sha256 && entry.arch == arch)
    else {
        return Ok(LegacyReleaseInspection {
            supported: false,
            reason: "unknown-release",
            version: None,
        });
    };
    // Recognition is not migration authorization; none of these old baselines excludes self-update.
    if release.admission_exclusion {
        return Err(OtaError::Invalid);
    }
    let source = semver::Version::parse(&release.version).map_err(|_| OtaError::Invalid)?;
    Ok(LegacyReleaseInspection {
        supported: false,
        reason: if destination < source {
            "destination-older"
        } else {
            "legacy-update-bypasses-reservation"
        },
        version: Some(release.version),
    })
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyExecutable {
    pub device: String,
    pub inode: String,
    pub size: u64,
    pub modified_ns: String,
    pub changed_ns: String,
    pub sha256: String,
    pub cdhash: String,
}

#[cfg(target_os = "macos")]
pub fn inspect_legacy_executable(
    path: &Path,
    process: &ProcessIdentity,
) -> Result<LegacyExecutable, OtaError> {
    use core_foundation::url::CFURL;
    use security_framework::os::macos::code_signing::{
        Flags, GuestAttributes, SecCode, SecRequirement, SecStaticCode,
    };
    use std::os::unix::fs::MetadataExt;
    let canonical = path.canonicalize().map_err(|_| OtaError::Identity)?;
    if canonical != path {
        return Err(OtaError::Identity);
    }
    let before = super::native::process_details(process.pid)
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    if before.identity != *process
        || before.uid != unsafe { libc::geteuid() }
        || before.executable != canonical
    {
        return Err(OtaError::Identity);
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| OtaError::Identity)?;
    if !metadata.is_file()
        || metadata.uid() != before.uid
        || metadata.mode() & 0o7022 != 0
        || metadata.mode() & 0o111 == 0
        || metadata.nlink() != 1
    {
        return Err(OtaError::Identity);
    }
    let bytes = super::platform_fs::read_owned_file(path, 512 * 1024 * 1024)?;
    let url = CFURL::from_path(path, false).ok_or(OtaError::Identity)?;
    let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| OtaError::Identity)?;
    let valid: SecRequirement = "always".parse().map_err(|_| OtaError::Identity)?;
    code.check_validity(
        Flags::STRICT_VALIDATE | Flags::CHECK_ALL_ARCHITECTURES,
        &valid,
    )
    .map_err(|_| OtaError::Identity)?;
    let cdhash = signing_cdhash(&code)?;
    let requirement: SecRequirement = format!("cdhash H\"{cdhash}\"")
        .parse()
        .map_err(|_| OtaError::Identity)?;
    let mut attributes = GuestAttributes::new();
    attributes.set_pid(i32::try_from(process.pid).map_err(|_| OtaError::Identity)?);
    let guest = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
        .map_err(|_| OtaError::Identity)?;
    guest
        .check_validity(Flags::NONE, &requirement)
        .map_err(|_| OtaError::Identity)?;
    let after = super::native::process_details(process.pid)
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    let checked = std::fs::symlink_metadata(path).map_err(|_| OtaError::Identity)?;
    if after != before
        || metadata.dev() != checked.dev()
        || metadata.ino() != checked.ino()
        || metadata.size() != checked.size()
        || metadata.mode() != checked.mode()
        || metadata.mtime() != checked.mtime()
        || metadata.mtime_nsec() != checked.mtime_nsec()
        || metadata.ctime() != checked.ctime()
        || metadata.ctime_nsec() != checked.ctime_nsec()
    {
        return Err(OtaError::Identity);
    }
    let timestamp = |seconds: i64, nanos: i64| -> Result<String, OtaError> {
        let value = i128::from(seconds) * 1_000_000_000 + i128::from(nanos);
        if value < 0 {
            return Err(OtaError::Identity);
        }
        Ok(value.to_string())
    };
    Ok(LegacyExecutable {
        device: metadata.dev().to_string(),
        inode: metadata.ino().to_string(),
        size: metadata.size(),
        modified_ns: timestamp(metadata.mtime(), metadata.mtime_nsec())?,
        changed_ns: timestamp(metadata.ctime(), metadata.ctime_nsec())?,
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        cdhash,
    })
}

#[cfg(target_os = "macos")]
fn signing_cdhash(
    code: &security_framework::os::macos::code_signing::SecStaticCode,
) -> Result<String, OtaError> {
    use core_foundation::{
        base::{CFType, CFTypeRef, TCFType},
        data::CFData,
        dictionary::{CFDictionary, CFDictionaryRef},
        string::{CFString, CFStringRef},
    };
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecCodeCopySigningInformation(
            code: CFTypeRef,
            flags: u32,
            information: *mut CFDictionaryRef,
        ) -> i32;
        static kSecCodeInfoUnique: CFStringRef;
    }
    let mut raw = std::ptr::null();
    // kSecCSSigningInformation=1<<1, SDK SecCode.h. Called only after static validity succeeds.
    if unsafe { SecCodeCopySigningInformation(code.as_CFTypeRef(), 2, &mut raw) } != 0
        || raw.is_null()
    {
        return Err(OtaError::Identity);
    }
    let information: CFDictionary<CFString, CFType> =
        unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let key = unsafe { CFString::wrap_under_get_rule(kSecCodeInfoUnique) };
    let value = information.find(&key).ok_or(OtaError::Identity)?;
    let hash = value.downcast::<CFData>().ok_or(OtaError::Identity)?;
    if hash.len() != 20 {
        return Err(OtaError::Identity);
    }
    Ok(hash
        .bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

#[cfg(not(target_os = "macos"))]
pub fn inspect_legacy_executable(
    _path: &Path,
    _process: &ProcessIdentity,
) -> Result<LegacyExecutable, OtaError> {
    Err(OtaError::Unavailable)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyProcess {
    pub pid: u32,
    pub boot_id: String,
    pub birth: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacyRegistration {
    pub label: String,
    pub home: String,
    pub pacer_home: String,
    pub port: u16,
    pub sha256: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LegacySourceEvidence {
    pub schema: u32,
    pub uid: u32,
    pub process: LegacyProcess,
    pub executable: String,
    pub file: LegacyExecutable,
    pub registration: LegacyRegistration,
}
impl LegacySourceEvidence {
    pub fn fingerprint(&self) -> Result<String, OtaError> {
        let path = |value: &str| {
            Path::new(value).is_absolute()
                && value.len() <= 4096
                && !value.bytes().any(|byte| byte < 32 || byte == 127)
                && !value.split('/').any(|part| part == "." || part == "..")
        };
        let hex = |value: &str, length: usize| {
            value.len() == length
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        let decimal = |value: &str| {
            value == "0"
                || (!value.starts_with('0')
                    && !value.is_empty()
                    && value.bytes().all(|byte| byte.is_ascii_digit()))
        };
        if self.schema != 1
            || self.process.pid == 0
            || self.process.pid > i32::MAX as u32
            || self.process.boot_id.is_empty()
            || self.process.boot_id.len() > 128
            || self.process.birth.is_empty()
            || self.process.birth.len() > 128
            || !path(&self.executable)
            || !path(&self.registration.home)
            || !path(&self.registration.pacer_home)
            || self.registration.port == 0
            || self.registration.label.is_empty()
            || self.registration.label.len() > 128
            || !self.registration.label.as_bytes()[0].is_ascii_alphanumeric()
            || !self
                .registration
                .label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            || !hex(&self.file.sha256, 64)
            || !hex(&self.file.cdhash, 40)
            || !hex(&self.registration.sha256, 64)
            || !decimal(&self.file.device)
            || !decimal(&self.file.inode)
            || !decimal(&self.file.modified_ns)
            || !decimal(&self.file.changed_ns)
            || self.file.size > 512 * 1024 * 1024
        {
            return Err(OtaError::Invalid);
        }
        let mut hash = Sha256::new();
        hash.update(b"pacer-legacy-source-v1\n");
        hash.update(serde_json::to_vec(self).map_err(|_| OtaError::Invalid)?);
        Ok(format!("{:x}", hash.finalize()))
    }
}

/// Native collection is read-only. Even a recognized digest can remain ineligible.
pub fn inspect_legacy_source(
    user_home: &Path,
    home: &Path,
    port: u16,
    trust: &super::trust::ReleaseTrust,
) -> Result<LegacySourceEvidence, OtaError> {
    let observed = super::control::observe_service_registration(user_home, home, port, trust)?;
    let file = inspect_legacy_executable(&observed.executable, &observed.process)?;
    let checked = super::control::observe_service_registration(user_home, home, port, trust)?;
    if observed != checked
        || inspect_legacy_executable(&checked.executable, &checked.process)? != file
    {
        return Err(OtaError::Identity);
    }
    let evidence = LegacySourceEvidence {
        schema: 1,
        uid: unsafe { libc::geteuid() },
        process: LegacyProcess {
            pid: observed.process.pid,
            boot_id: observed.process.boot_id,
            birth: observed.process.birth,
        },
        executable: observed
            .executable
            .to_str()
            .ok_or(OtaError::Identity)?
            .to_owned(),
        file,
        registration: LegacyRegistration {
            label: observed.label,
            home: user_home
                .canonicalize()
                .map_err(|_| OtaError::Identity)?
                .to_str()
                .ok_or(OtaError::Identity)?
                .to_owned(),
            pacer_home: observed.home.to_str().ok_or(OtaError::Identity)?.to_owned(),
            port: observed.port,
            sha256: format!("{:x}", Sha256::digest(&observed.registration)),
        },
    };
    evidence.fingerprint()?;
    Ok(evidence)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ota::{native, wire::Arch};

    #[test]
    fn recognized_legacy_code_without_exclusion_never_grants_migration() {
        let result = inspect_legacy_release(
            "f37bb3f6c2dd804e69c0651bda6fd4846ab92b00623b4dc95d75e89e64bbb340",
            Arch::Aarch64,
            "0.8.0",
        )
        .unwrap();
        assert!(!result.supported);
        assert_eq!(result.reason, "legacy-update-bypasses-reservation");
        assert_eq!(result.version.as_deref(), Some("0.7.1"));
        assert_eq!(
            inspect_legacy_release(
                "f37bb3f6c2dd804e69c0651bda6fd4846ab92b00623b4dc95d75e89e64bbb340",
                Arch::X86_64,
                "0.8.0"
            )
            .unwrap()
            .reason,
            "unknown-release"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn executable_digest_is_bound_to_current_running_code_and_incarnation() {
        let own = native::process_details(std::process::id())
            .unwrap()
            .unwrap();
        let result = inspect_legacy_executable(&own.executable, &own.identity).unwrap();
        assert_eq!(result.sha256.len(), 64);
        assert_eq!(result.cdhash.len(), 40);
        let mut wrong = own.identity.clone();
        wrong.birth.push('x');
        assert!(inspect_legacy_executable(&own.executable, &wrong).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn same_path_replacement_and_writable_or_redirected_source_are_rejected() {
        use std::{
            os::unix::fs::{symlink, PermissionsExt},
            process::{Command, Stdio},
            time::Duration,
        };
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let directory = tempfile::tempdir().unwrap();
        let directory = directory.path().canonicalize().unwrap();
        let path = directory.join("pacer");
        // Thin ad-hoc code, matching the supported standalone release shape.
        std::fs::copy(std::env::current_exe().unwrap(), &path).unwrap();
        let child = Child(
            Command::new(&path)
                .args([
                    "--exact",
                    "ota::bootstrap_identity::tests::legacy_process_fixture",
                ])
                .env("PACER_TEST_BOOTSTRAP_CHILD", "1")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        std::thread::sleep(Duration::from_millis(50));
        let process = native::process_details(child.0.id()).unwrap().unwrap();
        inspect_legacy_executable(&path, &process.identity).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(inspect_legacy_executable(&path, &process.identity).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let redirect = directory.join("redirect");
        symlink(&path, &redirect).unwrap();
        assert!(inspect_legacy_executable(&redirect, &process.identity).is_err());
        let replacement = directory.join("replacement");
        std::fs::copy("/usr/bin/true", &replacement).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(inspect_legacy_executable(&path, &process.identity).is_err());
    }
    #[test]
    fn evidence_fingerprint_matches_typescript_and_rejects_unknown_authority_fields() {
        let text = include_str!("../../../../test/fixtures/desktop-update/bootstrap-source.json");
        let evidence: LegacySourceEvidence = serde_json::from_str(text).unwrap();
        assert_eq!(
            evidence.fingerprint().unwrap(),
            "24f49ae83c5fd74355f48281f104cd8d3d5c6cc61b97eaada027ed16c8d5a9b7"
        );
        let mut value: serde_json::Value = serde_json::from_str(text).unwrap();
        value["allowUnsigned"] = serde_json::json!(true);
        assert!(serde_json::from_value::<LegacySourceEvidence>(value).is_err());
        let mut changed = evidence.clone();
        changed.file.cdhash = "c".repeat(40);
        assert_ne!(
            evidence.fingerprint().unwrap(),
            changed.fingerprint().unwrap()
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn legacy_process_fixture() {
        if std::env::var_os("PACER_TEST_BOOTSTRAP_CHILD").as_deref()
            == Some(std::ffi::OsStr::new("1"))
        {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }
}
