//! Native platform effects. Loaded job descriptions are checked conservatively;
//! unsupported macOS dictionary shapes refuse instead of guessing ownership.
#[cfg(target_os = "macos")]
#[path = "platform_adoption.rs"]
mod adoption_native;
#[cfg(any(test, feature = "ota-fixture"))]
#[path = "platform_fixture.rs"]
mod fixture;
use super::OtaError;
use super::{
    native,
    trust::{CodeRole, ReleaseTrust},
    ProcessIdentity,
};
#[cfg(target_os = "macos")]
pub(crate) use adoption_native::NativeAdoptionPlatform;
#[cfg(feature = "ota-fixture")]
pub(crate) use fixture::{fixture_attach, fixture_jobs};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct JobDefinition {
    pub label: String,
    pub arguments: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub keep_alive: bool,
    pub run_at_load: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LoadedJob {
    pub pid: Option<u32>,
    pub disabled: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum JobChange {
    Bootstrap,
    Disable,
    Enable,
    Bootout,
    Kickstart,
}
pub(crate) struct OwnedJob {
    pub definition: JobDefinition,
    pub plist_path: PathBuf,
    pub role: CodeRole,
}
#[cfg(target_os = "macos")]
fn inherit_launch_socket(command: &mut std::process::Command, fd: std::os::fd::RawFd) {
    use std::os::unix::process::CommandExt;
    // launchd retires the recovery job by signaling its process group. The
    // recovered Desktop must keep running after that helper is retired.
    command.process_group(0);
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}
impl OwnedJob {
    fn check(&self, trust: &ReleaseTrust) -> Result<(), OtaError> {
        if let Some(policy) = trust.fixture_policy() {
            policy.validate_live().map_err(|_| OtaError::Identity)?;
            if ![&policy.service_label, &policy.recovery_label].contains(&&self.definition.label)
                || !policy.permits_path(&self.plist_path)
            {
                return Err(OtaError::Identity);
            }
        }
        let bytes = super::platform_fs::read_owned_file(&self.plist_path, 131_072)?;
        if JobDefinition::from_plist(&bytes)? != self.definition {
            return Err(OtaError::Identity);
        }
        let executable = self.definition.arguments.first().ok_or(OtaError::Invalid)?;
        trust.verify_static(Path::new(executable), self.role)
    }
    pub(crate) fn observe(&self, trust: &ReleaseTrust) -> Result<Option<LoadedJob>, OtaError> {
        self.check(trust)?;
        copy_user_job(&self.definition.label)?
            .map(|value| self.definition.match_loaded(&value))
            .transpose()
    }
    pub(crate) async fn change(
        &self,
        trust: &ReleaseTrust,
        change: JobChange,
    ) -> Result<(), OtaError> {
        self.change_inner(trust, change, None).await
    }
    async fn stop_exact(
        &self,
        trust: &ReleaseTrust,
        expected: &ProcessIdentity,
    ) -> Result<(), OtaError> {
        self.change_inner(trust, JobChange::Bootout, Some(expected))
            .await
    }
    async fn change_inner(
        &self,
        trust: &ReleaseTrust,
        change: JobChange,
        expected: Option<&ProcessIdentity>,
    ) -> Result<(), OtaError> {
        let current = self.observe(trust)?;
        let stopped_process = if change == JobChange::Bootout {
            let process = current
                .as_ref()
                .and_then(|job| job.pid)
                .map(|pid| {
                    native::process_details(pid)
                        .map_err(|_| OtaError::Identity)?
                        .ok_or(OtaError::Identity)
                })
                .transpose()?;
            if let Some(expected) = expected {
                ensure(
                    process
                        .as_ref()
                        .is_some_and(|details| details.identity == *expected),
                )?;
            } else if matches!(self.role, CodeRole::Cli) && current.is_some() {
                return Err(OtaError::Identity);
            }
            if let Some(details) = &process {
                ensure(details.executable == Path::new(&self.definition.arguments[0]))?;
                trust.verify_process(&details.identity, self.role)?;
            }
            process.map(|details| details.identity)
        } else {
            None
        };
        match change {
            JobChange::Bootstrap if current.is_some() => return Ok(()),
            JobChange::Bootout if current.is_none() => return Ok(()),
            JobChange::Disable => match current.as_ref().and_then(|job| job.disabled) {
                Some(true) => return Ok(()),
                Some(false) => {}
                None => return Err(OtaError::Unavailable),
            },
            JobChange::Kickstart if current.as_ref().is_none_or(|job| job.pid.is_some()) => {
                return Err(OtaError::Identity)
            }
            _ => {}
        }
        let registration = super::platform_fs::read_owned_file(&self.plist_path, 131072)?;
        if change == JobChange::Bootstrap {
            self.stage_fixture_registration(trust, &registration)?;
        }
        if change == JobChange::Bootout {
            self.fixture_ledger(
                trust,
                &registration,
                "loaded",
                current.as_ref().and_then(|job| job.pid),
            )?;
        }
        self.check(trust)?;
        if let Some(process) = &stopped_process {
            ensure(self.observe(trust)?.and_then(|job| job.pid) == Some(process.pid))?;
            trust.verify_process(process, self.role)?;
        }
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let target = format!("{domain}/{}", self.definition.label);
        let mut command = tokio::process::Command::new("/bin/launchctl");
        match change {
            JobChange::Bootstrap => {
                command.arg("bootstrap").arg(&domain).arg(&self.plist_path);
            }
            JobChange::Disable => {
                command.arg("disable").arg(&target);
            }
            JobChange::Enable => {
                command.arg("enable").arg(&target);
            }
            JobChange::Bootout => {
                command.arg("bootout").arg(&target);
            }
            JobChange::Kickstart => {
                command.arg("kickstart").arg(&target);
            }
        }
        command
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), command.status())
            .await
            .map_err(|_| OtaError::Timeout)?
            .map_err(|_| OtaError::Io)?;
        if !status.success() {
            return Err(OtaError::Io);
        }
        let after = self.observe(trust)?;
        if change == JobChange::Bootstrap {
            let start = native::awake_now().map_err(|_| OtaError::Identity)?;
            loop {
                let current = self.observe(trust)?.ok_or(OtaError::Identity)?;
                match self.fixture_ledger(trust, &registration, "loaded", current.pid) {
                    Ok(()) => break,
                    Err(OtaError::Identity) | Err(OtaError::Busy) => {
                        let now = native::awake_now().map_err(|_| OtaError::Identity)?;
                        if native::elapsed_ms(&start, &now).map_err(|_| OtaError::Identity)? >= 5000
                        {
                            return Err(OtaError::Timeout);
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        if change == JobChange::Bootout {
            // Terminal cleanup has already been synced. If this is the recovery
            // job itself, launchd may terminate us before completion is journaled;
            // later observation sees the absent job and never rolls back.
            if let Some(process) = &stopped_process {
                wait_exact_exit(process).await?;
            }
            self.fixture_ledger(trust, &registration, "retired", None)?;
        }
        match change {
            JobChange::Bootstrap if after.is_none() => Err(OtaError::Identity),
            JobChange::Bootout if after.is_some() => Err(OtaError::Identity),
            JobChange::Disable if after.as_ref().and_then(|job| job.disabled) != Some(true) => {
                Err(OtaError::Unavailable)
            }
            JobChange::Enable
                if after
                    .as_ref()
                    .is_some_and(|job| job.disabled != Some(false)) =>
            {
                Err(OtaError::Unavailable)
            }
            _ => Ok(()),
        }
    }
}

/// Observe only. The request to exit must have been sent to the authenticated
/// native peer. No signal is issued to a PID, including on timeout or PID reuse.
pub(crate) async fn wait_exact_exit(expected: &ProcessIdentity) -> Result<(), OtaError> {
    let start = native::awake_now().map_err(|_| OtaError::Identity)?;
    loop {
        match native::process_details(expected.pid).map_err(|_| OtaError::Identity)? {
            None => return Ok(()),
            Some(details) if details.identity != *expected => return Err(OtaError::Identity),
            Some(_) => {}
        }
        let now = native::awake_now().map_err(|_| OtaError::Identity)?;
        if native::elapsed_ms(&start, &now).map_err(|_| OtaError::Identity)? > 10_000 {
            return Err(OtaError::Timeout);
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}
impl JobDefinition {
    pub(crate) fn to_plist(&self) -> Result<Vec<u8>, OtaError> {
        let values = [
            (
                "Label".to_string(),
                plist::Value::String(self.label.clone()),
            ),
            (
                "ProgramArguments".to_string(),
                plist::Value::Array(
                    self.arguments
                        .iter()
                        .cloned()
                        .map(plist::Value::String)
                        .collect(),
                ),
            ),
            (
                "EnvironmentVariables".to_string(),
                plist::Value::Dictionary(
                    self.environment
                        .iter()
                        .map(|(key, value)| (key.clone(), plist::Value::String(value.clone())))
                        .collect(),
                ),
            ),
            (
                "KeepAlive".to_string(),
                plist::Value::Boolean(self.keep_alive),
            ),
            (
                "RunAtLoad".to_string(),
                plist::Value::Boolean(self.run_at_load),
            ),
            (
                "ThrottleInterval".to_string(),
                plist::Value::Integer(10i64.into()),
            ),
            (
                "ProcessType".to_string(),
                plist::Value::String("Background".into()),
            ),
        ];
        let mut bytes = Vec::new();
        plist::Value::Dictionary(values.into_iter().collect())
            .to_writer_xml(&mut bytes)
            .map_err(|_| OtaError::Invalid)?;
        if Self::from_plist(&bytes)? != *self {
            return Err(OtaError::Invalid);
        }
        Ok(bytes)
    }
    pub(crate) fn from_plist(bytes: &[u8]) -> Result<Self, OtaError> {
        if bytes.len() > 131_072 {
            return Err(OtaError::Invalid);
        }
        let value = plist::Value::from_reader(std::io::Cursor::new(bytes))
            .map_err(|_| OtaError::Invalid)?;
        let dict = value.as_dictionary().ok_or(OtaError::Invalid)?;
        if dict.keys().any(|key| {
            !matches!(
                key.as_str(),
                "Label"
                    | "ProgramArguments"
                    | "EnvironmentVariables"
                    | "KeepAlive"
                    | "RunAtLoad"
                    | "ThrottleInterval"
                    | "ProcessType"
                    | "StandardOutPath"
                    | "StandardErrorPath"
            )
        }) {
            return Err(OtaError::Invalid);
        }
        let result = Self::description(dict)?;
        if result.label.is_empty()
            || result.label.len() > 255
            || !result
                .label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
            || result.arguments.is_empty()
            || result.arguments.len() > 8
            || !std::path::Path::new(&result.arguments[0]).is_absolute()
            || result
                .arguments
                .iter()
                .any(|arg| arg.is_empty() || arg.len() > 4096 || arg.contains(['\0', '\n', '\r']))
            || result.environment.iter().any(|(key, value)| {
                !matches!(key.as_str(), "HOME" | "PATH" | "PACER_HOME" | "PACER_PORT")
                    || value.len() > 4096
                    || value.contains(['\0', '\n', '\r'])
            })
        {
            return Err(OtaError::Invalid);
        }
        Ok(result)
    }
    fn description(dict: &plist::Dictionary) -> Result<Self, OtaError> {
        let label = dict
            .get("Label")
            .and_then(plist::Value::as_string)
            .ok_or(OtaError::Identity)?
            .into();
        let arguments = dict
            .get("ProgramArguments")
            .and_then(plist::Value::as_array)
            .ok_or(OtaError::Identity)?
            .iter()
            .map(|value| {
                value
                    .as_string()
                    .map(String::from)
                    .ok_or(OtaError::Identity)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let environment = dict
            .get("EnvironmentVariables")
            .and_then(plist::Value::as_dictionary)
            .ok_or(OtaError::Identity)?
            .iter()
            .map(|(key, value)| {
                value
                    .as_string()
                    .map(|v| (key.clone(), v.into()))
                    .ok_or(OtaError::Identity)
            })
            .collect::<Result<BTreeMap<_, _>, _>>()?;
        let keep_alive = dict
            .get("KeepAlive")
            .and_then(plist::Value::as_boolean)
            .ok_or(OtaError::Identity)?;
        let run_at_load = dict
            .get("RunAtLoad")
            .and_then(plist::Value::as_boolean)
            .ok_or(OtaError::Identity)?;
        Ok(Self {
            label,
            arguments,
            environment,
            keep_alive,
            run_at_load,
        })
    }
    pub(crate) fn match_loaded(&self, value: &plist::Value) -> Result<LoadedJob, OtaError> {
        let dict = value.as_dictionary().ok_or(OtaError::Identity)?;
        if dict.get("Label").and_then(plist::Value::as_string) != Some(self.label.as_str())
            || dict.get("Program").and_then(plist::Value::as_string)
                != self.arguments.first().map(String::as_str)
            || dict
                .get("ProgramArguments")
                .and_then(plist::Value::as_array)
                .map(|args| args.iter().map(plist::Value::as_string).collect::<Vec<_>>())
                != Some(
                    self.arguments
                        .iter()
                        .map(|arg| Some(arg.as_str()))
                        .collect(),
                )
        {
            return Err(OtaError::Identity);
        }
        // Lifecycle/environment are not exposed by this public snapshot. If a
        // platform supplies them, reject disagreement, but never infer absence.
        for (key, expected) in [
            ("KeepAlive", self.keep_alive),
            ("RunAtLoad", self.run_at_load),
        ] {
            if dict
                .get(key)
                .is_some_and(|value| value.as_boolean() != Some(expected))
            {
                return Err(OtaError::Identity);
            }
        }
        if let Some(value) = dict.get("EnvironmentVariables") {
            let expected: plist::Dictionary = self
                .environment
                .iter()
                .map(|(k, v)| (k.clone(), plist::Value::String(v.clone())))
                .collect();
            if value.as_dictionary() != Some(&expected) {
                return Err(OtaError::Identity);
            }
        }
        let pid = match dict.get("PID") {
            None => None,
            Some(value) => {
                let number = value.as_unsigned_integer().ok_or(OtaError::Identity)?;
                if number == 0 {
                    None
                } else {
                    Some(u32::try_from(number).map_err(|_| OtaError::Identity)?)
                }
            }
        };
        let disabled = match dict.get("Disabled") {
            None => None,
            Some(value) => Some(value.as_boolean().ok_or(OtaError::Identity)?),
        };
        Ok(LoadedJob { pid, disabled })
    }
}

fn registration_transition(
    record: &mut serde_json::Value,
    label: &str,
    path: &Path,
    hash: &str,
    next: &str,
    processes: &[ProcessIdentity],
    exited: &[ProcessIdentity],
) -> Result<(), OtaError> {
    let rows = record["registrations"]
        .as_array_mut()
        .ok_or(OtaError::Invalid)?;
    ensure(rows.iter().filter(|row| row["label"] == label).count() == 1)?;
    let row = rows
        .iter_mut()
        .find(|row| row["label"] == label)
        .ok_or(OtaError::Identity)?;
    ensure(row["path"].as_str() == path.to_str())?;
    let state = row["state"].as_str().ok_or(OtaError::Invalid)?;
    let mut previous: Vec<ProcessIdentity> =
        serde_json::from_value(row["processes"].clone()).map_err(|_| OtaError::Invalid)?;
    ensure(
        previous.len() <= 128
            && processes.len() <= 128
            && previous
                .iter()
                .chain(processes)
                .chain(exited)
                .all(|p| p.pid > 0 && !p.birth.is_empty() && !p.boot_id.is_empty()),
    )?;
    if state == "reserved" {
        ensure(row["sha256"].is_null() && previous.is_empty())?;
    } else {
        ensure(row["sha256"] == hash)?;
    }
    match next {
        "intent" => {
            ensure(matches!(state, "reserved" | "intent" | "retired") && processes.is_empty())?
        }
        "loaded" => {
            ensure(matches!(state, "intent" | "loaded"))?;
            for process in processes {
                if !previous.contains(process) {
                    previous.push(process.clone());
                }
            }
            ensure(previous.len() <= 128)?;
        }
        "retired" => ensure(
            matches!(state, "intent" | "loaded" | "retired")
                && processes.is_empty()
                && previous.iter().all(|p| exited.contains(p)),
        )?,
        _ => return Err(OtaError::Invalid),
    }
    row["state"] = next.into();
    row["sha256"] = hash.into();
    row["processes"] = serde_json::to_value(previous).map_err(|_| OtaError::Invalid)?;
    Ok(())
}
/// Fixture-only service adoption switches one label between at most two exact
/// registration generations. The caller must prove the manager job is absent;
/// every recorded incarnation must be in `exited`. The superseded generation is
/// kept in append-only history, never discarded.
fn registration_generation_switch(
    record: &mut serde_json::Value,
    label: &str,
    path: &Path,
    hash: &str,
    exited: &[ProcessIdentity],
) -> Result<(), OtaError> {
    ensure(
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
    )?;
    let rows = record["registrations"]
        .as_array_mut()
        .ok_or(OtaError::Invalid)?;
    ensure(rows.iter().filter(|row| row["label"] == label).count() == 1)?;
    let row = rows
        .iter_mut()
        .find(|row| row["label"] == label)
        .ok_or(OtaError::Identity)?;
    ensure(row["path"].as_str() == path.to_str())?;
    let state = row["state"].as_str().ok_or(OtaError::Invalid)?.to_owned();
    let current = row["sha256"].as_str().ok_or(OtaError::Identity)?.to_owned();
    ensure(matches!(state.as_str(), "intent" | "loaded" | "retired") && current != hash)?;
    let processes: Vec<ProcessIdentity> =
        serde_json::from_value(row["processes"].clone()).map_err(|_| OtaError::Invalid)?;
    ensure(processes.len() <= 128 && processes.iter().all(|p| exited.contains(p)))?;
    let mut generations: Vec<String> = match row.get("generations") {
        None => vec![current.clone()],
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| OtaError::Invalid)?,
    };
    ensure(generations.len() <= 2 && generations.contains(&current))?;
    if !generations.iter().any(|g| g == hash) {
        ensure(generations.len() < 2)?;
        generations.push(hash.to_owned());
    }
    let mut history: Vec<serde_json::Value> = match row.get("history") {
        None => Vec::new(),
        Some(value) => serde_json::from_value(value.clone()).map_err(|_| OtaError::Invalid)?,
    };
    ensure(history.len() < 16)?;
    history.push(serde_json::json!({"sha256": current, "state": state, "processes": processes}));
    row["generations"] = serde_json::to_value(generations).map_err(|_| OtaError::Invalid)?;
    row["history"] = serde_json::Value::Array(history);
    row["state"] = "retired".into();
    row["sha256"] = hash.into();
    row["processes"] = serde_json::json!([]);
    Ok(())
}
impl OwnedJob {
    pub(crate) fn stage_fixture_registration(
        &self,
        trust: &ReleaseTrust,
        bytes: &[u8],
    ) -> Result<(), OtaError> {
        ensure(JobDefinition::from_plist(bytes)? == self.definition)?;
        self.fixture_ledger(trust, bytes, "intent", None)
    }
    fn fixture_ledger(
        &self,
        trust: &ReleaseTrust,
        bytes: &[u8],
        next: &str,
        pid: Option<u32>,
    ) -> Result<(), OtaError> {
        let Some(policy) = trust.fixture_policy() else {
            return Ok(());
        };
        policy.validate_live().map_err(|_| OtaError::Identity)?;
        ensure([&policy.service_label, &policy.recovery_label].contains(&&self.definition.label))?;
        let expected = policy
            .root
            .join("registrations")
            .join(format!("{}.plist", self.definition.label));
        ensure(self.plist_path == expected)?;
        ensure(policy.permits_path(Path::new(
            self.definition.arguments.first().ok_or(OtaError::Invalid)?,
        )))?;
        let locks = super::platform_fs::PrivateDir::create(&policy.root.join("locks"))?;
        let _lock = locks.lock_named("ledger-lock")?;
        let root = super::platform_fs::PrivateDir::open(&policy.root)?;
        let before = root.read("record.json", 262144)?;
        let mut record: serde_json::Value =
            serde_json::from_slice(&before).map_err(|_| OtaError::Invalid)?;
        ensure(record["phase"] == "prepared" && record["nonce"] == policy.nonce)?;
        if self.definition.label == policy.service_label {
            let program = Path::new(&self.definition.arguments[0]);
            ensure(
                self.definition.arguments.len() == 2
                    && self.definition.arguments[1] == "serve"
                    && (program == policy.current_app.join("Contents/Resources/pacer")
                        || program == policy.external_cli()),
            )?;
            let row = record["registrations"]
                .as_array()
                .ok_or(OtaError::Invalid)?
                .iter()
                .find(|row| row["label"] == self.definition.label)
                .ok_or(OtaError::Identity)?;
            if next == "intent"
                && row["state"] != "reserved"
                && row["sha256"].as_str() != Some(digest(bytes).as_str())
            {
                // Adoption replaces the service registration in place. Only a
                // stopped job whose recorded incarnations all exited may switch.
                ensure(copy_user_job(&self.definition.label)?.is_none())?;
                let prior: Vec<ProcessIdentity> = serde_json::from_value(row["processes"].clone())
                    .map_err(|_| OtaError::Invalid)?;
                let mut gone = Vec::new();
                for process in prior {
                    ensure(original_process_gone(&process)?)?;
                    gone.push(process);
                }
                registration_generation_switch(
                    &mut record,
                    &self.definition.label,
                    &self.plist_path,
                    &digest(bytes),
                    &gone,
                )?;
            }
        }
        let mut processes = Vec::new();
        let mut exited = Vec::new();
        if next == "loaded" {
            if let Some(pid) = pid {
                let details = native::process_details(pid)
                    .map_err(|_| OtaError::Identity)?
                    .ok_or(OtaError::Identity)?;
                ensure(
                    details.uid == policy.uid
                        && details.executable == Path::new(&self.definition.arguments[0]),
                )?;
                trust.verify_process(&details.identity, self.role)?;
                processes.push(details.identity);
            }
        }
        if next == "retired" {
            ensure(copy_user_job(&self.definition.label)?.is_none())?;
            let inventory = super::control::native_process_inventory()?;
            processes = inventory
                .into_iter()
                .filter(|details| details.executable == Path::new(&self.definition.arguments[0]))
                .map(|details| details.identity)
                .collect();
            let row = record["registrations"]
                .as_array()
                .ok_or(OtaError::Invalid)?
                .iter()
                .find(|row| row["label"] == self.definition.label)
                .ok_or(OtaError::Identity)?;
            let prior: Vec<ProcessIdentity> =
                serde_json::from_value(row["processes"].clone()).map_err(|_| OtaError::Invalid)?;
            for process in prior {
                if original_process_gone(&process)? {
                    exited.push(process);
                }
            }
        }
        registration_transition(
            &mut record,
            &self.definition.label,
            &self.plist_path,
            &digest(bytes),
            next,
            &processes,
            &exited,
        )?;
        let after = serde_json::to_vec_pretty(&record).map_err(|_| OtaError::Invalid)?;
        root.replace_exact("record.json", &before, &after)
    }
}

fn parse_disabled(text: &str, label: &str) -> Result<bool, OtaError> {
    if text.len() > 262_144 {
        return Err(OtaError::Unavailable);
    }
    let mut lines = text.lines().map(str::trim).filter(|line| !line.is_empty());
    if lines.next() != Some("disabled services = {") {
        return Err(OtaError::Unavailable);
    }
    let mut entries = BTreeMap::new();
    let mut closed = false;
    for line in lines {
        if closed {
            return Err(OtaError::Unavailable);
        }
        if line == "}" {
            closed = true;
            continue;
        }
        let (name, state) = line.split_once(" => ").ok_or(OtaError::Unavailable)?;
        let name = name
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .ok_or(OtaError::Unavailable)?;
        if name.is_empty() || name.len() > 255 || name.contains(['"', '\\', '\0']) {
            return Err(OtaError::Unavailable);
        }
        let disabled = match state {
            "enabled" => false,
            "disabled" => true,
            _ => return Err(OtaError::Unavailable),
        };
        if entries.insert(name, disabled).is_some() {
            return Err(OtaError::Unavailable);
        }
    }
    if !closed {
        return Err(OtaError::Unavailable);
    }
    Ok(entries.get(label).copied().unwrap_or(false))
}

/// The dedicated print-disabled command is a bounded, strict baseline query.
/// launchctl print's diagnostic state is never parsed as authority.
async fn disabled_state(label: &str) -> Result<bool, OtaError> {
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new("/bin/launchctl")
        .args([
            "print-disabled",
            &format!("gui/{}", unsafe { libc::geteuid() }),
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| OtaError::Io)?;
    let mut stdout = child.stdout.take().ok_or(OtaError::Io)?.take(262_145);
    let output = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        let mut bytes = Vec::new();
        stdout
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| OtaError::Io)?;
        if bytes.len() > 262_144 {
            return Err(OtaError::Unavailable);
        }
        if !child.wait().await.map_err(|_| OtaError::Io)?.success() {
            return Err(OtaError::Unavailable);
        }
        parse_disabled(
            std::str::from_utf8(&bytes).map_err(|_| OtaError::Unavailable)?,
            label,
        )
    })
    .await
    .map_err(|_| OtaError::Timeout)??;
    Ok(output)
}

/// Public ServiceManagement API, deliberately conservative about its deprecated
/// dictionary schema. Null means no matching loaded job. Missing required fields
/// are never reconstructed from a plist on disk or launchctl diagnostic text.
#[cfg(target_os = "macos")]
pub(crate) fn copy_user_job(label: &str) -> Result<Option<plist::Value>, OtaError> {
    use core_foundation::{
        base::{CFType, TCFType},
        string::{CFString, CFStringRef},
    };
    #[link(name = "ServiceManagement", kind = "framework")]
    unsafe extern "C" {
        static kSMDomainUserLaunchd: CFStringRef;
        fn SMJobCopyDictionary(domain: CFStringRef, label: CFStringRef) -> *const std::ffi::c_void;
    }
    if label.is_empty()
        || label.len() > 255
        || !label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
    {
        return Err(OtaError::Invalid);
    }
    let label = CFString::new(label);
    let raw = unsafe { SMJobCopyDictionary(kSMDomainUserLaunchd, label.as_concrete_TypeRef()) };
    if raw.is_null() {
        return Ok(None);
    }
    let owned = unsafe { CFType::wrap_under_create_rule(raw) };
    let data = core_foundation::propertylist::create_data(
        owned.as_CFTypeRef(),
        core_foundation::propertylist::kCFPropertyListBinaryFormat_v1_0,
    )
    .map_err(|_| OtaError::Unavailable)?;
    if data.len() > 131_072 {
        return Err(OtaError::Unavailable);
    }
    plist::Value::from_reader(std::io::Cursor::new(data.bytes()))
        .map(Some)
        .map_err(|_| OtaError::Unavailable)
}
#[cfg(not(target_os = "macos"))]
pub(crate) fn copy_user_job(_label: &str) -> Result<Option<plist::Value>, OtaError> {
    Err(OtaError::Unavailable)
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChildExitReceipt {
    schema: u32,
    launch_id: String,
    boot_id: String,
    pid: u32,
}
fn record_child_exit(
    mut child: std::process::Child,
    directory: &super::platform_fs::PrivateDir,
    launch_id: &str,
    boot_id: &str,
) -> Result<(), OtaError> {
    let pid = child.id();
    // wait() owns this child, including its reap; a later process reusing the
    // numeric PID cannot invalidate the proof that this exact child exited.
    child.wait().map_err(|_| OtaError::Io)?;
    let proof = ChildExitReceipt {
        schema: 1,
        launch_id: launch_id.into(),
        boot_id: boot_id.into(),
        pid,
    };
    let bytes = serde_json::to_vec(&proof).map_err(|_| OtaError::Invalid)?;
    directory.write_new(&format!("launch-exited-{launch_id}"), &bytes)
}
fn child_exit_recorded(
    directory: &super::platform_fs::PrivateDir,
    launch_id: &str,
    boot_id: &str,
) -> Result<bool, OtaError> {
    let entry = format!("launch-exited-{launch_id}");
    if exact_absent(&directory.path.join(&entry))? {
        return Ok(false);
    }
    let proof: ChildExitReceipt =
        serde_json::from_slice(&directory.read(&entry, 4096)?).map_err(|_| OtaError::Invalid)?;
    ensure(
        proof.schema == 1
            && proof.launch_id == launch_id
            && proof.boot_id == boot_id
            && proof.pid > 0,
    )?;
    Ok(true)
}

async fn await_child_exit_receipt(
    directory: &super::platform_fs::PrivateDir,
    launch_id: &str,
    boot_id: &str,
    timeout_ms: u64,
) -> Result<bool, OtaError> {
    let start = native::awake_now().map_err(|_| OtaError::Identity)?;
    ensure(start.boot_id == boot_id)?;
    loop {
        if child_exit_recorded(directory, launch_id, boot_id)? {
            return Ok(true);
        }
        let now = native::awake_now().map_err(|_| OtaError::Identity)?;
        if native::elapsed_ms(&start, &now).map_err(|_| OtaError::Identity)? >= timeout_ms {
            return Ok(false);
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn maintenance_socket_survives_exec_with_redirected_stdio() {
        use std::io::Write;
        use std::os::fd::AsRawFd;
        use std::os::unix::net::UnixStream;
        use std::process::{Command, Stdio};
        let (mut writer, reader) = UnixStream::pair().unwrap();
        let mut command = Command::new("/bin/cat");
        command
            .arg("/dev/fd/3")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        inherit_launch_socket(&mut command, reader.as_raw_fd());
        let child = command.spawn().unwrap();
        let child_pid = child.id() as libc::pid_t;
        let child_group = unsafe { libc::getpgid(child_pid) };
        drop(reader);
        writer.write_all(b"private launch capability").unwrap();
        writer.shutdown(std::net::Shutdown::Write).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"private launch capability");
        assert_eq!(
            child_group, child_pid,
            "desktop must survive recovery job process-group retirement"
        );
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn failed_ticket_waits_for_exact_child_exit_receipt_without_signaling() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().canonicalize().unwrap().join("assets");
        let directory = super::super::platform_fs::PrivateDir::create(&path).unwrap();
        let launch = "e".repeat(64);
        let boot = native::awake_now().unwrap().boot_id;
        let writer = super::super::platform_fs::PrivateDir::open(&path).unwrap();
        let child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let child_launch = launch.clone();
        let child_boot = boot.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(10));
            record_child_exit(child, &writer, &child_launch, &child_boot).unwrap();
        });
        assert!(await_child_exit_receipt(&directory, &launch, &boot, 1000)
            .await
            .unwrap());
        thread.join().unwrap();
        assert!(
            !await_child_exit_receipt(&directory, &"f".repeat(64), &boot, 1)
                .await
                .unwrap()
        );
    }

    #[test]
    fn direct_child_exit_is_durable_and_exact_launch_bound() {
        let temp = tempfile::tempdir().unwrap();
        let directory = super::super::platform_fs::PrivateDir::create(
            &temp.path().canonicalize().unwrap().join("assets"),
        )
        .unwrap();
        let launch = "a".repeat(64);
        assert!(!child_exit_recorded(&directory, &launch, "boot-1").unwrap());
        let child = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        record_child_exit(child, &directory, &launch, "boot-1").unwrap();
        assert!(child_exit_recorded(&directory, &launch, "boot-1").unwrap());
        assert!(!child_exit_recorded(&directory, &"b".repeat(64), "boot-1").unwrap());
        assert!(child_exit_recorded(&directory, &launch, "boot-2").is_err());
        let reopened = super::super::platform_fs::PrivateDir::open(&directory.path).unwrap();
        assert!(child_exit_recorded(&reopened, &launch, "boot-1").unwrap());
    }

    fn definition() -> (Vec<u8>, plist::Value) {
        let value = plist::Value::Dictionary(
            [
                (
                    "Label".to_string(),
                    plist::Value::String("com.pacer.test.service".into()),
                ),
                (
                    "ProgramArguments".to_string(),
                    plist::Value::Array(vec![
                        "/tmp/private/current.app/Contents/Resources/pacer".into(),
                        "serve".into(),
                    ]),
                ),
                (
                    "EnvironmentVariables".to_string(),
                    plist::Value::Dictionary(
                        [
                            (
                                "HOME".to_string(),
                                plist::Value::String("/tmp/private/home".into()),
                            ),
                            (
                                "PACER_HOME".to_string(),
                                plist::Value::String("/tmp/private/home".into()),
                            ),
                            (
                                "PATH".to_string(),
                                plist::Value::String("/usr/bin:/bin".into()),
                            ),
                        ]
                        .into_iter()
                        .collect(),
                    ),
                ),
                ("KeepAlive".to_string(), true.into()),
                ("RunAtLoad".to_string(), true.into()),
                ("ThrottleInterval".to_string(), 10i64.into()),
                ("ProcessType".to_string(), "Background".into()),
            ]
            .into_iter()
            .collect(),
        );
        let mut bytes = Vec::new();
        value.to_writer_xml(&mut bytes).unwrap();
        (bytes, value)
    }
    #[test]
    fn loaded_job_requires_observed_program_arguments_and_never_infers_lifecycle() {
        let (bytes, mut loaded) = definition();
        let job = JobDefinition::from_plist(&bytes).unwrap();
        let dict = loaded.as_dictionary_mut().unwrap();
        dict.insert("Program".into(), job.arguments[0].clone().into());
        dict.insert("PID".into(), 123i64.into());
        for key in ["EnvironmentVariables", "KeepAlive", "RunAtLoad"] {
            dict.remove(key);
        }
        assert_eq!(
            job.match_loaded(&loaded).unwrap(),
            LoadedJob {
                pid: Some(123),
                disabled: None
            }
        );
        for key in ["Label", "ProgramArguments", "Program"] {
            let mut changed = loaded.clone();
            changed.as_dictionary_mut().unwrap().remove(key);
            assert!(job.match_loaded(&changed).is_err(), "{key}");
        }
        loaded
            .as_dictionary_mut()
            .unwrap()
            .insert("Program".into(), "/tmp/foreign".into());
        assert!(job.match_loaded(&loaded).is_err());
    }
    #[test]
    fn disabled_baseline_parser_refuses_ambiguity_and_never_guesses_unknown_shape() {
        let text="\n\tdisabled services = {\n\t\t\"com.pacer.service\" => enabled\n\t\t\"com.pacer.other\" => disabled\n\t}\n";
        assert_eq!(parse_disabled(text, "com.pacer.service").unwrap(), false);
        assert_eq!(parse_disabled(text, "com.pacer.other").unwrap(), true);
        assert_eq!(parse_disabled(text, "com.pacer.absent").unwrap(), false);
        for bad in ["", "disabled services = {} trailing", "disabled services = {\n\"com.pacer.service\" => perhaps\n}", "disabled services = {\n\"com.pacer.service\" => enabled\n\"com.pacer.service\" => disabled\n}"] { assert!(parse_disabled(bad,"com.pacer.service").is_err()); }
    }
    #[test]
    fn native_ledger_requires_intent_exact_hash_and_complete_exit_proof() {
        let mut record = serde_json::json!({"registrations":[{"label":"fixture.service","path":"/tmp/fixture.plist","state":"reserved","sha256":null,"processes":[]}]});
        let path = Path::new("/tmp/fixture.plist");
        let hash = "a".repeat(64);
        let process = ProcessIdentity {
            pid: 123,
            boot_id: "boot".into(),
            birth: "1:2".into(),
        };
        assert!(registration_transition(
            &mut record,
            "fixture.service",
            path,
            &hash,
            "loaded",
            std::slice::from_ref(&process),
            &[]
        )
        .is_err());
        registration_transition(
            &mut record,
            "fixture.service",
            path,
            &hash,
            "intent",
            &[],
            &[],
        )
        .unwrap();
        let before = record.clone();
        assert!(registration_transition(
            &mut record,
            "fixture.service",
            path,
            &"b".repeat(64),
            "loaded",
            &[],
            &[]
        )
        .is_err());
        assert_eq!(record, before);
        registration_transition(
            &mut record,
            "fixture.service",
            path,
            &hash,
            "loaded",
            std::slice::from_ref(&process),
            &[],
        )
        .unwrap();
        assert!(registration_transition(
            &mut record,
            "fixture.service",
            path,
            &hash,
            "retired",
            &[],
            &[]
        )
        .is_err());
        assert!(registration_transition(
            &mut record,
            "fixture.service",
            path,
            &hash,
            "retired",
            std::slice::from_ref(&process),
            std::slice::from_ref(&process)
        )
        .is_err());
        registration_transition(
            &mut record,
            "fixture.service",
            path,
            &hash,
            "retired",
            &[],
            std::slice::from_ref(&process),
        )
        .unwrap();
        registration_transition(
            &mut record,
            "fixture.service",
            path,
            &hash,
            "intent",
            &[],
            &[],
        )
        .unwrap();
        assert_eq!(
            record["registrations"][0]["processes"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn fixture_service_switches_only_between_two_cataloged_generations_after_exit() {
        let path = Path::new("/tmp/fixture.plist");
        let (a, b, c) = ("a".repeat(64), "b".repeat(64), "c".repeat(64));
        let process = ProcessIdentity {
            pid: 123,
            boot_id: "boot".into(),
            birth: "1:2".into(),
        };
        let mut record = serde_json::json!({"registrations":[{"label":"fixture.service","path":"/tmp/fixture.plist","state":"loaded","sha256":a,"processes":[process]}]});
        let before = record.clone();
        // A live recorded incarnation blocks the switch.
        assert!(registration_generation_switch(&mut record, "fixture.service", path, &b, &[]).is_err());
        assert_eq!(record, before);
        // A reserved row or unchanged hash is not a generation switch.
        let mut reserved = serde_json::json!({"registrations":[{"label":"fixture.service","path":"/tmp/fixture.plist","state":"reserved","sha256":null,"processes":[]}]});
        assert!(registration_generation_switch(&mut reserved, "fixture.service", path, &b, &[]).is_err());
        assert!(registration_generation_switch(&mut record, "fixture.service", path, &a, std::slice::from_ref(&process)).is_err());
        registration_generation_switch(&mut record, "fixture.service", path, &b, std::slice::from_ref(&process)).unwrap();
        let row = &record["registrations"][0];
        assert_eq!(row["state"], "retired");
        assert_eq!(row["sha256"], b.as_str());
        assert_eq!(row["processes"], serde_json::json!([]));
        assert_eq!(row["generations"], serde_json::json!([a, b]));
        assert_eq!(row["history"][0]["sha256"], a.as_str());
        assert_eq!(row["history"][0]["processes"][0]["pid"], 123);
        // The ordinary transition continues with the new generation.
        registration_transition(&mut record, "fixture.service", path, &b, "intent", &[], &[]).unwrap();
        // A third registration is never cataloged; returning to the first is.
        let snapshot = record.clone();
        assert!(registration_generation_switch(&mut record, "fixture.service", path, &c, &[]).is_err());
        assert_eq!(record, snapshot);
        registration_generation_switch(&mut record, "fixture.service", path, &a, &[]).unwrap();
        assert_eq!(record["registrations"][0]["generations"], serde_json::json!([a, b]));
        assert_eq!(record["registrations"][0]["history"].as_array().unwrap().len(), 2);
        assert_eq!(record["registrations"][0]["history"][1]["state"], "intent");
    }
    #[test]
    fn unsupported_registration_is_refused() {
        let (_, mut changed) = definition();
        changed.as_dictionary_mut().unwrap().insert(
            "MachServices".into(),
            plist::Value::Dictionary(Default::default()),
        );
        let mut bytes = Vec::new();
        changed.to_writer_xml(&mut bytes).unwrap();
        assert!(JobDefinition::from_plist(&bytes).is_err());
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct RegistrationBackup {
    schema: u32,
    plist: String,
    disabled: bool,
}
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
fn ensure(condition: bool) -> Result<(), OtaError> {
    if condition {
        Ok(())
    } else {
        Err(OtaError::Identity)
    }
}
fn exact_absent(path: &Path) -> Result<bool, OtaError> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(true),
        Err(_) => Err(OtaError::Identity),
    }
}
fn original_process_gone(process: &ProcessIdentity) -> Result<bool, OtaError> {
    // A recycled PID proves the original incarnation is gone, but grants no right
    // to signal or claim the replacement process.
    Ok(native::process_details(process.pid)
        .map_err(|_| OtaError::Identity)?
        .is_none_or(|details| details.identity != *process))
}
pub(crate) fn user_home(trust: &ReleaseTrust) -> Result<PathBuf, OtaError> {
    if let Some(policy) = trust.fixture_policy() {
        policy.validate_live().map_err(|_| OtaError::Identity)?;
        return Ok(policy.home.clone());
    }
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    let mut bytes = vec![0u8; 65536];
    if unsafe {
        libc::getpwuid_r(
            libc::geteuid(),
            entry.as_mut_ptr(),
            bytes.as_mut_ptr().cast(),
            bytes.len(),
            &mut result,
        )
    } != 0
        || result.is_null()
    {
        return Err(OtaError::Unavailable);
    }
    let entry = unsafe { entry.assume_init() };
    if entry.pw_dir.is_null() {
        return Err(OtaError::Identity);
    }
    let path = PathBuf::from(
        unsafe { std::ffi::CStr::from_ptr(entry.pw_dir) }
            .to_str()
            .map_err(|_| OtaError::Identity)?,
    );
    ensure(path.canonicalize().map_err(|_| OtaError::Identity)? == path)?;
    Ok(path)
}
#[cfg(target_os = "macos")]
impl NativePlatform {
    fn service_path(&self) -> Result<PathBuf, OtaError> {
        if let Some(policy) = self.trust.fixture_policy() {
            return Ok(policy
                .root
                .join("registrations")
                .join(format!("{}.plist", policy.service_label)));
        }
        ensure(self.context.target.service_label == "com.pacer.serve")?;
        Ok(user_home(&self.trust)?.join("Library/LaunchAgents/com.pacer.serve.plist"))
    }
    fn service_job(&self) -> Result<OwnedJob, OtaError> {
        let path = self.service_path()?;
        let bytes = super::platform_fs::read_owned_file(&path, 131072)?;
        let definition = JobDefinition::from_plist(&bytes)?;
        ensure(
            definition.label == self.context.target.service_label
                && definition.arguments
                    == vec![
                        self.service_executable.to_string_lossy().into_owned(),
                        "serve".to_string(),
                    ],
        )?;
        ensure(definition.environment.get("PACER_HOME") == Some(&self.context.target.pacer_home))?;
        ensure(
            definition.environment.get("HOME").map(String::as_str)
                == user_home(&self.trust)?.to_str(),
        )?;
        ensure(
            definition
                .environment
                .get("PACER_PORT")
                .map(String::as_str)
                .unwrap_or("4317")
                == self.context.target.port.to_string(),
        )?;
        Ok(OwnedJob {
            definition,
            plist_path: path,
            role: CodeRole::Cli,
        })
    }
    fn snapshot(
        &self,
        manifest: &super::PreparedManifest,
    ) -> Result<super::journal::Journal, OtaError> {
        let bytes = self.assets.read("prepared.json", 1_048_576)?;
        let stored: super::PreparedManifest =
            serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
        ensure(stored == *manifest)?;
        let journal: super::journal::Journal =
            serde_json::from_slice(&self.assets.read("journal.json", 1_048_576)?)
                .map_err(|_| OtaError::Invalid)?;
        journal.validate(manifest, &digest(&bytes))?;
        Ok(journal)
    }
    fn endpoint<'a>(&'a self, process: &'a ProcessIdentity) -> super::control::ServiceEndpoint<'a> {
        super::control::ServiceEndpoint {
            home: Path::new(&self.context.target.pacer_home),
            port: self.context.target.port,
            process,
            executable: &self.service_executable,
        }
    }
    fn actual_service(&self) -> Result<ProcessIdentity, OtaError> {
        if self.context.target.ownership == super::wire::Ownership::Attached {
            let details = self
                .trust
                .verify_process(&self.context.service, CodeRole::Cli)?;
            ensure(
                details
                    .details()
                    .executable
                    .canonicalize()
                    .map_err(|_| OtaError::Identity)?
                    == self.service_executable,
            )?;
            return Ok(self.context.service.clone());
        }
        let job = self.service_job()?;
        let loaded = job.observe(&self.trust)?.ok_or(OtaError::Unavailable)?;
        let pid = loaded.pid.ok_or(OtaError::Unavailable)?;
        let details = native::process_details(pid)
            .map_err(|_| OtaError::Identity)?
            .ok_or(OtaError::Identity)?;
        ensure(
            details
                .executable
                .canonicalize()
                .map_err(|_| OtaError::Identity)?
                == self.service_executable,
        )?;
        self.trust
            .verify_process(&details.identity, CodeRole::Cli)?;
        Ok(details.identity)
    }
    fn verify_bundle(&self, path: &Path, version: &str) -> Result<(), OtaError> {
        self.trust.verify_static(path, CodeRole::Desktop)?;
        self.trust
            .verify_static(&path.join("Contents/Resources/pacer"), CodeRole::Cli)?;
        self.trust.verify_static(
            &path.join("Contents/Resources/pacer-update-helper"),
            CodeRole::Helper,
        )?;
        let metadata: serde_json::Value =
            serde_json::from_slice(&super::platform_fs::read_owned_file(
                &path.join("Contents/Resources/pacer-release.json"),
                65536,
            )?)
            .map_err(|_| OtaError::Invalid)?;
        let layout = metadata.get("cliLayout")
            .map(|value| serde_json::from_value::<crate::packaging::CliLayout>(value.clone()))
            .transpose().map_err(|_| OtaError::Invalid)?;
        if matches!(layout, Some(crate::packaging::CliLayout::Paired)) {
            self.trust.verify_static(&path.join("Contents/Resources/pacer-core"), CodeRole::Cli)?;
        }
        ensure(
            metadata["schema"] == 1
                && metadata["version"] == version
                && metadata["bundleId"] == "dev.pacer.desktop"
                && metadata["admissionProtocol"] == 1
                && metadata["rollbackCompatible"] == true
                && metadata["arch"] == super::updater::arch_name(self.context.target.arch),
        )?;
        ensure(
            metadata["protocolMajors"]
                .as_array()
                .is_some_and(|values| values.contains(&serde_json::json!(3))),
        )?;
        let info = plist::Value::from_reader(std::io::Cursor::new(
            super::platform_fs::read_owned_file(&path.join("Contents/Info.plist"), 65536)?,
        ))
        .map_err(|_| OtaError::Invalid)?;
        let info = info.as_dictionary().ok_or(OtaError::Invalid)?;
        for (key, value) in [
            ("CFBundleIdentifier", "dev.pacer.desktop"),
            ("CFBundleExecutable", "pacer"),
            ("CFBundleVersion", version),
            ("CFBundleShortVersionString", version),
        ] {
            ensure(info.get(key).and_then(plist::Value::as_string) == Some(value))?;
        }
        Ok(())
    }
    fn verify_assets(
        &self,
        manifest: &super::PreparedManifest,
        backup_required: bool,
    ) -> Result<(), OtaError> {
        ensure(
            manifest.binding == self.context.binding
                && manifest.target == self.context.target
                && manifest.candidate == *self.package.candidate()
                && manifest.old_service_executable == self.service_executable.to_string_lossy(),
        )?;
        if self.trust.fixture_policy().is_some() {
            self.assets.require_same_volume(
                Path::new(&manifest.target.app_path)
                    .parent()
                    .ok_or(OtaError::Invalid)?,
            )?;
        }
        ensure(
            digest(
                &self
                    .assets
                    .read(&manifest.artifact.relative_path, 536870912)?,
            ) == manifest.artifact.sha256,
        )?;
        ensure(
            digest(&super::platform_fs::read_owned_file(
                &self
                    .assets
                    .path
                    .join(&manifest.recovery_job.helper.relative_path),
                134217728,
            )?) == manifest.recovery_job.helper.sha256,
        )?;
        self.trust.verify_static(
            &self
                .assets
                .path
                .join(&manifest.recovery_job.helper.relative_path),
            CodeRole::Helper,
        )?;
        self.verify_bundle(&self.package.app_path(), &manifest.candidate.version)?;
        if backup_required {
            let backup = self
                .assets
                .path
                .join(&manifest.old_bundle_backup.relative_path);
            ensure(super::platform_fs::bundle_hash(&backup)? == manifest.old_bundle_backup.sha256)?;
            self.verify_bundle(&backup, &manifest.target.version)?;
        }
        if let Some(asset) = &manifest.registration_backup {
            let bytes = self.assets.read(&asset.relative_path, 262144)?;
            ensure(digest(&bytes) == asset.sha256)?;
            let backup: RegistrationBackup =
                serde_json::from_slice(&bytes).map_err(|_| OtaError::Invalid)?;
            ensure(backup.schema == 1)?;
            use base64::Engine;
            let plist = base64::engine::general_purpose::STANDARD
                .decode(&backup.plist)
                .map_err(|_| OtaError::Invalid)?;
            // App replacement changes code at this exact path, never job configuration.
            ensure(super::platform_fs::read_owned_file(&self.service_path()?, 131072)? == plist)?;
        }
        Ok(())
    }
    fn recovery_job(&self, manifest: &super::PreparedManifest) -> Result<OwnedJob, OtaError> {
        let mut environment = BTreeMap::new();
        environment.insert(
            "HOME".into(),
            user_home(&self.trust)?.to_string_lossy().into_owned(),
        );
        let definition = JobDefinition {
            label: manifest.recovery_job.label.clone(),
            arguments: vec![
                self.assets
                    .path
                    .join("pacer-update-helper")
                    .to_string_lossy()
                    .into_owned(),
                "--ota-recover".into(),
                manifest.target.id.clone(),
                manifest.transaction_id().into(),
            ],
            environment,
            keep_alive: true,
            run_at_load: true,
        };
        Ok(OwnedJob {
            definition,
            plist_path: self
                .trust
                .fixture_policy()
                .map(|p| {
                    p.root
                        .join("registrations")
                        .join(format!("{}.plist", manifest.recovery_job.label))
                })
                .unwrap_or(
                    user_home(&self.trust)?
                        .join("Library/LaunchAgents")
                        .join(format!("{}.plist", manifest.recovery_job.label)),
                ),
            role: CodeRole::Helper,
        })
    }
    fn recovery_status(
        &self,
        manifest: &super::PreparedManifest,
    ) -> Result<Option<LoadedJob>, OtaError> {
        let job = self.recovery_job(manifest)?;
        if !exact_absent(&job.plist_path)? {
            return job.observe(&self.trust);
        }
        let loaded = copy_user_job(&job.definition.label)?;
        if loaded.is_none() {
            return Ok(None);
        }
        // Terminal retirement removes the persistent plist before bootout, since
        // bootout of this very helper can terminate it before a later unlink.
        ensure(Self::terminal(&self.snapshot(manifest)?))?;
        self.trust
            .verify_static(Path::new(&job.definition.arguments[0]), CodeRole::Helper)?;
        loaded
            .map(|value| job.definition.match_loaded(&value))
            .transpose()
    }
    fn require_effect(
        &self,
        manifest: &super::PreparedManifest,
        action: &super::PlatformAction,
    ) -> Result<super::journal::Journal, OtaError> {
        let journal = self.snapshot(manifest)?;
        ensure(
            journal
                .steps
                .iter()
                .any(|step| step.action == *action && step.evidence.is_none()),
        )?;
        if journal.authorization.is_none()
            && !matches!(
                action,
                super::PlatformAction::PrepareBackup | super::PlatformAction::ArmRecovery
            )
        {
            ensure(
                Self::terminal(&journal)
                    && matches!(
                        action,
                        super::PlatformAction::ReleaseReservation
                            | super::PlatformAction::RetireRecovery
                            | super::PlatformAction::PruneSupersededBackup
                    ),
            )?;
        }
        if matches!(
            action,
            super::PlatformAction::PrepareBackup | super::PlatformAction::ArmRecovery
        ) {
            let current = super::control::helper_session(
                &self.endpoint(&self.context.service),
                &manifest.binding,
                &self.trust,
            )?;
            ensure(
                current.target == manifest.target
                    && current.desktop == manifest.old_desktop
                    && current.service == manifest.old_service
                    && current.native_session_id == manifest.native_session_id,
            )?;
        } else {
            super::recovery_authority::verify(
                Path::new(&manifest.target.pacer_home),
                manifest,
                &journal,
            )?;
        }
        Ok(journal)
    }
    fn bundle_observation(
        &self,
        manifest: &super::PreparedManifest,
    ) -> Result<super::BundleObservation, OtaError> {
        use super::BundleObservation as B;
        let path = Path::new(&manifest.target.app_path);
        if exact_absent(path)? {
            return Ok(B::Missing);
        }
        let hash = match super::platform_fs::bundle_hash(path) {
            Ok(value) => value,
            Err(_) => return Ok(B::Unknown),
        };
        if hash == manifest.old_bundle_backup.sha256
            && self.verify_bundle(path, &manifest.target.version).is_ok()
        {
            return Ok(B::Old);
        }
        if hash == super::platform_fs::bundle_hash(&self.package.app_path())?
            && self
                .verify_bundle(path, &manifest.candidate.version)
                .is_ok()
        {
            return Ok(B::Candidate);
        }
        Ok(B::Unknown)
    }
    fn terminal(journal: &super::journal::Journal) -> bool {
        matches!(
            journal.state,
            super::journal::TransactionState::Committed
                | super::journal::TransactionState::Restored
        )
    }
}

/// Concrete composition owned by the native helper. Constructors do not perform
/// an installation; every engine entry rechecks live or durable authority.
#[cfg(target_os = "macos")]
pub(crate) struct NativePlatform {
    trust: ReleaseTrust,
    updater: super::updater::NativeUpdater,
    package: super::updater::VerifiedPackage,
    context: super::control::HelperContext,
    service_executable: PathBuf,
    assets: super::platform_fs::PrivateDir,
    recovered_manifest: Option<super::PreparedManifest>,
}
#[cfg(target_os = "macos")]
impl NativePlatform {
    pub(crate) fn new(
        trust: ReleaseTrust,
        updater: super::updater::NativeUpdater,
        package: super::updater::VerifiedPackage,
        context: super::control::HelperContext,
        service_executable: PathBuf,
    ) -> Result<Self, OtaError> {
        let tx = context
            .binding
            .transaction_id
            .as_deref()
            .ok_or(OtaError::Invalid)?;
        if context.target.id != context.binding.installation_id
            || context.target.owner_uid != unsafe { libc::geteuid() } as u64
            || context.protocol != 3
            || context.admission_protocol != 1
            || !context.state_compatible
            || service_executable.to_str() != Some(context.service_executable.as_str())
        {
            return Err(OtaError::Identity);
        }
        let assets = super::platform_fs::PrivateDir::installation(
            Path::new(&context.target.pacer_home),
            &context.target.id,
        )?
        .child(tx)?;
        if let Some(policy) = trust.fixture_policy() {
            policy.validate_live().map_err(|_| OtaError::Identity)?;
            if context.target.app_path != policy.current_app.to_string_lossy()
                || context.target.pacer_home != policy.home.to_string_lossy()
                || context.target.port != policy.port
                || !policy.permits_path(&assets.path)
            {
                return Err(OtaError::Identity);
            }
        }
        Ok(Self {
            trust,
            updater,
            package,
            context,
            service_executable,
            assets,
            recovered_manifest: None,
        })
    }
    pub(crate) fn recover(
        trust: ReleaseTrust,
        updater: super::updater::NativeUpdater,
        package: super::updater::VerifiedPackage,
        manifest: super::PreparedManifest,
        service_executable: PathBuf,
    ) -> Result<Self, OtaError> {
        ensure(service_executable.to_str() == Some(manifest.old_service_executable.as_str()))?;
        let context = super::control::HelperContext {
            schema: 1,
            binding: manifest.binding.clone(),
            target: manifest.target.clone(),
            native_session_id: manifest.native_session_id.clone(),
            desktop: manifest.old_desktop.clone(),
            service: manifest.old_service.clone(),
            service_version: manifest.old_service_version.clone(),
            service_executable: service_executable.to_string_lossy().into_owned(),
            protocol: manifest.old_service_protocol,
            admission_protocol: manifest.old_admission_protocol,
            state_compatible: manifest.old_state_compatible,
            transaction: None,
        };
        let mut platform = Self::new(trust, updater, package, context, service_executable)?;
        platform.recovered_manifest = Some(manifest);
        Ok(platform)
    }
    pub(crate) fn transaction_directory(&self) -> &Path {
        &self.assets.path
    }
}
#[cfg(target_os = "macos")]
impl super::UpdatePlatform for NativePlatform {
    fn awake_now(&self) -> Result<super::AwakeStamp, OtaError> {
        native::awake_now().map_err(|_| OtaError::Identity)
    }
    fn acquire_transaction_locks<'a>(
        &'a self,
        target: &'a super::wire::Installation,
    ) -> super::PlatformFuture<'a, Box<dyn super::TransactionLocks>> {
        Box::pin(async move {
            ensure(*target == self.context.target)?;
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
            let directory = super::platform_fs::PrivateDir::create(&root)?;
            Ok(Box::new(
                directory
                    .acquire_locks(Path::new(&target.app_path), Path::new(&target.pacer_home))?,
            ) as Box<dyn super::TransactionLocks>)
        })
    }
    fn verify_preconditions<'a>(
        &'a self,
        request: &'a super::InstallRequest,
    ) -> super::PlatformFuture<'a, super::VerifiedPreparation> {
        Box::pin(async move {
            use base64::Engine;
            let super::wire::AdapterCommand::Install {
                binding,
                candidate,
                target,
            } = &request.command
            else {
                return Err(OtaError::Invalid);
            };
            ensure(
                self.recovered_manifest.is_none()
                    && *binding == self.context.binding
                    && *target == self.context.target
                    && *candidate == *self.package.candidate()
                    && request.authority.binding() == binding,
            )?;
            let context = super::control::helper_session(
                &self.endpoint(&self.context.service),
                binding,
                &self.trust,
            )?;
            ensure(
                context.target == *target
                    && context.desktop == self.context.desktop
                    && context.service == self.context.service
                    && context.service_executable == self.context.service_executable
                    && context.native_session_id == self.context.native_session_id,
            )?;
            let path = Path::new(&target.app_path);
            ensure(path.canonicalize().map_err(|_| OtaError::Identity)? == path)?;
            self.verify_bundle(path, &target.version)?;
            self.verify_bundle(&self.package.app_path(), &candidate.version)?;
            let desktop = self
                .trust
                .verify_process(&context.desktop, CodeRole::Desktop)?;
            ensure(desktop.details().executable == path.join("Contents/MacOS/pacer"))?;
            ensure(
                self.actual_service()? == context.service
                    && self.awake_now()?.boot_id == context.desktop.boot_id,
            )?;
            super::space::verify(
                path,
                super::platform_fs::bundle_bytes(path)?,
                super::platform_fs::bundle_bytes(&self.package.app_path())?,
                &self.assets.path,
            )?;
            let old_hash = super::platform_fs::bundle_hash(path)?;
            let helper = path.join("Contents/Resources/pacer-update-helper");
            self.trust.verify_static(&helper, CodeRole::Helper)?;
            let helper_hash = digest(&super::platform_fs::read_owned_file(&helper, 134217728)?);
            self.assets.stage_helper(&helper, &helper_hash)?;
            if exact_absent(&self.assets.path.join("candidate.tar.gz"))? {
                self.assets
                    .write_new("candidate.tar.gz", self.package.bytes())?;
            }
            ensure(digest(&self.assets.read("candidate.tar.gz", 536870912)?) == candidate.sha256)?;
            let registration_backup = if target.ownership == super::wire::Ownership::Managed {
                let job = self.service_job()?;
                ensure(job.observe(&self.trust)?.and_then(|j| j.pid) == Some(context.service.pid))?;
                let disabled = disabled_state(&job.definition.label).await?;
                // A running but disabled baseline is possible; preserve it and
                // refuse an install that would need to change the user's policy.
                ensure(!disabled)?;
                let bytes = super::platform_fs::read_owned_file(&job.plist_path, 131072)?;
                let encoded = serde_json::to_vec(&RegistrationBackup {
                    schema: 1,
                    plist: base64::engine::general_purpose::STANDARD.encode(bytes),
                    disabled,
                })
                .map_err(|_| OtaError::Invalid)?;
                self.assets.write_new("registration.json", &encoded)?;
                Some(super::AssetIdentity {
                    relative_path: "registration.json".into(),
                    sha256: digest(&encoded),
                })
            } else {
                None
            };
            let recovery_label = self
                .trust
                .fixture_policy()
                .map(|p| p.recovery_label.clone())
                .unwrap_or_else(|| {
                    format!(
                        "com.pacer.update.{}.{}",
                        target.id,
                        binding.transaction_id.as_deref().unwrap_or("")
                    )
                });
            let manifest = super::PreparedManifest {
                schema: 1,
                binding: binding.clone(),
                target: target.clone(),
                candidate: candidate.clone(),
                native_session_id: context.native_session_id,
                requester_boot_id: context.desktop.boot_id.clone(),
                old_desktop: context.desktop,
                old_service: context.service,
                old_service_executable: context.service_executable,
                old_service_version: context.service_version,
                old_service_protocol: context.protocol,
                old_admission_protocol: context.admission_protocol,
                old_state_compatible: context.state_compatible,
                artifact: super::AssetIdentity {
                    relative_path: "candidate.tar.gz".into(),
                    sha256: candidate.sha256.clone(),
                },
                old_bundle_backup: super::AssetIdentity {
                    relative_path: "previous.app".into(),
                    sha256: old_hash,
                },
                registration_backup,
                recovery_job: super::RecoveryJob {
                    label: recovery_label,
                    helper: super::AssetIdentity {
                        relative_path: "pacer-update-helper".into(),
                        sha256: helper_hash,
                    },
                },
            };
            super::journal::validate_manifest(&manifest)?;
            let recovery = self.recovery_job(&manifest)?;
            ensure(
                copy_user_job(&recovery.definition.label)?.is_none()
                    && !disabled_state(&recovery.definition.label).await?,
            )?;
            let recovery_bytes = recovery.definition.to_plist()?;
            self.assets.write_new("recovery.plist", &recovery_bytes)?;
            self.verify_assets(&manifest, false)?;
            Ok(super::VerifiedPreparation::verified(
                manifest,
                super::VerifiedNativeAuthority::verified(binding.clone()),
            ))
        })
    }
    fn reverify<'a>(
        &'a self,
        manifest: &'a super::PreparedManifest,
        purpose: super::VerificationPurpose,
    ) -> super::PlatformFuture<'a, super::VerifiedNativeAuthority> {
        Box::pin(async move {
            super::journal::validate_manifest(manifest)?;
            let journal = self.snapshot(manifest)?;
            // No continuation means no restore/install may run; unchanged-old
            // cleanup remains possible if preparation died before backup publish.
            self.verify_assets(manifest, journal.authorization.is_some())?;
            match purpose {
                super::VerificationPurpose::Prepare | super::VerificationPurpose::Authorize => {
                    let current = super::control::helper_session(
                        &self.endpoint(&manifest.old_service),
                        &manifest.binding,
                        &self.trust,
                    )?;
                    ensure(
                        current.target == manifest.target
                            && current.desktop == manifest.old_desktop
                            && current.service == manifest.old_service
                            && current.native_session_id == manifest.native_session_id
                            && current.service_executable == manifest.old_service_executable,
                    )?;
                    ensure(self.bundle_observation(manifest)? == super::BundleObservation::Old)?;
                    if manifest.managed() {
                        ensure(!disabled_state(&manifest.target.service_label).await?)?;
                    }
                }
                super::VerificationPurpose::Recover => {
                    let journal = self.snapshot(manifest)?;
                    super::recovery_authority::verify(
                        Path::new(&manifest.target.pacer_home),
                        manifest,
                        &journal,
                    )?;
                }
            }
            Ok(super::VerifiedNativeAuthority::verified(
                manifest.binding.clone(),
            ))
        })
    }
    fn observe<'a>(
        &'a self,
        manifest: &'a super::PreparedManifest,
    ) -> super::PlatformFuture<'a, super::Observation> {
        Box::pin(async move {
            let journal = self.snapshot(manifest)?;
            let reservation_held = if manifest.managed() {
                super::recovery_authority::reservation_held(
                    Path::new(&manifest.target.pacer_home),
                    manifest.transaction_id(),
                )?
            } else {
                true
            };
            let recovery_job_armed = self.recovery_status(manifest)?.is_some();
            let mut candidate_processes = Vec::new();
            let mut unready_candidate_service = None;
            // Query every candidate intent, including effect-before-completion.
            // An unavailable service with a potentially live launch is uncertain.
            let boot = native::awake_now().map_err(|_| OtaError::Identity)?.boot_id;
            for step in &journal.steps {
                if step.intent_boot_id != boot {
                    continue;
                }
                if let super::PlatformAction::Launch {
                    release: super::Release::Candidate,
                    launch_id,
                    role,
                } = &step.action
                {
                    if *role == super::ProcessRole::Service
                        && journal.steps.iter().any(|step| {
                            step.action
                                == super::PlatformAction::StopUnreadyCandidateService {
                                    launch_id: launch_id.clone(),
                                }
                                && step.evidence == Some(super::ActionEvidence::Complete)
                        })
                    {
                        if self.bundle_observation(manifest)? == super::BundleObservation::Candidate
                        {
                            let job = self.service_job()?;
                            ensure(job.observe(&self.trust)?.is_none())?;
                            ensure(
                                unready_inventory(
                                    None,
                                    &super::control::native_process_inventory()?,
                                    Path::new(&job.definition.arguments[0]),
                                    manifest.target.owner_uid as u32,
                                )?
                                .is_empty(),
                            )?;
                        }
                        continue;
                    }
                    if *role == super::ProcessRole::Desktop
                        && child_exit_recorded(&self.assets, launch_id, &boot)?
                    {
                        continue;
                    }
                    if let Some(super::ActionEvidence::Launched { launch }) = &step.evidence {
                        if original_process_gone(&launch.process)? {
                            continue;
                        }
                        self.trust.verify_process(
                            &launch.process,
                            match launch.role {
                                super::ProcessRole::Desktop => CodeRole::Desktop,
                                super::ProcessRole::Service => CodeRole::Cli,
                            },
                        )?;
                        candidate_processes.push(launch.clone());
                    } else if !exact_absent(&self.assets.path.join(format!("launch-{launch_id}")))?
                    {
                        let result = (|| {
                            let service = self.actual_service()?;
                            super::control::observe_launch(
                                &self.endpoint(&service),
                                &manifest.binding,
                                launch_id,
                                &self.trust,
                            )?
                            .ok_or(OtaError::Identity)
                        })();
                        match result {
                            Ok(launch) => candidate_processes.push(launch),
                            Err(error) if *role == super::ProcessRole::Service => {
                                self.unready_candidate_job(manifest, launch_id)
                                    .map_err(|_| error)?;
                                ensure(unready_candidate_service.is_none())?;
                                unready_candidate_service = Some(launch_id.clone());
                            }
                            Err(error) => return Err(error),
                        }
                    }
                }
            }
            let recovery_service = if manifest.managed()
                && unready_candidate_service.is_none()
                && journal.state == super::journal::TransactionState::Restoring
            {
                match self.actual_service() {
                    Ok(service) => {
                        let current = super::control::maintenance_context(
                            &self.endpoint(&service),
                            &manifest.binding,
                            &self.trust,
                        )?;
                        ensure(
                            current.service == service
                                && current.target == manifest.target
                                && current.service_executable == manifest.old_service_executable
                                && current.native_session_id == manifest.native_session_id
                                && (current.service_version == manifest.target.version
                                    || current.service_version == manifest.candidate.version),
                        )?;
                        super::recovery_authority::verify(
                            Path::new(&manifest.target.pacer_home),
                            manifest,
                            &journal,
                        )?;
                        Some(service)
                    }
                    Err(OtaError::Unavailable) => None,
                    Err(error) => return Err(error),
                }
            } else {
                None
            };
            Ok(super::Observation {
                unready_candidate_service,
                bundle: self.bundle_observation(manifest)?,
                reservation_held,
                recovery_job_armed,
                candidate_processes,
                recovery_service,
            })
        })
    }
    fn inspect_action<'a>(
        &'a self,
        manifest: &'a super::PreparedManifest,
        action: &'a super::PlatformAction,
    ) -> super::PlatformFuture<'a, super::ActionObservation> {
        Box::pin(async move {
            use super::{
                ActionEvidence as E, ActionObservation as A, BundleObservation as B,
                PlatformAction as P,
            };
            let complete = A::Completed(E::Complete);
            match action {
                P::StopUnreadyCandidateService { launch_id } => {
                    let (job, processes) = self.unready_candidate_job(manifest, launch_id)?;
                    if job.observe(&self.trust)?.is_none() && processes.is_empty() {
                        let name = format!("unready-observed-{launch_id}");
                        if !exact_absent(&self.assets.path.join(&name))? {
                            let observed: Vec<ProcessIdentity> =
                                serde_json::from_slice(&self.assets.read(&name, 65536)?)
                                    .map_err(|_| OtaError::Invalid)?;
                            ensure(
                                observed.len() <= 256
                                    && observed.iter().all(|p| {
                                        p.pid > 0 && !p.boot_id.is_empty() && !p.birth.is_empty()
                                    }),
                            )?;
                            for process in &observed {
                                ensure(original_process_gone(process)?)?;
                            }
                        }
                        Ok(complete)
                    } else {
                        Ok(A::NotStarted)
                    }
                }
                P::PrepareBackup => {
                    let path = self
                        .assets
                        .path
                        .join(&manifest.old_bundle_backup.relative_path);
                    if exact_absent(&path)? {
                        Ok(A::NotStarted)
                    } else {
                        ensure(
                            super::platform_fs::bundle_hash(&path)?
                                == manifest.old_bundle_backup.sha256,
                        )?;
                        self.verify_bundle(&path, &manifest.target.version)?;
                        Ok(complete)
                    }
                }
                P::ArmRecovery => Ok(if self.recovery_status(manifest)?.is_some() {
                    complete
                } else {
                    A::NotStarted
                }),
                P::SuppressLifecycle => {
                    if manifest.managed()
                        && self.service_job()?.observe(&self.trust)?.is_none()
                        && original_process_gone(&manifest.old_desktop)?
                        && original_process_gone(&manifest.old_service)?
                    {
                        Ok(complete)
                    } else {
                        Ok(A::NotStarted)
                    }
                }
                P::Stop { role, process } => {
                    if *role == super::ProcessRole::Service {
                        ensure(manifest.managed())?;
                        let job = self.service_job()?;
                        let loaded = job.observe(&self.trust)?;
                        if loaded.is_none() && original_process_gone(process)? {
                            return Ok(complete);
                        }
                        ensure(loaded.and_then(|job| job.pid) == Some(process.pid))?;
                    }
                    if original_process_gone(process)? {
                        Ok(complete)
                    } else {
                        Ok(A::NotStarted)
                    }
                }
                P::InstallCandidate => Ok(match self.bundle_observation(manifest)? {
                    B::Old => A::NotStarted,
                    B::Candidate => complete,
                    _ => A::Ambiguous,
                }),
                P::SwitchRegistration | P::RestoreRegistration => {
                    self.verify_assets(manifest, true)?;
                    Ok(complete)
                }
                P::RestoreBundle => Ok(if self.bundle_observation(manifest)? == B::Old {
                    complete
                } else {
                    A::NotStarted
                }),
                P::Launch { launch_id, .. } => {
                    if exact_absent(&self.assets.path.join(format!("launch-{launch_id}")))? {
                        return Ok(A::NotStarted);
                    }
                    let service = match self.actual_service() {
                        Ok(v) => v,
                        Err(_) => return Ok(A::Ambiguous),
                    };
                    Ok(
                        match super::control::observe_launch(
                            &self.endpoint(&service),
                            &manifest.binding,
                            launch_id,
                            &self.trust,
                        )? {
                            Some(launch) => A::Completed(E::Launched { launch }),
                            None => A::Ambiguous,
                        },
                    )
                }
                P::ReleaseReservation => {
                    let journal = self.snapshot(manifest)?;
                    ensure(Self::terminal(&journal))?;
                    let held = super::recovery_authority::verify(
                        Path::new(&manifest.target.pacer_home),
                        manifest,
                        &journal,
                    )?;
                    Ok(if manifest.managed() && !held {
                        complete
                    } else {
                        A::NotStarted
                    })
                }
                P::RetireRecovery => {
                    ensure(Self::terminal(&self.snapshot(manifest)?))?;
                    let job_absent = self.recovery_status(manifest)?.is_none();
                    let registration_retired = self.trust.fixture_policy().is_some()
                        || exact_absent(&self.recovery_job(manifest)?.plist_path)?;
                    Ok(if job_absent && registration_retired {
                        complete
                    } else {
                        A::NotStarted
                    })
                }
                // Retain this transaction's previous known-good bundle. Pruning
                // older transactions is a separate bounded retention operation.
                P::PruneSupersededBackup => Ok(A::NotStarted),
            }
        })
    }
    fn perform<'a>(
        &'a self,
        manifest: &'a super::PreparedManifest,
        action: &'a super::PlatformAction,
        authority: &'a super::VerifiedNativeAuthority,
    ) -> super::PlatformFuture<'a, super::ActionEvidence> {
        Box::pin(async move {
            use super::{ActionEvidence as E, PlatformAction as P};
            ensure(authority.binding() == &manifest.binding)?;
            self.require_effect(manifest, action)?;
            match action {
                P::StopUnreadyCandidateService { launch_id } => {
                    self.stop_unready_candidate(manifest, launch_id).await?
                }
                P::PrepareBackup => {
                    self.verify_assets(manifest, false)?;
                    self.verify_bundle(
                        Path::new(&manifest.target.app_path),
                        &manifest.target.version,
                    )?;
                    self.assets.copy_bundle(
                        Path::new(&manifest.target.app_path),
                        &manifest.old_bundle_backup.relative_path,
                        &manifest.old_bundle_backup.sha256,
                    )?;
                    self.verify_assets(manifest, true)?;
                }
                P::ArmRecovery => {
                    self.verify_assets(manifest, true)?;
                    let job = self.recovery_job(manifest)?;
                    let bytes = self.assets.read("recovery.plist", 131072)?;
                    ensure(bytes == job.definition.to_plist()?)?;
                    job.stage_fixture_registration(&self.trust, &bytes)?;
                    super::platform_fs::publish_registration(&job.plist_path, &bytes)?;
                    job.change(&self.trust, JobChange::Bootstrap).await?;
                }
                P::SuppressLifecycle => {
                    let service = self.actual_service()?;
                    super::control::suppress_lifecycle(
                        &self.endpoint(&service),
                        &manifest.binding,
                        &self.trust,
                    )?;
                }
                P::Stop { role, process } => {
                    super::space::verify(
                        Path::new(&manifest.target.app_path),
                        super::platform_fs::bundle_bytes(
                            &self
                                .assets
                                .path
                                .join(&manifest.old_bundle_backup.relative_path),
                        )?,
                        super::platform_fs::bundle_bytes(&self.package.app_path())?,
                        &self.assets.path,
                    )?;

                    let service = self.actual_service()?;
                    if *role == super::ProcessRole::Desktop {
                        self.trust.verify_process(process, CodeRole::Desktop)?;
                        super::control::request_desktop_shutdown(
                            &self.endpoint(&service),
                            &manifest.binding,
                            process,
                            &self.trust,
                        )?;
                        wait_exact_exit(process).await?;
                    } else {
                        ensure(manifest.managed() && service == *process)?;
                        let current = super::control::maintenance_context(
                            &self.endpoint(process),
                            &manifest.binding,
                            &self.trust,
                        )?;
                        ensure(current.service == *process && current.target == manifest.target)?;
                        super::control::suppress_lifecycle(
                            &self.endpoint(process),
                            &manifest.binding,
                            &self.trust,
                        )?;
                        let job = self.service_job()?;
                        ensure(job.observe(&self.trust)?.and_then(|j| j.pid) == Some(process.pid))?;
                        self.trust.verify_process(process, CodeRole::Cli)?;
                        self.require_effect(manifest, action)?;
                        job.stop_exact(&self.trust, process).await?;
                        wait_exact_exit(process).await?;
                        ensure(job.observe(&self.trust)?.is_none())?;
                    }
                }
                P::InstallCandidate => {
                    self.verify_assets(manifest, true)?;
                    ensure(self.bundle_observation(manifest)? == super::BundleObservation::Old)?;
                    ensure(original_process_gone(&manifest.old_desktop)?)?;
                    if manifest.managed() {
                        ensure(
                            original_process_gone(&manifest.old_service)?
                                && self.service_job()?.observe(&self.trust)?.is_none(),
                        )?;
                    }
                    self.require_effect(manifest, action)?;
                    self.updater.install(&self.package)?;
                    ensure(
                        self.bundle_observation(manifest)? == super::BundleObservation::Candidate,
                    )?;
                }
                P::SwitchRegistration | P::RestoreRegistration => {
                    self.verify_assets(manifest, true)?;
                }
                P::RestoreBundle => {
                    #[cfg(feature = "ota-fixture")]
                    if super::fixture_fault::consume(
                        super::fixture_fault::Point::Restore,
                        &manifest.target.id,
                        manifest.transaction_id(),
                    )? {
                        return Err(OtaError::RecoveryFailed);
                    }
                    self.verify_assets(manifest, true)?;
                    let path = Path::new(&manifest.target.app_path);
                    // Keep every existing target, including an incomplete install,
                    // in a retained sibling. Never delete an unverified bundle.
                    let current = if exact_absent(path)? {
                        None
                    } else {
                        Some(super::platform_fs::bundle_hash(path)?)
                    };
                    let restore = if self.trust.fixture_policy().is_some() {
                        super::platform_fs::restore_bundle_private
                    } else {
                        super::platform_fs::restore_bundle
                    };
                    restore(
                        &self.assets,
                        &manifest.old_bundle_backup.relative_path,
                        path,
                        &manifest.old_bundle_backup.sha256,
                        current.as_deref(),
                    )?;
                    self.verify_bundle(path, &manifest.target.version)?;
                }
                P::Launch {
                    role,
                    release,
                    launch_id,
                } => {
                    return self
                        .launch_native(manifest, *role, *release, launch_id)
                        .await;
                }
                P::ReleaseReservation => {
                    let journal = self.snapshot(manifest)?;
                    ensure(Self::terminal(&journal))?;
                    let service = self.actual_service()?;
                    super::control::release_reservation(
                        &self.endpoint(&service),
                        &manifest.binding,
                        &self.trust,
                    )?;
                }
                P::RetireRecovery => {
                    ensure(Self::terminal(&self.snapshot(manifest)?))?;
                    let mut job = self.recovery_job(manifest)?;
                    let bytes = self.assets.read("recovery.plist", 131072)?;
                    ensure(bytes == job.definition.to_plist()?)?;
                    if self.trust.fixture_policy().is_none() {
                        // Publication is uniquely owned and exact-byte checked.
                        // Remove before self-bootout so next login cannot rearm.
                        if !exact_absent(&job.plist_path)? {
                            super::platform_fs::remove_registration(&job.plist_path, &bytes)?;
                        }
                        job.plist_path = self.assets.path.join("recovery.plist");
                    }
                    job.change(&self.trust, JobChange::Bootout).await?;
                }
                P::PruneSupersededBackup => {
                    ensure(Self::terminal(&self.snapshot(manifest)?))?;
                    super::retention::prune_superseded(
                        Path::new(&manifest.target.pacer_home),
                        manifest,
                        &self.trust,
                    )?;
                }
            }
            Ok(E::Complete)
        })
    }
    fn poll_readiness<'a>(
        &'a self,
        expected: &'a super::ExpectedReadiness,
    ) -> super::PlatformFuture<'a, super::ReadinessObservation> {
        Box::pin(async move {
            super::control::query_readiness(
                &self.endpoint(&expected.service),
                expected,
                &self.trust,
            )
        })
    }
    fn wait_for_observation<'a>(&'a self) -> super::PlatformFuture<'a, ()> {
        Box::pin(async {
            tokio::time::sleep(super::OBSERVATION_INTERVAL).await;
            Ok(())
        })
    }
}

