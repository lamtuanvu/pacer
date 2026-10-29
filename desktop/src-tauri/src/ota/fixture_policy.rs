//! Compile-time sandbox lease for dedicated non-production native validation.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FixturePolicy {
    pub schema: u32,
    pub root: PathBuf,
    pub nonce: String,
    pub home: PathBuf,
    pub port: u16,
    pub current_app: PathBuf,
    pub service_label: String,
    pub recovery_label: String,
    pub uid: u32,
    /// Disposable certificate the harness signed this lease's fixtures with.
    /// When present, fixture trust also pins it, like a production interim build.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_cert_sha1: Option<String>,
}
impl FixturePolicy {
    fn validate_fixture_selection(&self, record: &serde_json::Value) -> Result<(), ()> {
        let background_choice = self.nonce.starts_with("f0a3c29e5c0d");
        let standard_choice = self.nonce.starts_with("f0a3c29e5c0f");
        let choice = background_choice || standard_choice;
        let standard = self.nonce.starts_with("f0a3c29e") && !background_choice;
        match (choice, record.get("oldServiceChoice")) {
            (false, None) => {},
            (true, Some(serde_json::Value::String(choice))) if choice == "continue" => {},
            _ => return Err(()),
        }
        let priority = record.get("baselineProcessType").map(serde_json::Value::as_str).unwrap_or(Some("Background")).ok_or(())?;
        if priority != if standard { "Standard" } else { "Background" } { return Err(()); }
        if (choice || standard) && record["initialLayout"] != "paired" { return Err(()); }
        Ok(())
    }
    pub fn parse(text: &str) -> Result<Self, ()> {
        let policy: Self = serde_json::from_str(text).map_err(|_| ())?;
        let parent = policy.root.parent().ok_or(())?;
        let live = parent.parent().ok_or(())?;
        let valid_path = |path: &Path| {
            path.is_absolute()
                && path.components().all(|p| {
                    matches!(
                        p,
                        std::path::Component::RootDir | std::path::Component::Normal(_)
                    )
                })
                && !path.as_os_str().as_encoded_bytes().contains(&0)
        };
        if policy.schema != 1
            || policy.nonce.len() != 32
            || !policy
                .nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || policy.port == 0
            || policy.port == 4317
            || !valid_path(&policy.root)
            || !valid_path(&policy.home)
            || !valid_path(&policy.current_app)
            || policy.root.file_name().is_none_or(|p| p != "ota")
            || live.file_name().is_none_or(|p| p != "live")
            || live
                .parent()
                .and_then(Path::file_name)
                .is_none_or(|p| p != ".work")
            || policy.home != parent.join("home")
            || policy.current_app != policy.root.join("current.app")
            || policy.service_label != format!("com.pacer.live.{}.service", policy.nonce)
            || policy.recovery_label != format!("com.pacer.live.{}.recovery", policy.nonce)
            || policy.signing_cert_sha1.as_ref().is_some_and(|cert| {
                cert.len() != 40
                    || !cert
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
            })
        {
            return Err(());
        }
        Ok(policy)
    }
    pub fn validate_live(&self) -> Result<(), ()> {
        let record = self.private_record()?;
        if record.get("phase").and_then(serde_json::Value::as_str) != Some("prepared") {
            return Err(());
        }
        self.validate_fixture_selection(&record)
    }
    pub fn permits_old_service_choice(&self) -> bool {
        (self.nonce.starts_with("f0a3c29e5c0d") || self.nonce.starts_with("f0a3c29e5c0f")) && self.validate_live().is_ok()
    }
    fn private_record(&self) -> Result<serde_json::Value, ()> {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if self.uid != unsafe { libc::geteuid() } {
            return Err(());
        }
        for directory in [&self.root, &self.home, self.root.parent().ok_or(())?] {
            let info = std::fs::symlink_metadata(directory).map_err(|_| ())?;
            if !info.is_dir()
                || info.uid() != self.uid
                || info.mode() & 0o077 != 0
                || directory.canonicalize().map_err(|_| ())? != *directory
            {
                return Err(());
            }
        }
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.root.join("record.json"))
            .map_err(|_| ())?;
        let info = file.metadata().map_err(|_| ())?;
        if !info.is_file()
            || info.nlink() != 1
            || info.uid() != self.uid
            || info.mode() & 0o077 != 0
            || info.len() > 65_536
        {
            return Err(());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(65_537)
            .read_to_end(&mut bytes)
            .map_err(|_| ())?;
        if bytes.len() > 65_536 {
            return Err(());
        }
        let record: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| ())?;
        let expected = serde_json::json!({"schema":1,"root":self.root,"nonce":self.nonce,"pacerHome":self.home,"innerPort":self.port,"currentApp":self.current_app,"serviceLabel":self.service_label,"recoveryLabel":self.recovery_label,"ownerUid":self.uid});
        if expected
            .as_object()
            .ok_or(())?
            .iter()
            .any(|(key, value)| record.get(key) != Some(value))
        {
            return Err(());
        }
        Ok(record)
    }
    /// A build intent permits compilation only. Runtime authority always requires
    /// the separately finalized prepared lease in validate_live.
    pub fn validate_build(&self, public_key: &str) -> Result<(), ()> {
        use sha2::{Digest, Sha256};
        let record = self.private_record()?;
        self.validate_fixture_selection(&record)?;
        if record["phase"] == "prepared" {
            return Ok(());
        }
        if record["phase"] != "building" {
            return Err(());
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct BuildIntent {
            schema: u32,
            kind: String,
            build_root: PathBuf,
            baseline_version: String,
            candidate_version: String,
            arch: String,
            updater_key_sha256: String,
            #[serde(default)]
            signing_cert_sha1: Option<String>,
        }
        let intent: BuildIntent =
            serde_json::from_value(record["nativeFixture"].clone()).map_err(|_| ())?;
        let version = |value: &str| -> Result<Vec<u64>, ()> {
            let parts: Vec<_> = value.split('.').collect();
            if parts.len() != 3
                || parts.iter().any(|p| {
                    p.is_empty()
                        || !p.bytes().all(|b| b.is_ascii_digit())
                        || (p.len() > 1 && p.starts_with('0'))
                })
            {
                return Err(());
            }
            parts.iter().map(|p| p.parse().map_err(|_| ())).collect()
        };
        let sources = serde_json::json!([
            {"path":self.root.join("build/baseline/pacer.app"),"sha256":null},
            {"path":self.root.join("build/candidate/pacer.app"),"sha256":null}
        ]);
        if intent.schema != 1
            || intent.kind != "native-build"
            || intent.build_root != self.root.join("build")
            || !matches!(intent.arch.as_str(), "aarch64" | "x86_64")
            || version(&intent.candidate_version)? <= version(&intent.baseline_version)?
            || intent.updater_key_sha256 != format!("{:x}", Sha256::digest(public_key.as_bytes()))
            || intent.signing_cert_sha1 != self.signing_cert_sha1
            || record["sources"] != sources
        {
            return Err(());
        }
        Ok(())
    }
    /// The only external service executable a fixture lease may register.
    pub fn external_cli(&self) -> PathBuf {
        self.root.join("external/pacer")
    }
    pub fn takeover_cli(&self) -> PathBuf {
        self.home.join(".local/bin/pacer")
    }
    pub fn permits_path(&self, path: &Path) -> bool {
        if self.validate_live().is_err() {
            return false;
        }
        let Ok(canonical) = path.canonicalize() else {
            return false;
        };
        canonical == path
            && (path.starts_with(&self.root)
                || path.starts_with(self.home.join("desktop-updates/native"))
                || path == self.takeover_cli())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> (tempfile::TempDir, FixturePolicy) {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().canonicalize().unwrap().join(".work/live/lease");
        let root = base.join("ota");
        let home = base.join("home");
        for path in [&base, &root, &home] {
            std::fs::create_dir_all(path).unwrap();
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        let nonce = "a".repeat(32);
        let policy = FixturePolicy {
            schema: 1,
            root: root.clone(),
            nonce: nonce.clone(),
            home: home.clone(),
            port: 7433,
            current_app: root.join("current.app"),
            service_label: format!("com.pacer.live.{nonce}.service"),
            recovery_label: format!("com.pacer.live.{nonce}.recovery"),
            uid: unsafe { libc::getuid() },
            signing_cert_sha1: None,
        };
        std::fs::write(root.join("record.json"),serde_json::to_vec(&serde_json::json!({"schema":1,"phase":"prepared","root":root,"nonce":nonce,"pacerHome":home,"innerPort":7433,"currentApp":policy.current_app,"serviceLabel":policy.service_label,"recoveryLabel":policy.recovery_label,"ownerUid":policy.uid})).unwrap()).unwrap();
        std::fs::set_permissions(
            root.join("record.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        (temp, policy)
    }
    #[test]
    fn lease_may_pin_its_disposable_signing_certificate() {
        let (_temp, mut policy) = fixture();
        policy.signing_cert_sha1 = Some("2C5405FB6D2906AE2049D59B9DF5D42661997922".into());
        let text = serde_json::to_string(&policy).unwrap();
        assert!(text.contains("\"signingCertSha1\""));
        assert_eq!(FixturePolicy::parse(&text).unwrap(), policy);
        for bad in ["2c5405fb6d2906ae2049d59b9df5d42661997922", "2C54", ""] {
            policy.signing_cert_sha1 = Some(bad.into());
            assert!(FixturePolicy::parse(&serde_json::to_string(&policy).unwrap()).is_err());
        }
        policy.signing_cert_sha1 = None;
        assert!(!serde_json::to_string(&policy).unwrap().contains("signingCertSha1"));
    }
    #[test]
    fn old_service_choice_requires_exact_compiled_and_recorded_lease() {
        let (_temp, mut policy) = fixture();
        assert!(!policy.permits_old_service_choice());
        policy.nonce = format!("f0a3c29e5c0d{}", "a".repeat(20));
        policy.service_label = format!("com.pacer.live.{}.service", policy.nonce);
        policy.recovery_label = format!("com.pacer.live.{}.recovery", policy.nonce);
        assert_eq!(FixturePolicy::parse(&serde_json::to_string(&policy).unwrap()).unwrap(), policy);
        let path = policy.root.join("record.json");
        let mut record: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["nonce"] = policy.nonce.clone().into();
        record["serviceLabel"] = policy.service_label.clone().into();
        record["recoveryLabel"] = policy.recovery_label.clone().into();
        record["initialLayout"] = "paired".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!policy.permits_old_service_choice());
        record["oldServiceChoice"] = "continue".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(policy.permits_old_service_choice());
        record["initialLayout"] = "bridge".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!policy.permits_old_service_choice());
        record["initialLayout"] = "paired".into();
        record["oldServiceChoice"] = "skip".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!policy.permits_old_service_choice());
    }
    #[test]
    fn standard_choice_is_disjoint_from_background_and_plain_standard_leases() {
        let (_temp, mut policy) = fixture();
        policy.nonce = format!("f0a3c29e5c0f{}", "a".repeat(20));
        policy.service_label = format!("com.pacer.live.{}.service", policy.nonce);
        policy.recovery_label = format!("com.pacer.live.{}.recovery", policy.nonce);
        let path = policy.root.join("record.json");
        let mut record: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["nonce"] = policy.nonce.clone().into();
        record["serviceLabel"] = policy.service_label.clone().into();
        record["recoveryLabel"] = policy.recovery_label.clone().into();
        record["initialLayout"] = "paired".into();
        record["baselineProcessType"] = "Standard".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!policy.permits_old_service_choice());
        record["oldServiceChoice"] = "continue".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(policy.permits_old_service_choice());
        record["baselineProcessType"] = "Background".into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!policy.permits_old_service_choice());
        record["baselineProcessType"] = "Standard".into();
        policy.nonce = format!("f0a3c29e5c0e{}", "a".repeat(20));
        policy.service_label = format!("com.pacer.live.{}.service", policy.nonce);
        policy.recovery_label = format!("com.pacer.live.{}.recovery", policy.nonce);
        record["nonce"] = policy.nonce.clone().into();
        record["serviceLabel"] = policy.service_label.clone().into();
        record["recoveryLabel"] = policy.recovery_label.clone().into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(!policy.permits_old_service_choice());
    }
    #[test]
    fn lease_is_bound_to_private_live_harness_resources() {
        let (_temp, policy) = fixture();
        assert_eq!(
            FixturePolicy::parse(&serde_json::to_string(&policy).unwrap()).unwrap(),
            policy
        );
        policy.validate_live().unwrap();
        std::fs::create_dir(policy.current_app.clone()).unwrap();
        assert!(policy.permits_path(&policy.current_app));
        std::fs::create_dir_all(policy.home.join(".local/bin")).unwrap();
        std::fs::write(policy.takeover_cli(), b"fixture").unwrap();
        assert!(policy.permits_path(&policy.takeover_cli()));
        for other in [policy.home.join("pacer"), policy.home.join(".local/pacer"), policy.home.join(".local/bin/other"), policy.home.join(".local/bin/pacer2"), policy.home.join(".local/bin/sub/pacer")] {
            std::fs::create_dir_all(other.parent().unwrap()).unwrap();
            std::fs::write(&other, b"fixture").unwrap();
            assert!(!policy.permits_path(&other), "unexpected permitted path: {other:?}");
        }
        assert!(!policy.permits_path(Path::new("/Applications/pacer.app")));
        for key in [
            "root",
            "home",
            "currentApp",
            "serviceLabel",
            "recoveryLabel",
            "nonce",
        ] {
            let mut changed = serde_json::to_value(&policy).unwrap();
            changed[key] = serde_json::json!("/Applications/pacer.app");
            assert!(FixturePolicy::parse(&changed.to_string()).is_err(), "{key}");
        }
    }
    #[test]
    fn lease_change_or_redirect_revokes_fixture_authority() {
        let (_temp, policy) = fixture();
        policy.validate_live().unwrap();
        std::fs::write(policy.root.join("record.json"), b"{}").unwrap();
        assert!(policy.validate_live().is_err());
        let (_temp, policy) = fixture();
        std::fs::remove_file(policy.root.join("record.json")).unwrap();
        symlink("/dev/null", policy.root.join("record.json")).unwrap();
        assert!(policy.validate_live().is_err());
    }
    #[test]
    fn lease_fifo_is_rejected_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let (_temp, policy) = fixture();
        let filename = policy.root.join("record.json");
        std::fs::remove_file(&filename).unwrap();
        let path = std::ffi::CString::new(filename.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || tx.send(policy.validate_live()).unwrap());
        let result = rx.recv_timeout(std::time::Duration::from_secs(1));
        // Release a blocked RED reader before joining; never leak a test thread.
        let rescue = if result.is_err() {
            unsafe { libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_NONBLOCK) }
        } else {
            -1
        };
        worker.join().unwrap();
        if rescue >= 0 {
            unsafe { libc::close(rescue) };
        }
        assert!(result
            .expect("fixture lease open must not wait on a FIFO")
            .is_err());
    }
    #[test]
    fn building_lease_can_compile_but_cannot_authorize_runtime_effects() {
        use sha2::{Digest, Sha256};
        let (_temp, mut policy) = fixture();
        let path = policy.root.join("record.json");
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["phase"] = serde_json::json!("building");
        record["nativeFixture"] = serde_json::json!({"schema":1,"kind":"native-build","buildRoot":policy.root.join("build"),"baselineVersion":"0.2.3","candidateVersion":"0.2.4","arch":"aarch64","updaterKeySha256":format!("{:x}",Sha256::digest(b"disposable-public-key"))});
        record["sources"] = serde_json::json!([
            {"path":policy.root.join("build/baseline/pacer.app"),"sha256":null},
            {"path":policy.root.join("build/candidate/pacer.app"),"sha256":null}
        ]);
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(policy.validate_build("disposable-public-key").is_ok());
        // A record-only priority change cannot alter a compiled Background lease.
        record["baselineProcessType"] = serde_json::json!("Standard");
        record["initialLayout"] = serde_json::json!("paired");
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(policy.validate_build("disposable-public-key").is_err());
        // The published bridge's strict policy and nested BuildIntent shapes
        // are unchanged. A distinct compiled nonce selects the Standard lease.
        policy.nonce = format!("f0a3c29e5c0e{}", "a".repeat(20));
        policy.service_label = format!("com.pacer.live.{}.service", policy.nonce);
        policy.recovery_label = format!("com.pacer.live.{}.recovery", policy.nonce);
        record["nonce"] = policy.nonce.clone().into();
        record["serviceLabel"] = policy.service_label.clone().into();
        record["recoveryLabel"] = policy.recovery_label.clone().into();
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(policy.validate_build("disposable-public-key").is_ok());
        assert!(policy.validate_live().is_err());
        assert!(!policy.permits_path(&policy.root));
        assert!(policy.validate_build("another-public-key").is_err());
        for (pointer, replacement) in [
            ("/nativeFixture/buildRoot", serde_json::json!(policy.home)),
            ("/nativeFixture/arch", serde_json::json!("unknown")),
            (
                "/nativeFixture/candidateVersion",
                serde_json::json!("0.2.2"),
            ),
            ("/sources/0/path", serde_json::json!(policy.current_app)),
            ("/sources/1/sha256", serde_json::json!("f".repeat(64))),
            ("/phase", serde_json::json!("retired")),
        ] {
            let mut changed = record.clone();
            *changed.pointer_mut(pointer).unwrap() = replacement;
            std::fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
            assert!(
                policy.validate_build("disposable-public-key").is_err(),
                "{pointer}"
            );
        }
    }
    #[test]
    fn certificate_signed_build_requires_the_same_pin_in_lease_and_intent() {
        use sha2::{Digest, Sha256};
        const CERT: &str = "2C5405FB6D2906AE2049D59B9DF5D42661997922";
        let (_temp, mut policy) = fixture();
        let path = policy.root.join("record.json");
        let mut record: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        record["phase"] = serde_json::json!("building");
        record["nativeFixture"] = serde_json::json!({"schema":1,"kind":"native-build","buildRoot":policy.root.join("build"),"baselineVersion":"0.2.3","candidateVersion":"0.2.4","arch":"aarch64","updaterKeySha256":format!("{:x}",Sha256::digest(b"disposable-public-key")),"signingCertSha1":CERT});
        record["sources"] = serde_json::json!([
            {"path":policy.root.join("build/baseline/pacer.app"),"sha256":null},
            {"path":policy.root.join("build/candidate/pacer.app"),"sha256":null}
        ]);
        std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(policy.validate_build("disposable-public-key").is_err());
        policy.signing_cert_sha1 = Some(CERT.into());
        assert!(policy.validate_build("disposable-public-key").is_ok());
        policy.signing_cert_sha1 = Some("A".repeat(40));
        assert!(policy.validate_build("disposable-public-key").is_err());
    }
}
