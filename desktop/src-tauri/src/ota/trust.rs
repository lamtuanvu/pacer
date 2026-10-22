//! Compile-time updater trust. Public requests and runtime environment cannot change it.
#[path = "trust_config.rs"]
mod trust_config;
use super::native::{ProcessDetails, ProcessIdentity};
use super::OtaError;
use std::path::Path;

#[cfg(all(test, target_os = "macos"))]
thread_local! {
    // Diagnostic-only: set only by the synchronous owned-child trust test.
    static TRUST_TEST_SPAWN_STARTED: std::cell::Cell<Option<std::time::Instant>> = const { std::cell::Cell::new(None) };
}

pub const APP_ID: &str = "dev.pacer.desktop";
pub const CLI_ID: &str = "dev.pacer.cli";
pub const NATIVE_SHIM_ID: &str = "dev.pacer.desktop.native-shim";
pub const HELPER_ID: &str = "dev.pacer.desktop.update-helper";
pub const STABLE_FEED: &str =
    "https://raw.githubusercontent.com/lamtuanvu/pacer/desktop-updates/stable.json";
/// Public build diagnostics, also checked before a staged bundle is production-signed.
pub fn build_identity() -> serde_json::Value {
    use sha2::{Digest, Sha256};
    // Diagnostics describe compiled inputs even while a fixture is still being
    // built. They confer no authority; configured() separately checks its live lease.
    let enabled = cfg!(any(feature = "ota-production", feature = "ota-fixture"));
    let key = enabled
        .then_some(option_env!("PACER_OTA_PUBLIC_KEY"))
        .flatten();
    let team = if cfg!(feature = "ota-production") {
        option_env!("PACER_APPLE_TEAM_ID").filter(|v| !v.is_empty())
    } else if cfg!(feature = "ota-fixture") {
        Some("FIXTURE000")
    } else {
        None
    };
    let cert = cfg!(feature = "ota-production")
        .then_some(option_env!("PACER_SIGNING_CERT_SHA1").filter(|v| !v.is_empty()))
        .flatten();
    let signer = cfg!(feature = "ota-production")
        .then(|| signer_kind(team, cert))
        .flatten();
    serde_json::json!({
        "fixture":cfg!(feature="ota-fixture"),
        "otaMode":if cfg!(feature="ota-production") {"production"} else if cfg!(feature="ota-fixture") {"fixture"} else {"disabled"},
        "appleTeamId":team,
        "signingCertSha1":cert,
        "signer":signer,
        "updaterKeySha256":key.map(|key|format!("{:x}",Sha256::digest(key.as_bytes()))),
        "fixturePolicySha256":if cfg!(feature="ota-fixture") { option_env!("PACER_OTA_FIXTURE_POLICY").map(|policy|format!("{:x}",Sha256::digest(policy.as_bytes()))) } else { None },
    })
}
/// Fixture trust is identifier-only, plus the lease's disposable certificate when it pins one.
fn fixture_requirement(identifier: &str, cert: Option<&str>) -> String {
    match cert {
        Some(cert) => format!("identifier \"{identifier}\" and certificate leaf = H\"{cert}\""),
        None => format!("identifier \"{identifier}\""),
    }
}
fn signer_kind(team: Option<&str>, cert: Option<&str>) -> Option<&'static str> {
    match (team, cert) {
        (Some(_), Some(_)) => Some("both"),
        (Some(_), None) => Some("apple"),
        (None, Some(_)) => Some("self"),
        (None, None) => None,
    }
}
#[derive(Clone, Copy, Debug)]
pub enum CodeRole {
    Desktop,
    Cli,
    Helper,
}
impl CodeRole {
    pub fn identifier(self) -> &'static str {
        match self {
            Self::Desktop => APP_ID,
            Self::Cli => CLI_ID,
            Self::Helper => HELPER_ID,
        }
    }
}
#[derive(Clone, Debug)]
pub struct ReleaseTrust {
    public_key: String,
    team_id: Option<String>,
    cert_sha1: Option<String>,
    fixture: Option<super::fixture_policy::FixturePolicy>,
}
#[derive(Clone, Debug)]
pub struct VerifiedProcess {
    details: ProcessDetails,
}
impl VerifiedProcess {
    pub fn details(&self) -> &ProcessDetails {
        &self.details
    }
}

