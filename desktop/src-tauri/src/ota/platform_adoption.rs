//! Native service-only adoption. No updater or application replacement dependency.
use super::*;
use crate::ota::{
    adoption::*,
    control::{AdoptionContext, AdoptionRequestReceipt, AdoptionSource},
    platform_fs::PrivateDir,
    wire::{Binding, Installation},
};

#[cfg(feature = "ota-fixture")]
#[derive(Clone, Copy)]
enum ReadinessIdentityStage {
    Registration,
    JobObservation,
    ProcessInspection,
    ProcessMissing,
    Owner,
    Executable,
    CodeSignature,
    Launch,
    ServiceQuery,
    DesktopSignature,
}
#[cfg(feature = "ota-fixture")]
impl ReadinessIdentityStage {
    fn code(self) -> &'static str {
        match self {
            Self::Registration => "registration",
            Self::JobObservation => "job-observation",
            Self::ProcessInspection => "process-inspection",
            Self::ProcessMissing => "process-missing",
            Self::Owner => "owner",
            Self::Executable => "executable",
            Self::CodeSignature => "code-signature",
            Self::Launch => "launch",
            Self::ServiceQuery => "service-query",
            Self::DesktopSignature => "desktop-signature",
        }
    }
}
#[cfg(feature = "ota-fixture")]
fn readiness_identity_payload(
    stage: ReadinessIdentityStage,
    process: Option<&ProcessIdentity>,
) -> Option<Vec<u8>> {
    let bytes = serde_json::to_vec(&serde_json::json!({
        "stage": stage.code(),
        "process": process,
    }))
    .ok()?;
    (bytes.len() <= 512).then_some(bytes)
}
#[cfg(feature = "ota-fixture")]
macro_rules! record_readiness_identity {
    ($self:expr, $stage:expr, $process:expr) => {
        $self.record_managed_readiness_identity($stage, $process)
    };
}
#[cfg(not(feature = "ota-fixture"))]
macro_rules! record_readiness_identity {
    ($self:expr, $stage:expr, $process:expr) => {};
}