#[cfg(target_os = "macos")]
impl NativePlatform {
    async fn launch_native(
        &self,
        manifest: &super::PreparedManifest,
        role: super::ProcessRole,
        release: super::Release,
        launch_id: &str,
    ) -> Result<super::ActionEvidence, OtaError> {
        use super::{ActionEvidence, ProcessRole, Release};
        let expected_version = match release {
            Release::Old => &manifest.target.version,
            Release::Candidate => &manifest.candidate.version,
        };
        self.verify_bundle(Path::new(&manifest.target.app_path), expected_version)?;
        let journal = self.snapshot(manifest)?;
        let start = match release {
            Release::Old => journal.restoration_started,
            Release::Candidate => journal.verification_started,
        }
        .ok_or(OtaError::Invalid)?;
        if native::elapsed_ms(
            &start,
            &native::awake_now().map_err(|_| OtaError::Identity)?,
        )
        .map_err(|_| OtaError::Identity)?
            >= super::VERIFY_TIMEOUT_MS
        {
            return Err(OtaError::Timeout);
        }
        let marker = format!("launch-{launch_id}");
        // Exclusive marker precedes spawn/bootstrap. An uncertain restart may
        // observe a receipt, but must never repeat an effect after this marker.
        self.assets.write_new(&marker, b"started\n")?;
        // macOS forgets LOCAL_PEERTOKEN when the peer closes, even while the
        // ticket bytes remain buffered. Keep the helper endpoint alive until
        // the desktop has authenticated it and appeared on its fresh channel.
        let mut _launch_delivery = None;
        if role == ProcessRole::Service {
            ensure(manifest.managed())?;
            let job = self.service_job()?;
            ensure(
                job.observe(&self.trust)?.is_none()
                    && !disabled_state(&job.definition.label).await?,
            )?;
            job.change(&self.trust, JobChange::Bootstrap).await?;
        } else {
            use std::os::unix::{io::AsRawFd, net::UnixStream};
            let service = self.actual_service()?;
            let service_version = if manifest.managed() {
                expected_version.clone()
            } else {
                manifest.old_service_version.clone()
            };
            let ticket = super::control::LaunchTicket {
                schema: 1,
                installation_id: manifest.target.id.clone(),
                transaction_id: manifest.transaction_id().into(),
                launch_id: launch_id.into(),
                native_session_id: launch_id.into(),
                nonce: launch_id.into(),
                service,
                service_version,
                desktop_version: expected_version.clone(),
                protocol: manifest.old_service_protocol,
            };
            ticket.validate()?;
            let (mut writer, reader) = UnixStream::pair().map_err(|_| OtaError::Io)?;
            writer
                .set_write_timeout(Some(std::time::Duration::from_secs(5)))
                .map_err(|_| OtaError::Io)?;
            let fd = reader.as_raw_fd();
            let executable = Path::new(&manifest.target.app_path).join("Contents/MacOS/pacer");
            let mut command = std::process::Command::new(executable);
            command
                .arg("--pacer-maintenance-launch")
                .env_clear()
                .env("HOME", user_home(&self.trust)?)
                .env("PACER_HOME", &manifest.target.pacer_home)
                .env("PACER_PORT", manifest.target.port.to_string())
                .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            inherit_launch_socket(&mut command, fd);
            let boot = native::awake_now().map_err(|_| OtaError::Identity)?.boot_id;
            let receipt_directory = super::platform_fs::PrivateDir::open(&self.assets.path)?;
            let child = command.spawn().map_err(|_| OtaError::Io)?;
            drop(reader);
            let receipt_launch = launch_id.to_owned();
            // Always reap, including a failed ticket send. Only a successful
            // wait publishes exit proof. Live launch authority still comes from
            // the fresh authenticated channel, never from this numeric PID.
            std::thread::spawn(move || {
                let _ = record_child_exit(child, &receipt_directory, &receipt_launch, &boot);
            });
            if let Err(error) = super::control::send_launch_ticket(&mut writer, &ticket) {
                // An early exit may close the pipe before the waiter publishes
                // its exact-child receipt. Bound that publication gap; a timeout
                // retains ambiguity and never grants readiness or sends a signal.
                await_child_exit_receipt(&self.assets, launch_id, &ticket.service.boot_id, 10_000)
                    .await?;
                return Err(error);
            }
            _launch_delivery = Some(writer);
        }
        loop {
            if role == ProcessRole::Desktop
                && child_exit_recorded(&self.assets, launch_id, &start.boot_id)?
            {
                return Err(OtaError::RecoveryFailed);
            }
            if let Ok(service) = self.actual_service() {
                if let Ok(Some(launch)) = super::control::observe_launch(
                    &self.endpoint(&service),
                    &manifest.binding,
                    launch_id,
                    &self.trust,
                ) {
                    ensure(
                        launch.role == role
                            && launch.release == release
                            && launch.launch_id == launch_id
                            && launch.version == *expected_version,
                    )?;
                    self.trust.verify_process(
                        &launch.process,
                        match role {
                            ProcessRole::Desktop => CodeRole::Desktop,
                            ProcessRole::Service => CodeRole::Cli,
                        },
                    )?;
                    return Ok(ActionEvidence::Launched { launch });
                }
            }
            let now = native::awake_now().map_err(|_| OtaError::Identity)?;
            if native::elapsed_ms(&start, &now).map_err(|_| OtaError::Identity)?
                >= super::VERIFY_TIMEOUT_MS
            {
                return Err(OtaError::Timeout);
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }
}

/// Explicit native validation entry point. Absent from every helper/application
/// binary, including ota-fixture binaries: this exists only in the test harness.
#[cfg(all(test, target_os = "macos", feature = "ota-fixture"))]
mod fixture_job_probe {
    use super::*;
    use sha2::{Digest, Sha256};
    #[tokio::test]
    #[ignore = "requires a compiled private live fixture lease and durable registration intent"]
    async fn inspect_owned_job() {
        let trust = ReleaseTrust::configured().expect("compiled fixture trust");
        let policy = trust.fixture_policy().expect("fixture build");
        policy.validate_live().unwrap();
        let path = policy
            .root
            .join("registrations")
            .join(format!("{}.plist", policy.service_label));
        let bytes = super::super::platform_fs::read_owned_file(&path, 131_072).unwrap();
        let definition = JobDefinition::from_plist(&bytes).unwrap();
        assert_eq!(definition.label, policy.service_label);
        assert_eq!(
            definition.arguments[0],
            policy
                .current_app
                .join("Contents/MacOS/ota-job-probe")
                .to_string_lossy()
        );
        trust
            .verify_static(Path::new(&definition.arguments[0]), CodeRole::Cli)
            .unwrap();
        let record: serde_json::Value = serde_json::from_slice(
            &super::super::platform_fs::PrivateDir::open(&policy.root)
                .unwrap()
                .read("record.json", 262_144)
                .unwrap(),
        )
        .unwrap();
        let registration = record["registrations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["label"] == policy.service_label)
            .unwrap();
        assert_eq!(registration["path"], path.to_string_lossy().as_ref());
        assert_eq!(
            registration["sha256"],
            format!("{:x}", Sha256::digest(&bytes))
        );
        assert!(matches!(
            registration["state"].as_str(),
            Some("intent" | "loaded" | "retired")
        ));
        let action = std::env::var("PACER_OTA_PROBE_ACTION").unwrap_or_else(|_| "inspect".into());
        let before = copy_user_job(&definition.label).unwrap();
        if let Some(value) = &before {
            let dictionary = value.as_dictionary().unwrap();
            assert_eq!(
                dictionary.get("Label").and_then(plist::Value::as_string),
                Some(definition.label.as_str())
            );
            let arguments = dictionary
                .get("ProgramArguments")
                .and_then(plist::Value::as_array)
                .unwrap()
                .iter()
                .map(|value| value.as_string().unwrap().to_string())
                .collect::<Vec<_>>();
            assert_eq!(arguments, definition.arguments);
        }
        let domain = format!("gui/{}", policy.uid);
        let target = format!("{domain}/{}", definition.label);
        if action == "inspect-unready" {
            let job = OwnedJob {
                definition: definition.clone(),
                plist_path: path.clone(),
                role: CodeRole::Cli,
            };
            let start = native::awake_now().unwrap();
            loop {
                let loaded = job
                    .observe(&trust)
                    .unwrap()
                    .expect("owned job remains loaded");
                if loaded.pid.is_none() {
                    let inventory = super::super::control::native_process_inventory().unwrap();
                    let processes = unready_inventory(
                        Some(&loaded),
                        &inventory,
                        Path::new(&definition.arguments[0]),
                        policy.uid,
                    )
                    .unwrap();
                    assert!(processes.is_empty());
                    println!(
                        "OTA_UNREADY_BOUNDARY=loaded-exact-job-without-pid-and-empty-inventory"
                    );
                    break;
                }
                assert!(
                    native::elapsed_ms(&start, &native::awake_now().unwrap()).unwrap() < 30_000
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        } else if action == "owned-bootstrap" || action == "owned-retire" {
            let job = OwnedJob {
                definition: definition.clone(),
                plist_path: path.clone(),
                role: CodeRole::Cli,
            };
            if action == "owned-bootstrap" {
                job.change(&trust, JobChange::Bootstrap).await.unwrap();
            } else {
                let pid = job.observe(&trust).unwrap().unwrap().pid.unwrap();
                let process = native::process_details(pid).unwrap().unwrap().identity;
                job.stop_exact(&trust, &process).await.unwrap();
            }
        } else if action != "inspect" {
            policy.validate_live().unwrap();
            let mut command = tokio::process::Command::new("/bin/launchctl");
            match action.as_str() {
                "bootstrap" => {
                    assert!(before.is_none());
                    assert_eq!(registration["state"], "intent");
                    command.arg("bootstrap").arg(domain).arg(path);
                }
                "disable" => {
                    assert!(before.is_some());
                    command.arg("disable").arg(target);
                }
                "enable" => {
                    command.arg("enable").arg(target);
                }
                "retire" => {
                    assert!(before.is_some());
                    command.arg("bootout").arg(target);
                }
                _ => panic!("unsupported fixture probe action"),
            }
            let status = command
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .status()
                .await
                .unwrap();
            assert!(status.success());
        }
        let after = copy_user_job(&definition.label).unwrap();
        let matched = after.as_ref().map(|value| {
            definition
                .match_loaded(value)
                .map(|job| serde_json::json!({"pid":job.pid,"disabled":job.disabled}))
                .map_err(|error| error.to_string())
        });
        println!(
            "OTA_JOB_PROBE={}",
            serde_json::json!({"label":definition.label,"sha256":format!("{:x}",Sha256::digest(&bytes)),"loaded":after.is_some(),"snapshot":after,"matched":matched,"action":action})
        );
    }
}

/// Manager ownership and an empty original reservation, not a guessed PID,
/// authorize the special candidate-startup cleanup. Extra live processes refuse.
fn unready_inventory(
    loaded: Option<&LoadedJob>,
    inventory: &[native::ProcessDetails],
    executable: &Path,
    uid: u32,
) -> Result<Vec<ProcessIdentity>, OtaError> {
    if let Some(pid) = loaded.and_then(|j| j.pid) {
        if let Some(actual) = inventory.iter().find(|p| p.identity.pid == pid) {
            ensure(actual.executable == executable && actual.uid == uid)?;
        }
    }
    let matching: Vec<_> = inventory
        .iter()
        .filter(|p| p.executable == executable)
        .collect();
    ensure(matching.len() <= 1)?;
    if let Some(process) = matching.first() {
        ensure(loaded.and_then(|j| j.pid) == Some(process.identity.pid) && process.uid == uid)?;
    }
    Ok(matching.into_iter().map(|p| p.identity.clone()).collect())
}

#[cfg(target_os = "macos")]
impl NativePlatform {
    fn unready_candidate_job(
        &self,
        m: &super::PreparedManifest,
        id: &str,
    ) -> Result<(OwnedJob, Vec<ProcessIdentity>), OtaError> {
        let journal = self.snapshot(m)?;
        let boot = native::awake_now().map_err(|_| OtaError::Identity)?.boot_id;
        ensure(journal.state == super::journal::TransactionState::Restoring)?;
        journal.unready_candidate_launch(m, id, &boot)?;
        ensure(super::recovery_authority::verify(
            Path::new(&m.target.pacer_home),
            m,
            &journal,
        )?)?;
        ensure(self.assets.read(&format!("launch-{id}"), 16)? == b"started\n")?;
        self.verify_assets(m, true)?;
        self.verify_bundle(Path::new(&m.target.app_path), &m.candidate.version)?;
        ensure(
            self.bundle_observation(m)? == super::BundleObservation::Candidate
                && original_process_gone(&m.old_desktop)?
                && original_process_gone(&m.old_service)?,
        )?;
        let job = self.service_job()?;
        let loaded = job.observe(&self.trust)?;
        let mut inventory = super::control::native_process_inventory()?;
        // Inventory can race a short-lived retry. Read the manager's current PID
        // explicitly so a missing/renamed executable is never mistaken for exit.
        if let Some(pid) = loaded.as_ref().and_then(|job| job.pid) {
            if let Some(actual) = native::process_details(pid).map_err(|_| OtaError::Identity)? {
                ensure(
                    actual.executable == Path::new(&job.definition.arguments[0])
                        && actual.uid as u64 == m.target.owner_uid,
                )?;
                if !inventory.iter().any(|p| p.identity == actual.identity) {
                    inventory.push(actual);
                }
            }
        }
        let processes = unready_inventory(
            loaded.as_ref(),
            &inventory,
            Path::new(&job.definition.arguments[0]),
            m.target
                .owner_uid
                .try_into()
                .map_err(|_| OtaError::Identity)?,
        )?;
        for process in &processes {
            self.trust.verify_process(process, CodeRole::Cli)?;
        }
        Ok((job, processes))
    }
    fn remember_unready_processes(
        &self,
        id: &str,
        current: &[ProcessIdentity],
    ) -> Result<Vec<ProcessIdentity>, OtaError> {
        let name = format!("unready-observed-{id}");
        let before = if exact_absent(&self.assets.path.join(&name))? {
            None
        } else {
            Some(self.assets.read(&name, 65536)?)
        };
        let mut all: Vec<ProcessIdentity> = before
            .as_ref()
            .map(|b| serde_json::from_slice(b).map_err(|_| OtaError::Invalid))
            .transpose()?
            .unwrap_or_default();
        ensure(
            all.len() <= 256
                && all
                    .iter()
                    .all(|p| p.pid > 0 && !p.boot_id.is_empty() && !p.birth.is_empty()),
        )?;
        for p in current {
            if !all.contains(p) {
                all.push(p.clone());
            }
        }
        ensure(all.len() <= 256)?;
        let bytes = serde_json::to_vec(&all).map_err(|_| OtaError::Invalid)?;
        match before {
            Some(before) if before != bytes => self.assets.replace_exact(&name, &before, &bytes)?,
            None => self.assets.write_new(&name, &bytes)?,
            _ => {}
        }
        Ok(all)
    }
    async fn stop_unready_candidate(
        &self,
        m: &super::PreparedManifest,
        id: &str,
    ) -> Result<(), OtaError> {
        let (job, processes) = self.unready_candidate_job(m, id)?;
        let mut observed = self.remember_unready_processes(id, &processes)?;
        if job.observe(&self.trust)?.is_some() {
            let registration = super::platform_fs::read_owned_file(&job.plist_path, 131072)?;
            job.fixture_ledger(&self.trust, &registration, "loaded", None)?;
            // Repeat the complete original authority/job proof immediately before
            // bootout. This private path never relaxes generic stop_exact.
            let (_, current) = self.unready_candidate_job(m, id)?;
            observed = self.remember_unready_processes(id, &current)?;
            let target = format!(
                "gui/{}/{}",
                unsafe { libc::geteuid() },
                job.definition.label
            );
            let mut command = tokio::process::Command::new("/bin/launchctl");
            command
                .args(["bootout", &target])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            let status = tokio::time::timeout(std::time::Duration::from_secs(10), command.status())
                .await
                .map_err(|_| OtaError::Timeout)?
                .map_err(|_| OtaError::Io)?;
            if !status.success() && job.observe(&self.trust)?.is_some() {
                return Err(OtaError::Io);
            }
        }
        for process in &observed {
            wait_exact_exit(process).await?;
        }
        ensure(job.observe(&self.trust)?.is_none())?;
        ensure(
            unready_inventory(
                None,
                &super::control::native_process_inventory()?,
                Path::new(&job.definition.arguments[0]),
                m.target.owner_uid as u32,
            )?
            .is_empty(),
        )?;
        let registration = super::platform_fs::read_owned_file(&job.plist_path, 131072)?;
        job.fixture_ledger(&self.trust, &registration, "retired", None)?;
        Ok(())
    }
}

#[cfg(test)]
mod unready_tests {
    use super::*;
    #[test]
    fn unready_job_inventory_refuses_foreign_unattributed_or_duplicate_processes() {
        let executable = PathBuf::from("/tmp/candidate.app/Contents/Resources/pacer");
        let process = native::ProcessDetails {
            identity: ProcessIdentity {
                pid: 101,
                boot_id: "boot".into(),
                birth: "1:2".into(),
            },
            executable: executable.clone(),
            uid: 501,
            parent_pid: 1,
        };
        let mut loaded = LoadedJob {
            pid: None,
            disabled: None,
        };
        assert!(unready_inventory(Some(&loaded), &[], &executable, 501)
            .unwrap()
            .is_empty());
        assert!(unready_inventory(Some(&loaded), &[process.clone()], &executable, 501).is_err());
        loaded.pid = Some(101);
        assert_eq!(
            unready_inventory(Some(&loaded), &[process.clone()], &executable, 501).unwrap(),
            vec![process.identity.clone()]
        );
        assert!(unready_inventory(None, &[process.clone()], &executable, 501).is_err());
        let mut redirected = process.clone();
        redirected.executable = PathBuf::from("/tmp/unrelated-worker");
        assert!(unready_inventory(Some(&loaded), &[redirected], &executable, 501).is_err());
        assert!(unready_inventory(
            Some(&loaded),
            &[process.clone(), process.clone()],
            &executable,
            501
        )
        .is_err());
        assert!(unready_inventory(Some(&loaded), &[process], &executable, 502).is_err());
    }
}
