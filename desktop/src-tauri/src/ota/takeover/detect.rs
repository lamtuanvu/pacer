use crate::ota::bootstrap_identity::LegacyExecutable;
use crate::ota::trust::ReleaseTrust;
use crate::ota::{OtaError, ProcessIdentity};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsentRecord {
    pub at: String,
    pub path: bool,
    pub keep: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TakeoverCandidate {
    pub label: String,
    pub registration_sha256: String,
    pub process: ProcessIdentity,
    pub program: PathBuf,
    pub canonical_program: PathBuf,
    pub identity: LegacyExecutable,
    pub home: PathBuf,
    pub port: u16,
}

pub fn read_consent(config_dir: &Path) -> Result<Option<ConsentRecord>, OtaError> {
    let file = config_dir.join("consent.json");
    let metadata = match std::fs::symlink_metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(OtaError::Io),
    };
    if !metadata.is_file() || metadata.len() > 1_048_576 {
        return Err(OtaError::Invalid);
    }
    let bytes = std::fs::read(file).map_err(|_| OtaError::Io)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| OtaError::Invalid)
}

/// Native observations detection needs: launchd, the running process and code
/// signatures. Kept apart so the whole detection path is testable over real
/// consent files and program paths.
pub(crate) trait TakeoverSources {
    fn observe(&self) -> Result<crate::ota::control::ObservedServiceRegistration, OtaError>;
    /// Whether the registered service verifies as a release CLI.
    fn signed(&self) -> Result<(), OtaError>;
    fn identity(&self, program: &Path, process: &ProcessIdentity) -> Result<LegacyExecutable, OtaError>;
}

struct NativeSources<'a> {
    user_home: &'a Path,
    home: &'a Path,
    port: u16,
    trust: &'a ReleaseTrust,
}
impl TakeoverSources for NativeSources<'_> {
    fn observe(&self) -> Result<crate::ota::control::ObservedServiceRegistration, OtaError> {
        crate::ota::control::observe_service_registration(self.user_home, self.home, self.port, self.trust)
    }
    fn signed(&self) -> Result<(), OtaError> {
        crate::ota::control::inspect_registered_service(self.user_home, self.home, self.port, self.trust).map(|_| ())
    }
    fn identity(&self, program: &Path, process: &ProcessIdentity) -> Result<LegacyExecutable, OtaError> {
        crate::ota::bootstrap_identity::inspect_legacy_executable(program, process)
    }
}

pub fn detect_takeover(
    config_dir: &Path,
    user_home: &Path,
    home: &Path,
    port: u16,
    bundled_cli: &Path,
    trust: &ReleaseTrust,
) -> Result<Option<TakeoverCandidate>, OtaError> {
    detect_with(config_dir, user_home, port, bundled_cli, &NativeSources { user_home, home, port, trust })
}