pub(crate) struct NativeAdoptionPlatform {
    trust: ReleaseTrust,
    binding: Binding,
    source: AdoptionSource,
    request: AdoptionRequestReceipt,
    assets: PrivateDir,
    recovered: Option<AdoptionManifest>,
}
impl NativeAdoptionPlatform {
    #[cfg(feature = "ota-fixture")]
    fn record_managed_readiness_identity(
        &self,
        stage: ReadinessIdentityStage,
        process: Option<&ProcessIdentity>,
    ) {
        if let Some(bytes) = readiness_identity_payload(stage, process) {
            // First failure only. The private transaction directory is
            // already owned by the signed native adoption helper.
            let _ = self
                .assets
                .write_new("fixture-managed-readiness-identity.json", &bytes);
        }
    }
    pub(crate) fn new(trust: ReleaseTrust, context: AdoptionContext) -> Result<Self, OtaError> {
        ensure(
            context.schema == 1
                && context.transaction_kind == "adoption"
                && context.protocol == 3
                && context.admission_protocol == 1
                && context.state_compatible
                && context.binding.installation_id == context.source.target.id
                && context.source.target.ownership == crate::ota::wire::Ownership::Attached,
        )?;
        let tx = context
            .binding
            .transaction_id
            .as_deref()
            .ok_or(OtaError::Invalid)?;
        let assets = PrivateDir::installation(
            Path::new(&context.source.target.pacer_home),
            &context.source.target.id,
        )?
        .child(tx)?;
        Ok(Self {
            trust,
            binding: context.binding,
            source: context.source,
            request: context.request,
            assets,
            recovered: None,
        })
    }
    pub(crate) fn recover(
        trust: ReleaseTrust,
        manifest: AdoptionManifest,
    ) -> Result<Self, OtaError> {
        journal::validate_manifest(&manifest)?;
        let assets = PrivateDir::installation(
            Path::new(&manifest.source.target.pacer_home),
            &manifest.source.target.id,
        )?
        .child(manifest.transaction_id())?;
        Ok(Self {
            trust,
            binding: manifest.binding.clone(),
            source: manifest.source.clone(),
            request: manifest.request.clone(),
            assets,
            recovered: Some(manifest),
        })
    }
    pub(crate) fn transaction_directory(&self) -> &Path {
        &self.assets.path
    }
}
fn replacement_registration(bytes: &[u8], old: &str, new: &str) -> Result<Vec<u8>, OtaError> {
    let original = JobDefinition::from_plist(bytes)?;
    ensure(
        original.arguments == vec![old.to_owned(), "serve".into()]
            && Path::new(new).is_absolute()
            && !new.contains(['\0', '\n', '\r'])
            && old != new,
    )?;
    let mut value =
        plist::Value::from_reader(std::io::Cursor::new(bytes)).map_err(|_| OtaError::Invalid)?;
    let managed = value.as_dictionary_mut().ok_or(OtaError::Invalid)?;
    let args = managed
        .get_mut("ProgramArguments")
        .and_then(plist::Value::as_array_mut)
        .ok_or(OtaError::Invalid)?;
    args[0] = new.into();
    // The original plist is stored byte-for-byte for restoration. An older
    // Background job can throttle the paired Core's disk access during startup;
    // change only the candidate's explicitly recognized launch priority.
    if managed.get("ProcessType").and_then(plist::Value::as_string) == Some("Background") {
        managed.insert("ProcessType".into(), "Standard".into());
    }
    let mut output = Vec::new();
    value
        .to_writer_xml(&mut output)
        .map_err(|_| OtaError::Invalid)?;
    let mut expected = original;
    expected.arguments[0] = new.into();
    ensure(JobDefinition::from_plist(&output)? == expected)?;
    Ok(output)
}
fn resulting_installation_id(
    target: &Installation,
    binary: &str,
    registration: &str,
) -> Result<String, OtaError> {
    // Serialize struct fields, not a JSON map: this exact order is shared with TS.
    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity<'a> {
        app_path: &'a str,
        bundle_id: &'a str,
        owner_uid: u64,
        arch: crate::ota::wire::Arch,
        pacer_home: &'a str,
        port: u16,
        service_label: &'a str,
        ownership: &'a str,
        binary: &'a str,
        registration_text: &'a str,
    }
    let bytes = serde_json::to_vec(&Identity {
        app_path: &target.app_path,
        bundle_id: &target.bundle_id,
        owner_uid: target.owner_uid,
        arch: target.arch,
        pacer_home: &target.pacer_home,
        port: target.port,
        service_label: &target.service_label,
        ownership: "managed",
        binary,
        registration_text: registration,
    })
    .map_err(|_| OtaError::Invalid)?;
    Ok(digest(&bytes))
}
fn prove_managed_recovery_launch(
    m: &AdoptionManifest,
    journal: &journal::AdoptionJournal,
    current: Option<&ProcessIdentity>,
) -> Result<(), OtaError> {
    ensure(
        journal.state == journal::AdoptionState::Restoring
            && journal.authorization.is_some()
            && journal.verification_proof.is_none(),
    )?;
    let launched = journal
        .steps
        .iter()
        .find_map(|step| match (&step.action, &step.evidence) {
            (
                AdoptionAction::LaunchService {
                    branch: control::AdoptionBranch::Managed,
                    launch_id,
                },
                Some(AdoptionEvidence::Launched {
                    branch: control::AdoptionBranch::Managed,
                    launch,
                }),
            ) if launch_id == &m.managed_launch_id
                && launch.process.boot_id == step.intent_boot_id =>
            {
                Some(&launch.process)
            }
            _ => None,
        })
        .ok_or(OtaError::Identity)?;
    if let Some(current) = current {
        ensure(launched == current)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_recovery_requires_the_exact_completed_launch_incarnation() {
        let m = journal::tests::manifest();
        let (_temp, _store, mut j) = journal::tests::initialized();
        j.state = journal::AdoptionState::Restoring;
        j.authorization = Some(ota::Authorization {
            binding: m.binding.clone(),
            kind: crate::ota::wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: m.transaction_id().into(),
            journal_sha256: j.manifest_sha256.clone(),
        });
        let process = ProcessIdentity {
            pid: 903,
            boot_id: m.source.boot_id.clone(),
            birth: "one:9".into(),
        };
        let launch = ota::LaunchEvidence {
            role: ota::ProcessRole::Service,
            release: ota::Release::Candidate,
            launch_id: m.managed_launch_id.clone(),
            process: process.clone(),
            native_session_id: m.managed_launch_id.clone(),
            version: m.source.target.version.clone(),
        };
        assert!(prove_managed_recovery_launch(&m, &j, Some(&process)).is_err());
        j.steps.push(journal::AdoptionStep {
            action: AdoptionAction::LaunchService {
                branch: control::AdoptionBranch::Managed,
                launch_id: m.managed_launch_id.clone(),
            },
            intent_revision: j.revision + 1,
            intent_boot_id: process.boot_id.clone(),
            evidence: Some(AdoptionEvidence::Launched {
                branch: control::AdoptionBranch::Managed,
                launch,
            }),
        });
        assert!(prove_managed_recovery_launch(&m, &j, Some(&process)).is_ok());
        let reused = ProcessIdentity {
            birth: "two:9".into(),
            ..process.clone()
        };
        assert!(prove_managed_recovery_launch(&m, &j, Some(&reused)).is_err());
        j.steps.last_mut().unwrap().intent_boot_id = "other-boot".into();
        assert!(prove_managed_recovery_launch(&m, &j, Some(&process)).is_err());
    }
    #[test]
    fn adoption_rewrites_only_proven_executable_and_managed_launch_priority() {
        let original = r#"<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.pacer.serve</string><key>ProgramArguments</key><array><string>/tmp/attached/pacer</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>/tmp/home</string><key>PACER_HOME</key><string>/tmp/home</string></dict><key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>ThrottleInterval</key><integer>27</integer><key>ProcessType</key><string>Background</string><key>StandardOutPath</key><string>/tmp/home/log</string></dict></plist>"#;
        let old_bytes = original.as_bytes().to_vec();
        let old_hash = digest(&old_bytes);
        let bytes = replacement_registration(
            &old_bytes,
            "/tmp/attached/pacer",
            "/tmp/current.app/Contents/Resources/pacer",
        )
        .unwrap();
        let mut expected =
            plist::Value::from_reader(std::io::Cursor::new(original.as_bytes())).unwrap();
        expected
            .as_dictionary_mut()
            .unwrap()
            .get_mut("ProgramArguments")
            .unwrap()
            .as_array_mut()
            .unwrap()[0] = "/tmp/current.app/Contents/Resources/pacer".into();
        expected
            .as_dictionary_mut()
            .unwrap()
            .insert("ProcessType".into(), "Standard".into());
        assert_eq!(
            plist::Value::from_reader(std::io::Cursor::new(&bytes)).unwrap(),
            expected
        );
        assert_eq!(old_bytes, original.as_bytes());
        assert_eq!(digest(&old_bytes), old_hash);
        assert_ne!(digest(&bytes), old_hash);
        // Reversing the executable alone would retain Standard. Recovery must
        // use the separately retained original bytes and their original hash.
        let reversed = replacement_registration(
            &bytes,
            "/tmp/current.app/Contents/Resources/pacer",
            "/tmp/attached/pacer",
        )
        .unwrap();
        assert_ne!(reversed, old_bytes);
        let target = journal::tests::manifest().source.target;
        let managed_binary = "/tmp/current.app/Contents/Resources/pacer";
        let managed_id = resulting_installation_id(
            &target,
            managed_binary,
            std::str::from_utf8(&bytes).unwrap(),
        )
        .unwrap();
        assert_ne!(
            managed_id,
            resulting_installation_id(&target, managed_binary, original).unwrap()
        );
        assert!(replacement_registration(original.as_bytes(), "/tmp/other", "/tmp/new").is_err());
        let mut redirected = original.replace(
            "</dict></plist>",
            "<key>Program</key><string>/tmp/foreign</string></dict></plist>",
        );
        assert!(
            replacement_registration(redirected.as_bytes(), "/tmp/attached/pacer", "/tmp/new")
                .is_err()
        );
        redirected = original.replace(
            "<key>KeepAlive</key><true/>",
            "<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>",
        );
        assert!(
            replacement_registration(redirected.as_bytes(), "/tmp/attached/pacer", "/tmp/new")
                .is_err()
        );
    }
    #[test]
    fn managed_replacement_keeps_non_background_process_types() {
        for priority in ["Standard", "Interactive"] {
            let original = format!(
                r#"<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.pacer.serve</string><key>ProgramArguments</key><array><string>/tmp/attached/pacer</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>HOME</key><string>/tmp/home</string></dict><key>KeepAlive</key><true/><key>RunAtLoad</key><true/><key>ProcessType</key><string>{priority}</string></dict></plist>"#
            );
            let changed = replacement_registration(
                original.as_bytes(),
                "/tmp/attached/pacer",
                "/tmp/current.app/Contents/Resources/pacer",
            )
            .unwrap();
            let parsed = plist::Value::from_reader(std::io::Cursor::new(changed)).unwrap();
            assert_eq!(
                parsed
                    .as_dictionary()
                    .unwrap()
                    .get("ProcessType")
                    .unwrap()
                    .as_string(),
                Some(priority)
            );
        }
    }
    #[test]
    fn adoption_result_id_matches_ordered_typescript_identity_contract() {
        let target = journal::tests::manifest().source.target;
        let binary = format!("{}/Contents/Resources/pacer", target.app_path);
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/adoption-identity.json"
        ))
        .unwrap();
        assert_eq!(
            resulting_installation_id(
                &target,
                &binary,
                fixture["registrationText"].as_str().unwrap()
            )
            .unwrap(),
            fixture["expected"].as_str().unwrap()
        );
    }
    #[cfg(feature = "ota-fixture")]
    #[test]
    fn readiness_identity_trace_contains_only_fixed_stage_and_bounded_process_identity() {
        let process = ProcessIdentity {
            pid: 42,
            boot_id: "fixture-boot".into(),
            birth: "fixture-birth".into(),
        };
        let bytes = readiness_identity_payload(ReadinessIdentityStage::Launch, Some(&process))
            .expect("fixed trace should fit");
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["stage"], "launch");
        assert_eq!(value["process"], serde_json::to_value(process).unwrap());
        assert_eq!(value.as_object().unwrap().len(), 2);
        assert!(bytes.len() <= 512);
        let oversized = ProcessIdentity {
            pid: 43,
            boot_id: "x".repeat(512),
            birth: "fixture-birth".into(),
        };
        assert!(readiness_identity_payload(
            ReadinessIdentityStage::ProcessInspection,
            Some(&oversized)
        )
        .is_none());
    }
}

