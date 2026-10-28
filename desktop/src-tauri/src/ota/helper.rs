//! External helper pipe protocol. Endpoint hints never substitute for native peer proof.
use super::{
    control::ServiceEndpoint,
    trust::{CodeRole, ReleaseTrust},
    wire::{self, AdapterCommand, AdapterFrame, Binding, ResponseBinding},
    OtaError, ProcessIdentity,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
};

#[cfg(target_os = "macos")]
#[path = "helper_adoption.rs"]
mod adoption;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bootstrap {
    pub schema: u32,
    pub kind: String,
    pub home: PathBuf,
    pub port: u16,
    pub service: ProcessIdentity,
    pub executable: PathBuf,
}
impl Bootstrap {
    fn read(input: &mut impl Read) -> Result<Self, OtaError> {
        let mut length = [0u8; 4];
        input.read_exact(&mut length).map_err(|_| OtaError::Io)?;
        let length = u32::from_be_bytes(length) as usize;
        if length == 0 || length > 262_144 {
            return Err(OtaError::Invalid);
        }
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes).map_err(|_| OtaError::Io)?;
        let bootstrap: Self = serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
        let path = |path: &std::path::Path| {
            path.is_absolute()
                && path.as_os_str().as_encoded_bytes().len() <= 4096
                && !path.as_os_str().as_encoded_bytes().contains(&0)
                && path.components().all(|part| {
                    matches!(
                        part,
                        std::path::Component::RootDir | std::path::Component::Normal(_)
                    )
                })
        };
        if bootstrap.schema != 1
            || bootstrap.kind != "helper-bootstrap"
            || bootstrap.port == 0
            || !path(&bootstrap.home)
            || !path(&bootstrap.executable)
            || bootstrap.service.pid == 0
            || bootstrap.service.boot_id.is_empty()
            || bootstrap.service.birth.is_empty()
        {
            return Err(OtaError::Invalid);
        }
        Ok(bootstrap)
    }
    fn verify_parent(&self, trust: &ReleaseTrust) -> Result<(), OtaError> {
        let parent = unsafe { libc::getppid() };
        if parent <= 1 || parent as u32 != self.service.pid {
            return Err(OtaError::Identity);
        }
        let verified = trust.verify_process(&self.service, CodeRole::Cli)?;
        if verified
            .details()
            .executable
            .canonicalize()
            .map_err(|_| OtaError::Identity)?
            != self.executable
        {
            return Err(OtaError::Identity);
        }
        if let Some(fixture) = trust.fixture_policy() {
            if fixture.home != self.home || fixture.port != self.port {
                return Err(OtaError::Identity);
            }
        }
        Ok(())
    }
    fn endpoint(&self) -> ServiceEndpoint<'_> {
        ServiceEndpoint {
            home: &self.home,
            port: self.port,
            process: &self.service,
            executable: &self.executable,
        }
    }
}
#[cfg(target_os = "macos")]
pub(crate) fn verify_takeover_parent(
    manifest: &super::takeover::journal::TakeoverManifest,
    trust: &ReleaseTrust,
) -> Result<(), OtaError> {
    let pid = unsafe { libc::getppid() };
    if pid <= 1 || pid as u32 != manifest.desktop.pid {
        return Err(OtaError::Identity);
    }
    let verified = trust.verify_process(&manifest.desktop, CodeRole::Desktop)?;
    let app = manifest
        .bundled_cli
        .parent()
        .and_then(std::path::Path::parent)
        .and_then(std::path::Path::parent)
        .ok_or(OtaError::Identity)?;
    let desktop = app.join("Contents/MacOS/pacer");
    let helper = app.join("Contents/Resources/pacer-update-helper");
    if verified
        .details()
        .executable
        .canonicalize()
        .map_err(|_| OtaError::Identity)?
        != desktop
        || std::env::current_exe()
            .map_err(|_| OtaError::Identity)?
            .canonicalize()
            .map_err(|_| OtaError::Identity)?
            != helper
    {
        return Err(OtaError::Identity);
    }
    trust.verify_static(&manifest.bundled_cli, CodeRole::Cli)?;
    trust.verify_static(&helper, CodeRole::Helper)
}
struct Responses<W: Write> {
    output: W,
    binding: Binding,
    sequence: u64,
}
impl<W: Write> Responses<W> {
    fn next(&mut self) -> Result<ResponseBinding, OtaError> {
        let sequence = self.sequence;
        self.sequence = self.sequence.checked_add(1).ok_or(OtaError::Invalid)?;
        Ok(ResponseBinding {
            binding: self.binding.clone(),
            sequence,
        })
    }
    fn send(&mut self, frame: &AdapterFrame) -> Result<(), OtaError> {
        wire::write_message(&mut self.output, frame).map_err(|_| OtaError::Io)?;
        self.output.flush().map_err(|_| OtaError::Io)
    }
}

