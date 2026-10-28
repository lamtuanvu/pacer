//! macOS effects for the separately authorized service takeover transaction.
use super::{detect::detect_takeover, engine::TakeoverPlatform, journal::TakeoverManifest};
use crate::ota::{
    bootstrap_identity::inspect_legacy_executable,
    control,
    native::{self, AwakeStamp},
    platform::{self, JobChange, JobDefinition, OwnedJob},
    platform_fs,
    trust::{CodeRole, ReleaseTrust},
    OtaError,
};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

pub struct NativeTakeoverPlatform {
    trust: ReleaseTrust,
    user_home: PathBuf,
    config_dir: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RestorePlan {
    KeepOriginal,
    ReplaceManaged,
    StopAndReplaceManaged,
}

fn restore_plan(
    current: &[u8],
    original: &[u8],
    managed: &[u8],
    managed_loaded: bool,
    original_loaded_pinned: bool,
) -> Result<RestorePlan, OtaError> {
    if current == original {
        if managed_loaded {
            return Err(OtaError::Identity);
        }
        return Ok(RestorePlan::KeepOriginal);
    }
    if current == managed && !original_loaded_pinned {
        return Ok(if managed_loaded {
            RestorePlan::StopAndReplaceManaged
        } else {
            RestorePlan::ReplaceManaged
        });
    }
    Err(OtaError::Identity)
}

impl NativeTakeoverPlatform {
    fn disabled(&self, label: &str) -> Result<bool, OtaError> {
        let label = label.to_owned();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| OtaError::Unavailable)?;
            runtime.block_on(platform::disabled_state(&label))
        })
        .join()
        .map_err(|_| OtaError::Unavailable)?
    }
    pub fn new(
        trust: ReleaseTrust,
        user_home: PathBuf,
        config_dir: PathBuf,
    ) -> Result<Self, OtaError> {
        if user_home.canonicalize().map_err(|_| OtaError::Identity)? != user_home
            || !config_dir.is_absolute()
        {
            return Err(OtaError::Identity);
        }
        Ok(Self {
            trust,
            user_home,
            config_dir,
        })
    }
    fn source_path(&self, m: &TakeoverManifest) -> Result<PathBuf, OtaError> {
        if let Some(policy) = self.trust.fixture_policy() {
            policy.validate_live().map_err(|_| OtaError::Identity)?;
            if m.candidate.home != policy.home
                || m.candidate.label != policy.service_label
                || self.user_home != policy.home
            {
                return Err(OtaError::Identity);
            }
            Ok(policy
                .root
                .join("registrations")
                .join(format!("{}.plist", policy.service_label)))
        } else {
            if m.candidate.label != "com.pacer.serve" {
                return Err(OtaError::Identity);
            }
            Ok(self
                .user_home
                .join("Library/LaunchAgents/com.pacer.serve.plist"))
        }
    }
    fn original(&self, m: &TakeoverManifest) -> Result<Vec<u8>, OtaError> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&m.original_registration_b64)
            .map_err(|_| OtaError::Invalid)?;
        if format!("{:x}", Sha256::digest(&bytes)) != m.candidate.registration_sha256 {
            return Err(OtaError::Identity);
        }
        Ok(bytes)
    }
    fn managed_definition(&self, m: &TakeoverManifest) -> Result<JobDefinition, OtaError> {
        let environment: BTreeMap<_, _> = [
            ("HOME".into(), self.user_home.to_string_lossy().into_owned()),
            (
                "PACER_HOME".into(),
                m.candidate.home.to_string_lossy().into_owned(),
            ),
            ("PACER_PORT".into(), m.candidate.port.to_string()),
            ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ]
        .into_iter()
        .collect();
        Ok(JobDefinition {
            label: m.candidate.label.clone(),
            arguments: vec![m.bundled_cli.to_string_lossy().into_owned(), "serve".into()],
            environment,
            keep_alive: true,
            run_at_load: true,
        })
    }
    fn original_job(&self, m: &TakeoverManifest) -> Result<OwnedJob, OtaError> {
        let definition = JobDefinition::from_plist(&self.original(m)?)?;
        if definition.label != m.candidate.label
            || definition.arguments
                != [
                    m.candidate.program.to_string_lossy().into_owned(),
                    "serve".into(),
                ]
        {
            return Err(OtaError::Identity);
        }
        Ok(OwnedJob {
            definition,
            plist_path: self.source_path(m)?,
            role: CodeRole::Cli,
        })
    }
    fn managed_job(&self, m: &TakeoverManifest) -> Result<OwnedJob, OtaError> {
        Ok(OwnedJob {
            definition: self.managed_definition(m)?,
            plist_path: self.source_path(m)?,
            role: CodeRole::Cli,
        })
    }
    fn recovery_label(&self, m: &TakeoverManifest) -> String {
        if let Some(policy) = self.trust.fixture_policy() {
            // The lease reserves exactly one recovery label.
            policy.recovery_label.clone()
        } else {
            format!("com.pacer.takeover-recovery.{}", m.transaction_id)
        }
    }
    fn recovery_path(&self, m: &TakeoverManifest) -> PathBuf {
        let label = self.recovery_label(m);
        if let Some(policy) = self.trust.fixture_policy() {
            policy
                .root
                .join("registrations")
                .join(format!("{label}.plist"))
        } else {
            self.user_home
                .join("Library/LaunchAgents")
                .join(format!("{label}.plist"))
        }
    }
    fn transaction_dir(&self, m: &TakeoverManifest) -> PathBuf {
        m.candidate
            .home
            .join("desktop-updates/native/takeover")
            .join(&m.transaction_id)
    }
    fn recovery_job(&self, m: &TakeoverManifest) -> OwnedJob {
        let helper = self.transaction_dir(m).join("pacer-update-helper");
        OwnedJob {
            definition: JobDefinition {
                label: self.recovery_label(m),
                arguments: vec![
                    helper.to_string_lossy().into_owned(),
                    "--ota-recover-takeover".into(),
                    m.transaction_id.clone(),
                ],
                environment: [
                    ("HOME".into(), self.user_home.to_string_lossy().into_owned()),
                    (
                        "PACER_HOME".into(),
                        m.candidate.home.to_string_lossy().into_owned(),
                    ),
                ]
                .into_iter()
                .collect(),
                keep_alive: true,
                run_at_load: true,
            },
            plist_path: self.recovery_path(m),
            role: CodeRole::Helper,
        }
    }
    fn run_job(
        &self,
        job: OwnedJob,
        change: JobChange,
        pinned: Option<(
            crate::ota::ProcessIdentity,
            crate::ota::bootstrap_identity::LegacyExecutable,
        )>,
    ) -> Result<(), OtaError> {
        let trust = self.trust.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| OtaError::Unavailable)?;
            runtime.block_on(async {
                match pinned {
                    Some((process, file)) if change == JobChange::Bootout => {
                        job.stop_pinned(&trust, &process, file).await
                    }
                    Some((_, file)) if change == JobChange::Bootstrap => {
                        job.launch_pinned(&trust, file).await
                    }
                    Some(_) => Err(OtaError::Invalid),
                    None => job.change(&trust, change).await,
                }
            })
        })
        .join()
        .map_err(|_| OtaError::Unavailable)?
    }
    fn stop_signed(
        &self,
        job: OwnedJob,
        process: crate::ota::ProcessIdentity,
    ) -> Result<(), OtaError> {
        let trust = self.trust.clone();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|_| OtaError::Unavailable)?;
            runtime.block_on(job.stop_exact(&trust, &process))
        })
        .join()
        .map_err(|_| OtaError::Unavailable)?
    }
    fn original_loaded_pinned(&self, m: &TakeoverManifest) -> Result<bool, OtaError> {
        let job = self.original_job(m)?;
        let Some(loaded) = job.observe_pinned(&self.trust, &m.candidate.identity)? else {
            return Ok(false);
        };
        let pid = loaded.pid.ok_or(OtaError::Identity)?;
        let details = native::process_details(pid)
            .map_err(|_| OtaError::Identity)?
            .ok_or(OtaError::Identity)?;
        if details.executable != m.candidate.canonical_program
            || inspect_legacy_executable(&details.executable, &details.identity)?
                != m.candidate.identity
        {
            return Err(OtaError::Identity);
        }
        Ok(true)
    }
    fn service_http(&self, m: &TakeoverManifest, snapshot: bool) -> Result<(), OtaError> {
        probe_service(m.candidate.home.clone(), m.candidate.port, snapshot)
    }
}

