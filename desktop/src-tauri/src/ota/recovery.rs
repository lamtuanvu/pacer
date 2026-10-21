//! Journal-driven update sequencing. Native effects stay behind UpdatePlatform.
use super::journal::{
    evidence_valid, random_id, validate_manifest, Journal, JournalStore, Step, TransactionState,
};
use super::*;
use wire::WireMessage;

fn require(ok: bool) -> Result<(), OtaError> {
    if ok {
        Ok(())
    } else {
        Err(OtaError::Identity)
    }
}
fn verify_authority(
    authority: &VerifiedNativeAuthority,
    manifest: &PreparedManifest,
) -> Result<(), OtaError> {
    require(authority.binding() == &manifest.binding)
}

/// Preparation can create verified backups/recovery infrastructure, never stop or replace.
pub async fn prepare_transaction(
    store: &JournalStore,
    request: &InstallRequest,
    platform: &dyn UpdatePlatform,
) -> Result<PreparedReceipt, OtaError> {
    request.command.validate().map_err(|_| OtaError::Invalid)?;
    require(request.authority.binding() == request.command.binding())?;
    let (target, candidate) = match &request.command {
        AdapterCommand::Install {
            target, candidate, ..
        } => (target, candidate),
        _ => return Err(OtaError::Invalid),
    };
    let _locks = platform.acquire_transaction_locks(target).await?;
    let prepared = platform.verify_preconditions(request).await?;
    let manifest = prepared.manifest();
    validate_manifest(manifest)?;
    require(
        &manifest.binding == request.command.binding()
            && &manifest.target == target
            && &manifest.candidate == candidate,
    )?;
    verify_authority(prepared.authority(), manifest)?;
    let digest = store.create_manifest(manifest)?;
    let mut journal = store.initialize(&digest)?;
    run_action(
        store,
        &mut journal,
        manifest,
        PlatformAction::PrepareBackup,
        platform,
        prepared.authority(),
    )
    .await?;
    run_action(
        store,
        &mut journal,
        manifest,
        PlatformAction::ArmRecovery,
        platform,
        prepared.authority(),
    )
    .await?;
    let observation = platform.observe(manifest).await?;
    require(
        observation.bundle == BundleObservation::Old
            && observation.recovery_job_armed
            && observation.reservation_held,
    )?;
    journal.state = TransactionState::Prepared;
    store.save(&mut journal)?;
    Ok(PreparedReceipt {
        reservation_id: manifest.transaction_id().into(),
        journal_sha256: digest,
    })
}

/// Returns only after the original matching continuation has been durably synced.
/// The helper must send its authorized acknowledgment before invoking execute.
pub async fn authorize_transaction(
    store: &JournalStore,
    authorization: &Authorization,
    platform: &dyn UpdatePlatform,
) -> Result<(), OtaError> {
    authorization.validate().map_err(|_| OtaError::Invalid)?;
    let (manifest, digest) = store.manifest()?;
    let _locks = platform.acquire_transaction_locks(&manifest.target).await?;
    let mut journal = store.load()?;
    require(
        journal.state == TransactionState::Prepared
            && authorization.binding == manifest.binding
            && authorization.journal_sha256 == digest,
    )?;
    require(
        [PlatformAction::PrepareBackup, PlatformAction::ArmRecovery]
            .iter()
            .all(|action| {
                journal
                    .steps
                    .iter()
                    .any(|step| &step.action == action && step.evidence.is_some())
            }),
    )?;
    let authority = platform
        .reverify(&manifest, VerificationPurpose::Authorize)
        .await?;
    verify_authority(&authority, &manifest)?;
    let now = platform.awake_now()?;
    require(now.boot_id == manifest.requester_boot_id)?;
    let observation = platform.observe(&manifest).await?;
    require(
        observation.bundle == BundleObservation::Old
            && observation.reservation_held
            && observation.recovery_job_armed,
    )?;
    journal.authorization = Some(authorization.clone());
    journal.state = TransactionState::Authorized;
    store.save(&mut journal)
}

pub async fn execute_transaction(
    store: &JournalStore,
    platform: &dyn UpdatePlatform,
) -> Result<RecoveryOutcome, OtaError> {
    let (manifest, _) = store.manifest()?;
    let _locks = platform.acquire_transaction_locks(&manifest.target).await?;
    let mut journal = store.load()?;
    if journal.authorization.is_none() {
        return Err(OtaError::Invalid);
    }
    let authority = platform
        .reverify(&manifest, VerificationPurpose::Recover)
        .await?;
    verify_authority(&authority, &manifest)?;
    if let Some(outcome) = terminal(journal.state) {
        if outcome != RecoveryOutcome::RecoveryFailed {
            cleanup(store, &mut journal, &manifest, platform, &authority).await?;
        }
        return Ok(outcome);
    }
    // A previous execution or a different boot never obtains a fresh automatic
    // candidate deadline. Recovery conservatively restores uncommitted attempts.
    if journal.state != TransactionState::Authorized
        || platform.awake_now()?.boot_id != manifest.requester_boot_id
    {
        return restore(
            store,
            &mut journal,
            &manifest,
            platform,
            &authority,
            OtaError::Interrupted,
        )
        .await;
    }
    #[cfg(feature = "ota-fixture")]
    if super::fixture_fault::consume(
        super::fixture_fault::Point::Authorized,
        &manifest.target.id,
        manifest.transaction_id(),
    )? {
        unsafe { libc::_exit(175) }
    }
    match install(store, &mut journal, &manifest, platform, &authority).await {
        Ok(()) => {
            cleanup(store, &mut journal, &manifest, platform, &authority).await?;
            Ok(RecoveryOutcome::Committed)
        }
        Err(OtaError::Interrupted) => Err(OtaError::Interrupted),
        Err(error) => restore(store, &mut journal, &manifest, platform, &authority, error).await,
    }
}