async fn finish_authorized<W: Write>(
    responses: &mut Responses<W>,
    receipt: &super::PreparedReceipt,
    execute: impl std::future::Future<Output = Result<super::RecoveryOutcome, OtaError>>,
) -> Result<super::RecoveryOutcome, OtaError> {
    let response = responses.next()?;
    // Authorization is already durable. Losing the parent pipe cannot cancel
    // recovery or release ownership of the destination.
    let _ = responses.send(&AdapterFrame::Authorized {
        response,
        reservation_id: receipt.reservation_id.clone(),
        journal_sha256: receipt.journal_sha256.clone(),
    });
    let outcome = execute.await?;
    let response = responses.next()?;
    let wire_outcome = match outcome {
        super::RecoveryOutcome::Committed => wire::Outcome::Committed,
        super::RecoveryOutcome::Restored => wire::Outcome::Restored,
        super::RecoveryOutcome::RecoveryFailed => wire::Outcome::RecoveryFailed,
    };
    let _ = responses.send(&AdapterFrame::Outcome {
        response,
        outcome: wire_outcome,
    });
    Ok(outcome)
}

#[cfg(target_os = "macos")]
pub async fn run_pipe<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    trust: ReleaseTrust,
    input: &mut PipeInput,
    output: impl Write,
) -> Result<(), OtaError> {
    input.start_frame();
    let bootstrap = Bootstrap::read(input)?;
    bootstrap.verify_parent(&trust)?;
    input.start_frame();
    let command: AdapterCommand = wire::read_message(input)
        .map_err(|_| OtaError::Invalid)?
        .ok_or(OtaError::Interrupted)?;
    let mut responses = Responses {
        output,
        binding: command.binding().clone(),
        sequence: 0,
    };
    let result = run_request(app, trust, &bootstrap, command, input, &mut responses).await;
    if let Err(error) = result {
        if let Ok(response) = responses.next() {
            let _ = responses.send(&AdapterFrame::Error {
                response,
                code: match error {
                    OtaError::Io => wire::RemoteError::Disk,
                    OtaError::RecoveryFailed => wire::RemoteError::Recovery,
                    _ => wire::RemoteError::Verification,
                },
            });
        }
    }
    result
}