/// A just-launched service may not accept connections yet. Only that is
/// retried until the verification deadline; any other failure is final.
fn not_ready<T>(result: Result<T, OtaError>) -> Result<Option<T>, OtaError> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(OtaError::Unavailable) => Ok(None),
        Err(error) => Err(error),
    }
}

/// `/v3/hello` requires a session, so both the managed and the restored
/// service are probed through the home's token exchange. Only the managed
/// service must also serve a snapshot.
fn probe_service(home: PathBuf, port: u16, snapshot: bool) -> Result<(), OtaError> {
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|_| OtaError::Unavailable)?;
        runtime.block_on(async {
            let client = reqwest::Client::builder()
                .cookie_store(true)
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(std::time::Duration::from_secs(5))
                .build()
                .map_err(|_| OtaError::Unavailable)?;
            let origin = format!("http://127.0.0.1:{port}");
            let token =
                std::fs::read_to_string(home.join("token")).map_err(|_| OtaError::Identity)?;
            if token.trim().is_empty() {
                return Err(OtaError::Identity);
            }
            let response = client
                .post(format!("{origin}/v3/session/exchange"))
                .bearer_auth(token.trim())
                .header("X-Pacer-Client", "desktop/takeover")
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|_| OtaError::Unavailable)?;
            if response.status() != reqwest::StatusCode::NO_CONTENT {
                return Err(OtaError::Identity);
            }
            let hello = client
                .get(format!("{origin}/v3/hello"))
                .timeout(std::time::Duration::from_secs(15))
                .send()
                .await
                .map_err(|_| OtaError::Unavailable)?;
            if !hello.status().is_success() {
                return Err(OtaError::Identity);
            }
            let hello: serde_json::Value = hello.json().await.map_err(|_| OtaError::Identity)?;
            if !hello.is_object() {
                return Err(OtaError::Identity);
            }
            if snapshot {
                let state = client
                    .get(format!("{origin}/v3/snapshot"))
                    .timeout(std::time::Duration::from_secs(10))
                    .send()
                    .await
                    .map_err(|_| OtaError::Unavailable)?;
                if !state.status().is_success() {
                    return Err(OtaError::Identity);
                }
                let state: serde_json::Value =
                    state.json().await.map_err(|_| OtaError::Identity)?;
                if !state.is_object() {
                    return Err(OtaError::Identity);
                }
            }
            Ok(())
        })
    })
    .join()
    .map_err(|_| OtaError::Unavailable)?
}

