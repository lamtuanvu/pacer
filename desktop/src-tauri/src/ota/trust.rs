//! Compile-time updater trust. Public requests and runtime environment cannot change it.
#[path = "trust_config.rs"]
mod trust_config;
use super::native::{ProcessDetails, ProcessIdentity};
use super::OtaError;
use std::path::Path;

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
        option_env!("PACER_APPLE_TEAM_ID")
    } else if cfg!(feature = "ota-fixture") {
        Some("FIXTURE000")
    } else {
        None
    };
    serde_json::json!({
        "fixture":cfg!(feature="ota-fixture"),
        "otaMode":if cfg!(feature="ota-production") {"production"} else if cfg!(feature="ota-fixture") {"fixture"} else {"disabled"},
        "appleTeamId":team,
        "updaterKeySha256":key.map(|key|format!("{:x}",Sha256::digest(key.as_bytes()))),
        "fixturePolicySha256":if cfg!(feature="ota-fixture") { option_env!("PACER_OTA_FIXTURE_POLICY").map(|policy|format!("{:x}",Sha256::digest(policy.as_bytes()))) } else { None },
    })
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
    team_id: String,
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
            Self::from_production(env!("PACER_OTA_PUBLIC_KEY"), env!("PACER_APPLE_TEAM_ID")).ok()
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
    pub(crate) fn from_production(public_key: &str, team_id: &str) -> Result<Self, OtaError> {
        trust_config::validate(public_key, team_id).map_err(|_| OtaError::Invalid)?;
        Ok(Self {
            public_key: public_key.into(),
            team_id: team_id.into(),
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
            team_id: String::new(),
            fixture: Some(fixture),
        })
    }
    pub fn fixture_policy(&self) -> Option<&super::fixture_policy::FixturePolicy> {
        self.fixture.as_ref()
    }
    pub fn public_key(&self) -> &str {
        &self.public_key
    }
    pub fn team_id(&self) -> &str {
        &self.team_id
    }
    pub fn requirement(&self, role: CodeRole) -> String {
        self.static_requirement(role.identifier())
    }
    fn static_requirement(&self, identifier: &str) -> String {
        if self.fixture.is_some() {
            return format!("identifier \"{}\"", identifier);
        }
        format!(
            "anchor apple generic and identifier \"{}\" and certificate leaf[subject.OU] = \"{}\"",
            identifier, self.team_id
        )
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
            .map_err(|_| OtaError::Identity)?
            .ok_or(OtaError::Identity)?;
        if &before.identity != expected || before.uid != unsafe { libc::geteuid() } {
            return Err(OtaError::Identity);
        }
        if self
            .fixture
            .as_ref()
            .is_some_and(|fixture| !fixture.permits_path(&before.executable))
        {
            return Err(OtaError::Identity);
        }
        let requirement: SecRequirement = self
            .requirement(role)
            .parse()
            .map_err(|_| OtaError::Identity)?;
        let mut attributes = GuestAttributes::new();
        attributes.set_pid(i32::try_from(expected.pid).map_err(|_| OtaError::Identity)?);
        let token = audit_token.map(|bytes| CFData::from_buffer(bytes));
        if let Some(token) = token.as_ref() {
            attributes.set_audit_token(token.as_concrete_TypeRef());
        }
        let code = SecCode::copy_guest_with_attribues(None, &attributes, Flags::NONE)
            .map_err(|_| OtaError::Identity)?;
        code.check_validity(Flags::NONE, &requirement)
            .map_err(|_| OtaError::Identity)?;
        let after = super::native::process_details(expected.pid)
            .map_err(|_| OtaError::Identity)?
            .ok_or(OtaError::Identity)?;
        if before != after {
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

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
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
        let trust = ReleaseTrust::from_production(&public_key(), "ABCDE12345").unwrap();
        assert_eq!(trust.team_id(), "ABCDE12345");
        for team in ["", "*", "ABCDE12345\" or true", "abcde12345", "ABCDE123456"] {
            assert!(ReleaseTrust::from_production(&public_key(), team).is_err());
        }
        for key in ["", "garbage", "dW50cnVzdGVkIGNvbW1lbnQ6IG5vIGtleQ=="] {
            assert!(ReleaseTrust::from_production(key, "ABCDE12345").is_err());
        }
    }
    #[test]
    fn signing_requirements_bind_vendor_and_component_role() {
        let trust = ReleaseTrust::from_production(&public_key(), "ABCDE12345").unwrap();
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
    #[cfg(target_os = "macos")]
    #[test]
    fn native_validation_refuses_unrelated_code_and_wrong_process_birth() {
        let trust = ReleaseTrust::from_production(&public_key(), "ABCDE12345").unwrap();
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
        };
        std::fs::write(root.join("record.json"),serde_json::to_vec(&serde_json::json!({"schema":1,"phase":"prepared","root":root,"nonce":policy.nonce,"pacerHome":home,"innerPort":policy.port,"currentApp":policy.current_app,"serviceLabel":policy.service_label,"recoveryLabel":policy.recovery_label,"ownerUid":policy.uid})).unwrap()).unwrap();
        std::fs::set_permissions(
            root.join("record.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let binary = root.join("fixture-helper");
        std::fs::copy("/bin/sleep", &binary).unwrap();
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
        assert!(ReleaseTrust::from_production(&public_key(), "ABCDE12345")
            .unwrap()
            .verify_native_shim(&shim)
            .is_err());

        assert!(trust.verify_static(&binary, CodeRole::Cli).is_err());
        assert!(trust
            .verify_static(Path::new("/bin/sleep"), CodeRole::Helper)
            .is_err());
        assert!(ReleaseTrust::from_production(&public_key(), "ABCDE12345")
            .unwrap()
            .verify_static(&binary, CodeRole::Helper)
            .is_err());
        let mut child = std::process::Command::new(&binary)
            .arg("5")
            .spawn()
            .unwrap();
        let identity = super::super::native::process_details(child.id())
            .unwrap()
            .unwrap()
            .identity;
        let verified = trust.verify_process(&identity, CodeRole::Helper);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(verified.is_ok());
        std::fs::write(root.join("record.json"), b"{}").unwrap();
        assert!(trust.verify_static(&binary, CodeRole::Helper).is_err());
    }
}