#[cfg(target_os = "macos")]
async fn run_request<R: tauri::Runtime, W: Write>(
    app: &tauri::AppHandle<R>,
    trust: ReleaseTrust,
    bootstrap: &Bootstrap,
    command: AdapterCommand,
    input: &mut PipeInput,
    responses: &mut Responses<W>,
) -> Result<(), OtaError> {
    if matches!(
        command,
        AdapterCommand::Adopt { .. } | AdapterCommand::RecoverAdoption { .. }
    ) {
        return adoption::run_request(trust, bootstrap, command, input, responses).await;
    }
    use super::{
        control, journal::JournalStore, platform::NativePlatform, platform_fs::PrivateDir,
        recovery, updater::NativeUpdater,
    };
    let context = control::helper_session(&bootstrap.endpoint(), command.binding(), &trust)?;
    let native_arch = match std::env::consts::ARCH {
        "aarch64" => wire::Arch::Aarch64,
        "x86_64" => wire::Arch::X86_64,
        _ => return Err(OtaError::Unavailable),
    };
    if context.target.pacer_home != bootstrap.home.to_str().ok_or(OtaError::Identity)?
        || context.target.port != bootstrap.port
        || context.target.arch != native_arch
    {
        return Err(OtaError::Identity);
    }
    let response = responses.next()?;
    responses.send(&AdapterFrame::Hello {
        response,
        version: env!("CARGO_PKG_VERSION").into(),
        bundle_id: super::trust::APP_ID.into(),
        arch: native_arch,
    })?;
    let updater = NativeUpdater::new(app, trust.clone(), context.target.clone())?;
    match &command {
        // Routed before update context or candidate verification is constructed.
        AdapterCommand::Adopt { .. } | AdapterCommand::RecoverAdoption { .. } => {
            Err(OtaError::Invalid)
        }
        AdapterCommand::Check { .. } => {
            let candidate = updater.check().await?;
            let response = responses.next()?;
            responses.send(&AdapterFrame::Checked {
                response,
                candidate,
            })
        }
        AdapterCommand::Download { candidate, .. } => {
            let directory = PrivateDir::downloads(&bootstrap.home, &context.target.id)?;
            let package = updater
                .download(
                    candidate,
                    &directory.path,
                    |downloaded_bytes, total_bytes| {
                        if let Ok(response) = responses.next() {
                            let _ = responses.send(&AdapterFrame::Progress {
                                response,
                                downloaded_bytes,
                                total_bytes,
                            });
                        }
                    },
                )
                .await?;
            let cache_lock = directory.lock_named(".cache-lock")?;
            let current =
                control::helper_session(&bootstrap.endpoint(), command.binding(), &trust)?;
            if current.target != context.target
                || current.desktop != context.desktop
                || current.service != context.service
                || current.native_session_id != context.native_session_id
            {
                return Err(OtaError::Identity);
            }
            directory.store_archive(&candidate.sha256, package.bytes())?;
            super::retention::prune_downloads(&directory, &candidate.sha256, &cache_lock)?;
            let size = package.bytes().len() as u64;
            let response = responses.next()?;
            responses.send(&AdapterFrame::Downloaded {
                response,
                candidate: candidate.clone(),
                downloaded_bytes: size,
                total_bytes: size,
            })
        }
        AdapterCommand::Install {
            candidate, target, ..
        } => {
            if target != &context.target {
                return Err(OtaError::Identity);
            }
            let directory = PrivateDir::downloads(&bootstrap.home, &target.id)?;
            let package = updater.verify(
                directory.read_archive(&candidate.sha256)?,
                candidate,
                &directory.path,
            )?;
            let platform = NativePlatform::new(
                trust,
                updater,
                package,
                context,
                bootstrap.executable.clone(),
            )?;
            let store = JournalStore::open(platform.transaction_directory())?;
            let request = super::InstallRequest {
                authority: super::VerifiedNativeAuthority::verified(command.binding().clone()),
                command,
            };
            let receipt = recovery::prepare_transaction(&store, &request, &platform).await?;
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
            recovery::authorize_transaction(&store, &authorization, &platform).await?;
            finish_authorized(
                responses,
                &receipt,
                recovery::execute_transaction(&store, &platform),
            )
            .await
            .map(|_| ())
        }
        AdapterCommand::Recover { binding } => {
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
            if manifest.target.id != binding.installation_id || manifest.transaction_id() != tx {
                return Err(OtaError::Identity);
            }
            super::recovery_authority::verify(&bootstrap.home, &manifest, &store.load()?)?;
            // The current bundle may already be the candidate. Restore updater
            // metadata using the immutable old version, never the running helper's.
            let updater = NativeUpdater::new(app, trust.clone(), manifest.target.clone())?;
            let bytes = directory.read(
                &manifest.artifact.relative_path,
                super::updater::MAX_ARTIFACT_BYTES,
            )?;
            let package = updater.verify(bytes, &manifest.candidate, &directory.path)?;
            let platform = NativePlatform::recover(
                trust,
                updater,
                package,
                manifest,
                bootstrap.executable.clone(),
            )?;
            let outcome = recovery::recover_transaction(&store, &platform).await?;
            let response = responses.next()?;
            responses.send(&AdapterFrame::Outcome {
                response,
                outcome: match outcome {
                    super::RecoveryOutcome::Committed => wire::Outcome::Committed,
                    super::RecoveryOutcome::Restored => wire::Outcome::Restored,
                    super::RecoveryOutcome::RecoveryFailed => wire::Outcome::RecoveryFailed,
                },
            })
        }
    }
}