/// No caller-supplied recovery binding can supply authorization. Only the journal
/// checkpoint written by authorize_transaction can permit installation effects.
pub async fn recover_transaction(
    store: &JournalStore,
    platform: &dyn UpdatePlatform,
) -> Result<RecoveryOutcome, OtaError> {
    let (manifest, _) = store.manifest()?;
    let _locks = platform.acquire_transaction_locks(&manifest.target).await?;
    let mut journal = store.load()?;
    let authority = platform
        .reverify(&manifest, VerificationPurpose::Recover)
        .await?;
    verify_authority(&authority, &manifest)?;
    if let Some(outcome) = terminal(journal.state) {
        if outcome != RecoveryOutcome::RecoveryFailed {
            cleanup(store, &mut journal, &manifest, platform, &authority).await?;
        }
        return Ok(outcome);
    }
    if journal.authorization.is_none() {
        let observation = platform.observe(&manifest).await?;
        if observation.bundle != BundleObservation::Old
            || observation.unready_candidate_service.is_some()
            || !observation.candidate_processes.is_empty()
        {
            return recovery_failed(store, &mut journal, OtaError::Identity);
        }
        // No destructive action was authorized. "Restored" here means verified
        // old package retained; no quarantine or process/service mutation occurs.
        journal.unchanged_original = Some(super::journal::OriginalBundleProof {
            sha256: manifest.old_bundle_backup.sha256.clone(),
            observed_at: platform.awake_now()?,
        });
        journal.state = TransactionState::Restored;
        store.save(&mut journal)?;
        cleanup(store, &mut journal, &manifest, platform, &authority).await?;
        return Ok(RecoveryOutcome::Restored);
    }
    restore(
        store,
        &mut journal,
        &manifest,
        platform,
        &authority,
        OtaError::Interrupted,
    )
    .await
}
fn terminal(state: TransactionState) -> Option<RecoveryOutcome> {
    match state {
        TransactionState::Committed => Some(RecoveryOutcome::Committed),
        TransactionState::Restored => Some(RecoveryOutcome::Restored),
        TransactionState::RecoveryFailed => Some(RecoveryOutcome::RecoveryFailed),
        _ => None,
    }
}