use crate::ota::{
    self as ota, control, AssetIdentity, AwakeStamp, PlatformFuture, RecoveryJob, TransactionLocks,
    VerificationPurpose, VerifiedNativeAuthority,
};
impl NativeAdoptionPlatform {
    fn source_path(&self) -> Result<PathBuf, OtaError> {
        if let Some(policy) = self.trust.fixture_policy() {
            policy.validate_live().map_err(|_| OtaError::Identity)?;
            ensure(
                self.source.target.pacer_home == policy.home.to_string_lossy()
                    && self.source.target.app_path == policy.current_app.to_string_lossy()
                    && self.source.target.port == policy.port
                    && self.source.target.service_label == policy.service_label,
            )?;
            return Ok(policy
                .root
                .join("registrations")
                .join(format!("{}.plist", policy.service_label)));
        }
        ensure(self.source.target.service_label == "com.pacer.serve")?;
        Ok(user_home(&self.trust)?.join("Library/LaunchAgents/com.pacer.serve.plist"))
    }
    fn verify_app(&self) -> Result<(), OtaError> {
        let app = Path::new(&self.source.target.app_path);
        ensure(app.canonicalize().map_err(|_| OtaError::Identity)? == app)?;
        self.trust.verify_static(app, CodeRole::Desktop)?;
        for (path, role) in [
            (app.join("Contents/Resources/pacer"), CodeRole::Cli),
            (
                app.join("Contents/Resources/pacer-update-helper"),
                CodeRole::Helper,
            ),
        ] {
            ensure(path.canonicalize().map_err(|_| OtaError::Identity)? == path)?;
            self.trust.verify_static(&path, role)?;
        }
        let metadata: serde_json::Value =
            serde_json::from_slice(&ota::platform_fs::read_owned_file(
                &app.join("Contents/Resources/pacer-release.json"),
                65536,
            )?)
            .map_err(|_| OtaError::Invalid)?;
        ensure(
            metadata["schema"] == 1
                && metadata["bundleId"] == "dev.pacer.desktop"
                && metadata["version"] == self.source.target.version
                && metadata["admissionProtocol"] == 1
                && metadata["rollbackCompatible"] == true
                && metadata["arch"] == ota::updater::arch_name(self.source.target.arch)
                && metadata["protocolMajors"]
                    .as_array()
                    .is_some_and(|a| a.contains(&serde_json::json!(3))),
        )?;
        let info = plist::Value::from_reader(std::io::Cursor::new(
            ota::platform_fs::read_owned_file(&app.join("Contents/Info.plist"), 65536)?,
        ))
        .map_err(|_| OtaError::Invalid)?;
        let info = info.as_dictionary().ok_or(OtaError::Invalid)?;
        for (key, expected) in [
            ("CFBundleIdentifier", "dev.pacer.desktop"),
            ("CFBundleExecutable", "pacer"),
            ("CFBundleVersion", self.source.target.version.as_str()),
            (
                "CFBundleShortVersionString",
                self.source.target.version.as_str(),
            ),
        ] {
            ensure(info.get(key).and_then(plist::Value::as_string) == Some(expected))?;
        }
        Ok(())
    }
    fn snapshot(&self, m: &AdoptionManifest) -> Result<journal::AdoptionJournal, OtaError> {
        let bytes = self.assets.read("adoption-prepared.json", 1_048_576)?;
        let stored: AdoptionManifest =
            serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
        ensure(stored == *m)?;
        let journal: journal::AdoptionJournal =
            serde_json::from_slice(&self.assets.read("adoption-journal.json", 1_048_576)?)
                .map_err(|_| OtaError::Invalid)?;
        journal.validate(m, &digest(&bytes))?;
        Ok(journal)
    }
    fn registration(
        &self,
        m: &AdoptionManifest,
        branch: control::AdoptionBranch,
    ) -> Result<Vec<u8>, OtaError> {
        let asset = if branch == control::AdoptionBranch::Original {
            &m.old_registration
        } else {
            &m.new_registration
        };
        let bytes = self.assets.read(&asset.relative_path, 131072)?;
        ensure(digest(&bytes) == asset.sha256)?;
        Ok(bytes)
    }
    fn verify_assets(&self, m: &AdoptionManifest) -> Result<(), OtaError> {
        journal::validate_manifest(m)?;
        ensure(m.binding == self.binding && m.source == self.source && m.request == self.request)?;
        if let Some(recovered) = &self.recovered {
            ensure(recovered == m)?;
        }
        self.verify_app()?;
        let old = self.registration(m, control::AdoptionBranch::Original)?;
        let new = self.registration(m, control::AdoptionBranch::Managed)?;
        ensure(
            replacement_registration(
                &old,
                &self.source.old_service_executable,
                &self.source.new_service_executable,
            )? == new,
        )?;
        ensure(
            resulting_installation_id(
                &self.source.target,
                &self.source.new_service_executable,
                std::str::from_utf8(&new).map_err(|_| OtaError::Invalid)?,
            )? == m.expected_new_installation_id,
        )?;
        for path in [
            &self.source.old_service_executable,
            &self.source.new_service_executable,
        ] {
            ensure(
                Path::new(path)
                    .canonicalize()
                    .map_err(|_| OtaError::Identity)?
                    == Path::new(path),
            )?;
            self.trust.verify_static(Path::new(path), CodeRole::Cli)?;
        }
        ensure(
            digest(&ota::platform_fs::read_owned_file(
                &self.assets.path.join(&m.recovery_job.helper.relative_path),
                134217728,
            )?) == m.recovery_job.helper.sha256,
        )?;
        self.trust.verify_static(
            &self.assets.path.join(&m.recovery_job.helper.relative_path),
            CodeRole::Helper,
        )?;
        Ok(())
    }
    fn job(&self, bytes: &[u8], branch: control::AdoptionBranch) -> Result<OwnedJob, OtaError> {
        let definition = JobDefinition::from_plist(bytes)?;
        let executable = if branch == control::AdoptionBranch::Original {
            &self.source.old_service_executable
        } else {
            &self.source.new_service_executable
        };
        ensure(
            definition.label == self.source.target.service_label
                && definition.arguments == vec![executable.clone(), "serve".into()],
        )?;
        ensure(
            definition.environment.get("HOME").map(String::as_str)
                == user_home(&self.trust)?.to_str()
                && definition.environment.get("PACER_HOME") == Some(&self.source.target.pacer_home)
                && definition
                    .environment
                    .get("PACER_PORT")
                    .map(String::as_str)
                    .unwrap_or("4317")
                    == self.source.target.port.to_string(),
        )?;
        Ok(OwnedJob {
            definition,
            plist_path: self.source_path()?,
            role: CodeRole::Cli,
        })
    }
    fn current_job(
        &self,
        m: &AdoptionManifest,
    ) -> Result<(OwnedJob, control::AdoptionBranch), OtaError> {
        let bytes = ota::platform_fs::read_owned_file(&self.source_path()?, 131072)?;
        let hash = digest(&bytes);
        let branch = if hash == m.old_registration.sha256 {
            control::AdoptionBranch::Original
        } else if hash == m.new_registration.sha256 {
            control::AdoptionBranch::Managed
        } else {
            return Err(OtaError::Identity);
        };
        Ok((self.job(&bytes, branch)?, branch))
    }
    fn current_service(
        &self,
        m: &AdoptionManifest,
    ) -> Result<Option<(ProcessIdentity, PathBuf)>, OtaError> {
        self.current_service_traced(m, false)
    }
    fn current_service_traced(
        &self,
        m: &AdoptionManifest,
        trace_managed_readiness: bool,
    ) -> Result<Option<(ProcessIdentity, PathBuf)>, OtaError> {
        let (job, _) = self.current_job(m).map_err(|error| {
            if trace_managed_readiness && matches!(error, OtaError::Identity) {
                record_readiness_identity!(self, ReadinessIdentityStage::Registration, None);
            }
            error
        })?;
        let Some(loaded) = job.observe(&self.trust).map_err(|error| {
            if trace_managed_readiness && matches!(error, OtaError::Identity) {
                record_readiness_identity!(self, ReadinessIdentityStage::JobObservation, None);
            }
            error
        })?
        else {
            return Ok(None);
        };
        let pid = loaded.pid.ok_or(OtaError::Unavailable)?;
        let details = native::process_details(pid).map_err(|_| {
            if trace_managed_readiness {
                record_readiness_identity!(self, ReadinessIdentityStage::ProcessInspection, None);
            }
            OtaError::Identity
        })?;
        let Some(details) = details else {
            if trace_managed_readiness {
                record_readiness_identity!(self, ReadinessIdentityStage::ProcessMissing, None);
            }
            return Err(OtaError::Identity);
        };
        if details.uid as u64 != m.source.target.owner_uid {
            if trace_managed_readiness {
                record_readiness_identity!(
                    self,
                    ReadinessIdentityStage::Owner,
                    Some(&details.identity)
                );
            }
            return Err(OtaError::Identity);
        }
        if details.executable != Path::new(&job.definition.arguments[0]) {
            if trace_managed_readiness {
                record_readiness_identity!(
                    self,
                    ReadinessIdentityStage::Executable,
                    Some(&details.identity)
                );
            }
            return Err(OtaError::Identity);
        }
        self.trust
            .verify_process(&details.identity, CodeRole::Cli)
            .map_err(|error| {
                if trace_managed_readiness && matches!(error, OtaError::Identity) {
                    record_readiness_identity!(
                        self,
                        ReadinessIdentityStage::CodeSignature,
                        Some(&details.identity)
                    );
                }
                error
            })?;
        Ok(Some((details.identity, details.executable)))
    }
    fn endpoint<'a>(
        &'a self,
        process: &'a ProcessIdentity,
        executable: &'a Path,
    ) -> control::ServiceEndpoint<'a> {
        control::ServiceEndpoint {
            home: Path::new(&self.source.target.pacer_home),
            port: self.source.target.port,
            process,
            executable,
        }
    }
    fn checked_context(
        &self,
        m: &AdoptionManifest,
        process: &ProcessIdentity,
        executable: &Path,
    ) -> Result<AdoptionContext, OtaError> {
        let context = control::adoption_context(
            &self.endpoint(process, executable),
            &m.binding,
            &self.trust,
        )?;
        ensure(
            context.source == m.source
                && context.request == m.request
                && context.transaction.reservation_id == m.transaction_id(),
        )?;
        Ok(context)
    }
    fn recovery_job(&self, m: &AdoptionManifest) -> Result<OwnedJob, OtaError> {
        let definition = JobDefinition {
            label: m.recovery_job.label.clone(),
            arguments: vec![
                self.assets
                    .path
                    .join(&m.recovery_job.helper.relative_path)
                    .to_string_lossy()
                    .into_owned(),
                "--ota-recover-adoption".into(),
                m.source.target.id.clone(),
                m.transaction_id().into(),
            ],
            environment: [(
                "HOME".into(),
                user_home(&self.trust)?.to_string_lossy().into_owned(),
            )]
            .into_iter()
            .collect(),
            keep_alive: true,
            run_at_load: true,
        };
        let plist_path = if let Some(policy) = self.trust.fixture_policy() {
            policy
                .root
                .join("registrations")
                .join(format!("{}.plist", m.recovery_job.label))
        } else {
            user_home(&self.trust)?
                .join("Library/LaunchAgents")
                .join(format!("{}.plist", m.recovery_job.label))
        };
        Ok(OwnedJob {
            definition,
            plist_path,
            role: CodeRole::Helper,
        })
    }
    fn recovery_loaded(&self, m: &AdoptionManifest) -> Result<Option<LoadedJob>, OtaError> {
        let job = self.recovery_job(m)?;
        if !exact_absent(&job.plist_path)? {
            return job.observe(&self.trust);
        }
        let value = copy_user_job(&job.definition.label)?;
        if value.is_none() {
            return Ok(None);
        }
        ensure(matches!(
            self.snapshot(m)?.state,
            journal::AdoptionState::Committed | journal::AdoptionState::Restored
        ))?;
        self.trust
            .verify_static(Path::new(&job.definition.arguments[0]), CodeRole::Helper)?;
        value.map(|v| job.definition.match_loaded(&v)).transpose()
    }
    fn require_effect(
        &self,
        m: &AdoptionManifest,
        action: &AdoptionAction,
    ) -> Result<journal::AdoptionJournal, OtaError> {
        let journal = self.snapshot(m)?;
        ensure(
            journal
                .steps
                .iter()
                .any(|step| &step.action == action && step.evidence.is_none()),
        )?;
        let terminal = matches!(
            journal.state,
            journal::AdoptionState::Committed | journal::AdoptionState::Restored
        );
        if terminal {
            ensure(matches!(
                action,
                AdoptionAction::ReleaseReservation | AdoptionAction::RetireRecovery
            ))?;
        }
        if journal.authorization.is_none() {
            ensure(
                matches!(
                    action,
                    AdoptionAction::BackupRegistration | AdoptionAction::ArmRecovery
                ) || (terminal
                    && matches!(
                        action,
                        AdoptionAction::ReleaseReservation | AdoptionAction::RetireRecovery
                    )),
            )?;
        }
        let held = ota::recovery_authority::verify_adoption(
            Path::new(&m.source.target.pacer_home),
            m,
            &journal,
        )?;
        if !terminal {
            ensure(held)?;
        }
        Ok(journal)
    }
    fn reconnect_plan(
        &self,
        m: &AdoptionManifest,
        capability: Option<&RecoveryReconnectCapability>,
    ) -> Result<control::AdoptionReconnectPlan, OtaError> {
        let original_id = capability
            .map(|c| c.original_launch_id.as_str())
            .unwrap_or(&m.original_launch_id);
        let branch =
            |branch: control::AdoptionBranch, launch_id: &str| control::AdoptionBranchPlan {
                branch,
                launch_id: launch_id.into(),
                nonce: launch_id.into(),
                executable: if branch == control::AdoptionBranch::Original {
                    m.source.old_service_executable.clone()
                } else {
                    m.source.new_service_executable.clone()
                },
                version: m.version(branch).into(),
                installation_id: m.resulting_id(branch).into(),
            };
        let plan = control::AdoptionReconnectPlan {
            schema: 1,
            kind: "adoption".into(),
            recovery: capability.is_some(),
            installation_id: m.source.target.id.clone(),
            transaction_id: m.transaction_id().into(),
            native_session_id: capability
                .map(|c| c.native_session_id.clone())
                .unwrap_or_else(|| m.source.native_session_id.clone()),
            manifest_sha256: digest(&self.assets.read("adoption-prepared.json", 1_048_576)?),
            desktop: capability
                .map(|c| c.desktop.clone())
                .unwrap_or_else(|| m.source.desktop.clone()),
            managed: if capability.is_none() {
                Some(branch(
                    control::AdoptionBranch::Managed,
                    &m.managed_launch_id,
                ))
            } else {
                None
            },
            original: branch(control::AdoptionBranch::Original, original_id),
        };
        plan.validate()?;
        Ok(plan)
    }
}