impl TakeoverPlatform for NativeTakeoverPlatform {
    fn awake_now(&self) -> Result<AwakeStamp, OtaError> {
        native::awake_now().map_err(|_| OtaError::Io)
    }
    fn redetect(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        let candidate = detect_takeover(
            &self.config_dir,
            &self.user_home,
            &m.candidate.home,
            m.candidate.port,
            &m.bundled_cli,
            &self.trust,
        )?;
        if candidate.as_ref() != Some(&m.candidate) {
            return Err(OtaError::Identity);
        }
        let observed = control::observe_service_registration(
            &self.user_home,
            &m.candidate.home,
            m.candidate.port,
            &self.trust,
        )?;
        if observed.registration != self.original(m)? {
            return Err(OtaError::Identity);
        }
        if self.disabled(&m.candidate.label)? {
            return Err(OtaError::Identity);
        }
        Ok(())
    }
    fn arm_recovery(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        let app = m
            .bundled_cli
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or(OtaError::Invalid)?;
        let source = app.join("Contents/Resources/pacer-update-helper");
        self.trust.verify_static(&source, CodeRole::Helper)?;
        let job = self.recovery_job(m);
        if self.disabled(&job.definition.label)? {
            return Err(OtaError::Identity);
        }
        let helper = Path::new(&job.definition.arguments[0]);
        let metadata = std::fs::metadata(&source).map_err(|_| OtaError::Io)?;
        if metadata.len() > 64 * 1024 * 1024 {
            return Err(OtaError::Invalid);
        }
        if helper.exists() {
            if platform_fs::read_owned_file(helper, 64 * 1024 * 1024)?
                != std::fs::read(&source).map_err(|_| OtaError::Io)?
            {
                return Err(OtaError::Identity);
            }
        } else {
            let bytes = std::fs::read(&source).map_err(|_| OtaError::Io)?;
            if bytes.len() as u64 != metadata.len() {
                return Err(OtaError::Identity);
            }
            platform_fs::PrivateDir::open(&self.transaction_dir(m))?
                .write_new("pacer-update-helper", &bytes)?;
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(helper, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| OtaError::Io)?;
        }
        self.trust.verify_static(helper, CodeRole::Helper)?;
        let bytes = job.definition.to_plist()?;
        if job.plist_path.exists() {
            if platform_fs::read_owned_file(&job.plist_path, 131072)? != bytes {
                return Err(OtaError::Identity);
            }
        } else {
            platform_fs::publish_registration(&job.plist_path, &bytes)?;
        }
        self.run_job(job, JobChange::Bootstrap, None)
    }
    fn stop_original(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        let job = self.original_job(m)?;
        if job
            .observe_pinned(&self.trust, &m.candidate.identity)?
            .is_none()
        {
            if native::process_details(m.candidate.process.pid)
                .map_err(|_| OtaError::Identity)?
                .is_none_or(|p| p.identity != m.candidate.process)
            {
                return Ok(());
            }
            return Err(OtaError::Identity);
        }
        self.run_job(
            job,
            JobChange::Bootout,
            Some((m.candidate.process.clone(), m.candidate.identity.clone())),
        )?;
        if platform::copy_user_job(&m.candidate.label)?.is_some()
            || native::process_details(m.candidate.process.pid)
                .map_err(|_| OtaError::Identity)?
                .is_some_and(|p| p.identity == m.candidate.process)
        {
            return Err(OtaError::Identity);
        }
        Ok(())
    }
    fn switch_registration(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        self.trust.verify_static(&m.bundled_cli, CodeRole::Cli)?;
        if platform::copy_user_job(&m.candidate.label)?.is_some() {
            return Err(OtaError::Identity);
        }
        platform_fs::replace_registration(
            &self.source_path(m)?,
            &self.original(m)?,
            &self.managed_definition(m)?.to_plist()?,
        )?;
        #[cfg(feature = "ota-fixture")]
        if crate::ota::fixture_fault::consume_takeover(
            crate::ota::fixture_fault::Point::TakeoverSwitch,
            &m.transaction_id,
        )? {
            std::process::exit(86);
        }
        Ok(())
    }
    fn launch_managed(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        self.trust.verify_static(&m.bundled_cli, CodeRole::Cli)?;
        self.run_job(self.managed_job(m)?, JobChange::Bootstrap, None)
    }
    fn verify_managed(&self, m: &TakeoverManifest, deadline: AwakeStamp) -> Result<(), OtaError> {
        #[cfg(feature = "ota-fixture")]
        if crate::ota::fixture_fault::consume_takeover(
            crate::ota::fixture_fault::Point::TakeoverStartup,
            &m.transaction_id,
        )? {
            return Err(OtaError::Unavailable);
        }
        loop {
            let now = self.awake_now()?;
            if now.boot_id != deadline.boot_id || now.millis > deadline.millis {
                return Err(OtaError::Timeout);
            }
            if let Ok(service) = control::inspect_registered_service(
                &self.user_home,
                &m.candidate.home,
                m.candidate.port,
                &self.trust,
            ) {
                if service.process != m.candidate.process && service.executable == m.bundled_cli {
                    let endpoint = control::ServiceEndpoint {
                        home: &m.candidate.home,
                        port: m.candidate.port,
                        process: &service.process,
                        executable: &service.executable,
                    };
                    // The helper is the peer, so it authenticates in the helper role.
                    let Some(connection) =
                        not_ready(control::authenticate_helper(&endpoint, &self.trust))?
                    else {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        continue;
                    };
                    if not_ready(self.service_http(m, true))?.is_none() {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        continue;
                    }
                    let after = control::inspect_registered_service(
                        &self.user_home,
                        &m.candidate.home,
                        m.candidate.port,
                        &self.trust,
                    )?;
                    if !control::channel_open(&connection)
                        || after.process != service.process
                        || after.executable != service.executable
                    {
                        return Err(OtaError::Identity);
                    }
                    let now = self.awake_now()?;
                    if now.boot_id != deadline.boot_id || now.millis > deadline.millis {
                        return Err(OtaError::Timeout);
                    }
                    drop(connection);
                    return Ok(());
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    fn restore_registration(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        let path = self.source_path(m)?;
        let original = self.original(m)?;
        let managed = self.managed_definition(m)?.to_plist()?;
        let current = platform_fs::read_owned_file(&path, 131072)?;
        let plan = if current == managed {
            let loaded = self.managed_job(m)?.observe(&self.trust)?.is_some();
            restore_plan(&current, &original, &managed, loaded, false)?
        } else if current == original {
            let original_loaded = self.original_loaded_pinned(m)?;
            restore_plan(&current, &original, &managed, false, original_loaded)?
        } else {
            return Err(OtaError::Identity);
        };
        if plan == RestorePlan::StopAndReplaceManaged {
            let job = self.managed_job(m)?;
            if let Some(loaded) = job.observe(&self.trust)? {
                let pid = loaded.pid.ok_or(OtaError::Identity)?;
                let process = native::process_details(pid)
                    .map_err(|_| OtaError::Identity)?
                    .ok_or(OtaError::Identity)?
                    .identity;
                self.stop_signed(job, process)?;
            }
        }
        if plan == RestorePlan::KeepOriginal {
            Ok(())
        } else {
            platform_fs::replace_registration(&path, &managed, &original)
        }
    }
    fn launch_original(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        if self.original_loaded_pinned(m)? {
            return Ok(());
        }
        self.run_job(
            self.original_job(m)?,
            JobChange::Bootstrap,
            Some((m.candidate.process.clone(), m.candidate.identity.clone())),
        )
    }
    fn verify_original(&self, m: &TakeoverManifest, deadline: AwakeStamp) -> Result<(), OtaError> {
        loop {
            let now = self.awake_now()?;
            if now.boot_id != deadline.boot_id || now.millis > deadline.millis {
                return Err(OtaError::Timeout);
            }
            if let Ok(observed) = control::observe_service_registration(
                &self.user_home,
                &m.candidate.home,
                m.candidate.port,
                &self.trust,
            ) {
                if observed.registration == self.original(m)?
                    && observed.executable == m.candidate.canonical_program
                    && inspect_legacy_executable(&m.candidate.canonical_program, &observed.process)?
                        == m.candidate.identity
                {
                    if not_ready(self.service_http(m, false))?.is_none() {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                        continue;
                    }
                    let after = control::observe_service_registration(
                        &self.user_home,
                        &m.candidate.home,
                        m.candidate.port,
                        &self.trust,
                    )?;
                    if after.process != observed.process
                        || after.registration != observed.registration
                    {
                        return Err(OtaError::Identity);
                    }
                    let now = self.awake_now()?;
                    if now.boot_id != deadline.boot_id || now.millis > deadline.millis {
                        return Err(OtaError::Timeout);
                    }
                    return Ok(());
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
    }
    fn retire_recovery(&self, m: &TakeoverManifest) -> Result<(), OtaError> {
        let mut job = self.recovery_job(m);
        if self.trust.fixture_policy().is_none() {
            // A fixture lease retires its one cataloged recovery registration
            // in place, as for update recovery.
            let bytes = job.definition.to_plist()?;
            if job.plist_path.exists() {
                platform_fs::remove_registration(&job.plist_path, &bytes)?;
            }
            job.plist_path = self.transaction_dir(m).join("recovery.plist");
            if !job.plist_path.exists() {
                platform_fs::PrivateDir::open(&self.transaction_dir(m))?
                    .write_new("recovery.plist", &bytes)?;
            }
        }
        self.run_job(job, JobChange::Bootout, None)
    }
}

#[cfg(test)]
mod restore_tests {
    use super::*;

    #[test]
    fn restore_plan_covers_registration_and_loaded_job_combinations() {
        let original = b"original";
        let managed = b"managed";
        for (current, managed_loaded, original_loaded_pinned, expected) in [
            (&original[..], false, false, Ok(RestorePlan::KeepOriginal)),
            (&original[..], false, true, Ok(RestorePlan::KeepOriginal)),
            (&original[..], true, false, Err(OtaError::Identity)),
            (&original[..], true, true, Err(OtaError::Identity)),
            (&managed[..], false, false, Ok(RestorePlan::ReplaceManaged)),
            (
                &managed[..],
                true,
                false,
                Ok(RestorePlan::StopAndReplaceManaged),
            ),
            (&managed[..], false, true, Err(OtaError::Identity)),
            (&managed[..], true, true, Err(OtaError::Identity)),
            (&b"drift"[..], false, false, Err(OtaError::Identity)),
            (&b"drift"[..], false, true, Err(OtaError::Identity)),
            (&b"drift"[..], true, false, Err(OtaError::Identity)),
            (&b"drift"[..], true, true, Err(OtaError::Identity)),
        ] {
            assert_eq!(
                restore_plan(current, original, managed, managed_loaded, original_loaded_pinned),
                expected,
                "current={current:?} managed_loaded={managed_loaded} original_loaded_pinned={original_loaded_pinned}"
            );
        }
    }

    /// Serves one fake pacer: `/v3/hello` and `/v3/snapshot` require the
    /// session cookie issued by a bearer token exchange.
    fn fake_service(snapshot_ok: bool) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{BufRead, BufReader, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut seen = Vec::new();
            listener.set_nonblocking(false).unwrap();
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut writer = stream;
            loop {
                let mut head = Vec::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 {
                        return seen;
                    }
                    if line == "\r\n" {
                        break;
                    }
                    head.push(line.to_ascii_lowercase());
                }
                let request = head[0].clone();
                let has = |needle: &str| head.iter().any(|line| line.starts_with(needle));
                seen.push(request.trim().to_owned());
                let (status, extra, body) = if request.starts_with("post /v3/session/exchange ") {
                    if has("authorization: bearer fixture-token") {
                        (
                            "204 No Content",
                            "set-cookie: pacer_session=s1; Path=/\r\n",
                            "",
                        )
                    } else {
                        ("401 Unauthorized", "", "unauthorized")
                    }
                } else if !has("cookie: pacer_session=s1") {
                    ("401 Unauthorized", "", "unauthorized")
                } else if request.starts_with("get /v3/hello ") {
                    (
                        "200 OK",
                        "content-type: application/json\r\n",
                        "{\"version\":\"0.2.4\"}",
                    )
                } else if request.starts_with("get /v3/snapshot ") && snapshot_ok {
                    ("200 OK", "content-type: application/json\r\n", "{}")
                } else {
                    ("500 Internal Server Error", "", "")
                };
                write!(
                    writer,
                    "HTTP/1.1 {status}\r\n{extra}content-length: {}\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
        });
        (port, handle)
    }

    #[test]
    fn only_unavailable_services_are_polled_again() {
        assert_eq!(not_ready(Ok(1)), Ok(Some(1)));
        assert_eq!(not_ready::<()>(Err(OtaError::Unavailable)), Ok(None));
        for error in [
            OtaError::Identity,
            OtaError::Invalid,
            OtaError::Io,
            OtaError::Timeout,
        ] {
            assert_eq!(not_ready::<()>(Err(error.clone())), Err(error));
        }
    }

    #[test]
    fn restored_service_probe_authenticates_before_hello() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("token"), "fixture-token\n").unwrap();
        let (port, server) = fake_service(false);
        assert_eq!(
            probe_service(home.path().to_path_buf(), port, false),
            Ok(())
        );
        assert_eq!(
            server.join().unwrap(),
            [
                "post /v3/session/exchange http/1.1",
                "get /v3/hello http/1.1"
            ]
        );
    }

    #[test]
    fn managed_service_probe_also_requires_a_snapshot() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join("token"), "fixture-token\n").unwrap();
        let (port, server) = fake_service(false);
        assert_eq!(
            probe_service(home.path().to_path_buf(), port, true),
            Err(OtaError::Identity)
        );
        server.join().unwrap();
        let (port, server) = fake_service(true);
        assert_eq!(probe_service(home.path().to_path_buf(), port, true), Ok(()));
        server.join().unwrap();
    }
}