async fn run_action(
    store: &JournalStore,
    journal: &mut Journal,
    manifest: &PreparedManifest,
    action: PlatformAction,
    platform: &dyn UpdatePlatform,
    authority: &VerifiedNativeAuthority,
) -> Result<ActionEvidence, OtaError> {
    let index = if let Some(index) = journal.steps.iter().position(|step| step.action == action) {
        index
    } else {
        let index = journal.steps.len();
        journal.steps.push(Step {
            action: action.clone(),
            intent_revision: journal.revision.checked_add(1).ok_or(OtaError::Invalid)?,
            intent_boot_id: platform.awake_now()?.boot_id,
            evidence: None,
        });
        store.save(journal)?;
        index
    };
    if let Some(evidence) = &journal.steps[index].evidence {
        return Ok(evidence.clone());
    }
    // A persisted intent is not evidence the side effect did or did not happen.
    let evidence = match platform.inspect_action(manifest, &action).await? {
        ActionObservation::Completed(evidence) => evidence,
        ActionObservation::NotStarted => platform.perform(manifest, &action, authority).await?,
        ActionObservation::Ambiguous => return Err(OtaError::Identity),
    };
    require(evidence_valid(&action, &evidence, manifest))?;
    journal.steps[index].evidence = Some(evidence.clone());
    store.save(journal)?;
    Ok(evidence)
}
async fn launch(
    store: &JournalStore,
    journal: &mut Journal,
    manifest: &PreparedManifest,
    role: ProcessRole,
    release: Release,
    platform: &dyn UpdatePlatform,
    authority: &VerifiedNativeAuthority,
) -> Result<LaunchEvidence, OtaError> {
    let boot_id = platform.awake_now()?.boot_id;
    let existing = journal
        .steps
        .iter()
        .rev()
        .filter(|step| step.intent_boot_id == boot_id)
        .find_map(|step| match &step.action {
            PlatformAction::Launch {
                role: r,
                release: v,
                ..
            } if *r == role && *v == release => Some(step.action.clone()),
            _ => None,
        });
    let action = match existing {
        Some(action) => action,
        None => PlatformAction::Launch {
            role,
            release,
            launch_id: random_id()?,
        },
    };
    match run_action(store, journal, manifest, action, platform, authority).await? {
        ActionEvidence::Launched { launch } => Ok(launch),
        _ => Err(OtaError::Invalid),
    }
}
async fn install(
    store: &JournalStore,
    journal: &mut Journal,
    manifest: &PreparedManifest,
    platform: &dyn UpdatePlatform,
    authority: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    let observation = platform.observe(manifest).await?;
    require(
        observation.bundle == BundleObservation::Old
            && observation.reservation_held
            && observation.recovery_job_armed,
    )?;
    journal.state = TransactionState::Installing;
    store.save(journal)?;
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::SuppressLifecycle,
        platform,
        authority,
    )
    .await?;
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::Stop {
            role: ProcessRole::Desktop,
            process: manifest.old_desktop.clone(),
        },
        platform,
        authority,
    )
    .await?;
    if manifest.managed() {
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::Stop {
                role: ProcessRole::Service,
                process: manifest.old_service.clone(),
            },
            platform,
            authority,
        )
        .await?;
    }
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::InstallCandidate,
        platform,
        authority,
    )
    .await?;
    #[cfg(feature = "ota-fixture")]
    if super::fixture_fault::consume(
        super::fixture_fault::Point::Installed,
        &manifest.target.id,
        manifest.transaction_id(),
    )? {
        unsafe { libc::_exit(176) }
    }
    if manifest.managed() {
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::SwitchRegistration,
            platform,
            authority,
        )
        .await?;
    }
    journal.verification_started = Some(platform.awake_now()?);
    journal.state = TransactionState::Verifying;
    store.save(journal)?;
    let service = if manifest.managed() {
        launch(
            store,
            journal,
            manifest,
            ProcessRole::Service,
            Release::Candidate,
            platform,
            authority,
        )
        .await?
        .process
    } else {
        manifest.old_service.clone()
    };
    let desktop = launch(
        store,
        journal,
        manifest,
        ProcessRole::Desktop,
        Release::Candidate,
        platform,
        authority,
    )
    .await?;
    let expected = expected_readiness(manifest, Release::Candidate, desktop, service);
    journal.verification_proof = Some(
        verify_ready(
            manifest,
            &expected,
            journal
                .verification_started
                .as_ref()
                .ok_or(OtaError::Invalid)?,
            platform,
        )
        .await?,
    );
    journal.state = TransactionState::Committed;
    store.save(journal)
}
fn expected_readiness(
    manifest: &PreparedManifest,
    release: Release,
    desktop: LaunchEvidence,
    service: ProcessIdentity,
) -> ExpectedReadiness {
    ExpectedReadiness {
        installation_id: manifest.target.id.clone(),
        transaction_id: manifest.transaction_id().into(),
        release,
        desktop,
        service,
        service_version: if release == Release::Candidate && manifest.managed() {
            manifest.candidate.version.clone()
        } else {
            manifest.old_service_version.clone()
        },
        protocol: if release == Release::Old
            || !manifest.managed()
            || manifest
                .candidate
                .protocol_majors
                .contains(&manifest.old_service_protocol)
        {
            manifest.old_service_protocol
        } else {
            manifest.candidate.protocol_majors[0]
        },
    }
}
fn before_deadline(start: &AwakeStamp, now: &AwakeStamp) -> Result<(), OtaError> {
    let elapsed = native::elapsed_ms(start, now).map_err(|_| OtaError::Identity)?;
    if elapsed >= VERIFY_TIMEOUT_MS {
        Err(OtaError::Timeout)
    } else {
        Ok(())
    }
}
async fn verify_ready(
    manifest: &PreparedManifest,
    expected: &ExpectedReadiness,
    start: &AwakeStamp,
    platform: &dyn UpdatePlatform,
) -> Result<ReadinessProof, OtaError> {
    loop {
        before_deadline(start, &platform.awake_now()?)?;
        // Startup can temporarily interrupt the authenticated query (including
        // while the sign-in CLI is still exiting). Absence of a response proves
        // nothing: retry within the original awake deadline, never renew it.
        let observation = match platform.poll_readiness(expected).await {
            Err(OtaError::Io | OtaError::Unavailable) => ReadinessObservation::Pending,
            other => other?,
        };
        match observation {
            ReadinessObservation::Ready(proof) => {
                before_deadline(start, &platform.awake_now()?)?;
                require(
                    proof.installation_id == expected.installation_id
                        && proof.transaction_id == expected.transaction_id
                        && proof.desktop == expected.desktop.process
                        && proof.native_session_id == expected.desktop.native_session_id
                        && proof.desktop_version == expected.desktop.version
                        && proof.service == expected.service
                        && proof.service_version == expected.service_version
                        && proof.protocol == expected.protocol
                        && proof.desktop_signed_in
                        && proof.valid_state_read,
                )?;
                let observation = platform.observe(manifest).await?;
                before_deadline(start, &platform.awake_now()?)?;
                require(
                    observation.bundle
                        == if expected.release == Release::Candidate {
                            BundleObservation::Candidate
                        } else {
                            BundleObservation::Old
                        },
                )?;
                require(observation.reservation_held && observation.recovery_job_armed)?;
                return Ok(proof);
            }
            ReadinessObservation::Failed => return Err(OtaError::Identity),
            ReadinessObservation::Pending => platform.wait_for_observation().await?,
        }
    }
}
async fn restore(
    store: &JournalStore,
    journal: &mut Journal,
    manifest: &PreparedManifest,
    platform: &dyn UpdatePlatform,
    authority: &VerifiedNativeAuthority,
    reason: OtaError,
) -> Result<RecoveryOutcome, OtaError> {
    if let Some(outcome) = terminal(journal.state) {
        return Ok(outcome);
    }
    journal.state = TransactionState::Restoring;
    journal.error = Some(reason);
    journal.failed_version = Some(manifest.candidate.version.clone());
    store.save(journal)?;
    match restore_inner(store, journal, manifest, platform, authority).await {
        Ok(()) => {
            journal.state = TransactionState::Restored;
            store.save(journal)?;
            cleanup(store, journal, manifest, platform, authority).await?;
            Ok(RecoveryOutcome::Restored)
        }
        Err(OtaError::Interrupted) => Err(OtaError::Interrupted),
        Err(error) => recovery_failed(store, journal, error),
    }
}
async fn restore_inner(
    store: &JournalStore,
    journal: &mut Journal,
    manifest: &PreparedManifest,
    platform: &dyn UpdatePlatform,
    authority: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    let observed = platform.observe(manifest).await?;
    require(
        observed.bundle != BundleObservation::Unknown
            && observed.reservation_held
            && observed.recovery_job_armed,
    )?;
    if let Some(launch_id) = &observed.unready_candidate_service {
        journal.unready_candidate_launch(manifest, launch_id, &platform.awake_now()?.boot_id)?;
        require(observed.candidate_processes.is_empty() && observed.recovery_service.is_none())?;
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::StopUnreadyCandidateService {
                launch_id: launch_id.clone(),
            },
            platform,
            authority,
        )
        .await?;
        require(
            platform
                .observe(manifest)
                .await?
                .unready_candidate_service
                .is_none(),
        )?;
    }
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::SuppressLifecycle,
        platform,
        authority,
    )
    .await?;
    let recovery_service = observed.recovery_service.clone();
    let mut candidates = observed.candidate_processes;
    // Desktop cooperative shutdown is relayed by its exact service. Keep that
    // peer alive until every verified candidate desktop has exited.
    candidates.sort_by_key(|launch| match launch.role {
        ProcessRole::Desktop => 0,
        ProcessRole::Service => 1,
    });
    for launch in candidates {
        require(launch.release == Release::Candidate && journal.steps.iter().any(|step| matches!(&step.action, PlatformAction::Launch {role, release: Release::Candidate, launch_id} if role == &launch.role && launch_id == &launch.launch_id)) &&
            launch.version == manifest.candidate.version && (manifest.managed() || launch.role != ProcessRole::Service))?;
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::Stop {
                role: launch.role,
                process: launch.process,
            },
            platform,
            authority,
        )
        .await?;
    }
    // Recovery may begin before the original stop effects. Quiesce only these
    // already-authorized incarnations; completed intents remain idempotent.
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::SuppressLifecycle,
        platform,
        authority,
    )
    .await?;
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::Stop {
            role: ProcessRole::Desktop,
            process: manifest.old_desktop.clone(),
        },
        platform,
        authority,
    )
    .await?;
    if let Some(process) = recovery_service {
        require(manifest.managed())?;
        // The fresh maintenance peer may still be the original service. Its
        // relay must survive until the original desktop shutdown is complete.
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::Stop {
                role: ProcessRole::Service,
                process,
            },
            platform,
            authority,
        )
        .await?;
    }
    if manifest.managed() {
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::Stop {
                role: ProcessRole::Service,
                process: manifest.old_service.clone(),
            },
            platform,
            authority,
        )
        .await?;
    }
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::RestoreBundle,
        platform,
        authority,
    )
    .await?;
    if manifest.managed() {
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::RestoreRegistration,
            platform,
            authority,
        )
        .await?;
    }
    let now = platform.awake_now()?;
    if journal
        .restoration_started
        .as_ref()
        .is_none_or(|stamp| stamp.boot_id != now.boot_id)
    {
        if let Some(old) = journal.restoration_started.take() {
            journal.restoration_history.push(old);
        }
        journal.restoration_started = Some(now);
        store.save(journal)?;
    }
    let service = if manifest.managed() {
        launch(
            store,
            journal,
            manifest,
            ProcessRole::Service,
            Release::Old,
            platform,
            authority,
        )
        .await?
        .process
    } else {
        manifest.old_service.clone()
    };
    let desktop = launch(
        store,
        journal,
        manifest,
        ProcessRole::Desktop,
        Release::Old,
        platform,
        authority,
    )
    .await?;
    journal.restoration_proof = Some(
        verify_ready(
            manifest,
            &expected_readiness(manifest, Release::Old, desktop, service),
            journal
                .restoration_started
                .as_ref()
                .ok_or(OtaError::Invalid)?,
            platform,
        )
        .await?,
    );
    Ok(())
}
fn recovery_failed(
    store: &JournalStore,
    journal: &mut Journal,
    reason: OtaError,
) -> Result<RecoveryOutcome, OtaError> {
    journal.state = TransactionState::RecoveryFailed;
    journal.error = Some(reason);
    store.save(journal)?;
    Ok(RecoveryOutcome::RecoveryFailed)
}
async fn cleanup(
    store: &JournalStore,
    journal: &mut Journal,
    manifest: &PreparedManifest,
    platform: &dyn UpdatePlatform,
    authority: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    require(matches!(
        journal.state,
        TransactionState::Committed | TransactionState::Restored
    ))?;
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::ReleaseReservation,
        platform,
        authority,
    )
    .await?;
    run_action(
        store,
        journal,
        manifest,
        PlatformAction::RetireRecovery,
        platform,
        authority,
    )
    .await?;
    if journal.state == TransactionState::Committed {
        run_action(
            store,
            journal,
            manifest,
            PlatformAction::PruneSupersededBackup,
            platform,
            authority,
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::journal::{
        tests::{manifest, Temp},
        TransactionState,
    };
    use super::*;
    use std::cell::RefCell;

    struct Lock;
    impl TransactionLocks for Lock {}
    #[derive(Clone)]
    struct World {
        manifest: PreparedManifest,
        bundle: BundleObservation,
        registration: Release,
        gate: bool,
        armed: bool,
        desktop: Option<ProcessIdentity>,
        service: Option<ProcessIdentity>,
        effects: Vec<(PlatformAction, ActionEvidence)>,
        root: Option<std::path::PathBuf>,
        crash_before: Option<&'static str>,
        crash_after: Option<&'static str>,
        fail_install: bool,
        fail_service_start: bool,
        unready_service: Option<String>,
        fail_restore: bool,
        candidate_readiness: bool,
        readiness_errors: Vec<OtaError>,
        recovery_service: Option<ProcessIdentity>,
        old_readiness: bool,
        wrong_identity: bool,
        ready_stamp: Option<AwakeStamp>,
        millis: u64,
        boot: String,
        pid: u32,
        waits: u32,
    }
    struct Fake(RefCell<World>);
    fn tag(action: &PlatformAction) -> &'static str {
        match action {
            PlatformAction::StopUnreadyCandidateService { .. } => "stop-unready-service",
            PlatformAction::PrepareBackup => "backup",
            PlatformAction::ArmRecovery => "arm",
            PlatformAction::SuppressLifecycle => "suppress",
            PlatformAction::Stop {
                role: ProcessRole::Desktop,
                ..
            } => "stop-desktop",
            PlatformAction::Stop {
                role: ProcessRole::Service,
                ..
            } => "stop-service",
            PlatformAction::InstallCandidate => "install",
            PlatformAction::SwitchRegistration => "registration",
            PlatformAction::Launch {
                role: ProcessRole::Service,
                release: Release::Candidate,
                ..
            } => "launch-service",
            PlatformAction::Launch {
                role: ProcessRole::Desktop,
                release: Release::Candidate,
                ..
            } => "launch-desktop",
            PlatformAction::Launch { .. } => "launch-old",
            PlatformAction::RestoreBundle => "restore",
            PlatformAction::RestoreRegistration => "restore-registration",
            PlatformAction::ReleaseReservation => "release",
            PlatformAction::RetireRecovery => "retire",
            PlatformAction::PruneSupersededBackup => "prune",
        }
    }
    impl Fake {
        fn new(attached: bool) -> Self {
            let mut manifest = manifest();
            if attached {
                manifest.target.ownership = Ownership::Attached;
                manifest.registration_backup = None;
            }
            Self(RefCell::new(World {
                desktop: Some(manifest.old_desktop.clone()),
                service: Some(manifest.old_service.clone()),
                manifest,
                bundle: BundleObservation::Old,
                registration: Release::Old,
                gate: true,
                armed: false,
                effects: vec![],
                root: None,
                crash_before: None,
                crash_after: None,
                fail_install: false,
                fail_service_start: false,
                unready_service: None,
                fail_restore: false,
                candidate_readiness: true,
                readiness_errors: vec![],
                recovery_service: None,
                old_readiness: true,
                wrong_identity: false,
                ready_stamp: None,
                millis: 1000,
                boot: "boot-one".into(),
                pid: 200,
                waits: 0,
            }))
        }
        fn request(&self) -> InstallRequest {
            let world = self.0.borrow();
            InstallRequest {
                command: AdapterCommand::Install {
                    binding: world.manifest.binding.clone(),
                    target: world.manifest.target.clone(),
                    candidate: world.manifest.candidate.clone(),
                },
                authority: VerifiedNativeAuthority::verified(world.manifest.binding.clone()),
            }
        }
    }
    impl UpdatePlatform for Fake {
        fn awake_now(&self) -> Result<AwakeStamp, OtaError> {
            let w = self.0.borrow();
            Ok(AwakeStamp {
                boot_id: w.boot.clone(),
                millis: w.millis,
            })
        }
        fn acquire_transaction_locks<'a>(
            &'a self,
            _: &'a Installation,
        ) -> PlatformFuture<'a, Box<dyn TransactionLocks>> {
            Box::pin(async { Ok(Box::new(Lock) as Box<dyn TransactionLocks>) })
        }
        fn verify_preconditions<'a>(
            &'a self,
            _: &'a InstallRequest,
        ) -> PlatformFuture<'a, VerifiedPreparation> {
            Box::pin(async {
                let w = self.0.borrow();
                Ok(VerifiedPreparation::verified(
                    w.manifest.clone(),
                    VerifiedNativeAuthority::verified(w.manifest.binding.clone()),
                ))
            })
        }
        fn reverify<'a>(
            &'a self,
            manifest: &'a PreparedManifest,
            _: VerificationPurpose,
        ) -> PlatformFuture<'a, VerifiedNativeAuthority> {
            Box::pin(async move { Ok(VerifiedNativeAuthority::verified(manifest.binding.clone())) })
        }
        fn observe<'a>(&'a self, _: &'a PreparedManifest) -> PlatformFuture<'a, Observation> {
            Box::pin(async {
                let w = self.0.borrow();
                Ok(Observation {
                    unready_candidate_service: w.unready_service.clone(),
                    bundle: w.bundle,
                    reservation_held: w.gate,
                    recovery_job_armed: w.armed,
                    recovery_service: w.recovery_service.clone(),
                    candidate_processes: w
                        .effects
                        .iter()
                        .filter_map(|(_, evidence)| match evidence {
                            ActionEvidence::Launched { launch }
                                if launch.release == Release::Candidate
                                    && (w.desktop.as_ref() == Some(&launch.process)
                                        || w.service.as_ref() == Some(&launch.process)) =>
                            {
                                Some(launch.clone())
                            }
                            _ => None,
                        })
                        .collect(),
                })
            })
        }
        fn inspect_action<'a>(
            &'a self,
            _: &'a PreparedManifest,
            action: &'a PlatformAction,
        ) -> PlatformFuture<'a, ActionObservation> {
            Box::pin(async move {
                Ok(self
                    .0
                    .borrow()
                    .effects
                    .iter()
                    .find(|(done, _)| done == action)
                    .map(|(_, e)| ActionObservation::Completed(e.clone()))
                    .unwrap_or(ActionObservation::NotStarted))
            })
        }
        fn perform<'a>(
            &'a self,
            manifest: &'a PreparedManifest,
            action: &'a PlatformAction,
            _: &'a VerifiedNativeAuthority,
        ) -> PlatformFuture<'a, ActionEvidence> {
            Box::pin(async move {
                let mut w = self.0.borrow_mut();
                let durable: Journal = serde_json::from_slice(
                    &std::fs::read(w.root.as_ref().unwrap().join("journal.json")).unwrap(),
                )
                .unwrap();
                assert!(
                    durable
                        .steps
                        .iter()
                        .any(|step| &step.action == action && step.evidence.is_none()),
                    "effect without durable intent"
                );
                if matches!(action, PlatformAction::ReleaseReservation) {
                    assert!(
                        matches!(
                            durable.state,
                            TransactionState::Committed | TransactionState::Restored
                        ),
                        "release before durable terminal state"
                    );
                }
                if w.crash_before == Some(tag(action)) {
                    w.crash_before = None;
                    return Err(OtaError::Interrupted);
                }
                if (w.fail_install && matches!(action, PlatformAction::InstallCandidate))
                    || (w.fail_restore && matches!(action, PlatformAction::RestoreBundle))
                {
                    return Err(OtaError::Io);
                }
                let mut evidence = ActionEvidence::Complete;
                match action {
                    PlatformAction::StopUnreadyCandidateService { launch_id } => {
                        assert_eq!(w.unready_service.as_ref(), Some(launch_id));
                        w.unready_service = None;
                    }
                    PlatformAction::ArmRecovery => w.armed = true,
                    PlatformAction::Stop { role, process } => {
                        let current = if *role == ProcessRole::Desktop {
                            &mut w.desktop
                        } else {
                            &mut w.service
                        };
                        if current.as_ref().is_some_and(|p| p != process) {
                            return Err(OtaError::Identity);
                        }
                        *current = None;
                    }
                    PlatformAction::InstallCandidate => w.bundle = BundleObservation::Candidate,
                    PlatformAction::SwitchRegistration => w.registration = Release::Candidate,
                    PlatformAction::RestoreBundle => {
                        if w.unready_service.is_some() {
                            return Err(OtaError::Identity);
                        }
                        w.bundle = BundleObservation::Old;
                    }
                    PlatformAction::RestoreRegistration => w.registration = Release::Old,
                    PlatformAction::ReleaseReservation => w.gate = false,
                    PlatformAction::RetireRecovery => w.armed = false,
                    PlatformAction::Launch {
                        role,
                        release,
                        launch_id,
                    } => {
                        if *role == ProcessRole::Service
                            && *release == Release::Candidate
                            && w.fail_service_start
                        {
                            w.unready_service = Some(launch_id.clone());
                            return Err(OtaError::Timeout);
                        }
                        let current = if *role == ProcessRole::Desktop {
                            w.desktop.as_ref()
                        } else {
                            w.service.as_ref()
                        };
                        let old = if *role == ProcessRole::Desktop {
                            &manifest.old_desktop
                        } else {
                            &manifest.old_service
                        };
                        if current.is_some_and(|process| process != old) {
                            return Err(OtaError::Identity);
                        }
                        w.pid += 1;
                        let process = ProcessIdentity {
                            pid: w.pid,
                            boot_id: w.boot.clone(),
                            birth: format!("{}:0", w.pid),
                        };
                        if *role == ProcessRole::Desktop {
                            w.desktop = Some(process.clone());
                        } else {
                            w.service = Some(process.clone());
                        }
                        evidence = ActionEvidence::Launched {
                            launch: LaunchEvidence {
                                role: *role,
                                release: *release,
                                launch_id: launch_id.clone(),
                                process,
                                native_session_id: format!("native-{}", w.pid),
                                version: if *release == Release::Old {
                                    manifest.target.version.clone()
                                } else {
                                    manifest.candidate.version.clone()
                                },
                            },
                        };
                    }
                    _ => {}
                }
                w.effects.push((action.clone(), evidence.clone()));
                if w.crash_after == Some(tag(action)) {
                    w.crash_after = None;
                    return Err(OtaError::Interrupted);
                }
                Ok(evidence)
            })
        }
        fn poll_readiness<'a>(
            &'a self,
            expected: &'a ExpectedReadiness,
        ) -> PlatformFuture<'a, ReadinessObservation> {
            Box::pin(async move {
                let mut w = self.0.borrow_mut();
                if expected.release == Release::Candidate {
                    if let Some(stamp) = w.ready_stamp.take() {
                        w.millis = stamp.millis;
                        w.boot = stamp.boot_id;
                    }
                }
                if !w.readiness_errors.is_empty() {
                    return Err(w.readiness_errors.remove(0));
                }
                if (expected.release == Release::Candidate && !w.candidate_readiness)
                    || (expected.release == Release::Old && !w.old_readiness)
                {
                    return Ok(ReadinessObservation::Failed);
                }
                let mut desktop = expected.desktop.process.clone();
                if w.wrong_identity && expected.release == Release::Candidate {
                    desktop.birth = "99999:0".into();
                }
                Ok(ReadinessObservation::Ready(ReadinessProof {
                    installation_id: expected.installation_id.clone(),
                    transaction_id: expected.transaction_id.clone(),
                    desktop,
                    native_session_id: expected.desktop.native_session_id.clone(),
                    desktop_version: expected.desktop.version.clone(),
                    service: expected.service.clone(),
                    service_version: expected.service_version.clone(),
                    protocol: expected.protocol,
                    desktop_signed_in: true,
                    valid_state_read: true,
                }))
            })
        }
        fn wait_for_observation<'a>(&'a self) -> PlatformFuture<'a, ()> {
            Box::pin(async {
                let mut w = self.0.borrow_mut();
                w.millis += 30_000;
                w.waits += 1;
                Ok(())
            })
        }
    }
    #[tokio::test]
    async fn transient_readiness_transport_failure_waits_for_fresh_proof_within_deadline() {
        for (errors, outcome, waits) in [
            (
                vec![OtaError::Io, OtaError::Unavailable],
                RecoveryOutcome::Committed,
                2,
            ),
            (vec![OtaError::Io; 4], RecoveryOutcome::Restored, 4),
            (vec![OtaError::Identity], RecoveryOutcome::Restored, 0),
        ] {
            let fake = Fake::new(false);
            let (_temp, store) = authorized(&fake).await;
            fake.0.borrow_mut().readiness_errors = errors;
            assert_eq!(execute_transaction(&store, &fake).await.unwrap(), outcome);
            assert_eq!(fake.0.borrow().waits, waits);
        }
    }

    async fn prepared(fake: &Fake) -> (Temp, JournalStore, PreparedReceipt) {
        let temp = Temp::new();
        let store = JournalStore::open(&temp.0).unwrap();
        fake.0.borrow_mut().root = Some(temp.0.clone());
        let receipt = prepare_transaction(&store, &fake.request(), fake)
            .await
            .unwrap();
        (temp, store, receipt)
    }
    fn authorization(fake: &Fake, receipt: &PreparedReceipt) -> Authorization {
        Authorization {
            binding: fake.0.borrow().manifest.binding.clone(),
            kind: wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: receipt.reservation_id.clone(),
            journal_sha256: receipt.journal_sha256.clone(),
        }
    }
    async fn authorized(fake: &Fake) -> (Temp, JournalStore) {
        let (temp, store, receipt) = prepared(fake).await;
        authorize_transaction(&store, &authorization(fake, &receipt), fake)
            .await
            .unwrap();
        (temp, store)
    }
    #[tokio::test]
    async fn unready_candidate_cleanup_refuses_missing_or_redirected_original_authority() {
        let p = Fake::new(false);
        let (_temp, store) = authorized(&p).await;
        p.0.borrow_mut().fail_service_start = true;
        assert_eq!(
            execute_transaction(&store, &p).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let j = store.load().unwrap();
        let m = p.0.borrow().manifest.clone();
        let boot = p.awake_now().unwrap().boot_id;
        let id = j
            .steps
            .iter()
            .find_map(|step| match &step.action {
                PlatformAction::StopUnreadyCandidateService { launch_id } => {
                    Some(launch_id.clone())
                }
                _ => None,
            })
            .unwrap();
        assert!(j.unready_candidate_launch(&m, &id, &boot).is_ok());
        let mut bad = j.clone();
        bad.state = TransactionState::Verifying;
        assert!(bad.unready_candidate_launch(&m, &id, &boot).is_err());
        let mut reordered = j.clone();
        let stop = reordered
            .steps
            .iter()
            .position(|s| matches!(s.action, PlatformAction::StopUnreadyCandidateService { .. }))
            .unwrap();
        let launch = reordered
            .steps
            .iter()
            .position(|s| matches!(&s.action,PlatformAction::Launch{launch_id,..}if launch_id==&id))
            .unwrap();
        reordered.steps.swap(stop, launch);
        let (_, sha) = store.manifest().unwrap();
        assert!(reordered.validate(&m, &sha).is_err());
        assert!(j
            .unready_candidate_launch(&m, &"f".repeat(64), &boot)
            .is_err());
        assert!(j.unready_candidate_launch(&m, &id, "other-boot").is_err());
        let mut attached = m.clone();
        attached.target.ownership = Ownership::Attached;
        assert!(j.unready_candidate_launch(&attached, &id, &boot).is_err());
        let mut bad = j.clone();
        bad.authorization = None;
        assert!(bad.unready_candidate_launch(&m, &id, &boot).is_err());
        for effect in [
            PlatformAction::SuppressLifecycle,
            PlatformAction::InstallCandidate,
            PlatformAction::SwitchRegistration,
            PlatformAction::Stop {
                role: ProcessRole::Desktop,
                process: m.old_desktop.clone(),
            },
            PlatformAction::Stop {
                role: ProcessRole::Service,
                process: m.old_service.clone(),
            },
        ] {
            let mut bad = j.clone();
            bad.steps
                .iter_mut()
                .find(|s| s.action == effect)
                .unwrap()
                .evidence = None;
            assert!(bad.unready_candidate_launch(&m, &id, &boot).is_err());
        }
        let mut bad = j.clone();
        let launch = bad
            .steps
            .iter_mut()
            .find(|s| matches!(&s.action,PlatformAction::Launch{launch_id,..}if launch_id==&id))
            .unwrap();
        if let PlatformAction::Launch { release, .. } = &mut launch.action {
            *release = Release::Old;
        }
        assert!(bad.unready_candidate_launch(&m, &id, &boot).is_err());
        let mut bad = j.clone();
        bad.steps.push(super::super::journal::Step {
            action: PlatformAction::Launch {
                role: ProcessRole::Desktop,
                release: Release::Candidate,
                launch_id: "e".repeat(64),
            },
            intent_revision: j.revision + 1,
            intent_boot_id: boot.clone(),
            evidence: None,
        });
        assert!(bad.unready_candidate_launch(&m, &id, &boot).is_err());
    }
    #[tokio::test]
    async fn failed_candidate_cli_before_native_receipt_requires_closed_job_cleanup_before_restore()
    {
        let p = Fake::new(false);
        let (_temp, store) = authorized(&p).await;
        p.0.borrow_mut().fail_service_start = true;
        assert_eq!(
            execute_transaction(&store, &p).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let world = p.0.borrow();
        let actions: Vec<_> = world.effects.iter().map(|(a, _)| tag(a)).collect();
        assert!(
            actions
                .iter()
                .position(|a| *a == "stop-unready-service")
                .unwrap()
                < actions.iter().position(|a| *a == "restore").unwrap()
        );
        assert!(world.unready_service.is_none());
        assert_eq!(world.bundle, BundleObservation::Old);
    }
    #[tokio::test]
    async fn prepare_and_authorize_do_not_stop_or_install_and_wrong_digest_cannot_authorize() {
        let fake = Fake::new(false);
        let (_temp, store, receipt) = prepared(&fake).await;
        assert_eq!(fake.0.borrow().bundle, BundleObservation::Old);
        assert_eq!(
            fake.0.borrow().desktop,
            Some(fake.0.borrow().manifest.old_desktop.clone())
        );
        assert!(fake.0.borrow().effects.iter().all(|(action, _)| matches!(
            action,
            PlatformAction::PrepareBackup | PlatformAction::ArmRecovery
        )));
        assert!(execute_transaction(&store, &fake).await.is_err());
        let mut wrong = authorization(&fake, &receipt);
        wrong.journal_sha256 = "f".repeat(64);
        assert!(authorize_transaction(&store, &wrong, &fake).await.is_err());
        assert!(store.load().unwrap().authorization.is_none());
        authorize_transaction(&store, &authorization(&fake, &receipt), &fake)
            .await
            .unwrap();
        assert_eq!(store.load().unwrap().state, TransactionState::Authorized);
        assert_eq!(fake.0.borrow().bundle, BundleObservation::Old);
    }
    #[tokio::test]
    async fn verified_install_commits_before_releasing_and_never_rolls_back_after_commit() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Committed
        );
        assert_eq!(store.load().unwrap().state, TransactionState::Committed);
        for step in &store.load().unwrap().steps {
            if let PlatformAction::Launch { launch_id, .. } = &step.action {
                assert_eq!(
                    launch_id.len(),
                    64,
                    "private launch ID is the durable 256-bit launch ticket nonce"
                );
                assert!(launch_id
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
            }
        }
        let w = fake.0.borrow();
        assert_eq!(w.bundle, BundleObservation::Candidate);
        assert_eq!(w.registration, Release::Candidate);
        assert!(!w.gate);
        assert!(!w.armed);
        drop(w);
        fake.0.borrow_mut().candidate_readiness = false;
        assert_eq!(
            recover_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Committed
        );
        assert_eq!(fake.0.borrow().bundle, BundleObservation::Candidate);
        assert!(!fake
            .0
            .borrow()
            .effects
            .iter()
            .any(|(a, _)| matches!(a, PlatformAction::RestoreBundle)));
    }
    #[tokio::test]
    async fn committed_cleanup_survives_lost_completion_without_restoring() {
        for boundary in ["release", "retire", "prune"] {
            for after_effect in [false, true] {
                let fake = Fake::new(false);
                let (_temp, store) = authorized(&fake).await;
                if after_effect {
                    fake.0.borrow_mut().crash_after = Some(boundary);
                } else {
                    fake.0.borrow_mut().crash_before = Some(boundary);
                }
                assert_eq!(
                    execute_transaction(&store, &fake).await,
                    Err(OtaError::Interrupted)
                );
                assert_eq!(store.load().unwrap().state, TransactionState::Committed);
                drop(store);
                let store = JournalStore::open(&_temp.0).unwrap();
                fake.0.borrow_mut().candidate_readiness = false;
                assert_eq!(
                    recover_transaction(&store, &fake).await.unwrap(),
                    RecoveryOutcome::Committed
                );
                let world = fake.0.borrow();
                assert_eq!(world.bundle, BundleObservation::Candidate);
                assert!(!world.gate);
                assert!(!world.armed);
                assert!(!world
                    .effects
                    .iter()
                    .any(|(action, _)| matches!(action, PlatformAction::RestoreBundle)));
            }
        }
    }
    #[tokio::test]
    async fn startup_failure_restores_old_bundle_and_registration_before_releasing() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        fake.0.borrow_mut().candidate_readiness = false;
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let journal = store.load().unwrap();
        assert_eq!(journal.failed_version.as_deref(), Some("1.1.0"));
        let w = fake.0.borrow();
        assert_eq!(w.bundle, BundleObservation::Old);
        assert_eq!(w.registration, Release::Old);
        assert!(!w.gate);
        assert!(!w.armed);
    }
    #[tokio::test]
    async fn interrupted_effects_reconcile_from_disk_without_duplicating_candidate_launches() {
        for after_effect in [false, true] {
            for boundary in [
                "suppress",
                "stop-desktop",
                "stop-service",
                "install",
                "registration",
                "launch-service",
                "launch-desktop",
            ] {
                let fake = Fake::new(false);
                let (temp, store) = authorized(&fake).await;
                if after_effect {
                    fake.0.borrow_mut().crash_after = Some(boundary);
                } else {
                    fake.0.borrow_mut().crash_before = Some(boundary);
                }
                assert_eq!(
                    execute_transaction(&store, &fake).await,
                    Err(OtaError::Interrupted),
                    "{boundary}"
                );
                assert!(fake.0.borrow().gate);
                drop(store);
                let reopened = JournalStore::open(&temp.0).unwrap();
                assert_eq!(
                    recover_transaction(&reopened, &fake).await.unwrap(),
                    RecoveryOutcome::Restored,
                    "{boundary}"
                );
                let w = fake.0.borrow();
                assert_eq!(w.bundle, BundleObservation::Old);
                assert!(!w.gate);
                assert!(
                    w.effects
                        .iter()
                        .filter(|(a, _)| matches!(
                            a,
                            PlatformAction::Launch {
                                release: Release::Candidate,
                                role: ProcessRole::Desktop,
                                ..
                            }
                        ))
                        .count()
                        <= 1
                );
            }
        }
    }
    #[tokio::test]
    async fn rebooted_managed_service_requires_a_new_explicit_verified_stop_intent() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        let new = ProcessIdentity {
            pid: 900,
            boot_id: "boot-two".into(),
            birth: "20:30".into(),
        };
        {
            let mut world = fake.0.borrow_mut();
            world.boot = "boot-two".into();
            world.millis = 10;
            world.desktop = None;
            world.service = Some(new.clone());
            world.recovery_service = Some(new.clone());
        }
        assert_eq!(
            recover_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let journal = store.load().unwrap();
        assert!(journal.steps.iter().any(|step|matches!(&step.action,PlatformAction::Stop{role:ProcessRole::Service,process} if process==&new) && step.evidence.is_some()));
    }
    #[tokio::test]
    async fn rollback_stops_candidate_desktop_before_its_service_relay() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        fake.0.borrow_mut().candidate_readiness = false;
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let world = fake.0.borrow();
        let stops = world
            .effects
            .iter()
            .filter_map(|(action, _)| match action {
                PlatformAction::Stop { role, process }
                    if process != &world.manifest.old_desktop
                        && process != &world.manifest.old_service =>
                {
                    Some(*role)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(stops, vec![ProcessRole::Desktop, ProcessRole::Service]);
    }
    #[tokio::test]
    async fn recovery_before_first_stop_quiesces_original_processes_before_relaunch() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        // Native recovery discovers the still-running original service as a
        // fresh maintenance peer when the helper dies before either stop.
        let original_service = fake.0.borrow().manifest.old_service.clone();
        fake.0.borrow_mut().recovery_service = Some(original_service);
        assert_eq!(
            recover_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let world = fake.0.borrow();
        assert!(world.effects.iter().any(|(action,_)|matches!(action,PlatformAction::Stop{role:ProcessRole::Desktop,process} if process==&world.manifest.old_desktop)));
        assert!(world.effects.iter().any(|(action,_)|matches!(action,PlatformAction::Stop{role:ProcessRole::Service,process} if process==&world.manifest.old_service)));
        let stops: Vec<_> = world
            .effects
            .iter()
            .filter_map(|(action, _)| match action {
                PlatformAction::Stop { role, .. } => Some(*role),
                _ => None,
            })
            .collect();
        assert_eq!(stops, vec![ProcessRole::Desktop, ProcessRole::Service]);
    }
    #[tokio::test]
    async fn failed_restore_keeps_reservation_backup_and_recovery_job() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        {
            let mut w = fake.0.borrow_mut();
            w.candidate_readiness = false;
            w.fail_restore = true;
        }
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::RecoveryFailed
        );
        assert_eq!(
            store.load().unwrap().state,
            TransactionState::RecoveryFailed
        );
        let w = fake.0.borrow();
        assert!(w.gate);
        assert!(w.armed);
        assert!(!w
            .effects
            .iter()
            .any(|(a, _)| matches!(a, PlatformAction::PruneSupersededBackup)));
    }
    #[tokio::test]
    async fn attached_update_and_restore_never_mutate_external_service() {
        let fake = Fake::new(true);
        let (_temp, store) = authorized(&fake).await;
        fake.0.borrow_mut().candidate_readiness = false;
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let w = fake.0.borrow();
        assert_eq!(w.service.as_ref(), Some(&w.manifest.old_service));
        assert_eq!(w.registration, Release::Old);
        assert!(!w.effects.iter().any(|(a, _)| matches!(
            a,
            PlatformAction::Stop {
                role: ProcessRole::Service,
                ..
            } | PlatformAction::Launch {
                role: ProcessRole::Service,
                ..
            } | PlatformAction::SwitchRegistration
                | PlatformAction::RestoreRegistration
        )));
    }
    #[tokio::test]
    async fn reused_process_or_wrong_readiness_identity_never_counts_as_verified() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        fake.0.borrow_mut().wrong_identity = true;
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        assert_eq!(fake.0.borrow().bundle, BundleObservation::Old);
    }
    #[tokio::test]
    async fn changed_boot_after_authorization_restores_without_candidate_install() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        fake.0.borrow_mut().boot = "boot-two".into();
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        assert!(!fake
            .0
            .borrow()
            .effects
            .iter()
            .any(|(a, _)| matches!(a, PlatformAction::InstallCandidate)));
    }

    #[tokio::test]
    async fn reboot_during_restore_launches_current_boot_old_processes_without_resetting_candidate_time(
    ) {
        let fake = Fake::new(false);
        let (temp, store) = authorized(&fake).await;
        {
            let mut w = fake.0.borrow_mut();
            w.candidate_readiness = false;
            w.crash_after = Some("launch-old");
        }
        assert_eq!(
            execute_transaction(&store, &fake).await,
            Err(OtaError::Interrupted)
        );
        let original_candidate_start = store.load().unwrap().verification_started;
        drop(store);
        {
            let mut w = fake.0.borrow_mut();
            w.boot = "boot-two".into();
            w.millis = 1;
            w.desktop = None;
            w.service = None;
        }
        let reopened = JournalStore::open(&temp.0).unwrap();
        assert_eq!(
            recover_transaction(&reopened, &fake).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let journal = reopened.load().unwrap();
        assert_eq!(journal.verification_started, original_candidate_start);
        assert_eq!(
            journal.restoration_proof.as_ref().unwrap().desktop.boot_id,
            "boot-two"
        );
        assert_eq!(
            journal.restoration_proof.as_ref().unwrap().service.boot_id,
            "boot-two"
        );
    }

    #[tokio::test]
    async fn verification_accepts_119999_awake_millis_but_not_120000_or_clock_regression() {
        for (millis, outcome) in [
            (120999, RecoveryOutcome::Committed),
            (121000, RecoveryOutcome::Restored),
            (999, RecoveryOutcome::Restored),
        ] {
            let fake = Fake::new(false);
            let (_temp, store) = authorized(&fake).await;
            fake.0.borrow_mut().ready_stamp = Some(AwakeStamp {
                boot_id: "boot-one".into(),
                millis,
            });
            assert_eq!(
                execute_transaction(&store, &fake).await.unwrap(),
                outcome,
                "{millis}"
            );
        }
    }

    #[tokio::test]
    async fn reused_old_service_pid_is_never_stopped_or_overwritten() {
        let fake = Fake::new(false);
        let (_temp, store) = authorized(&fake).await;
        let foreign = ProcessIdentity {
            pid: 101,
            boot_id: "boot-one".into(),
            birth: "2000:1".into(),
        };
        fake.0.borrow_mut().service = Some(foreign.clone());
        assert_eq!(
            execute_transaction(&store, &fake).await.unwrap(),
            RecoveryOutcome::RecoveryFailed
        );
        let w = fake.0.borrow();
        assert_eq!(w.service, Some(foreign));
        assert!(w.gate);
        assert!(!w.effects.iter().any(|(action, _)| matches!(
            action,
            PlatformAction::InstallCandidate
                | PlatformAction::Stop {
                    role: ProcessRole::Service,
                    ..
                }
        )));
    }
}
