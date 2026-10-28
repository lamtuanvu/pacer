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

fn takeover_decision(
    consent: Option<&ConsentRecord>,
    observed: Result<&crate::ota::control::ObservedServiceRegistration, OtaError>,
    program_is_bundled: bool,
    signed: Result<(), OtaError>,
    identity: Result<&LegacyExecutable, OtaError>,
) -> bool {
    consent.is_some_and(|c| !c.keep)
        && observed.is_ok()
        && !program_is_bundled
        && signed == Err(OtaError::Identity)
        && identity.is_ok()
}

pub fn detect_takeover(
    config_dir: &Path,
    user_home: &Path,
    home: &Path,
    port: u16,
    bundled_cli: &Path,
    trust: &ReleaseTrust,
) -> Result<Option<TakeoverCandidate>, OtaError> {
    let consent = match read_consent(config_dir) {
        Ok(value) => value,
        Err(OtaError::Io) => return Err(OtaError::Io),
        Err(_) => return Ok(None),
    };
    if !consent.as_ref().is_some_and(|c| !c.keep) {
        return Ok(None);
    }
    let observed =
        match crate::ota::control::observe_service_registration(user_home, home, port, trust) {
            Ok(value) => value,
            Err(OtaError::Io) => return Err(OtaError::Io),
            Err(_) => return Ok(None),
        };
    let argv = crate::ota::control::parse_registration(
        &observed.registration,
        user_home,
        &observed.home,
        port,
        &observed.label,
    )?;
    let program = PathBuf::from(&argv[0]);
    let canonical_program = match program.canonicalize() {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    let bundled = match bundled_cli.canonicalize() {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if canonical_program == bundled {
        return Ok(None);
    }
    let signed =
        crate::ota::control::inspect_registered_service(user_home, home, port, trust).map(|_| ());
    if signed == Err(OtaError::Io) {
        return Err(OtaError::Io);
    }
    if signed != Err(OtaError::Identity) {
        return Ok(None);
    }
    let identity = match crate::ota::bootstrap_identity::inspect_legacy_executable(
        &canonical_program,
        &observed.process,
    ) {
        Ok(value) => value,
        Err(OtaError::Io) => return Err(OtaError::Io),
        Err(_) => return Ok(None),
    };
    if !takeover_decision(
        consent.as_ref(),
        Ok(&observed),
        false,
        signed,
        Ok(&identity),
    ) {
        return Ok(None);
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn takeover_requires_every_predicate() {
        let consent = ConsentRecord {
            at: "today".into(),
            path: false,
            keep: false,
        };
        let keep = ConsentRecord {
            keep: true,
            ..consent.clone()
        };
        let observed = crate::ota::control::ObservedServiceRegistration {
            home: "/tmp/pacer".into(),
            port: 4317,
            process: ProcessIdentity {
                pid: 1,
                boot_id: "boot".into(),
                birth: "birth".into(),
            },
            executable: "/tmp/other".into(),
            registration: vec![],
            label: "com.pacer.serve".into(),
        };
        let identity = LegacyExecutable {
            device: "1".into(),
            inode: "1".into(),
            size: 1,
            modified_ns: "1".into(),
            changed_ns: "1".into(),
            sha256: "a".repeat(64),
            cdhash: "b".repeat(40),
        };
        assert!(takeover_decision(
            Some(&consent),
            Ok(&observed),
            false,
            Err(OtaError::Identity),
            Ok(&identity)
        ));
        assert!(!takeover_decision(
            None,
            Ok(&observed),
            false,
            Err(OtaError::Identity),
            Ok(&identity)
        ));
        assert!(!takeover_decision(
            Some(&keep),
            Ok(&observed),
            false,
            Err(OtaError::Identity),
            Ok(&identity)
        ));
        for error in [OtaError::Identity, OtaError::Invalid, OtaError::Unavailable] {
            assert!(!takeover_decision(
                Some(&consent),
                Err(error),
                false,
                Err(OtaError::Identity),
                Ok(&identity)
            ));
        }
        assert!(!takeover_decision(
            Some(&consent),
            Ok(&observed),
            true,
            Err(OtaError::Identity),
            Ok(&identity)
        ));
        assert!(!takeover_decision(
            Some(&consent),
            Ok(&observed),
            false,
            Ok(()),
            Ok(&identity)
        ));
        assert!(!takeover_decision(
            Some(&consent),
            Ok(&observed),
            false,
            Err(OtaError::Unavailable),
            Ok(&identity)
        ));
        assert!(!takeover_decision(
            Some(&consent),
            Ok(&observed),
            false,
            Err(OtaError::Identity),
            Err(OtaError::Identity)
        ));
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