impl ReleaseTrust {
    pub fn configured() -> Option<Self> {
        #[cfg(feature = "ota-production")]
        {
            Self::from_production(
                env!("PACER_OTA_PUBLIC_KEY"),
                option_env!("PACER_APPLE_TEAM_ID").filter(|v| !v.is_empty()),
                option_env!("PACER_SIGNING_CERT_SHA1").filter(|v| !v.is_empty()),
            )
            .ok()
        }
        #[cfg(all(feature = "ota-fixture", not(feature = "ota-production")))]
        {
            Self::from_fixture(
                env!("PACER_OTA_PUBLIC_KEY"),
                env!("PACER_OTA_FIXTURE_POLICY"),
            )
            .ok()
        }
        #[cfg(not(any(feature = "ota-production", feature = "ota-fixture")))]
        {
            None
        }
    }
    pub(crate) fn from_production(
        public_key: &str,
        team_id: Option<&str>,
        cert_sha1: Option<&str>,
    ) -> Result<Self, OtaError> {
        trust_config::validate_key(public_key).map_err(|_| OtaError::Invalid)?;
        trust_config::validate_signers(team_id, cert_sha1).map_err(|_| OtaError::Invalid)?;
        Ok(Self {
            public_key: public_key.into(),
            team_id: team_id.map(Into::into),
            cert_sha1: cert_sha1.map(Into::into),
            fixture: None,
        })
    }
    #[cfg(any(test, feature = "ota-fixture"))]
    pub(crate) fn from_fixture(public_key: &str, policy: &str) -> Result<Self, OtaError> {
        trust_config::validate(public_key, "FIXTURE000").map_err(|_| OtaError::Invalid)?;
        let fixture =
            super::fixture_policy::FixturePolicy::parse(policy).map_err(|_| OtaError::Invalid)?;
        fixture.validate_live().map_err(|_| OtaError::Identity)?;
        Ok(Self {
            public_key: public_key.into(),
            team_id: None,
            cert_sha1: None,
            fixture: Some(fixture),
        })
    }
    pub fn fixture_policy(&self) -> Option<&super::fixture_policy::FixturePolicy> {
        self.fixture.as_ref()
    }
    pub fn public_key(&self) -> &str {
        &self.public_key
    }
    pub fn team_id(&self) -> Option<&str> {
        self.team_id.as_deref()
    }
    pub fn signer(&self) -> Option<&'static str> {
        signer_kind(self.team_id.as_deref(), self.cert_sha1.as_deref())
    }
    pub fn requirement(&self, role: CodeRole) -> String {
        self.static_requirement(role.identifier())
    }
    fn static_requirement(&self, identifier: &str) -> String {
        if let Some(fixture) = &self.fixture {
            return fixture_requirement(identifier, fixture.signing_cert_sha1.as_deref());
        }
        let apple = self.team_id.as_ref().map(|team| {
            format!("anchor apple generic and certificate leaf[subject.OU] = \"{team}\"")
        });
        let own = self
            .cert_sha1
            .as_ref()
            .map(|cert| format!("certificate leaf = H\"{cert}\""));
        match (apple, own) {
            // Unchanged Developer ID form; it is equivalent to the grouped form.
            (Some(_), None) => format!(
                "anchor apple generic and identifier \"{}\" and certificate leaf[subject.OU] = \"{}\"",
                identifier,
                self.team_id.as_deref().unwrap_or_default()
            ),
            (None, Some(own)) => format!("identifier \"{identifier}\" and {own}"),
            (Some(apple), Some(own)) => {
                format!("identifier \"{identifier}\" and (({apple}) or {own})")
            }
            // from_production requires a pin, so production trust never reaches this.
            (None, None) => format!("identifier \"{identifier}\" and never"),
        }
    }
    #[cfg(target_os = "macos")]
    pub fn verify_static(&self, path: &Path, role: CodeRole) -> Result<(), OtaError> {
        self.verify_static_identifier(path, role.identifier())
    }
    /// A library can satisfy static package trust but can never act as a native peer.
    pub fn verify_native_shim(&self, path: &Path) -> Result<(), OtaError> {
        self.verify_static_identifier(path, NATIVE_SHIM_ID)
    }
    #[cfg(target_os = "macos")]
    fn verify_static_identifier(&self, path: &Path, identifier: &str) -> Result<(), OtaError> {
        use core_foundation::url::CFURL;
        use security_framework::os::macos::code_signing::{Flags, SecRequirement, SecStaticCode};
        if self
            .fixture
            .as_ref()
            .is_some_and(|fixture| !fixture.permits_path(path))
        {
            return Err(OtaError::Identity);
        }
        let requirement: SecRequirement = self
            .static_requirement(identifier)
            .parse()
            .map_err(|_| OtaError::Identity)?;
        let url = CFURL::from_path(path, path.is_dir()).ok_or(OtaError::Identity)?;
        let code = SecStaticCode::from_path(&url, Flags::NONE).map_err(|_| OtaError::Identity)?;
        code.check_validity(
            Flags::STRICT_VALIDATE | Flags::CHECK_NESTED_CODE | Flags::CHECK_ALL_ARCHITECTURES,
            &requirement,
        )
        .map_err(|_| OtaError::Identity)
    }
    #[cfg(not(target_os = "macos"))]
    pub fn verify_static(&self, _path: &Path, _role: CodeRole) -> Result<(), OtaError> {
        Err(OtaError::Unavailable)
    }
    #[cfg(not(target_os = "macos"))]
    fn verify_static_identifier(&self, _path: &Path, _identifier: &str) -> Result<(), OtaError> {
        Err(OtaError::Unavailable)
    }
    pub fn verify_process(
        &self,
        expected: &ProcessIdentity,
        role: CodeRole,
    ) -> Result<VerifiedProcess, OtaError> {
        self.verify_process_inner(expected, role, None)
    }
    /// The token must come directly from LOCAL_PEERTOKEN on the connected socket.
    pub fn verify_peer(
        &self,
        expected: &ProcessIdentity,
        role: CodeRole,
        audit_token: &[u8; 32],
    ) -> Result<VerifiedProcess, OtaError> {
        self.verify_process_inner(expected, role, Some(audit_token))
    }
    #[cfg(target_os = "macos")]
    fn verify_process_inner(
        &self,
        expected: &ProcessIdentity,
        role: CodeRole,
        audit_token: Option<&[u8; 32]>,
    ) -> Result<VerifiedProcess, OtaError> {
        use core_foundation::{base::TCFType, data::CFData};
        use security_framework::os::macos::code_signing::{
            Flags, GuestAttributes, SecCode, SecRequirement,
        };
        let before = super::native::process_details(expected.pid)
            .map_err(|_error| {
                #[cfg(test)]
                eprintln!(
                    "trust-test dynamic before-process-details errno={:?} kind={:?}",
                    _error.raw_os_error(),
                    _error.kind()
                );
                OtaError::Identity
            })?
            .ok_or_else(|| {
                #[cfg(test)]
                eprintln!("trust-test dynamic before-process-absent");
                OtaError::Identity
            })?;
        if &before.identity != expected || before.uid != unsafe { libc::geteuid() } {
            #[cfg(test)]
            eprintln!("trust-test dynamic before-identity-or-uid");
            return Err(OtaError::Identity);
        }
        if self
            .fixture
            .as_ref()
            .is_some_and(|fixture| !fixture.permits_path(&before.executable))
        {
            #[cfg(test)]
            eprintln!("trust-test dynamic fixture-path");
            return Err(OtaError::Identity);
        }
        let requirement: SecRequirement = self
            .requirement(role)
            .parse::<SecRequirement>()
            .map_err(|_error| {
                #[cfg(test)]
                eprintln!("trust-test dynamic requirement osstatus={}", _error.code());
                OtaError::Identity
            })?;
        let mut attributes = GuestAttributes::new();
        attributes.set_pid(i32::try_from(expected.pid).map_err(|_| OtaError::Identity)?);
        let token = audit_token.map(|bytes| CFData::from_buffer(bytes));
        if let Some(token) = token.as_ref() {
            attributes.set_audit_token(token.as_concrete_TypeRef());
        }
        #[cfg(test)]
        let guest_started = std::time::Instant::now();
        #[cfg(test)]
        let spawn_to_guest_us = TRUST_TEST_SPAWN_STARTED.with(|start| {
            start
                .get()
                .map(|start| guest_started.duration_since(start).as_micros())
        });
        let code = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE).map_err(
            |_error| {
                #[cfg(test)]
                eprintln!("trust-test dynamic guest-lookup osstatus={} spawn_to_guest_us={spawn_to_guest_us:?} guest_us={}", _error.code(), guest_started.elapsed().as_micros());
                OtaError::Identity
            },
        )?;
        code.check_validity(Flags::NONE, &requirement)
            .map_err(|_error| {
                #[cfg(test)]
                eprintln!("trust-test dynamic validity osstatus={}", _error.code());
                OtaError::Identity
            })?;
        let after = super::native::process_details(expected.pid)
            .map_err(|_error| {
                #[cfg(test)]
                eprintln!(
                    "trust-test dynamic after-process-details errno={:?} kind={:?}",
                    _error.raw_os_error(),
                    _error.kind()
                );
                OtaError::Identity
            })?
            .ok_or_else(|| {
                #[cfg(test)]
                eprintln!("trust-test dynamic after-process-absent");
                OtaError::Identity
            })?;
        if before != after {
            #[cfg(test)]
            eprintln!("trust-test dynamic after-details-changed");
            return Err(OtaError::Identity);
        }
        Ok(VerifiedProcess { details: after })
    }
    #[cfg(not(target_os = "macos"))]
    fn verify_process_inner(
        &self,
        _expected: &ProcessIdentity,
        _role: CodeRole,
        _token: Option<&[u8; 32]>,
    ) -> Result<VerifiedProcess, OtaError> {
        Err(OtaError::Unavailable)
    }
}