impl AdoptionPlatform for NativeAdoptionPlatform {
    fn awake_now(&self) -> Result<AwakeStamp, OtaError> {
        native::awake_now().map_err(|_| OtaError::Identity)
    }
    fn acquire_transaction_locks<'a>(
        &'a self,
        target: &'a Installation,
    ) -> PlatformFuture<'a, Box<dyn TransactionLocks>> {
        Box::pin(async move {
            ensure(*target == self.source.target)?;
            let root = if let Some(policy) = self.trust.fixture_policy() {
                policy.validate_live().map_err(|_| OtaError::Identity)?;
                policy.root.join("locks")
            } else {
                use std::os::unix::fs::MetadataExt;
                let parent =
                    std::fs::symlink_metadata("/private/tmp").map_err(|_| OtaError::Identity)?;
                ensure(parent.is_dir() && parent.uid() == 0 && parent.mode() & 0o1000 != 0)?;
                PathBuf::from(format!("/private/tmp/pacer-ota-{}", unsafe {
                    libc::geteuid()
                }))
            };
            Ok(Box::new(
                PrivateDir::create(&root)?
                    .acquire_locks(Path::new(&target.app_path), Path::new(&target.pacer_home))?,
            ) as Box<dyn TransactionLocks>)
        })
    }
    fn verify_preconditions<'a>(
        &'a self,
        request: &'a AdoptionRequest,
    ) -> PlatformFuture<'a, VerifiedAdoptionPreparation> {
        Box::pin(async move {
            ensure(
                self.recovered.is_none()
                    && request.binding == self.binding
                    && request.target == self.source.target
                    && request.authority.binding() == &self.binding,
            )?;
            self.verify_app()?;
            let current = control::adoption_context(
                &self.endpoint(
                    &self.source.service,
                    Path::new(&self.source.old_service_executable),
                ),
                &self.binding,
                &self.trust,
            )?;
            ensure(
                current.source == self.source
                    && current.request == self.request
                    && current.service == self.source.service
                    && current.transaction.reservation_id
                        == self.binding.transaction_id.as_deref().unwrap_or("")
                    && !current.transaction.authorized
                    && self.awake_now()?.boot_id == self.source.boot_id,
            )?;
            let desktop = self
                .trust
                .verify_process(&self.source.desktop, CodeRole::Desktop)?;
            ensure(
                desktop.details().executable
                    == Path::new(&self.source.target.app_path).join("Contents/MacOS/pacer"),
            )?;
            let old = ota::platform_fs::read_owned_file(&self.source_path()?, 131072)?;
            let job = self.job(&old, control::AdoptionBranch::Original)?;
            ensure(
                job.observe(&self.trust)?.and_then(|j| j.pid) == Some(self.source.service.pid)
                    && !disabled_state(&job.definition.label).await?,
            )?;
            self.trust
                .verify_process(&self.source.service, CodeRole::Cli)?;
            let new = replacement_registration(
                &old,
                &self.source.old_service_executable,
                &self.source.new_service_executable,
            )?;
            self.assets.write_new("old-registration.plist", &old)?;
            self.assets.write_new("new-registration.plist", &new)?;
            let helper = Path::new(&self.source.target.app_path)
                .join("Contents/Resources/pacer-update-helper");
            let helper_hash = digest(&ota::platform_fs::read_owned_file(&helper, 134217728)?);
            self.assets.stage_helper(&helper, &helper_hash)?;
            let manifest = AdoptionManifest {
                schema: 1,
                transaction_kind: "adoption".into(),
                binding: self.binding.clone(),
                source: self.source.clone(),
                request: self.request.clone(),
                expected_new_installation_id: resulting_installation_id(
                    &self.source.target,
                    &self.source.new_service_executable,
                    std::str::from_utf8(&new).map_err(|_| OtaError::Invalid)?,
                )?,
                managed_launch_id: ota::journal::random_id()?,
                original_launch_id: ota::journal::random_id()?,
                old_registration: AssetIdentity {
                    relative_path: "old-registration.plist".into(),
                    sha256: digest(&old),
                },
                new_registration: AssetIdentity {
                    relative_path: "new-registration.plist".into(),
                    sha256: digest(&new),
                },
                recovery_job: RecoveryJob {
                    label: self
                        .trust
                        .fixture_policy()
                        .map(|p| p.recovery_label.clone())
                        .unwrap_or_else(|| {
                            format!(
                                "com.pacer.adoption.{}.{}",
                                self.source.target.id,
                                self.binding.transaction_id.as_deref().unwrap_or("")
                            )
                        }),
                    helper: AssetIdentity {
                        relative_path: "pacer-update-helper".into(),
                        sha256: helper_hash,
                    },
                },
            };
            self.verify_assets(&manifest)?;
            let recovery = self.recovery_job(&manifest)?;
            // The recovery registration is written later; observe() would read it.
            ensure(
                copy_user_job(&recovery.definition.label)?.is_none()
                    && !disabled_state(&recovery.definition.label).await?,
            )?;
            self.assets
                .write_new("recovery.plist", &recovery.definition.to_plist()?)?;
            Ok(VerifiedAdoptionPreparation {
                manifest,
                authority: VerifiedNativeAuthority::verified(self.binding.clone()),
            })
        })
    }
    fn reverify<'a>(
        &'a self,
        m: &'a AdoptionManifest,
        purpose: VerificationPurpose,
    ) -> PlatformFuture<'a, VerifiedNativeAuthority> {
        Box::pin(async move {
            self.verify_assets(m)?;
            let journal = self.snapshot(m)?;
            ota::recovery_authority::verify_adoption(
                Path::new(&m.source.target.pacer_home),
                m,
                &journal,
            )?;
            if matches!(
                purpose,
                VerificationPurpose::Prepare | VerificationPurpose::Authorize
            ) {
                let context = self.checked_context(
                    m,
                    &m.source.service,
                    Path::new(&m.source.old_service_executable),
                )?;
                ensure(
                    context.service == m.source.service
                        && self.current_job(m)?.1 == control::AdoptionBranch::Original
                        && self.awake_now()?.boot_id == m.source.boot_id
                        && !disabled_state(&m.source.target.service_label).await?,
                )?;
            }
            Ok(VerifiedNativeAuthority::verified(m.binding.clone()))
        })
    }
    fn observe<'a>(&'a self, m: &'a AdoptionManifest) -> PlatformFuture<'a, AdoptionObservation> {
        Box::pin(async move {
            let journal = self.snapshot(m)?;
            let held = ota::recovery_authority::verify_adoption(
                Path::new(&m.source.target.pacer_home),
                m,
                &journal,
            )?;
            let (_, branch) = self.current_job(m)?;
            let service = match self.current_service(m)? {
                Some((p, e)) => {
                    self.checked_context(m, &p, &e)?;
                    Some(p)
                }
                None => None,
            };
            Ok(AdoptionObservation {
                registration: if branch == control::AdoptionBranch::Original {
                    RegistrationObservation::Original
                } else {
                    RegistrationObservation::Managed
                },
                reservation_held: held,
                recovery_job_armed: self.recovery_loaded(m)?.is_some(),
                service,
            })
        })
    }
    fn observe_managed_recovery<'a>(
        &'a self,
        m: &'a AdoptionManifest,
    ) -> PlatformFuture<'a, Option<AdoptionObservation>> {
        Box::pin(async move {
            let journal = self.snapshot(m)?;
            let held = ota::recovery_authority::verify_adoption(
                Path::new(&m.source.target.pacer_home),
                m,
                &journal,
            )?;
            let (_, branch) = self.current_job(m)?;
            if branch != control::AdoptionBranch::Managed {
                return Ok(None);
            }
            let service = self.current_service(m)?.map(|(process, _)| process);
            if service.is_none() && !journal.steps.iter().any(|step| matches!(
                (&step.action, &step.evidence),
                (
                    AdoptionAction::LaunchService { branch: control::AdoptionBranch::Managed, .. },
                    Some(AdoptionEvidence::Launched { branch: control::AdoptionBranch::Managed, .. })
                )
            )) {
                return Ok(None);
            }
            prove_managed_recovery_launch(m, &journal, service.as_ref())?;
            Ok(Some(AdoptionObservation {
                registration: RegistrationObservation::Managed,
                reservation_held: held,
                recovery_job_armed: self.recovery_loaded(m)?.is_some(),
                service,
            }))
        })
    }
    fn inspect_action<'a>(
        &'a self,
        m: &'a AdoptionManifest,
        action: &'a AdoptionAction,
    ) -> PlatformFuture<'a, AdoptionActionObservation> {
        Box::pin(async move {
            use AdoptionAction as P;
            use AdoptionActionObservation as A;
            use AdoptionEvidence as E;
            let complete = A::Completed(E::Complete);
            match action {
                P::BackupRegistration => {
                    self.verify_assets(m)?;
                    Ok(complete)
                }
                P::ArmRecovery => Ok(if self.recovery_loaded(m)?.is_some() {
                    complete
                } else {
                    A::NotStarted
                }),
                P::SuppressLifecycle => {
                    Ok(if self.current_job(m)?.0.observe(&self.trust)?.is_none() {
                        complete
                    } else {
                        A::NotStarted
                    })
                }
                P::PrepareReconnect => Ok(A::NotStarted),
                P::PrepareRecoveryReconnect { capability } => {
                    if let Some((p, e)) = self.current_service(m)? {
                        if let Some(proof) = control::query_adoption_readiness(
                            &self.endpoint(&p, &e),
                            &m.binding,
                            control::AdoptionBranch::Original,
                            &self.trust,
                        )? {
                            if proof.desktop == capability.desktop
                                && proof.native_session_id == capability.original_launch_id
                            {
                                return Ok(complete);
                            }
                        }
                    }
                    Ok(A::NotStarted)
                }
                P::StopService { process } => {
                    let loaded = self.current_job(m)?.0.observe(&self.trust)?;
                    if loaded.is_none() && original_process_gone(process)? {
                        Ok(complete)
                    } else if loaded.and_then(|j| j.pid) == Some(process.pid)
                        && !original_process_gone(process)?
                    {
                        Ok(A::NotStarted)
                    } else {
                        Ok(A::Ambiguous)
                    }
                }
                P::SwitchRegistration { branch } => Ok(if self.current_job(m)?.1 == *branch {
                    complete
                } else {
                    A::NotStarted
                }),
                P::LaunchService { branch, launch_id } => {
                    if exact_absent(&self.assets.path.join(format!("launch-{launch_id}")))? {
                        return Ok(A::NotStarted);
                    }
                    if let Some(launch) = self.observed_launch(m, *branch, launch_id)? {
                        Ok(A::Completed(E::Launched {
                            branch: *branch,
                            launch,
                        }))
                    } else {
                        Ok(A::Ambiguous)
                    }
                }
                P::LaunchRecoveryDesktop { launch_id } => {
                    if exact_absent(&self.assets.path.join(format!("launch-{launch_id}")))? {
                        return Ok(A::NotStarted);
                    }
                    match self.desktop_birth(launch_id)? {
                        Some(process) => Ok(A::Completed(E::DesktopSpawned { process })),
                        None => Ok(A::Ambiguous),
                    }
                }
                P::ReleaseReservation => {
                    let j = self.snapshot(m)?;
                    ensure(matches!(
                        j.state,
                        journal::AdoptionState::Committed | journal::AdoptionState::Restored
                    ))?;
                    Ok(
                        if !ota::recovery_authority::verify_adoption(
                            Path::new(&m.source.target.pacer_home),
                            m,
                            &j,
                        )? {
                            complete
                        } else {
                            A::NotStarted
                        },
                    )
                }
                P::RetireRecovery => Ok(
                    if self.recovery_loaded(m)?.is_none()
                        && (self.trust.fixture_policy().is_some()
                            || exact_absent(&self.recovery_job(m)?.plist_path)?)
                    {
                        complete
                    } else {
                        A::NotStarted
                    },
                ),
            }
        })
    }
    fn perform<'a>(
        &'a self,
        m: &'a AdoptionManifest,
        action: &'a AdoptionAction,
        authority: &'a VerifiedNativeAuthority,
    ) -> PlatformFuture<'a, AdoptionEvidence> {
        Box::pin(async move {
            use AdoptionAction as P;
            ensure(authority.binding() == &m.binding)?;
            self.require_effect(m, action)?;
            self.verify_assets(m)?;
            match action {
                P::BackupRegistration => {}
                P::ArmRecovery => {
                    let job = self.recovery_job(m)?;
                    let bytes = self.assets.read("recovery.plist", 131072)?;
                    ensure(bytes == job.definition.to_plist()?)?;
                    job.stage_fixture_registration(&self.trust, &bytes)?;
                    ota::platform_fs::publish_registration(&job.plist_path, &bytes)?;
                    job.change(&self.trust, JobChange::Bootstrap).await?;
                }
                P::PrepareReconnect | P::PrepareRecoveryReconnect { .. } => {
                    let (p, e) = self.current_service(m)?.ok_or(OtaError::Unavailable)?;
                    self.checked_context(m, &p, &e)?;
                    let cap = if let P::PrepareRecoveryReconnect { capability } = action {
                        Some(capability)
                    } else {
                        None
                    };
                    control::prepare_adoption_reconnect(
                        &self.endpoint(&p, &e),
                        &m.binding,
                        &self.reconnect_plan(m, cap)?,
                        &self.trust,
                    )?;
                }
                P::SuppressLifecycle => {
                    let (p, e) = self.current_service(m)?.ok_or(OtaError::Unavailable)?;
                    control::suppress_adoption_lifecycle(
                        &self.endpoint(&p, &e),
                        &m.binding,
                        &self.trust,
                    )?;
                }
                P::StopService { process } => {
                    let (p, e) = self.current_service(m)?.ok_or(OtaError::Unavailable)?;
                    ensure(p == *process)?;
                    let journal = self.require_effect(m, action)?;
                    if self.current_job(m)?.1 == control::AdoptionBranch::Managed
                        && journal.state == journal::AdoptionState::Restoring
                    {
                        prove_managed_recovery_launch(m, &journal, Some(&p))?;
                    } else {
                        self.checked_context(m, &p, &e)?;
                        control::suppress_adoption_lifecycle(
                            &self.endpoint(&p, &e),
                            &m.binding,
                            &self.trust,
                        )?;
                    }
                    self.require_effect(m, action)?;
                    let job = self.current_job(m)?.0;
                    job.stop_exact(&self.trust, process).await?;
                    wait_exact_exit(process).await?;
                    ensure(job.observe(&self.trust)?.is_none())?;
                }
                P::SwitchRegistration { branch } => {
                    let (job, current) = self.current_job(m)?;
                    ensure(job.observe(&self.trust)?.is_none())?;
                    let expected = self.registration(m, current)?;
                    let next = self.registration(m, *branch)?;
                    self.job(&next, *branch)?
                        .stage_fixture_registration(&self.trust, &next)?;
                    self.require_effect(m, action)?;
                    ota::platform_fs::replace_registration(&self.source_path()?, &expected, &next)?;
                }
                P::LaunchService { branch, launch_id } => {
                    return self.launch_service(m, *branch, launch_id).await
                }
                P::LaunchRecoveryDesktop { launch_id } => {
                    return self.launch_desktop(m, launch_id).await
                }
                P::ReleaseReservation => {
                    let (p, e) = self.current_service(m)?.ok_or(OtaError::Unavailable)?;
                    control::release_adoption(&self.endpoint(&p, &e), &m.binding, &self.trust)?;
                }
                P::RetireRecovery => {
                    let mut job = self.recovery_job(m)?;
                    let bytes = self.assets.read("recovery.plist", 131072)?;
                    ensure(bytes == job.definition.to_plist()?)?;
                    if self.trust.fixture_policy().is_none() {
                        if !exact_absent(&job.plist_path)? {
                            ota::platform_fs::remove_registration(&job.plist_path, &bytes)?;
                        }
                        job.plist_path = self.assets.path.join("recovery.plist");
                    }
                    job.change(&self.trust, JobChange::Bootout).await?;
                }
            }
            Ok(AdoptionEvidence::Complete)
        })
    }
    fn recovery_desktop<'a>(
        &'a self,
        m: &'a AdoptionManifest,
        launch: &'a ota::LaunchEvidence,
    ) -> PlatformFuture<'a, Option<VerifiedRecoveryDesktop>> {
        Box::pin(async move {
            let Some((p, e)) = self.current_service(m)? else {
                return Ok(None);
            };
            ensure(p == launch.process)?;
            let Some(context) = control::adoption_recovery_context(
                &self.endpoint(&p, &e),
                &m.binding,
                &self.trust,
            )?
            else {
                return Ok(None);
            };
            let peer = self
                .trust
                .verify_process(&context.desktop, CodeRole::Desktop)?;
            ensure(
                peer.details().executable
                    == Path::new(&m.source.target.app_path).join("Contents/MacOS/pacer")
                    && context.service_version == m.source.service_version
                    && context.desktop.boot_id == self.awake_now()?.boot_id,
            )?;
            Ok(Some(VerifiedRecoveryDesktop {
                desktop: context.desktop,
                native_session_id: context.native_session_id,
                service: p,
            }))
        })
    }
    fn poll_readiness<'a>(
        &'a self,
        m: &'a AdoptionManifest,
        branch: control::AdoptionBranch,
        launch: &'a ota::LaunchEvidence,
    ) -> PlatformFuture<'a, AdoptionReadiness> {
        Box::pin(async move {
            let trace_managed = branch == control::AdoptionBranch::Managed;
            let Some((p, e)) = self.current_service_traced(m, trace_managed)? else {
                return Ok(AdoptionReadiness::Pending);
            };
            if p != launch.process {
                if trace_managed {
                    record_readiness_identity!(self, ReadinessIdentityStage::Launch, Some(&p));
                }
                return Err(OtaError::Identity);
            }
            #[cfg(feature = "ota-fixture")]
            if branch == control::AdoptionBranch::Managed
                && crate::ota::fixture_fault::consume(
                    crate::ota::fixture_fault::Point::AdoptionStartup,
                    &m.binding.installation_id,
                    m.transaction_id(),
                )?
            {
                return Ok(AdoptionReadiness::Failed);
            }
            Ok(
                match control::query_adoption_readiness(
                    &self.endpoint(&p, &e),
                    &m.binding,
                    branch,
                    &self.trust,
                )
                .map_err(|error| {
                    if trace_managed && matches!(error, OtaError::Identity) {
                        record_readiness_identity!(
                            self,
                            ReadinessIdentityStage::ServiceQuery,
                            Some(&p)
                        );
                    }
                    error
                })? {
                    Some(proof) => {
                        self.trust
                            .verify_process(&proof.desktop, CodeRole::Desktop)
                            .map_err(|error| {
                                if trace_managed && matches!(error, OtaError::Identity) {
                                    record_readiness_identity!(
                                        self,
                                        ReadinessIdentityStage::DesktopSignature,
                                        Some(&proof.desktop)
                                    );
                                }
                                error
                            })?;
                        AdoptionReadiness::Ready(proof)
                    }
                    None => AdoptionReadiness::Pending,
                },
            )
        })
    }
    fn wait_for_observation<'a>(&'a self) -> PlatformFuture<'a, ()> {
        Box::pin(async {
            tokio::time::sleep(ota::OBSERVATION_INTERVAL).await;
            Ok(())
        })
    }
}

