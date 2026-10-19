//! Adoption transitions are intentionally separate from bundle installation.
use super::{
    journal::{AdoptionJournal, AdoptionState, AdoptionStep, AdoptionStore, UnchangedRegistration},
    *,
};

use crate::ota::wire::WireMessage;
fn require(value: bool) -> Result<(), OtaError> {
    if value {
        Ok(())
    } else {
        Err(OtaError::Identity)
    }
}
fn authority(a: &VerifiedNativeAuthority, m: &AdoptionManifest) -> Result<(), OtaError> {
    require(a.binding() == &m.binding)
}
fn outcome(state: AdoptionState) -> Option<RecoveryOutcome> {
    match state {
        AdoptionState::Committed => Some(RecoveryOutcome::Committed),
        AdoptionState::Restored => Some(RecoveryOutcome::Restored),
        AdoptionState::RecoveryFailed => Some(RecoveryOutcome::RecoveryFailed),
        _ => None,
    }
}
pub async fn prepare_adoption(
    store: &AdoptionStore,
    request: &AdoptionRequest,
    platform: &dyn AdoptionPlatform,
) -> Result<PreparedReceipt, OtaError> {
    AdapterCommand::Adopt {
        binding: request.binding.clone(),
        target: request.target.clone(),
    }
    .validate()
    .map_err(|_| OtaError::Invalid)?;
    let _locks = platform.acquire_transaction_locks(&request.target).await?;
    require(request.authority.binding() == &request.binding)?;
    let prepared = platform.verify_preconditions(request).await?;
    let m = &prepared.manifest;
    journal::validate_manifest(m)?;
    require(m.binding == request.binding && m.source.target == request.target)?;
    authority(&prepared.authority, m)?;
    let digest = store.create_manifest(m)?;
    let mut j = store.initialize(&digest)?;
    action(
        store,
        &mut j,
        m,
        AdoptionAction::BackupRegistration,
        platform,
        &prepared.authority,
    )
    .await?;
    action(
        store,
        &mut j,
        m,
        AdoptionAction::ArmRecovery,
        platform,
        &prepared.authority,
    )
    .await?;
    let observed = platform.observe(m).await?;
    require(
        observed.registration == RegistrationObservation::Original
            && observed.reservation_held
            && observed.recovery_job_armed,
    )?;
    j.state = AdoptionState::Prepared;
    store.save(&mut j)?;
    Ok(PreparedReceipt {
        reservation_id: m.transaction_id().into(),
        journal_sha256: digest,
    })
}
pub async fn authorize_adoption(
    store: &AdoptionStore,
    authorization: &Authorization,
    platform: &dyn AdoptionPlatform,
) -> Result<(), OtaError> {
    authorization.validate().map_err(|_| OtaError::Invalid)?;
    let (m, sha) = store.manifest()?;
    let _locks = platform.acquire_transaction_locks(&m.source.target).await?;
    let mut j = store.load()?;
    require(
        j.state == AdoptionState::Prepared
            && j.authorization.is_none()
            && authorization.binding == m.binding
            && authorization.journal_sha256 == sha
            && authorization.reservation_id == m.transaction_id(),
    )?;
    for a in [
        AdoptionAction::BackupRegistration,
        AdoptionAction::ArmRecovery,
    ] {
        require(
            j.steps
                .iter()
                .any(|step| step.action == a && step.evidence == Some(AdoptionEvidence::Complete)),
        )?;
    }
    require(platform.awake_now()?.boot_id == m.source.boot_id)?;
    authority(
        &platform
            .reverify(&m, VerificationPurpose::Authorize)
            .await?,
        &m,
    )?;
    let o = platform.observe(&m).await?;
    require(
        o.registration == RegistrationObservation::Original
            && o.reservation_held
            && o.recovery_job_armed,
    )?;
    j.authorization = Some(authorization.clone());
    j.state = AdoptionState::Authorized;
    store.save(&mut j)
}
pub async fn execute_adoption(
    store: &AdoptionStore,
    platform: &dyn AdoptionPlatform,
) -> Result<RecoveryOutcome, OtaError> {
    let (m, _) = store.manifest()?;
    let _locks = platform.acquire_transaction_locks(&m.source.target).await?;
    let mut j = store.load()?;
    require(j.authorization.is_some())?;
    let a = platform.reverify(&m, VerificationPurpose::Recover).await?;
    authority(&a, &m)?;
    if let Some(result) = outcome(j.state) {
        if result != RecoveryOutcome::RecoveryFailed {
            cleanup(store, &mut j, &m, platform, &a).await?;
        }
        return Ok(result);
    }
    if j.state != AdoptionState::Authorized || platform.awake_now()?.boot_id != m.source.boot_id {
        return restore(store, &mut j, &m, platform, &a, OtaError::Interrupted).await;
    }
    match switch(store, &mut j, &m, platform, &a).await {
        Ok(()) => {
            cleanup(store, &mut j, &m, platform, &a).await?;
            Ok(RecoveryOutcome::Committed)
        }
        Err(OtaError::Interrupted) => Err(OtaError::Interrupted),
        Err(error) => restore(store, &mut j, &m, platform, &a, error).await,
    }
}
pub async fn recover_adoption(
    store: &AdoptionStore,
    platform: &dyn AdoptionPlatform,
) -> Result<RecoveryOutcome, OtaError> {
    let (m, _) = store.manifest()?;
    let _locks = platform.acquire_transaction_locks(&m.source.target).await?;
    let mut j = store.load()?;
    let a = platform.reverify(&m, VerificationPurpose::Recover).await?;
    authority(&a, &m)?;
    if let Some(result) = outcome(j.state) {
        if result != RecoveryOutcome::RecoveryFailed {
            cleanup(store, &mut j, &m, platform, &a).await?;
        }
        return Ok(result);
    }
    if j.authorization.is_none() {
        let o = platform.observe(&m).await?;
        require(o.registration == RegistrationObservation::Original)?;
        j.state = AdoptionState::Restored;
        j.unchanged_registration = Some(UnchangedRegistration {
            sha256: m.old_registration.sha256.clone(),
            observed_at: platform.awake_now()?,
        });
        store.save(&mut j)?;
        cleanup(store, &mut j, &m, platform, &a).await?;
        return Ok(RecoveryOutcome::Restored);
    }
    restore(store, &mut j, &m, platform, &a, OtaError::Interrupted).await
}
async fn action(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    action: AdoptionAction,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
) -> Result<AdoptionEvidence, OtaError> {
    authority(a, m)?;
    let boot = p.awake_now()?.boot_id;
    let repeated = matches!(
        action,
        AdoptionAction::SuppressLifecycle | AdoptionAction::SwitchRegistration { .. }
    );
    let index = if let Some(index) = j
        .steps
        .iter()
        .position(|step| step.action == action && (!repeated || step.intent_boot_id == boot))
    {
        index
    } else {
        let index = j.steps.len();
        j.steps.push(AdoptionStep {
            action: action.clone(),
            intent_revision: j.revision.checked_add(1).ok_or(OtaError::Invalid)?,
            intent_boot_id: p.awake_now()?.boot_id,
            evidence: None,
        });
        store.save(j)?;
        index
    };
    if let Some(evidence) = &j.steps[index].evidence {
        return Ok(evidence.clone());
    }
    let evidence = match p.inspect_action(m, &action).await? {
        AdoptionActionObservation::Completed(e) => e,
        AdoptionActionObservation::NotStarted => p.perform(m, &action, a).await?,
        AdoptionActionObservation::Ambiguous => return Err(OtaError::RecoveryFailed),
    };
    j.steps[index].evidence = Some(evidence.clone());
    store.save(j)?;
    Ok(evidence)
}
async fn cleanup(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    require(matches!(
        j.state,
        AdoptionState::Committed | AdoptionState::Restored
    ))?;
    for effect in [
        AdoptionAction::ReleaseReservation,
        AdoptionAction::RetireRecovery,
    ] {
        action(store, j, m, effect, p, a).await?;
    }
    Ok(())
}
async fn stop_current(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    let o = p.observe(m).await?;
    require(o.reservation_held && o.recovery_job_armed)?;
    if let Some(process) = o.service {
        action(store, j, m, AdoptionAction::StopService { process }, p, a).await?;
    }
    require(p.observe(m).await?.service.is_none())
}
async fn launch(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    branch: AdoptionBranch,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
) -> Result<LaunchEvidence, OtaError> {
    let boot = p.awake_now()?.boot_id;
    let launch_id = if branch == AdoptionBranch::Original && boot != m.source.boot_id {
        match j.steps.iter().find_map(|step| match &step.action {
            AdoptionAction::LaunchService {
                branch: AdoptionBranch::Original,
                launch_id,
            } if step.intent_boot_id == boot => Some(launch_id.clone()),
            _ => None,
        }) {
            Some(id) => id,
            None => crate::ota::journal::random_id()?,
        }
    } else {
        m.launch_id(branch).into()
    };
    match action(
        store,
        j,
        m,
        AdoptionAction::LaunchService { branch, launch_id },
        p,
        a,
    )
    .await?
    {
        AdoptionEvidence::Launched { branch: b, launch } if b == branch => Ok(launch),
        _ => Err(OtaError::Identity),
    }
}
async fn readiness(
    j: &AdoptionJournal,
    m: &AdoptionManifest,
    branch: AdoptionBranch,
    launch: &LaunchEvidence,
    start: &AwakeStamp,
    p: &dyn AdoptionPlatform,
) -> Result<AdoptionReadinessProof, OtaError> {
    loop {
        let now = p.awake_now()?;
        let elapsed = native::elapsed_ms(start, &now).map_err(|_| OtaError::Timeout)?;
        if elapsed >= VERIFY_TIMEOUT_MS {
            return Err(OtaError::Timeout);
        }
        match p.poll_readiness(m, branch, launch).await? {
            AdoptionReadiness::Ready(proof) => {
                let after = p.awake_now()?;
                require(
                    native::elapsed_ms(start, &after).map_err(|_| OtaError::Timeout)?
                        < VERIFY_TIMEOUT_MS,
                )?;
                require(j.proof_valid(&proof, branch, m))?;
                return Ok(proof);
            }
            AdoptionReadiness::Failed => return Err(OtaError::RecoveryFailed),
            AdoptionReadiness::Pending => p.wait_for_observation().await?,
        }
    }
}
async fn switch(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    j.state = AdoptionState::Switching;
    store.save(j)?;
    action(store, j, m, AdoptionAction::PrepareReconnect, p, a).await?;
    action(store, j, m, AdoptionAction::SuppressLifecycle, p, a).await?;
    stop_current(store, j, m, p, a).await?;
    action(
        store,
        j,
        m,
        AdoptionAction::SwitchRegistration {
            branch: AdoptionBranch::Managed,
        },
        p,
        a,
    )
    .await?;
    j.verification_started = Some(p.awake_now()?);
    j.state = AdoptionState::Verifying;
    store.save(j)?;
    let launch = launch(store, j, m, AdoptionBranch::Managed, p, a).await?;
    let proof = readiness(
        j,
        m,
        AdoptionBranch::Managed,
        &launch,
        j.verification_started.as_ref().ok_or(OtaError::Invalid)?,
        p,
    )
    .await?;
    j.verification_proof = Some(proof);
    j.state = AdoptionState::Committed;
    store.save(j)
}
async fn restore(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
    error: OtaError,
) -> Result<RecoveryOutcome, OtaError> {
    require(j.authorization.is_some() && j.state != AdoptionState::Committed)?;
    j.state = AdoptionState::Restoring;
    j.error = Some(error);
    store.save(j)?;
    match restore_inner(store, j, m, p, a).await {
        Ok(()) => {
            cleanup(store, j, m, p, a).await?;
            Ok(RecoveryOutcome::Restored)
        }
        Err(OtaError::Interrupted) => Err(OtaError::Interrupted),
        Err(error) => {
            j.state = AdoptionState::RecoveryFailed;
            j.error = Some(error);
            store.save(j)?;
            Ok(RecoveryOutcome::RecoveryFailed)
        }
    }
}
async fn restore_inner(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    if p.awake_now()?.boot_id == m.source.boot_id {
        action(store, j, m, AdoptionAction::PrepareReconnect, p, a).await?;
    }
    action(store, j, m, AdoptionAction::SuppressLifecycle, p, a).await?;
    // A crash after original launch must resume its readiness interval, not
    // stop the exact incarnation which the durable launch already identifies.
    let observed = p.observe(m).await?;
    let boot = p.awake_now()?.boot_id;
    let original_action = j.steps.iter().find_map(|step| {
        (step.intent_boot_id == boot
            && matches!(
                step.action,
                AdoptionAction::LaunchService {
                    branch: AdoptionBranch::Original,
                    ..
                }
            ))
        .then(|| step.action.clone())
    });
    let resume_original = if observed.registration == RegistrationObservation::Original {
        if let (Some(process), Some(effect)) = (&observed.service, original_action) {
            match p.inspect_action(m, &effect).await? {
                AdoptionActionObservation::Completed(AdoptionEvidence::Launched {
                    branch: AdoptionBranch::Original,
                    launch,
                }) if launch.process == *process => {
                    action(store, j, m, effect, p, a).await?;
                    true
                }
                _ => false,
            }
        } else {
            false
        }
    } else {
        false
    };
    if !resume_original {
        stop_current(store, j, m, p, a).await?;
        action(
            store,
            j,
            m,
            AdoptionAction::SwitchRegistration {
                branch: AdoptionBranch::Original,
            },
            p,
            a,
        )
        .await?;
    }
    let now = p.awake_now()?;
    if let Some(old) = &j.restoration_started {
        if old.boot_id != now.boot_id {
            require(
                !j.restoration_history
                    .iter()
                    .any(|s| s.boot_id == now.boot_id),
            )?;
            j.restoration_history.push(old.clone());
            j.restoration_started = Some(now);
            store.save(j)?;
        }
    } else {
        j.restoration_started = Some(now);
        store.save(j)?;
    }
    let launch = launch(store, j, m, AdoptionBranch::Original, p, a).await?;
    if launch.process.boot_id != m.source.boot_id {
        recovery_reconnect(store, j, m, &launch, p, a).await?;
    }
    let proof = readiness(
        j,
        m,
        AdoptionBranch::Original,
        &launch,
        j.restoration_started.as_ref().ok_or(OtaError::Invalid)?,
        p,
    )
    .await?;
    j.restoration_proof = Some(proof);
    j.state = AdoptionState::Restored;
    store.save(j)
}