/// Offers a takeover only when every predicate holds; any other failure keeps
/// today's behavior. `Io` is reported so the caller can retry later.
pub(crate) fn detect_with(
    config_dir: &Path,
    user_home: &Path,
    port: u16,
    bundled_cli: &Path,
    sources: &dyn TakeoverSources,
) -> Result<Option<TakeoverCandidate>, OtaError> {
    let consent = match read_consent(config_dir) {
        Ok(value) => value,
        Err(OtaError::Io) => return Err(OtaError::Io),
        Err(_) => return Ok(None),
    };
    if !consent.as_ref().is_some_and(|c| !c.keep) {
        return Ok(None);
    }
    let observed = match sources.observe() {
        Ok(value) => value,
        Err(OtaError::Io) => return Err(OtaError::Io),
        Err(_) => return Ok(None),
    };
    let Ok(user_home) = user_home.canonicalize() else { return Ok(None) };
    let argv = match crate::ota::control::parse_registration(
        &observed.registration,
        &user_home,
        &observed.home,
        port,
        &observed.label,
    ) {
        Ok(argv) => argv,
        Err(_) => return Ok(None),
    };
    let program = PathBuf::from(&argv[0]);
    let canonical_program = match program.canonicalize() {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    // The transaction pins the registered path itself, so a symlinked program
    // (including the app's own terminal link) is never offered.
    if canonical_program != program {
        return Ok(None);
    }
    let bundled = match bundled_cli.canonicalize() {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if canonical_program == bundled {
        return Ok(None);
    }
    match sources.signed() {
        Err(OtaError::Identity) => {}
        Err(OtaError::Io) => return Err(OtaError::Io),
        _ => return Ok(None),
    }
    let identity = match sources.identity(&canonical_program, &observed.process) {
        Ok(value) => value,
        Err(OtaError::Io) => return Err(OtaError::Io),
        Err(_) => return Ok(None),
    };
    Ok(Some(TakeoverCandidate {
        label: observed.label,
        registration_sha256: format!("{:x}", sha2::Sha256::digest(&observed.registration)),
        process: observed.process,
        program,
        canonical_program,
        identity,
        home: observed.home,
        port,
    }))
}

/// Whether a cached inspection still describes the running service: the same
/// registration bytes, loaded PID incarnation and program file. This costs a
/// plist read and a stat, unlike a full detection, which hashes and verifies
/// the whole executable.
pub fn still_current(cached: &TakeoverCandidate, observed: &crate::ota::control::ObservedServiceRegistration) -> bool {
    use std::os::unix::fs::MetadataExt;
    let Ok(metadata) = std::fs::symlink_metadata(&cached.canonical_program) else { return false };
    let nanos = |seconds: i64, nanos: i64| (i128::from(seconds) * 1_000_000_000 + i128::from(nanos)).to_string();
    format!("{:x}", sha2::Sha256::digest(&observed.registration)) == cached.registration_sha256
        && observed.process == cached.process
        && observed.label == cached.label
        && observed.home == cached.home
        && observed.executable == cached.canonical_program
        && metadata.is_file()
        && metadata.dev().to_string() == cached.identity.device
        && metadata.ino().to_string() == cached.identity.inode
        && metadata.size() == cached.identity.size
        && nanos(metadata.mtime(), metadata.mtime_nsec()) == cached.identity.modified_ns
        && nanos(metadata.ctime(), metadata.ctime_nsec()) == cached.identity.changed_ns
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ota::control::ObservedServiceRegistration;

    #[test]
    fn a_cached_inspection_is_reused_only_while_nothing_changed() {
        use std::os::unix::fs::MetadataExt;
        let f = fixture();
        let sources = running(&f, &f.program);
        let metadata = std::fs::symlink_metadata(&f.program).unwrap();
        let mut candidate = detect(&f, &sources).unwrap().unwrap();
        candidate.identity = LegacyExecutable {
            device: metadata.dev().to_string(),
            inode: metadata.ino().to_string(),
            size: metadata.size(),
            modified_ns: (i128::from(metadata.mtime()) * 1_000_000_000 + i128::from(metadata.mtime_nsec())).to_string(),
            changed_ns: (i128::from(metadata.ctime()) * 1_000_000_000 + i128::from(metadata.ctime_nsec())).to_string(),
            ..identity()
        };
        let observed = sources.observed.clone().unwrap();
        assert!(still_current(&candidate, &observed));
        let mut restarted = observed.clone();
        restarted.process.birth.push('2');
        assert!(!still_current(&candidate, &restarted));
        let mut edited = observed.clone();
        edited.registration.push(b' ');
        assert!(!still_current(&candidate, &edited));
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(&f.program, b"another build").unwrap();
        assert!(!still_current(&candidate, &observed));
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        config: PathBuf,
        bundled: PathBuf,
        program: PathBuf,
        home: PathBuf,
    }
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let config = root.join("config");
        let home = root.join(".pacer");
        let bundled = root.join("pacer.app/Contents/Resources/pacer");
        let program = root.join(".local/bin/pacer");
        for path in [&config, &home, &bundled.parent().unwrap().to_path_buf(), &program.parent().unwrap().to_path_buf()] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(&bundled, b"bundled").unwrap();
        std::fs::write(&program, b"other build").unwrap();
        std::fs::write(config.join("consent.json"), r#"{"at":"today","keep":false,"path":false}"#).unwrap();
        Fixture { _dir: dir, root, config, bundled, program, home }
    }
    fn registration(f: &Fixture, program: &Path) -> Vec<u8> {
        let mut bytes = Vec::new();
        plist::Value::Dictionary(plist::Dictionary::from_iter([
            ("Label".to_string(), plist::Value::String("com.pacer.serve".into())),
            ("ProgramArguments".to_string(), plist::Value::Array(vec![
                plist::Value::String(program.to_string_lossy().into_owned()),
                plist::Value::String("serve".into()),
            ])),
            ("EnvironmentVariables".to_string(), plist::Value::Dictionary(plist::Dictionary::from_iter([
                ("HOME".to_string(), plist::Value::String(f.root.to_string_lossy().into_owned())),
                ("PACER_HOME".to_string(), plist::Value::String(f.home.to_string_lossy().into_owned())),
            ]))),
        ])).to_writer_xml(&mut bytes).unwrap();
        bytes
    }
    fn identity() -> LegacyExecutable {
        LegacyExecutable { device: "1".into(), inode: "1".into(), size: 1, modified_ns: "1".into(), changed_ns: "1".into(), sha256: "a".repeat(64), cdhash: "b".repeat(40) }
    }
    struct Fake {
        observed: Result<ObservedServiceRegistration, OtaError>,
        signed: Result<(), OtaError>,
        identity: Result<LegacyExecutable, OtaError>,
    }
    impl TakeoverSources for Fake {
        fn observe(&self) -> Result<ObservedServiceRegistration, OtaError> { self.observed.clone() }
        fn signed(&self) -> Result<(), OtaError> { self.signed }
        fn identity(&self, _: &Path, _: &ProcessIdentity) -> Result<LegacyExecutable, OtaError> { self.identity.clone() }
    }
    fn running(f: &Fixture, program: &Path) -> Fake {
        Fake {
            observed: Ok(ObservedServiceRegistration {
                home: f.home.clone(),
                port: 4317,
                process: ProcessIdentity { pid: 7, boot_id: "boot".into(), birth: "birth".into() },
                executable: program.canonicalize().unwrap_or_else(|_| program.to_owned()),
                registration: registration(f, program),
                label: "com.pacer.serve".into(),
            }),
            signed: Err(OtaError::Identity),
            identity: Ok(identity()),
        }
    }
    fn detect(f: &Fixture, sources: &Fake) -> Result<Option<TakeoverCandidate>, OtaError> {
        detect_with(&f.config, &f.root, 4317, &f.bundled, sources)
    }

    #[test]
    fn a_copied_build_in_the_apps_consented_setup_is_offered() {
        let f = fixture();
        let candidate = detect(&f, &running(&f, &f.program)).unwrap().unwrap();
        assert_eq!(candidate.program, f.program);
        assert_eq!(candidate.canonical_program, f.program);
        assert_eq!(candidate.identity, identity());
        assert_eq!(candidate.home, f.home);
        assert_eq!(candidate.registration_sha256, format!("{:x}", sha2::Sha256::digest(registration(&f, &f.program))));
    }

    #[test]
    fn the_apps_own_link_and_other_symlinks_are_not_offered() {
        let f = fixture();
        let link = f.root.join(".local/bin/pacer-link");
        std::os::unix::fs::symlink(&f.bundled, &link).unwrap();
        assert_eq!(detect(&f, &running(&f, &link)), Ok(None));
        let elsewhere = f.root.join(".local/bin/pacer-elsewhere");
        std::os::unix::fs::symlink(&f.program, &elsewhere).unwrap();
        assert_eq!(detect(&f, &running(&f, &elsewhere)), Ok(None));
        // The bundled CLI registered directly is the app's own service.
        assert_eq!(detect(&f, &running(&f, &f.bundled)), Ok(None));
    }

    #[test]
    fn consent_that_is_missing_kept_or_malformed_is_not_offered() {
        let f = fixture();
        let consent = f.config.join("consent.json");
        for bad in [
            r#"{"at":"today","keep":true,"path":false}"#,
            "{",
            r#"{"at":"today","keep":false,"path":false,"extra":1}"#,
        ] {
            std::fs::write(&consent, bad).unwrap();
            assert_eq!(detect(&f, &running(&f, &f.program)), Ok(None), "{bad}");
        }
        std::fs::remove_file(&consent).unwrap();
        assert_eq!(detect(&f, &running(&f, &f.program)), Ok(None));
        std::os::unix::fs::symlink(f.root.join("elsewhere.json"), &consent).unwrap();
        assert_eq!(detect(&f, &running(&f, &f.program)), Ok(None));
    }

    #[test]
    fn registration_identity_and_signature_failures_are_not_offered() {
        let f = fixture();
        for error in [OtaError::Identity, OtaError::Invalid, OtaError::Unavailable] {
            let sources = Fake { observed: Err(error), ..running(&f, &f.program) };
            assert_eq!(detect(&f, &sources), Ok(None));
        }
        // A verified release service, or one that cannot be checked, is not a takeover.
        for signed in [Ok(()), Err(OtaError::Unavailable), Err(OtaError::Invalid)] {
            assert_eq!(detect(&f, &Fake { signed, ..running(&f, &f.program) }), Ok(None));
        }
        // An executable whose identity cannot be pinned (for example multiply linked).
        assert_eq!(detect(&f, &Fake { identity: Err(OtaError::Identity), ..running(&f, &f.program) }), Ok(None));
        // A foreign data home or an extra plist key fails registration parsing.
        let mut foreign = running(&f, &f.program);
        if let Ok(observed) = &mut foreign.observed { observed.home = f.root.join("other"); }
        assert_eq!(detect(&f, &foreign), Ok(None));
        let mut extra = running(&f, &f.program);
        if let Ok(observed) = &mut extra.observed {
            let text = String::from_utf8(observed.registration.clone()).unwrap()
                .replace("<key>Label</key>", "<key>Sockets</key><string>x</string><key>Label</key>");
            observed.registration = text.into_bytes();
        }
        assert_eq!(detect(&f, &extra), Ok(None));
        // A missing program is not offered; I/O failures are reported for a retry.
        assert_eq!(detect(&f, &running(&f, &f.root.join("missing"))), Ok(None));
        assert_eq!(detect(&f, &Fake { observed: Err(OtaError::Io), ..running(&f, &f.program) }), Err(OtaError::Io));
        assert_eq!(detect(&f, &Fake { signed: Err(OtaError::Io), ..running(&f, &f.program) }), Err(OtaError::Io));
    }

    #[test]
    fn consent_is_strict() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_consent(dir.path()), Ok(None));
        let file = dir.path().join("consent.json");
        std::fs::write(&file, r#"{"at":"today","keep":false,"path":false}"#).unwrap();
        assert_eq!(read_consent(dir.path()).unwrap().unwrap().keep, false);
        for bad in [
            "{",
            r#"{"at":"today","keep":false,"path":false,"extra":1}"#,
            r#"{"at":"today","keep":"false","path":false}"#,
        ] {
            std::fs::write(&file, bad).unwrap();
            assert_eq!(read_consent(dir.path()), Err(OtaError::Invalid));
        }
    }
}