impl NativeAdoptionPlatform {
    fn observed_launch(
        &self,
        m: &AdoptionManifest,
        branch: control::AdoptionBranch,
        id: &str,
    ) -> Result<Option<ota::LaunchEvidence>, OtaError> {
        let Some((p, e)) = self.current_service(m)? else {
            return Ok(None);
        };
        let Some(launch) = control::observe_adoption_launch(
            &self.endpoint(&p, &e),
            &m.binding,
            branch,
            &self.trust,
        )?
        else {
            return Ok(None);
        };
        ensure(
            launch.process == p
                && launch.role == ota::ProcessRole::Service
                && launch.release
                    == if branch == control::AdoptionBranch::Original {
                        ota::Release::Old
                    } else {
                        ota::Release::Candidate
                    }
                && launch.launch_id == id
                && launch.native_session_id == id
                && launch.version == m.version(branch),
        )?;
        Ok(Some(launch))
    }
    async fn launch_service(
        &self,
        m: &AdoptionManifest,
        branch: control::AdoptionBranch,
        id: &str,
    ) -> Result<AdoptionEvidence, OtaError> {
        let (job, current) = self.current_job(m)?;
        ensure(
            current == branch
                && job.observe(&self.trust)?.is_none()
                && !disabled_state(&job.definition.label).await?,
        )?;
        self.assets
            .write_new(&format!("launch-{id}"), b"started\n")?;
        job.change(&self.trust, JobChange::Bootstrap).await?;
        let start = self.awake_now()?;
        loop {
            if let Ok(Some(launch)) = self.observed_launch(m, branch, id) {
                return Ok(AdoptionEvidence::Launched { branch, launch });
            }
            if native::elapsed_ms(&start, &self.awake_now()?).map_err(|_| OtaError::Identity)?
                >= 10_000
            {
                return Err(OtaError::Timeout);
            }
            self.wait_for_observation().await?;
        }
    }
    fn desktop_birth(&self, id: &str) -> Result<Option<ProcessIdentity>, OtaError> {
        let name = format!("desktop-birth-{id}");
        if exact_absent(&self.assets.path.join(&name))? {
            return Ok(None);
        }
        let process: ProcessIdentity = serde_json::from_slice(&self.assets.read(&name, 4096)?)
            .map_err(|_| OtaError::Invalid)?;
        ensure(process.pid > 0 && !process.boot_id.is_empty() && !process.birth.is_empty())?;
        Ok(Some(process))
    }
    async fn launch_desktop(
        &self,
        m: &AdoptionManifest,
        id: &str,
    ) -> Result<AdoptionEvidence, OtaError> {
        ensure(self.awake_now()?.boot_id != m.source.boot_id)?;
        self.verify_app()?;
        let executable = Path::new(&m.source.target.app_path).join("Contents/MacOS/pacer");
        ensure(
            !control::native_process_inventory()?
                .iter()
                .any(|p| p.executable == executable),
        )?;
        self.assets
            .write_new(&format!("launch-{id}"), b"started\n")?;
        let boot = self.awake_now()?.boot_id;
        use std::os::unix::process::CommandExt;
        let child = std::process::Command::new(&executable)
            .process_group(0)
            .env_clear()
            .env("HOME", user_home(&self.trust)?)
            .env("PACER_HOME", &m.source.target.pacer_home)
            .env("PACER_PORT", m.source.target.port.to_string())
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|_| OtaError::Io)?;
        // The unreaped direct child cannot have its PID reused while birth is read.
        let details = native::process_details(child.id());
        let directory = PrivateDir::open(&self.assets.path)?;
        let launch_id = id.to_owned();
        let receipt_boot = boot.clone();
        std::thread::spawn(move || {
            let _ = record_child_exit(child, &directory, &launch_id, &receipt_boot);
        });
        let details = details
            .map_err(|_| OtaError::Identity)?
            .ok_or(OtaError::Unavailable)?;
        ensure(
            details.executable == executable
                && details.uid as u64 == m.source.target.owner_uid
                && details.identity.boot_id == boot,
        )?;
        self.trust
            .verify_process(&details.identity, CodeRole::Desktop)?;
        self.assets.write_new(
            &format!("desktop-birth-{id}"),
            &serde_json::to_vec(&details.identity).map_err(|_| OtaError::Invalid)?,
        )?;
        Ok(AdoptionEvidence::DesktopSpawned {
            process: details.identity,
        })
    }
}