async fn recovery_reconnect(
    store: &AdoptionStore,
    j: &mut AdoptionJournal,
    m: &AdoptionManifest,
    launch: &LaunchEvidence,
    p: &dyn AdoptionPlatform,
    a: &VerifiedNativeAuthority,
) -> Result<(), OtaError> {
    let boot = p.awake_now()?.boot_id;
    if let Some(cap) = j
        .recovery_reconnects
        .iter()
        .find(|cap| cap.boot_id == boot)
        .cloned()
    {
        require(cap.original_launch_id == launch.launch_id)?;
        action(
            store,
            j,
            m,
            AdoptionAction::PrepareRecoveryReconnect { capability: cap },
            p,
            a,
        )
        .await?;
        return Ok(());
    }
    let desktop_launch_id = match j.steps.iter().find_map(|step| match &step.action {
        AdoptionAction::LaunchRecoveryDesktop { launch_id } if step.intent_boot_id == boot => {
            Some(launch_id.clone())
        }
        _ => None,
    }) {
        Some(id) => id,
        None => crate::ota::journal::random_id()?,
    };
    loop {
        let now = p.awake_now()?;
        require(
            native::elapsed_ms(
                j.restoration_started.as_ref().ok_or(OtaError::Invalid)?,
                &now,
            )
            .map_err(|_| OtaError::Timeout)?
                < VERIFY_TIMEOUT_MS,
        )?;
        if let Some(verified) = p.recovery_desktop(m, launch).await? {
            require(verified.service == launch.process && verified.desktop.boot_id == boot)?;
            if let Some(AdoptionEvidence::DesktopSpawned { process }) = j
                .steps
                .iter()
                .find(|step| {
                    step.action
                        == AdoptionAction::LaunchRecoveryDesktop {
                            launch_id: desktop_launch_id.clone(),
                        }
                })
                .and_then(|step| step.evidence.as_ref())
            {
                require(verified.desktop == *process)?;
            }
            let cap = RecoveryReconnectCapability {
                desktop: verified.desktop,
                original_launch_id: launch.launch_id.clone(),
                boot_id: boot,
                native_session_id: verified.native_session_id,
            };
            j.recovery_reconnects.push(cap.clone());
            store.save(j)?;
            action(
                store,
                j,
                m,
                AdoptionAction::PrepareRecoveryReconnect { capability: cap },
                p,
                a,
            )
            .await?;
            return Ok(());
        }
        action(
            store,
            j,
            m,
            AdoptionAction::LaunchRecoveryDesktop {
                launch_id: desktop_launch_id.clone(),
            },
            p,
            a,
        )
        .await?;
        p.wait_for_observation().await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    struct Lock;
    impl TransactionLocks for Lock {}
    struct World {
        registration: RegistrationObservation,
        service: Option<ProcessIdentity>,
        desktop: Option<ProcessIdentity>,
        armed: bool,
        reserved: bool,
        clock: u64,
        boot: String,
        fail_managed: bool,
        fail_original: bool,
        ready_at: u64,
        interrupt_after: Option<AdoptionAction>,
        effects: Vec<(AdoptionAction, AdoptionEvidence)>,
    }
    struct Fake {
        manifest: AdoptionManifest,
        world: RefCell<World>,
        path: std::path::PathBuf,
    }
    impl Fake {
        fn new(path: std::path::PathBuf) -> Self {
            let m = journal::tests::manifest();
            Self {
                world: RefCell::new(World {
                    registration: RegistrationObservation::Original,
                    service: Some(m.source.service.clone()),
                    desktop: Some(m.source.desktop.clone()),
                    armed: false,
                    reserved: true,
                    clock: 0,
                    boot: m.source.boot_id.clone(),
                    fail_managed: false,
                    fail_original: false,
                    ready_at: 0,
                    interrupt_after: None,
                    effects: vec![],
                }),
                manifest: m,
                path,
            }
        }
    }
    impl AdoptionPlatform for Fake {
        fn recovery_desktop<'a>(
            &'a self,
            _: &'a AdoptionManifest,
            launch: &'a LaunchEvidence,
        ) -> PlatformFuture<'a, Option<VerifiedRecoveryDesktop>> {
            Box::pin(async move {
                let w = self.world.borrow();
                Ok(w.desktop
                    .as_ref()
                    .filter(|p| p.boot_id == w.boot)
                    .map(|desktop| VerifiedRecoveryDesktop {
                        desktop: desktop.clone(),
                        native_session_id: "fresh-discovery".into(),
                        service: launch.process.clone(),
                    }))
            })
        }
        fn awake_now(&self) -> Result<AwakeStamp, OtaError> {
            let w = self.world.borrow();
            Ok(AwakeStamp {
                boot_id: w.boot.clone(),
                millis: w.clock,
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
            _: &'a AdoptionRequest,
        ) -> PlatformFuture<'a, VerifiedAdoptionPreparation> {
            Box::pin(async {
                Ok(VerifiedAdoptionPreparation {
                    manifest: self.manifest.clone(),
                    authority: VerifiedNativeAuthority::verified(self.manifest.binding.clone()),
                })
            })
        }
        fn reverify<'a>(
            &'a self,
            _: &'a AdoptionManifest,
            _: VerificationPurpose,
        ) -> PlatformFuture<'a, VerifiedNativeAuthority> {
            Box::pin(async {
                Ok(VerifiedNativeAuthority::verified(
                    self.manifest.binding.clone(),
                ))
            })
        }
        fn observe<'a>(
            &'a self,
            _: &'a AdoptionManifest,
        ) -> PlatformFuture<'a, AdoptionObservation> {
            Box::pin(async {
                let w = self.world.borrow();
                Ok(AdoptionObservation {
                    registration: w.registration,
                    reservation_held: w.reserved,
                    recovery_job_armed: w.armed,
                    service: w.service.clone(),
                })
            })
        }
        fn inspect_action<'a>(
            &'a self,
            _: &'a AdoptionManifest,
            a: &'a AdoptionAction,
        ) -> PlatformFuture<'a, AdoptionActionObservation> {
            Box::pin(async move {
                Ok(self
                    .world
                    .borrow()
                    .effects
                    .iter()
                    .find(|(x, _)| x == a)
                    .map(|(_, e)| AdoptionActionObservation::Completed(e.clone()))
                    .unwrap_or(AdoptionActionObservation::NotStarted))
            })
        }
        fn perform<'a>(
            &'a self,
            m: &'a AdoptionManifest,
            a: &'a AdoptionAction,
            _: &'a VerifiedNativeAuthority,
        ) -> PlatformFuture<'a, AdoptionEvidence> {
            Box::pin(async move {
                let journal: AdoptionJournal = serde_json::from_slice(
                    &std::fs::read(self.path.join("adoption-journal.json")).unwrap(),
                )
                .unwrap();
                assert!(
                    journal
                        .steps
                        .iter()
                        .any(|step| step.action == *a && step.evidence.is_none()),
                    "effect must have synced intent"
                );
                let mut w = self.world.borrow_mut();
                let mut e = AdoptionEvidence::Complete;
                match a {
                    AdoptionAction::LaunchRecoveryDesktop { .. } => {
                        assert!(w.desktop.is_none());
                        let process = ProcessIdentity {
                            pid: 303,
                            boot_id: w.boot.clone(),
                            birth: "900:1".into(),
                        };
                        w.desktop = Some(process.clone());
                        e = AdoptionEvidence::DesktopSpawned { process };
                    }
                    AdoptionAction::ArmRecovery => w.armed = true,
                    AdoptionAction::StopService { process } => {
                        assert_eq!(w.service.as_ref(), Some(process));
                        w.service = None;
                    }
                    AdoptionAction::SwitchRegistration { branch } => {
                        assert!(w.service.is_none());
                        w.registration = if *branch == AdoptionBranch::Managed {
                            RegistrationObservation::Managed
                        } else {
                            RegistrationObservation::Original
                        };
                    }
                    AdoptionAction::LaunchService { branch, launch_id } => {
                        assert!(w.service.is_none());
                        let process = ProcessIdentity {
                            pid: if *branch == AdoptionBranch::Managed {
                                202
                            } else {
                                203
                            },
                            boot_id: w.boot.clone(),
                            birth: "100:9".into(),
                        };
                        w.service = Some(process.clone());
                        e = AdoptionEvidence::Launched {
                            branch: *branch,
                            launch: LaunchEvidence {
                                role: ProcessRole::Service,
                                release: if *branch == AdoptionBranch::Managed {
                                    Release::Candidate
                                } else {
                                    Release::Old
                                },
                                launch_id: launch_id.clone(),
                                process,
                                native_session_id: launch_id.clone(),
                                version: m.version(*branch).into(),
                            },
                        };
                    }
                    AdoptionAction::ReleaseReservation => {
                        assert!(matches!(
                            journal.state,
                            AdoptionState::Committed | AdoptionState::Restored
                        ));
                        w.reserved = false;
                    }
                    AdoptionAction::RetireRecovery => w.armed = false,
                    _ => {}
                }
                w.effects.push((a.clone(), e.clone()));
                if w.interrupt_after.as_ref() == Some(a) {
                    w.interrupt_after = None;
                    return Err(OtaError::Interrupted);
                }
                Ok(e)
            })
        }
        fn poll_readiness<'a>(
            &'a self,
            m: &'a AdoptionManifest,
            b: AdoptionBranch,
            launch: &'a LaunchEvidence,
        ) -> PlatformFuture<'a, AdoptionReadiness> {
            Box::pin(async move {
                let w = self.world.borrow();
                if w.service.as_ref() != Some(&launch.process) {
                    return Ok(AdoptionReadiness::Failed);
                }
                if (b == AdoptionBranch::Managed && w.fail_managed)
                    || (b == AdoptionBranch::Original && w.fail_original)
                {
                    return Ok(AdoptionReadiness::Failed);
                }
                if w.clock < w.ready_at {
                    return Ok(AdoptionReadiness::Pending);
                }
                let journal: AdoptionJournal = serde_json::from_slice(
                    &std::fs::read(self.path.join("adoption-journal.json")).unwrap(),
                )
                .unwrap();
                let desktop = journal
                    .recovery_reconnects
                    .iter()
                    .find(|c| c.original_launch_id == launch.launch_id)
                    .map(|c| c.desktop.clone())
                    .unwrap_or_else(|| m.source.desktop.clone());
                Ok(AdoptionReadiness::Ready(AdoptionReadinessProof {
                    installation_id: m.source.target.id.clone(),
                    transaction_id: m.transaction_id().into(),
                    resulting_installation_id: m.resulting_id(b).into(),
                    branch: b,
                    desktop,
                    native_session_id: launch.launch_id.clone(),
                    desktop_version: m.source.target.version.clone(),
                    service: launch.process.clone(),
                    service_version: m.version(b).into(),
                    protocol: 3,
                    desktop_signed_in: true,
                    valid_state_read: true,
                }))
            })
        }
        fn wait_for_observation<'a>(&'a self) -> PlatformFuture<'a, ()> {
            Box::pin(async {
                self.world.borrow_mut().clock += 1;
                Ok(())
            })
        }
    }
    async fn prepared() -> (
        crate::ota::journal::tests::Temp,
        AdoptionStore,
        Fake,
        PreparedReceipt,
    ) {
        let temp = crate::ota::journal::tests::Temp::new();
        let store = AdoptionStore::open(&temp.0).unwrap();
        let fake = Fake::new(temp.0.clone());
        let request = AdoptionRequest {
            binding: fake.manifest.binding.clone(),
            target: fake.manifest.source.target.clone(),
            authority: VerifiedNativeAuthority::verified(fake.manifest.binding.clone()),
        };
        let receipt = prepare_adoption(&store, &request, &fake).await.unwrap();
        (temp, store, fake, receipt)
    }
    async fn authorized() -> (crate::ota::journal::tests::Temp, AdoptionStore, Fake) {
        let (temp, store, fake, r) = prepared().await;
        authorize_adoption(
            &store,
            &Authorization {
                binding: fake.manifest.binding.clone(),
                kind: wire::AuthorizationKind::AuthorizeInstall,
                reservation_id: r.reservation_id,
                journal_sha256: r.journal_sha256,
            },
            &fake,
        )
        .await
        .unwrap();
        (temp, store, fake)
    }
    #[tokio::test]
    async fn recovery_after_original_launch_keeps_exact_live_incarnation_and_deadline() {
        let (_t, store, p) = authorized().await;
        p.world.borrow_mut().fail_managed = true;
        p.world.borrow_mut().interrupt_after = Some(AdoptionAction::LaunchService {
            branch: AdoptionBranch::Original,
            launch_id: p.manifest.original_launch_id.clone(),
        });
        assert!(matches!(
            execute_adoption(&store, &p).await,
            Err(OtaError::Interrupted)
        ));
        let process = p.world.borrow().service.clone();
        let started = store.load().unwrap().restoration_started.clone();
        assert_eq!(
            recover_adoption(&store, &p).await.unwrap(),
            RecoveryOutcome::Restored
        );
        assert_eq!(p.world.borrow().service, process);
        assert_eq!(store.load().unwrap().restoration_started, started);
        assert_eq!(
            p.world
                .borrow()
                .effects
                .iter()
                .filter(|(a, _)| matches!(
                    a,
                    AdoptionAction::LaunchService {
                        branch: AdoptionBranch::Original,
                        ..
                    }
                ))
                .count(),
            1
        );
    }
    #[tokio::test]
    async fn interruption_after_registration_effect_restores_without_rearming_managed_launch() {
        let (_t, store, p) = authorized().await;
        p.world.borrow_mut().interrupt_after = Some(AdoptionAction::SwitchRegistration {
            branch: AdoptionBranch::Managed,
        });
        assert!(matches!(
            execute_adoption(&store, &p).await,
            Err(OtaError::Interrupted)
        ));
        assert_eq!(
            p.world.borrow().registration,
            RegistrationObservation::Managed
        );
        assert!(store
            .load()
            .unwrap()
            .steps
            .last()
            .unwrap()
            .evidence
            .is_none());
        assert_eq!(
            recover_adoption(&store, &p).await.unwrap(),
            RecoveryOutcome::Restored
        );
        assert!(!p.world.borrow().effects.iter().any(|(a, _)| matches!(
            a,
            AdoptionAction::LaunchService {
                branch: AdoptionBranch::Managed,
                ..
            }
        )));
    }
    #[tokio::test]
    async fn readiness_accepts_119999_but_refuses_exact_120000_awake_ms() {
        let (_t, store, p) = authorized().await;
        let mut j = store.load().unwrap();
        let launch = LaunchEvidence {
            role: ProcessRole::Service,
            release: Release::Candidate,
            launch_id: p.manifest.managed_launch_id.clone(),
            native_session_id: p.manifest.managed_launch_id.clone(),
            process: p.manifest.source.service.clone(),
            version: p.manifest.source.target.version.clone(),
        };
        j.steps.push(AdoptionStep {
            action: AdoptionAction::LaunchService {
                branch: AdoptionBranch::Managed,
                launch_id: launch.launch_id.clone(),
            },
            intent_revision: j.revision + 1,
            intent_boot_id: p.manifest.source.boot_id.clone(),
            evidence: Some(AdoptionEvidence::Launched {
                branch: AdoptionBranch::Managed,
                launch: launch.clone(),
            }),
        });
        let start = AwakeStamp {
            boot_id: p.manifest.source.boot_id.clone(),
            millis: 0,
        };
        p.world.borrow_mut().clock = 119_999;
        assert!(readiness(
            &j,
            &p.manifest,
            AdoptionBranch::Managed,
            &launch,
            &start,
            &p
        )
        .await
        .is_ok());
        p.world.borrow_mut().clock = 120_000;
        assert!(matches!(
            readiness(
                &j,
                &p.manifest,
                AdoptionBranch::Managed,
                &launch,
                &start,
                &p
            )
            .await,
            Err(OtaError::Timeout)
        ));
    }
    #[tokio::test]
    async fn restoration_deadline_cannot_reset_within_one_boot() {
        let (_t, store, p) = authorized().await;
        let mut j = store.load().unwrap();
        j.state = AdoptionState::Restoring;
        j.restoration_started = Some(p.awake_now().unwrap());
        store.save(&mut j).unwrap();
        j.restoration_started.as_mut().unwrap().millis += 1;
        assert!(store.save(&mut j).is_err());
    }
    #[tokio::test]
    async fn original_only_restore_cannot_append_a_managed_launch() {
        let (_t, store, p) = authorized().await;
        let mut j = store.load().unwrap();
        j.state = AdoptionState::Restoring;
        store.save(&mut j).unwrap();
        j.steps.push(AdoptionStep {
            action: AdoptionAction::LaunchService {
                branch: AdoptionBranch::Managed,
                launch_id: p.manifest.managed_launch_id.clone(),
            },
            intent_revision: j.revision + 1,
            intent_boot_id: p.awake_now().unwrap().boot_id,
            evidence: None,
        });
        assert!(store.save(&mut j).is_err());
    }
    #[tokio::test]
    async fn reboot_reobserves_lifecycle_and_original_registration_before_effects() {
        let (_t, store, p) = authorized().await;
        let mut j = store.load().unwrap();
        j.state = AdoptionState::Restoring;
        store.save(&mut j).unwrap();
        p.world.borrow_mut().service = None;
        let authority = VerifiedNativeAuthority::verified(p.manifest.binding.clone());
        for effect in [
            AdoptionAction::SuppressLifecycle,
            AdoptionAction::SwitchRegistration {
                branch: AdoptionBranch::Original,
            },
        ] {
            action(&store, &mut j, &p.manifest, effect, &p, &authority)
                .await
                .unwrap();
        }
        p.world.borrow_mut().effects.clear();
        p.world.borrow_mut().boot = "boot-two".into();
        p.world.borrow_mut().registration = RegistrationObservation::Managed;
        for effect in [
            AdoptionAction::SuppressLifecycle,
            AdoptionAction::SwitchRegistration {
                branch: AdoptionBranch::Original,
            },
        ] {
            action(&store, &mut j, &p.manifest, effect, &p, &authority)
                .await
                .unwrap();
        }
        assert_eq!(
            p.world.borrow().registration,
            RegistrationObservation::Original
        );
        assert_eq!(p.world.borrow().effects.len(), 2);
        assert_eq!(
            j.steps
                .iter()
                .filter(|s| s.intent_boot_id == "boot-two")
                .count(),
            2
        );
    }
    #[tokio::test]
    async fn original_boot_consent_cannot_be_authorized_after_reboot() {
        let (_temp, store, fake, receipt) = prepared().await;
        fake.world.borrow_mut().boot = "different-boot".into();
        let auth = Authorization {
            binding: fake.manifest.binding.clone(),
            kind: wire::AuthorizationKind::AuthorizeInstall,
            reservation_id: receipt.reservation_id,
            journal_sha256: receipt.journal_sha256,
        };
        assert!(authorize_adoption(&store, &auth, &fake).await.is_err());
        assert!(store.load().unwrap().authorization.is_none());
    }
    #[tokio::test]
    async fn adoption_commits_only_after_fresh_reconnect_and_never_restores_committed() {
        let (_t, s, p) = authorized().await;
        assert_eq!(
            execute_adoption(&s, &p).await.unwrap(),
            RecoveryOutcome::Committed
        );
        let before = p.world.borrow().effects.clone();
        assert_eq!(
            recover_adoption(&s, &p).await.unwrap(),
            RecoveryOutcome::Committed
        );
        assert_eq!(p.world.borrow().effects, before);
        let actions: Vec<_> = before.iter().map(|(a, _)| a).collect();
        assert!(
            actions
                .iter()
                .position(|a| matches!(a, AdoptionAction::PrepareReconnect))
                .unwrap()
                < actions
                    .iter()
                    .position(|a| matches!(a, AdoptionAction::StopService { .. }))
                    .unwrap()
        );
        assert!(!p.world.borrow().reserved);
    }
    #[tokio::test]
    async fn failed_managed_readiness_restores_original_registration_and_fresh_service() {
        let (_t, s, p) = authorized().await;
        p.world.borrow_mut().fail_managed = true;
        assert_eq!(
            execute_adoption(&s, &p).await.unwrap(),
            RecoveryOutcome::Restored
        );
        let w = p.world.borrow();
        assert_eq!(w.registration, RegistrationObservation::Original);
        assert_eq!(w.service.as_ref().unwrap().pid, 203);
        assert!(!w.reserved);
        assert!(s.load().unwrap().restoration_proof.is_some());
    }
    #[tokio::test]
    async fn failed_original_readiness_keeps_reservation_recovery_and_evidence() {
        let (_t, s, p) = authorized().await;
        {
            let mut w = p.world.borrow_mut();
            w.fail_managed = true;
            w.fail_original = true;
        }
        assert_eq!(
            execute_adoption(&s, &p).await.unwrap(),
            RecoveryOutcome::RecoveryFailed
        );
        assert!(p.world.borrow().reserved && p.world.borrow().armed);
        assert_eq!(s.load().unwrap().state, AdoptionState::RecoveryFailed);
    }
    #[tokio::test]
    async fn grantless_recovery_cleans_only_unchanged_original_and_never_stops() {
        let (_t, s, p, _) = prepared().await;
        assert_eq!(
            recover_adoption(&s, &p).await.unwrap(),
            RecoveryOutcome::Restored
        );
        assert!(s.load().unwrap().unchanged_registration.is_some());
        assert!(!p.world.borrow().effects.iter().any(|(a, _)| matches!(
            a,
            AdoptionAction::StopService { .. }
                | AdoptionAction::SwitchRegistration { .. }
                | AdoptionAction::LaunchService { .. }
        )));
    }
    #[tokio::test]
    async fn changed_boot_restores_without_launching_managed_branch() {
        let (_t, s, p) = authorized().await;
        p.world.borrow_mut().boot = "boot-two".into();
        p.world.borrow_mut().desktop = None;
        assert_eq!(
            execute_adoption(&s, &p).await.unwrap(),
            RecoveryOutcome::Restored
        );
        assert!(!p.world.borrow().effects.iter().any(|(a, _)| matches!(
            a,
            AdoptionAction::LaunchService {
                branch: AdoptionBranch::Managed,
                ..
            }
        )));
        let journal = s.load().unwrap();
        let proof = journal.restoration_proof.unwrap();
        assert_eq!(proof.desktop.pid, 303);
        assert_eq!(proof.desktop.boot_id, "boot-two");
        assert_ne!(proof.native_session_id, p.manifest.original_launch_id);
        assert_eq!(journal.recovery_reconnects.len(), 1);
    }
}