#[cfg(target_os = "macos")]
pub async fn run_adoption_recovery(
    trust: ReleaseTrust,
    installation: &str,
    transaction: &str,
) -> Result<(), OtaError> {
    adoption::run_recovery(trust, installation, transaction).await
}

fn recovery_coordinates(
    executable: &std::path::Path,
    installation: &str,
    transaction: &str,
) -> Result<(PathBuf, PathBuf), OtaError> {
    let identifier = |s: &str| {
        !s.is_empty()
            && s.len() <= 128
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !identifier(installation)
        || !identifier(transaction)
        || executable.canonicalize().map_err(|_| OtaError::Identity)? != executable
    {
        return Err(OtaError::Identity);
    }
    let directory = executable.parent().ok_or(OtaError::Identity)?;
    let home = directory.ancestors().nth(4).ok_or(OtaError::Identity)?;
    let expected = home
        .join("desktop-updates/native")
        .join(installation)
        .join(transaction);
    if directory != expected
        || executable.file_name().and_then(|name| name.to_str()) != Some("pacer-update-helper")
    {
        return Err(OtaError::Identity);
    }
    Ok((home.into(), directory.into()))
}

async fn recovery_store(path: &std::path::Path) -> Result<super::journal::JournalStore, OtaError> {
    let started = super::native::awake_now().map_err(|_| OtaError::Identity)?;
    loop {
        match super::journal::JournalStore::open(path) {
            Err(OtaError::Busy) => {}
            result => return result,
        }
        let now = super::native::awake_now().map_err(|_| OtaError::Identity)?;
        if now.boot_id != started.boot_id || now.millis < started.millis {
            return Err(OtaError::Identity);
        }
        if now.millis - started.millis >= 480_000 {
            return Err(OtaError::Timeout);
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

#[cfg(target_os = "macos")]
pub async fn run_recovery<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    trust: ReleaseTrust,
    installation: &str,
    transaction: &str,
) -> Result<(), OtaError> {
    use super::{platform::NativePlatform, platform_fs::PrivateDir, updater::NativeUpdater};
    use sha2::{Digest, Sha256};
    let executable = std::env::current_exe().map_err(|_| OtaError::Identity)?;
    let (home, path) = recovery_coordinates(&executable, installation, transaction)?;
    let directory = PrivateDir::open(&path)?;
    let store = recovery_store(&path).await?;
    let (manifest, _) = store.manifest()?;
    if manifest.target.id != installation
        || manifest.transaction_id() != transaction
        || std::path::Path::new(&manifest.target.pacer_home) != home
        || manifest.recovery_job.helper.relative_path != "pacer-update-helper"
    {
        return Err(OtaError::Identity);
    }
    trust.verify_static(&executable, CodeRole::Helper)?;
    let helper = super::platform_fs::read_owned_file(&executable, 128 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(helper)) != manifest.recovery_job.helper.sha256 {
        return Err(OtaError::Identity);
    }
    super::recovery_authority::verify(&home, &manifest, &store.load()?)?;
    let updater = NativeUpdater::new(app, trust.clone(), manifest.target.clone())?;
    let bytes = directory.read(
        &manifest.artifact.relative_path,
        super::updater::MAX_ARTIFACT_BYTES,
    )?;
    let package = updater.verify(bytes, &manifest.candidate, &directory.path)?;
    let service_executable = PathBuf::from(&manifest.old_service_executable);
    let platform = NativePlatform::recover(trust, updater, package, manifest, service_executable)?;
    super::recovery::recover_transaction(&store, &platform)
        .await
        .map(|_| ())
}

/// A hung or truncated pre-authorization sender must not pin a helper forever.
/// The clock budget is refreshed between protocol frames by the caller.
pub struct PipeInput {
    input: std::fs::File,
    deadline: std::time::Instant,
}
impl PipeInput {
    pub fn new() -> Result<Self, OtaError> {
        use std::os::fd::FromRawFd;
        let fd = unsafe { libc::fcntl(libc::STDIN_FILENO, libc::F_DUPFD_CLOEXEC, 3) };
        if fd < 0 {
            return Err(OtaError::Io);
        }
        let mut result = Self {
            input: unsafe { std::fs::File::from_raw_fd(fd) },
            deadline: std::time::Instant::now(),
        };
        result.start_frame();
        Ok(result)
    }
    fn start_frame(&mut self) {
        self.deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    }
}
impl Read for PipeInput {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        use std::os::fd::AsRawFd;
        if buffer.is_empty() {
            return Ok(0);
        }
        loop {
            let remaining = self
                .deadline
                .saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            let mut fd = libc::pollfd {
                fd: self.input.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let status = unsafe {
                libc::poll(
                    &mut fd,
                    1,
                    remaining.as_millis().min(i32::MAX as u128) as i32,
                )
            };
            if status < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error);
            }
            if status == 0 {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            let count = unsafe {
                libc::read(
                    self.input.as_raw_fd(),
                    buffer.as_mut_ptr().cast(),
                    buffer.len(),
                )
            };
            if count >= 0 {
                return Ok(count as usize);
            }
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn responses_start_at_zero_and_advance_without_wrapping() {
        let binding = Binding {
            schema: 1,
            command_id: "command".into(),
            installation_id: "install".into(),
            transaction_id: None,
            revision: 1,
            nonce: "a".repeat(64),
        };
        let mut responses = Responses {
            output: Vec::new(),
            binding,
            sequence: 0,
        };
        assert_eq!(responses.next().unwrap().sequence, 0);
        assert_eq!(responses.next().unwrap().sequence, 1);
        responses.sequence = u64::MAX;
        assert!(responses.next().is_err());
    }
    fn encoded(value: serde_json::Value) -> Vec<u8> {
        let bytes = serde_json::to_vec(&value).unwrap();
        let mut framed = (bytes.len() as u32).to_be_bytes().to_vec();
        framed.extend(bytes);
        framed
    }
    fn bootstrap() -> serde_json::Value {
        serde_json::json!({"schema":1,"kind":"helper-bootstrap","home":"/tmp/private-home","port":7433,"service":{"pid":123,"bootId":"boot","birth":"1:2"},"executable":"/tmp/pacer"})
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn recovery_waits_for_the_existing_writer_instead_of_reporting_failure() {
        let directory = super::super::journal::tests::Temp::new();
        let writer = super::super::journal::JournalStore::open(&directory.0).unwrap();
        let (result, ()) = tokio::join!(recovery_store(&directory.0), async {
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            drop(writer);
        });
        assert!(result.is_ok());
    }
    #[test]
    fn recovery_derives_home_only_from_its_exact_external_executable() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().canonicalize().unwrap();
        let directory = home.join("desktop-updates/native/installation/transaction");
        std::fs::create_dir_all(&directory).unwrap();
        let executable = directory.join("pacer-update-helper");
        std::fs::write(&executable, b"helper").unwrap();
        assert_eq!(
            recovery_coordinates(&executable, "installation", "transaction").unwrap(),
            (home.clone(), directory)
        );
        assert!(recovery_coordinates(&executable, "another", "transaction").is_err());
        assert!(recovery_coordinates(&executable, "installation", "../transaction").is_err());
        let alias = home.join("pacer-update-helper");
        std::os::unix::fs::symlink(&executable, &alias).unwrap();
        assert!(recovery_coordinates(&alias, "installation", "transaction").is_err());
    }
    #[tokio::test]
    async fn authorized_transaction_finishes_when_service_pipe_disappears() {
        use std::os::unix::net::UnixStream;
        let (output, reader) = UnixStream::pair().unwrap();
        drop(reader);
        let binding = Binding {
            schema: 1,
            command_id: "command".into(),
            installation_id: "install".into(),
            transaction_id: Some("transaction".into()),
            revision: 1,
            nonce: "a".repeat(64),
        };
        let mut responses = Responses {
            output,
            binding,
            sequence: 1,
        };
        let receipt = super::super::PreparedReceipt {
            reservation_id: "transaction".into(),
            journal_sha256: "b".repeat(64),
        };
        let temp = tempfile::tempdir().unwrap();
        let proof = temp.path().join("finished");
        let result = finish_authorized(&mut responses, &receipt, async {
            std::fs::write(&proof, b"restored").unwrap();
            Ok(super::super::RecoveryOutcome::Restored)
        })
        .await;
        assert_eq!(result, Ok(super::super::RecoveryOutcome::Restored));
        assert_eq!(std::fs::read(&proof).unwrap(), b"restored");
    }
    #[test]
    fn bootstrap_is_bounded_strict_and_consumes_exactly_one_frame() {
        let mut input = encoded(bootstrap());
        input.extend(b"next");
        let mut input = input.as_slice();
        assert_eq!(Bootstrap::read(&mut input).unwrap().port, 7433);
        assert_eq!(input, b"next");
        for (key, value) in [
            ("kind", serde_json::json!("run")),
            ("home", serde_json::json!("relative")),
            ("appPath", serde_json::json!("/Applications/pacer.app")),
            ("port", serde_json::json!(0)),
        ] {
            let mut changed = bootstrap();
            changed[key] = value;
            assert!(
                Bootstrap::read(&mut encoded(changed).as_slice()).is_err(),
                "{key}"
            );
        }
        assert!(Bootstrap::read(&mut u32::MAX.to_be_bytes().as_slice()).is_err());
    }
}

/// Fixed fixture entry point that installs the lease's external service.
#[cfg(all(target_os = "macos", feature = "ota-fixture"))]
pub async fn fixture_attach(takeover: bool) -> Result<serde_json::Value, OtaError> {
    let trust = ReleaseTrust::configured().ok_or(OtaError::Unavailable)?;
    let own = super::native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Helper)?;
    trust.verify_static(&own.executable, CodeRole::Helper)?;
    serde_json::to_value(super::platform::fixture_attach(&trust, takeover).await?)
        .map_err(|_| OtaError::Invalid)
}

#[cfg(all(target_os = "macos", feature = "ota-fixture"))]
pub async fn fixture_refresh_takeover() -> Result<serde_json::Value, OtaError> {
    let trust = ReleaseTrust::configured().ok_or(OtaError::Unavailable)?;
    let own = super::native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?.ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Helper)?;
    serde_json::to_value(super::platform::fixture_refresh_takeover(&trust).await?)
        .map_err(|_| OtaError::Invalid)
}

/// Fixed fixture manager entry point. Its compiled lease supplies every path and label.
#[cfg(all(target_os = "macos", feature = "ota-fixture"))]
pub async fn fixture_jobs(retire: bool) -> Result<serde_json::Value, OtaError> {
    let trust = ReleaseTrust::configured().ok_or(OtaError::Unavailable)?;
    let own = super::native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Helper)?;
    trust.verify_static(&own.executable, CodeRole::Helper)?;
    serde_json::to_value(super::platform::fixture_jobs(&trust, retire).await?)
        .map_err(|_| OtaError::Invalid)
}
