//! Candidate-free helper dispatch. Never constructs an updater or reads update grants.
use super::*;
use crate::ota::{
    adoption::{journal::AdoptionStore, recovery, AdoptionRequest},
    control,
    platform::NativeAdoptionPlatform,
    platform_fs::PrivateDir,
};

pub(super) async fn run_request<W: Write>(
    trust: ReleaseTrust,
    bootstrap: &Bootstrap,
    command: AdapterCommand,
    input: &mut PipeInput,
    responses: &mut Responses<W>,
) -> Result<(), OtaError> {
    let context = control::adoption_context(&bootstrap.endpoint(), command.binding(), &trust)?;
    let native_arch = match std::env::consts::ARCH {
        "aarch64" => wire::Arch::Aarch64,
        "x86_64" => wire::Arch::X86_64,
        _ => return Err(OtaError::Unavailable),
    };
    if context.source.target.pacer_home != bootstrap.home.to_str().ok_or(OtaError::Identity)?
        || context.source.target.port != bootstrap.port
        || context.source.target.arch != native_arch
    {
        return Err(OtaError::Identity);
    }
    let response = responses.next()?;
    responses.send(&AdapterFrame::Hello {
        response,
        version: env!("CARGO_PKG_VERSION").into(),
        bundle_id: crate::ota::trust::APP_ID.into(),
        arch: native_arch,
    })?;
    match command {
        AdapterCommand::Adopt { binding, target } => {
            if target != context.source.target {
                return Err(OtaError::Identity);
            }
            let platform = NativeAdoptionPlatform::new(trust, context)?;
            let store = AdoptionStore::open(platform.transaction_directory())?;
            let request = AdoptionRequest {
                authority: crate::ota::VerifiedNativeAuthority::verified(binding.clone()),
                binding,
                target,
            };
            let receipt = recovery::prepare_adoption(&store, &request, &platform).await?;
            let response = responses.next()?;
            responses.send(&AdapterFrame::Prepared {
                response,
                reservation_id: receipt.reservation_id.clone(),
                journal_sha256: receipt.journal_sha256.clone(),
            })?;
            input.start_frame();
            let authorization: wire::InstallAuthorization = wire::read_message(input)
                .map_err(|_| OtaError::Invalid)?
                .ok_or(OtaError::Interrupted)?;
            recovery::authorize_adoption(&store, &authorization, &platform).await?;
            finish_authorized(
                responses,
                &receipt,
                recovery::execute_adoption(&store, &platform),
            )
            .await
            .map(|_| ())
        }
        AdapterCommand::RecoverAdoption { binding } => {
            let tx = binding.transaction_id.as_deref().ok_or(OtaError::Invalid)?;
            let directory = PrivateDir::open(
                &bootstrap
                    .home
                    .join("desktop-updates/native")
                    .join(&binding.installation_id)
                    .join(tx),
            )?;
            let store = recovery_store(&directory.path).await?;
            let (manifest, _) = store.manifest()?;
            if manifest.source.target.id != binding.installation_id
                || manifest.transaction_id() != tx
                || std::path::Path::new(&manifest.source.target.pacer_home) != bootstrap.home
            {
                return Err(OtaError::Identity);
            }
            crate::ota::recovery_authority::verify_adoption(
                &bootstrap.home,
                &manifest,
                &store.load()?,
            )?;
            let platform = NativeAdoptionPlatform::recover(trust, manifest)?;
            let outcome = recovery::recover_adoption(&store, &platform).await?;
            let response = responses.next()?;
            responses.send(&AdapterFrame::Outcome {
                response,
                outcome: match outcome {
                    crate::ota::RecoveryOutcome::Committed => wire::Outcome::Committed,
                    crate::ota::RecoveryOutcome::Restored => wire::Outcome::Restored,
                    crate::ota::RecoveryOutcome::RecoveryFailed => wire::Outcome::RecoveryFailed,
                },
            })
        }
        _ => Err(OtaError::Invalid),
    }
}

async fn recovery_store(path: &std::path::Path) -> Result<AdoptionStore, OtaError> {
    let started = crate::ota::native::awake_now().map_err(|_| OtaError::Identity)?;
    loop {
        match AdoptionStore::open(path) {
            Err(OtaError::Busy) => {}
            result => return result,
        }
        let now = crate::ota::native::awake_now().map_err(|_| OtaError::Identity)?;
        if now.boot_id != started.boot_id || now.millis < started.millis {
            return Err(OtaError::Identity);
        }
        if now.millis - started.millis >= 480_000 {
            return Err(OtaError::Timeout);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

pub(super) async fn run_recovery(
    trust: ReleaseTrust,
    installation: &str,
    transaction: &str,
) -> Result<(), OtaError> {
    use sha2::{Digest, Sha256};
    let own = crate::ota::native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Helper)?;
    let executable = own.executable;
    let (home, path) = recovery_coordinates(&executable, installation, transaction)?;
    let store = recovery_store(&path).await?;
    let (manifest, _) = store.manifest()?;
    if manifest.source.target.id != installation
        || manifest.transaction_id() != transaction
        || std::path::Path::new(&manifest.source.target.pacer_home) != home
        || manifest.recovery_job.helper.relative_path != "pacer-update-helper"
    {
        return Err(OtaError::Identity);
    }
    trust.verify_static(&executable, CodeRole::Helper)?;
    let helper = crate::ota::platform_fs::read_owned_file(&executable, 128 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(helper)) != manifest.recovery_job.helper.sha256 {
        return Err(OtaError::Identity);
    }
    crate::ota::recovery_authority::verify_adoption(&home, &manifest, &store.load()?)?;
    let platform = NativeAdoptionPlatform::recover(trust, manifest)?;
    match recovery::recover_adoption(&store, &platform).await? {
        crate::ota::RecoveryOutcome::RecoveryFailed => Err(OtaError::RecoveryFailed),
        _ => Ok(()),
    }
}