#[cfg(all(test, target_os = "macos"))]
#[path = "trust_test_search.rs"]
mod test_search;

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    #[cfg(feature = "ota-production")]
    #[test]
    fn production_build_trust_matches_validated_optional_pins() {
        let expected_team = option_env!("PACER_APPLE_TEAM_ID").filter(|v| !v.is_empty());
        let expected_cert = option_env!("PACER_SIGNING_CERT_SHA1").filter(|v| !v.is_empty());
        let identity = build_identity();
        assert_eq!(identity["appleTeamId"], serde_json::json!(expected_team));
        assert_eq!(
            identity["signingCertSha1"],
            serde_json::json!(expected_cert)
        );
        let configured = ReleaseTrust::configured()
            .expect("validated production trust must be available at runtime");
        assert_eq!(
            configured.requirement(CodeRole::Cli),
            ReleaseTrust::from_production(
                env!("PACER_OTA_PUBLIC_KEY"),
                expected_team,
                expected_cert
            )
            .unwrap()
            .requirement(CodeRole::Cli)
        );
    }
    fn public_key() -> String {
        let mut packet = vec![0u8; 42];
        packet[..2].copy_from_slice(b"Ed");
        packet[10..].fill(7);
        STANDARD.encode(format!(
            "untrusted comment: disposable public key\n{}\n",
            STANDARD.encode(packet)
        ))
    }
    #[test]
    fn production_trust_requires_a_real_key_packet_and_exact_team_format() {
        let trust = ReleaseTrust::from_production(&public_key(), Some("ABCDE12345"), None).unwrap();
        assert_eq!(trust.team_id(), Some("ABCDE12345"));
        assert_eq!(trust.signer(), Some("apple"));
        for team in ["", "*", "ABCDE12345\" or true", "abcde12345", "ABCDE123456"] {
            assert!(ReleaseTrust::from_production(&public_key(), Some(team), None).is_err());
        }
        for key in ["", "garbage", "dW50cnVzdGVkIGNvbW1lbnQ6IG5vIGtleQ=="] {
            assert!(ReleaseTrust::from_production(key, Some("ABCDE12345"), None).is_err());
        }
    }
    const CERT: &str = "2C5405FB6D2906AE2049D59B9DF5D42661997922";
    #[test]
    fn self_signed_trust_pins_the_exact_certificate_and_refuses_malformed_pins() {
        let trust = ReleaseTrust::from_production(&public_key(), None, Some(CERT)).unwrap();
        assert_eq!(trust.signer(), Some("self"));
        assert_eq!(
            trust.requirement(CodeRole::Cli),
            format!("identifier \"dev.pacer.cli\" and certificate leaf = H\"{CERT}\"")
        );
        for cert in [
            "",
            &CERT[..39],
            "2c5405fb6d2906ae2049d59b9df5d42661997922",
            "2C5405FB6D2906AE2049D59B9DF5D4266199792\"",
            "2C5405FB6D2906AE2049D59B9DF5D4266199792G",
        ] {
            assert!(ReleaseTrust::from_production(&public_key(), None, Some(cert)).is_err());
        }
        assert!(ReleaseTrust::from_production(&public_key(), None, None).is_err());
    }
    #[test]
    fn fixture_requirement_adds_the_leases_certificate_pin_only_when_present() {
        assert_eq!(
            fixture_requirement(CLI_ID, None),
            "identifier \"dev.pacer.cli\""
        );
        assert_eq!(
            fixture_requirement(CLI_ID, Some(CERT)),
            format!("identifier \"dev.pacer.cli\" and certificate leaf = H\"{CERT}\"")
        );
    }
    #[test]
    fn bridge_trust_accepts_either_signer_for_the_same_role() {
        let trust =
            ReleaseTrust::from_production(&public_key(), Some("ABCDE12345"), Some(CERT)).unwrap();
        assert_eq!(trust.signer(), Some("both"));
        assert_eq!(
            trust.requirement(CodeRole::Helper),
            format!("identifier \"dev.pacer.desktop.update-helper\" and ((anchor apple generic and certificate leaf[subject.OU] = \"ABCDE12345\") or certificate leaf = H\"{CERT}\")")
        );
        assert!(ReleaseTrust::from_production(&public_key(), Some("bad"), Some(CERT)).is_err());
    }
    #[test]
    fn signing_requirements_bind_vendor_and_component_role() {
        let trust = ReleaseTrust::from_production(&public_key(), Some("ABCDE12345"), None).unwrap();
        assert_eq!(trust.requirement(CodeRole::Helper), "anchor apple generic and identifier \"dev.pacer.desktop.update-helper\" and certificate leaf[subject.OU] = \"ABCDE12345\"");
        assert_ne!(
            trust.requirement(CodeRole::Desktop),
            trust.requirement(CodeRole::Cli)
        );
    }
    #[cfg(not(any(feature = "ota-production", feature = "ota-fixture")))]
    #[test]
    fn ordinary_build_has_no_production_trust() {
        assert!(ReleaseTrust::configured().is_none());
    }
    /// Disposable self-signed code-signing identity in a private keychain.
    #[cfg(target_os = "macos")]
    struct SelfSigner {
        dir: Option<tempfile::TempDir>,
        search: Option<super::test_search::Entry>,
        hosted: bool,
        _writer: std::sync::MutexGuard<'static, ()>,
        keychain: std::path::PathBuf,
        sha1: String,
        openssl: &'static str,
    }
    #[cfg(target_os = "macos")]
    impl SelfSigner {
        fn new() -> Option<Self> {
            Self::with_openssl("openssl")
        }
        fn with_openssl(openssl: &'static str) -> Option<Self> {
            let hosted = super::test_search::hosted();
            let result = Self::build(openssl, hosted);
            if hosted {
                assert!(result.is_some(), "hosted signer setup failed");
            }
            result
        }
        fn directory(&self) -> &Path {
            self.dir
                .as_ref()
                .expect("fixture directory retained")
                .path()
        }
        fn build(openssl: &'static str, hosted: bool) -> Option<Self> {
            use std::process::Command;
            let writer = super::test_search::lock();
            let ok = |c: &mut Command| c.output().ok().filter(|o| o.status.success());
            let dir = tempfile::tempdir().ok()?;
            let p = |name: &str| dir.path().join(name);
            std::fs::write(
                p("cs.cnf"),
                "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=pacer trust test\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n",
            )
            .ok()?;
            ok(Command::new(openssl)
                .args([
                    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
                ])
                .arg("-keyout")
                .arg(p("key.pem"))
                .arg("-out")
                .arg(p("cert.pem"))
                .arg("-config")
                .arg(p("cs.cnf")))?;
            ok(Command::new(openssl)
                .args(["pkcs12", "-export", "-legacy", "-passout", "pass:test"])
                .arg("-inkey")
                .arg(p("key.pem"))
                .arg("-in")
                .arg(p("cert.pem"))
                .arg("-out")
                .arg(p("id.p12")))
            .or_else(|| {
                ok(Command::new(openssl)
                    .args(["pkcs12", "-export", "-passout", "pass:test"])
                    .arg("-inkey")
                    .arg(p("key.pem"))
                    .arg("-in")
                    .arg(p("cert.pem"))
                    .arg("-out")
                    .arg(p("id.p12")))
            })?;
            let keychain = dir.path().canonicalize().ok()?.join("test.keychain-db");
            let search =
                hosted.then(|| super::test_search::Entry::new(keychain.clone(), dir.path()));
            let mut signer = Self {
                dir: Some(dir),
                keychain,
                sha1: String::new(),
                openssl,
                search,
                hosted,
                _writer: writer,
            };
            if hosted {
                use std::io::Write;
                use std::os::unix::fs::OpenOptionsExt;
                let mut intent = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .mode(0o600)
                    .open(signer.directory().join("cleanup.intent"))
                    .expect("hosted cleanup intent");
                intent
                    .write_all(b"owned fixture keychain; verify search absence before deleting\n")
                    .expect("hosted cleanup intent write");
                intent.sync_all().expect("hosted cleanup intent sync");
            }
            ok(Command::new("/usr/bin/security")
                .args(["create-keychain", "-p", "test"])
                .arg(&signer.keychain))?;
            ok(Command::new("security")
                .args(["unlock-keychain", "-p", "test"])
                .arg(&signer.keychain))?;
            ok(Command::new("security")
                .arg("import")
                .arg(signer.directory().join("id.p12"))
                .arg("-k")
                .arg(&signer.keychain)
                .args(["-P", "test", "-T", "/usr/bin/codesign"]))?;
            ok(Command::new("security")
                .args([
                    "set-key-partition-list",
                    "-S",
                    "apple-tool:,apple:",
                    "-s",
                    "-k",
                    "test",
                ])
                .arg(&signer.keychain))?;
            let fingerprint = ok(Command::new(openssl)
                .args(["x509", "-noout", "-fingerprint", "-sha1", "-in"])
                .arg(signer.directory().join("cert.pem")))?;
            let text = String::from_utf8(fingerprint.stdout).ok()?;
            signer.sha1 = text.trim().rsplit('=').next()?.replace(':', "");
            if hosted {
                signer
                    .search
                    .as_mut()
                    .unwrap()
                    .install()
                    .expect("hosted own search entry setup");
            }
            Some(signer)
        }
        // Failure-only public metadata, always restricted to this fixture keychain/certificate.
        fn signing_diagnostic(&self, stage: &str, command: &mut std::process::Command) {
            match command.output() {
                Ok(output) => {
                    let redact = |bytes: &[u8]| {
                        let mut text = String::from_utf8_lossy(bytes)
                            .replace(&*self.directory().to_string_lossy(), "<fixture>")
                            .replace(
                                &*self.keychain.parent().unwrap().to_string_lossy(),
                                "<fixture>",
                            );
                        if let Some(home) = std::env::var_os("HOME").filter(|home| !home.is_empty())
                        {
                            text = text.replace(&*home.to_string_lossy(), "<home>");
                        }
                        let mut end = text.len().min(4096);
                        while !text.is_char_boundary(end) {
                            end -= 1;
                        }
                        text.truncate(end);
                        text
                    };
                    eprintln!(
                        "trust-test {stage} status={} stdout={:?} stderr={:?}",
                        output.status,
                        redact(&output.stdout),
                        redact(&output.stderr)
                    );
                }
                Err(error) => eprintln!(
                    "trust-test {stage} spawn errno={:?} kind={:?}",
                    error.raw_os_error(),
                    error.kind()
                ),
            }
        }
        fn diagnose_signing_failure(&self) {
            use std::process::Command;
            // Without -v, find-identity includes invalid identities; no search-list query.
            self.signing_diagnostic(
                "fixture-identities",
                Command::new("/usr/bin/security")
                    .args(["find-identity", "-p", "codesigning"])
                    .arg(&self.keychain),
            );
            self.signing_diagnostic(
                "fixture-certificate",
                Command::new(self.openssl)
                    .args(["x509", "-noout", "-fingerprint", "-sha1", "-subject", "-in"])
                    .arg(self.directory().join("cert.pem")),
            );
            self.signing_diagnostic(
                "openssl-path",
                Command::new("/usr/bin/which").arg(self.openssl),
            );
            self.signing_diagnostic("openssl-version", Command::new(self.openssl).arg("version"));
        }
        fn sign(&self, file: &Path, identifier: &str) -> bool {
            let result = std::process::Command::new("/usr/bin/codesign")
                .args([
                    "--force",
                    "--timestamp=none",
                    "--sign",
                    &self.sha1,
                    "--keychain",
                ])
                .arg(&self.keychain)
                .args(["--identifier", identifier])
                .arg(file)
                .output();
            match result {
                Ok(output) => {
                    if !output.status.success() {
                        let redacted = String::from_utf8_lossy(&output.stderr)
                            .replace(&*self.directory().to_string_lossy(), "<fixture>")
                            .replace(
                                &*self.keychain.parent().unwrap().to_string_lossy(),
                                "<fixture>",
                            );
                        let mut end = redacted.len().min(4096);
                        while !redacted.is_char_boundary(end) {
                            end -= 1;
                        }
                        let stderr = &redacted[..end];
                        eprintln!(
                            "trust-test codesign status={} stderr={stderr:?}",
                            output.status
                        );
                        self.diagnose_signing_failure();
                    }
                    output.status.success()
                }
                Err(error) => {
                    eprintln!(
                        "trust-test codesign spawn errno={:?} kind={:?}",
                        error.raw_os_error(),
                        error.kind()
                    );
                    false
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    impl Drop for SelfSigner {
        fn drop(&mut self) {
            let delete = || {
                std::process::Command::new("/usr/bin/security")
                    .arg("delete-keychain")
                    .arg(&self.keychain)
                    .output()
                    .is_ok_and(|output| output.status.success())
            };
            let cleaned = if let Some(entry) = self.search.as_mut() {
                entry.cleanup(delete).is_ok()
            } else {
                delete()
            };
            super::test_search::finish_cleanup(self.hosted, cleaned, &mut self.dir);
        }
    }
    // Diagnostic control: same fixture recipe, only the OpenSSL executable differs.
    // Keep the original PATH-resolved test below unchanged to retain its failure.
    #[cfg(target_os = "macos")]
    #[test]
    fn system_openssl_fixture_signing_control() {
        let signer = SelfSigner::with_openssl("/usr/bin/openssl")
            .expect("system OpenSSL fixture creation must succeed");
        let binary = signer.directory().join("system-openssl-control");
        std::fs::copy("/usr/bin/true", &binary).unwrap();
        assert!(signer.sign(&binary, CLI_ID));
        let trust = ReleaseTrust::from_production(&public_key(), None, Some(&signer.sha1)).unwrap();
        assert!(trust.verify_static(&binary, CodeRole::Cli).is_ok());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn self_signed_pin_accepts_only_code_signed_by_the_pinned_certificate() {
        let Some(signer) = SelfSigner::new() else {
            eprintln!("skipped: openssl or security unavailable");
            return;
        };
        let pinned = signer.directory().join("pinned");
        std::fs::copy("/usr/bin/true", &pinned).unwrap();
        assert!(signer.sign(&pinned, CLI_ID));
        let trust = ReleaseTrust::from_production(&public_key(), None, Some(&signer.sha1)).unwrap();
        assert!(trust.verify_static(&pinned, CodeRole::Cli).is_ok());
        assert!(trust.verify_static(&pinned, CodeRole::Helper).is_err());
        let other = ReleaseTrust::from_production(&public_key(), None, Some(CERT)).unwrap();
        assert!(other.verify_static(&pinned, CodeRole::Cli).is_err());
        let bridge =
            ReleaseTrust::from_production(&public_key(), Some("ABCDE12345"), Some(&signer.sha1))
                .unwrap();
        assert!(bridge.verify_static(&pinned, CodeRole::Cli).is_ok());
        let impostor = signer.directory().join("impostor");
        std::fs::copy("/usr/bin/true", &impostor).unwrap();
        assert!(std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--identifier", CLI_ID])
            .arg(&impostor)
            .output()
            .unwrap()
            .status
            .success());
        assert!(trust.verify_static(&impostor, CodeRole::Cli).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn native_validation_refuses_unrelated_code_and_wrong_process_birth() {
        let trust = ReleaseTrust::from_production(&public_key(), Some("ABCDE12345"), None).unwrap();
        assert!(trust
            .verify_static(Path::new("/usr/bin/true"), CodeRole::Cli)
            .is_err());
        let mut process = super::super::native::process_details(std::process::id())
            .unwrap()
            .unwrap()
            .identity;
        assert!(trust.verify_process(&process, CodeRole::Helper).is_err());
        process.birth.push('0');
        assert!(trust.verify_process(&process, CodeRole::Helper).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn fixture_signature_authority_is_scoped_to_compiled_live_lease() {
        // Re-signed platform /bin/sleep traps on hosted macOS15. Execute only
        // this user-target fixture; retain the same five-second child lifetime.
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("owned.rs");
        let binary = temp.path().join("owned-fixture");
        std::fs::write(
            &source,
            "fn main() { std::thread::sleep(std::time::Duration::from_secs(5)); }\n",
        )
        .unwrap();
        let output = std::process::Command::new("rustc")
            .args([
                "--edition=2021",
                "--crate-name",
                "pacer_owned_trust_fixture",
            ])
            .arg(&source)
            .arg("-o")
            .arg(&binary)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "owned fixture compiler failed: {}",
            output.status
        );
        fixture_signature_case(&binary);
    }
    #[cfg(target_os = "macos")]
    fn fixture_signature_case(binary_source: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let base = temp
            .path()
            .canonicalize()
            .unwrap()
            .join(".work/live/native-trust");
        let root = base.join("ota");
        let home = base.join("home");
        for path in [&base, &root, &home] {
            std::fs::create_dir_all(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let policy = super::super::fixture_policy::FixturePolicy {
            schema: 1,
            root: root.clone(),
            nonce: "b".repeat(32),
            home: home.clone(),
            port: 7433,
            current_app: root.join("current.app"),
            service_label: format!("com.pacer.live.{}.service", "b".repeat(32)),
            recovery_label: format!("com.pacer.live.{}.recovery", "b".repeat(32)),
            uid: unsafe { libc::geteuid() },
            signing_cert_sha1: None,
        };
        std::fs::write(root.join("record.json"),serde_json::to_vec(&serde_json::json!({"schema":1,"phase":"prepared","root":root,"nonce":policy.nonce,"pacerHome":home,"innerPort":policy.port,"currentApp":policy.current_app,"serviceLabel":policy.service_label,"recoveryLabel":policy.recovery_label,"ownerUid":policy.uid})).unwrap()).unwrap();
        std::fs::set_permissions(
            root.join("record.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let binary = root.join("fixture-helper");
        std::fs::copy(binary_source, &binary).unwrap();
        let result = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--identifier", HELPER_ID])
            .arg(&binary)
            .output()
            .unwrap();
        assert!(result.status.success());
        let trust =
            ReleaseTrust::from_fixture(&public_key(), &serde_json::to_string(&policy).unwrap())
                .unwrap();
        trust.verify_static(&binary, CodeRole::Helper).unwrap();
        let shim = root.join("libpacer-native.dylib");
        std::fs::copy("/bin/sleep", &shim).unwrap();
        assert!(std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-", "--identifier", NATIVE_SHIM_ID])
            .arg(&shim)
            .output()
            .unwrap()
            .status
            .success());
        trust.verify_native_shim(&shim).unwrap();
        assert!(trust.verify_native_shim(&binary).is_err());
        for role in [CodeRole::Desktop, CodeRole::Cli, CodeRole::Helper] {
            assert!(trust.verify_static(&shim, role).is_err());
        }
        assert!(
            ReleaseTrust::from_production(&public_key(), Some("ABCDE12345"), None)
                .unwrap()
                .verify_native_shim(&shim)
                .is_err()
        );

        assert!(trust.verify_static(&binary, CodeRole::Cli).is_err());
        assert!(trust
            .verify_static(Path::new("/bin/sleep"), CodeRole::Helper)
            .is_err());
        assert!(
            ReleaseTrust::from_production(&public_key(), Some("ABCDE12345"), None)
                .unwrap()
                .verify_static(&binary, CodeRole::Helper)
                .is_err()
        );
        TRUST_TEST_SPAWN_STARTED.with(|start| start.set(Some(std::time::Instant::now())));
        let mut child = std::process::Command::new(&binary)
            .arg("5")
            .spawn()
            .unwrap();
        let identity = super::super::native::process_details(child.id())
            .unwrap()
            .unwrap()
            .identity;
        let verified = trust.verify_process(&identity, CodeRole::Helper);
        TRUST_TEST_SPAWN_STARTED.with(|start| start.set(None));
        if verified.is_err() {
            use std::os::unix::process::ExitStatusExt;
            match child.try_wait() {
                Ok(None) => eprintln!("trust-test fixture-child state=running"),
                Ok(Some(status)) => eprintln!(
                    "trust-test fixture-child state=exited code={:?} signal={:?}",
                    status.code(),
                    status.signal()
                ),
                Err(error) => eprintln!(
                    "trust-test fixture-child state=unavailable errno={:?} kind={:?}",
                    error.raw_os_error(),
                    error.kind()
                ),
            }
        }
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(verified.is_ok());
        std::fs::write(root.join("record.json"), b"{}").unwrap();
        assert!(trust.verify_static(&binary, CodeRole::Helper).is_err());
    }
}
