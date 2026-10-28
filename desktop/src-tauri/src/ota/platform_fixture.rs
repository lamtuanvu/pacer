//! Fixed, compiled lease inspection/retirement. No caller-supplied job or path.
use super::*;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FixtureJobsReport {
    schema: u32,
    jobs: Vec<FixtureJobReport>,
    desktops: Vec<ProcessIdentity>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FixtureJobReport {
    label: String,
    state: String,
    loaded: bool,
    process: Option<ProcessIdentity>,
    executable: Option<String>,
    registration_sha256: Option<String>,
    registration_text: Option<String>,
}
fn registration<'a>(
    record: &'a serde_json::Value,
    label: &str,
    path: &Path,
    bytes: Option<&[u8]>,
) -> Result<&'a serde_json::Value, OtaError> {
    let rows = record["registrations"]
        .as_array()
        .ok_or(OtaError::Invalid)?;
    let matches: Vec<_> = rows.iter().filter(|row| row["label"] == label).collect();
    ensure(matches.len() == 1)?;
    let row = matches[0];
    ensure(row["path"].as_str() == path.to_str())?;
    let state = row["state"].as_str().ok_or(OtaError::Invalid)?;
    let processes: Vec<ProcessIdentity> =
        serde_json::from_value(row["processes"].clone()).map_err(|_| OtaError::Invalid)?;
    ensure(processes.len() <= 128)?;
    match (state, bytes) {
        ("reserved", None) => ensure(row["sha256"].is_null() && processes.is_empty())?,
        ("intent" | "loaded" | "retired", Some(bytes)) => ensure(row["sha256"] == digest(bytes))?,
        _ => return Err(OtaError::Identity),
    }
    Ok(row)
}
#[derive(serde::Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct StartupRuntime {
    schema:u32,state:String,request:Option<serde_json::Value>,
    driver:ProcessIdentity,source_service:ProcessIdentity,desktop:ProcessIdentity,
}
fn startup_identities(record:&serde_json::Value)->Result<Vec<ProcessIdentity>,OtaError>{
    ensure(record.get("exercise")==Some(&serde_json::Value::Null))?;
    let runtime:StartupRuntime=serde_json::from_value(record["runtime"].clone()).map_err(|_|OtaError::Invalid)?;
    ensure(runtime.schema==1 && runtime.state=="starting" && runtime.request.is_none() && record["runtime"].get("request")==Some(&serde_json::Value::Null))?;
    let identities=vec![runtime.driver,runtime.source_service,runtime.desktop];
    ensure(identities.iter().all(|p|p.pid>0&&!p.birth.is_empty()&&!p.boot_id.is_empty()))?;
    ensure(identities.iter().map(|p|p.pid).collect::<std::collections::BTreeSet<_>>().len()==3)?;
    Ok(identities)
}
#[cfg(feature="ota-fixture")]
fn startup_proof(trust:&ReleaseTrust)->Result<(),OtaError>{
    use crate::ota::{control,platform_fs::PrivateDir,recovery_authority};
    let policy=trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    policy.validate_live().map_err(|_|OtaError::Identity)?;
    let root=PrivateDir::open(&policy.root)?;
    let record:serde_json::Value=serde_json::from_slice(&root.read("record.json",262144)?).map_err(|_|OtaError::Invalid)?;
    let boot=native::awake_now().map_err(|_|OtaError::Identity)?.boot_id;
    for expected in startup_identities(&record)? {
        ensure(expected.boot_id==boot)?;
        if let Some(current)=native::process_details(expected.pid).map_err(|_|OtaError::Identity)? {ensure(current.identity!=expected)?;}
    }
    ensure(control::native_process_inventory()?.iter().all(|p|p.executable!=policy.current_app.join("Contents/MacOS/pacer")))?;
    let recovery_path=policy.root.join("registrations").join(format!("{}.plist",policy.recovery_label));
    let recovery=registration(&record,&policy.recovery_label,&recovery_path,None)?;
    ensure(recovery["state"]=="reserved" && copy_user_job(&policy.recovery_label)?.is_none() && exact_absent(&recovery_path)?)?;
    let updates=PrivateDir::open(&policy.home.join("desktop-updates"))?;
    for entry in std::fs::read_dir(&updates.path).map_err(|_|OtaError::Io)? {
        let name=entry.map_err(|_|OtaError::Io)?.file_name();
        ensure(name=="admission.sqlite" || name=="admission.sqlite-journal")?;
    }
    let reservation=format!("fixture-cleanup-{}",policy.nonce);
    ensure(recovery_authority::admission_clear(&policy.home)? || recovery_authority::reservation_held(&policy.home,&reservation)?)?;
    trust.verify_static(&policy.current_app,CodeRole::Desktop)?;
    let metadata:serde_json::Value=serde_json::from_slice(&crate::ota::platform_fs::read_owned_file(&policy.current_app.join("Contents/Resources/pacer-release.json"),65536)?).map_err(|_|OtaError::Invalid)?;
    ensure(metadata["version"]==record["nativeFixture"]["baselineVersion"] && metadata["fixture"]==true)?;
    Ok(())
}
fn diagnostic_digest(path:&Path)->Result<String,OtaError>{
    use std::os::unix::fs::MetadataExt;
    let _parent=crate::ota::platform_fs::PrivateDir::open(path.parent().ok_or(OtaError::Invalid)?)?;
    let before=std::fs::symlink_metadata(path).map_err(|_|OtaError::Io)?;
    ensure(before.is_file() && before.nlink()==1 && before.uid()==unsafe{libc::geteuid()} && before.mode()&0o7777==0o700)?;
    let bytes=crate::ota::platform_fs::read_owned_file(path,512*1024*1024)?;
    let after=std::fs::symlink_metadata(path).map_err(|_|OtaError::Io)?;
    ensure(after.is_file() && after.nlink()==1 && after.mode()&0o7777==0o700 && before.dev()==after.dev() && before.ino()==after.ino() && before.len()==after.len() && before.mtime()==after.mtime() && before.mtime_nsec()==after.mtime_nsec())?;
    Ok(digest(&bytes))
}
#[cfg(feature="ota-fixture")]
async fn reserve_startup_cleanup(trust:&ReleaseTrust)->Result<String,OtaError>{
    use crate::ota::platform_fs::PrivateDir;
    #[derive(serde::Deserialize,serde::Serialize)]
    #[serde(rename_all="camelCase",deny_unknown_fields)]
    struct Descriptor {schema:u32,policy_sha256:String,cli_sha256:String,helper_sha256:String,#[serde(default,skip_serializing_if="Option::is_none")]native_shim_sha256:Option<String>}
    let policy=trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    startup_proof(trust)?;
    let root=PrivateDir::open(&policy.root)?;
    let record:serde_json::Value=serde_json::from_slice(&root.read("record.json",262144)?).map_err(|_|OtaError::Invalid)?;
    let directory=PrivateDir::open(&policy.root.join("diagnostics"))?;
    let descriptor:Descriptor=serde_json::from_slice(&directory.read("build.json",4096)?).map_err(|_|OtaError::Invalid)?;
    ensure(descriptor.schema==1 && serde_json::to_value(&descriptor).map_err(|_|OtaError::Invalid)?==record["diagnostics"] && crate::ota::trust::build_identity()["fixturePolicySha256"]==descriptor.policy_sha256)?;
    let names=std::fs::read_dir(&directory.path).map_err(|_|OtaError::Io)?.map(|entry|entry.map(|e|e.file_name())).collect::<Result<std::collections::BTreeSet<_>,_>>().map_err(|_|OtaError::Io)?;
    let mut expected:std::collections::BTreeSet<_>=["build.json","pacer-startup-cleanup","pacer-update-helper"].into_iter().map(std::ffi::OsString::from).collect();
    if let Some(hash)=&descriptor.native_shim_sha256 {
        expected.insert(std::ffi::OsString::from("libpacer-native.dylib"));
        let shim=directory.path.join("libpacer-native.dylib");
        ensure(diagnostic_digest(&shim)?==*hash)?;
        trust.verify_native_shim(&shim)?;
    }
    ensure(names==expected)?;
    let cli=directory.path.join("pacer-startup-cleanup");let helper=directory.path.join("pacer-update-helper");
    ensure(std::env::current_exe().map_err(|_|OtaError::Io)?==helper)?;
    ensure(diagnostic_digest(&cli)?==descriptor.cli_sha256 && diagnostic_digest(&helper)?==descriptor.helper_sha256)?;
    trust.verify_static(&cli,CodeRole::Cli)?;trust.verify_static(&helper,CodeRole::Helper)?;
    let mut command=tokio::process::Command::new(&cli);
    command.arg("--pacer-fixture-startup-cleanup").env_clear().env("HOME",&policy.home).env("PACER_HOME",&policy.home).env("PATH","/usr/bin:/bin:/usr/sbin:/sbin").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true);
    let output=tokio::time::timeout(std::time::Duration::from_secs(30),command.output()).await.map_err(|_|OtaError::Timeout)?.map_err(|_|OtaError::Io)?;
    ensure(output.status.success() && output.stdout.len()<=4096)?;
    let ack:serde_json::Value=serde_json::from_slice(&output.stdout).map_err(|_|OtaError::Invalid)?;
    let reservation=format!("fixture-cleanup-{}",policy.nonce);
    ensure(ack==serde_json::json!({"schema":1,"kind":"fixture-startup-cleanup","nonce":policy.nonce,"policySha256":descriptor.policy_sha256,"reservationId":reservation}))?;
    startup_proof(trust)?;
    ensure(crate::ota::recovery_authority::reservation_held(&policy.home,&reservation)?)?;
    Ok(reservation)
}
#[cfg(feature="ota-fixture")]
async fn retire_startup_job(trust:&ReleaseTrust,job:&OwnedJob,reservation:&str)->Result<(),OtaError>{
    let policy=trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    let start=native::awake_now().map_err(|_|OtaError::Identity)?;
    loop {
        startup_proof(trust)?;
        ensure(crate::ota::recovery_authority::reservation_held(&policy.home,reservation)?)?;
        let Some(loaded)=job.observe(trust)? else {return Ok(())};
        if let Some(pid)=loaded.pid {
            if let Some(details)=native::process_details(pid).map_err(|_|OtaError::Identity)? {
                ensure(details.executable==Path::new(&job.definition.arguments[0]))?;
                trust.verify_process(&details.identity,CodeRole::Cli)?;
                match job.stop_exact(trust,&details.identity).await {
                    Ok(())=>return Ok(()),
                    Err(OtaError::Identity)|Err(OtaError::Unavailable)=>{},
                    Err(error)=>return Err(error),
                }
            }
        }
        ensure(native::elapsed_ms(&start,&native::awake_now().map_err(|_|OtaError::Identity)?).map_err(|_|OtaError::Identity)?<60_000)?;
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
}
#[cfg(feature = "ota-fixture")]
pub(crate) async fn fixture_jobs(
    trust: &ReleaseTrust,
    retire: bool,
) -> Result<FixtureJobsReport, OtaError> {
    use crate::ota::{control, platform_fs::PrivateDir, recovery_authority};
    let policy = trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    policy.validate_live().map_err(|_| OtaError::Identity)?;
    let own = native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Helper)?;
    trust.verify_static(&policy.current_app, CodeRole::Desktop)?;
    let locks = PrivateDir::create(&policy.root.join("locks"))?;
    let _ownership = locks.acquire_locks(&policy.current_app, &policy.home)?;
    let root = PrivateDir::open(&policy.root)?;
    let record: serde_json::Value = serde_json::from_slice(&root.read("record.json", 262144)?)
        .map_err(|_| OtaError::Invalid)?;
    ensure(
        record["registrations"]
            .as_array()
            .is_some_and(|rows| rows.len() == 2),
    )?;
    let desktop_executable = policy.current_app.join("Contents/MacOS/pacer");
    let desktops = control::native_process_inventory()?
        .into_iter()
        .filter(|details| details.executable == desktop_executable)
        .map(|details| {
            ensure(details.uid == policy.uid)?;
            trust.verify_process(&details.identity, CodeRole::Desktop)?;
            Ok::<_, OtaError>(details.identity)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut jobs = Vec::new();
    // Validate both jobs before requesting admission or changing either job.
    for (label, role) in [
        (&policy.service_label, CodeRole::Cli),
        (&policy.recovery_label, CodeRole::Helper),
    ] {
        let path = policy
            .root
            .join("registrations")
            .join(format!("{label}.plist"));
        if exact_absent(&path)? {
            registration(&record, label, &path, None)?;
            ensure(copy_user_job(label)?.is_none())?;
            jobs.push((label.clone(), None, None, None));
            continue;
        }
        let bytes = crate::ota::platform_fs::read_owned_file(&path, 131072)?;
        registration(&record, label, &path, Some(&bytes))?;
        let definition = JobDefinition::from_plist(&bytes)?;
        ensure(definition.label == *label)?;
        if label == &policy.service_label {
            let program = Path::new(definition.arguments.first().ok_or(OtaError::Invalid)?);
            ensure(
                definition.arguments.len() == 2
                    && definition.arguments[1] == "serve"
                    && (program == policy.current_app.join("Contents/Resources/pacer")
                        || program == policy.external_cli()
                        || program == policy.takeover_cli()),
            )?;
            ensure(
                definition.environment.get("PACER_HOME").map(String::as_str)
                    == policy.home.to_str()
                    && definition.environment.get("PACER_PORT") == Some(&policy.port.to_string()),
            )?;
        } else {
            ensure(recovery_arguments_valid(&definition.arguments, &policy.home))?;
        }
        let job = OwnedJob {
            definition,
            plist_path: path,
            role,
        };
        let loaded = job.observe(trust)?;
        let process = loaded
            .as_ref()
            .and_then(|v| v.pid)
            .map(|pid| {
                let details = native::process_details(pid)
                    .map_err(|_| OtaError::Identity)?
                    .ok_or(OtaError::Identity)?;
                ensure(
                    details.uid == policy.uid
                        && details.executable == Path::new(&job.definition.arguments[0]),
                )?;
                crate::ota::platform::verify_fixture_or_release_process(trust, &details.identity, &details.executable, role)?;
                Ok::<_, OtaError>(details.identity)
            })
            .transpose()?;
        jobs.push((label.clone(), Some((job, bytes)), loaded, process));
    }
    if retire && jobs.iter().any(|(_, _, loaded, _)| loaded.is_some()) {
      if startup_identities(&record).is_ok() {
        ensure(desktops.is_empty())?;
        let reservation=reserve_startup_cleanup(trust).await?;
        for (_,owned,loaded,_) in &jobs {
          if let Some((job,_))=owned { if loaded.is_some() { retire_startup_job(trust,job,&reservation).await?; } }
        }
      } else {
        let (_, owned, loaded, process) = &jobs[0];
        let (job, _) = owned.as_ref().ok_or(OtaError::Unavailable)?;
        ensure(loaded.is_some())?;
        let service = process.as_ref().ok_or(OtaError::Unavailable)?;
        if Path::new(&job.definition.arguments[0]) == policy.takeover_cli() {
            // A source-built takeover CLI has no native OTA authority, so it
            // cannot acknowledge fixture cleanup. The driver has already ended
            // every fixture desktop; stop only this exact verified service.
            ensure(desktops.is_empty() && jobs[1].2.is_none())?;
            job.stop_exact(trust, service).await?;
        } else {
        let endpoint = control::ServiceEndpoint {
            home: &policy.home,
            port: policy.port,
            process: service,
            executable: Path::new(&job.definition.arguments[0]),
        };
        let acknowledgment = control::request_fixture_cleanup(&endpoint, trust)?;
        let reservation = acknowledgment.reservation_id;
        ensure(reservation == format!("fixture-cleanup-{}", policy.nonce))?;
        for desktop in &acknowledgment.desktops {
            ensure(desktops.contains(desktop))?;
            wait_exact_exit(desktop).await?;
        }
        ensure(
            control::native_process_inventory()?
                .iter()
                .all(|details| details.executable != desktop_executable),
        )?;
        for (_, owned, loaded, process) in &jobs {
            let Some((job, _)) = owned else { continue };
            if loaded.is_some() {
                ensure(recovery_authority::reservation_held(
                    &policy.home,
                    &reservation,
                )?)?;
                let process = process.as_ref().ok_or(OtaError::Unavailable)?;
                job.stop_exact(trust, process).await?;
            }
        }
        }
    }
    }
    let mut report = Vec::new();
    for (label, owned, _, _) in jobs {
        if let Some((job, bytes)) = owned {
            let loaded = job.observe(trust)?;
            if retire {
                ensure(loaded.is_none())?;
                // Observation-only retirement is safe without a core writer: it
                // proves manager absence and every recorded incarnation exited.
                job.fixture_ledger(trust, &bytes, "retired", None)?;
            }
            let current: serde_json::Value =
                serde_json::from_slice(&root.read("record.json", 262144)?)
                    .map_err(|_| OtaError::Invalid)?;
            let row = registration(&current, &label, &job.plist_path, Some(&bytes))?;
            let process = loaded
                .as_ref()
                .and_then(|v| v.pid)
                .map(|pid| {
                    native::process_details(pid)
                        .map_err(|_| OtaError::Identity)?
                        .map(|v| v.identity)
                        .ok_or(OtaError::Identity)
                })
                .transpose()?;
            report.push(FixtureJobReport {
                label,
                state: row["state"].as_str().ok_or(OtaError::Invalid)?.into(),
                loaded: loaded.is_some(),
                process,
                executable: Some(job.definition.arguments[0].clone()),
                registration_sha256: Some(digest(&bytes)),
                registration_text: Some(String::from_utf8(bytes).map_err(|_| OtaError::Invalid)?),
            });
        } else {
            report.push(FixtureJobReport {
                label,
                state: "reserved".into(),
                loaded: false,
                process: None,
                executable: None,
                registration_sha256: None,
                registration_text: None,
            });
        }
    }
    let remaining_desktops = control::native_process_inventory()?
        .into_iter()
        .filter(|details| details.executable == desktop_executable)
        .map(|details| {
            trust.verify_process(&details.identity, CodeRole::Desktop)?;
            Ok::<_, OtaError>(details.identity)
        })
        .collect::<Result<Vec<_>, _>>()?;
    if retire {
        ensure(remaining_desktops.is_empty())?;
    }
    Ok(FixtureJobsReport {
        schema: 1,
        jobs: report,
        desktops: remaining_desktops,
    })
}

/// Install the lease's one external service registration so Desktop starts
/// attached. Fixed program, label and environment; never a caller-chosen path.
#[cfg(feature = "ota-fixture")]
pub(crate) async fn fixture_attach(trust: &ReleaseTrust, takeover: bool) -> Result<FixtureJobsReport, OtaError> {
    use crate::ota::{control, platform_fs::PrivateDir};
    let policy = trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    policy.validate_live().map_err(|_| OtaError::Identity)?;
    let own = native::process_details(std::process::id())
        .map_err(|_| OtaError::Identity)?
        .ok_or(OtaError::Identity)?;
    trust.verify_process(&own.identity, CodeRole::Helper)?;
    let external = if takeover { policy.takeover_cli() } else { policy.external_cli() };
    ensure(policy.permits_path(&external))?;
    if takeover {
        ensure(policy.signing_cert_sha1.is_some())?;
        ensure(trust.verify_static(&external, CodeRole::Cli).is_err())?;
        ensure(std::fs::symlink_metadata(&external).map_err(|_| OtaError::Identity)?.is_file())?;
    } else {
        trust.verify_static(&external, CodeRole::Cli)?;
    }
    {
        let locks = PrivateDir::create(&policy.root.join("locks"))?;
        let _ownership = locks.acquire_locks(&policy.current_app, &policy.home)?;
        let desktop = policy.current_app.join("Contents/MacOS/pacer");
        ensure(
            control::native_process_inventory()?
                .iter()
                .all(|details| details.executable != desktop && details.executable != external),
        )?;
        let path = policy
            .root
            .join("registrations")
            .join(format!("{}.plist", policy.service_label));
        let root = PrivateDir::open(&policy.root)?;
        let record: serde_json::Value = serde_json::from_slice(&root.read("record.json", 262144)?)
            .map_err(|_| OtaError::Invalid)?;
        ensure(record.get("exercise").is_none_or(serde_json::Value::is_null))?;
        registration(&record, &policy.service_label, &path, None)?;
        ensure(exact_absent(&path)? && copy_user_job(&policy.service_label)?.is_none())?;
        let home = policy.home.to_string_lossy().into_owned();
        let mut environment = BTreeMap::new();
        environment.insert("HOME".into(), home.clone());
        environment.insert("PACER_HOME".into(), home);
        environment.insert("PACER_PORT".into(), policy.port.to_string());
        environment.insert("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into());
        let job = OwnedJob {
            definition: JobDefinition {
                label: policy.service_label.clone(),
                arguments: vec![external.to_string_lossy().into_owned(), "serve".into()],
                environment,
                keep_alive: true,
                run_at_load: true,
            },
            plist_path: path,
            role: CodeRole::Cli,
        };
        let bytes = job.definition.to_plist()?;
        job.stage_fixture_registration(trust, &bytes)?;
        crate::ota::platform_fs::publish_registration(&job.plist_path, &bytes)?;
        job.change(trust, JobChange::Bootstrap).await?;
    }
    fixture_jobs(trust, false).await
}

/// Fixed dismissal probe: replace only the fixture's stopped takeover command
/// with the staged baseline build, then reload the same recorded job.
#[cfg(feature = "ota-fixture")]
pub(crate) async fn fixture_refresh_takeover(trust: &ReleaseTrust) -> Result<FixtureJobsReport, OtaError> {
    use crate::ota::{bootstrap_identity::inspect_legacy_executable, control, platform_fs::PrivateDir};
    let policy = trust.fixture_policy().ok_or(OtaError::Unavailable)?;
    policy.validate_live().map_err(|_| OtaError::Identity)?;
    ensure(policy.signing_cert_sha1.is_some())?;
    let root = PrivateDir::open(&policy.root)?;
    let record: serde_json::Value = serde_json::from_slice(&root.read("record.json", 262144)?).map_err(|_| OtaError::Invalid)?;
    ensure(record["exercise"]["scenario"] == "takeover-dismiss"
        && record["exercise"]["state"] == "running"
        && record["exercise"]["transactionId"].is_null())?;
    let desktop = policy.current_app.join("Contents/MacOS/pacer");
    ensure(control::native_process_inventory()?.iter().all(|p| p.executable != desktop))?;
    let path = policy.root.join("registrations").join(format!("{}.plist", policy.service_label));
    let bytes = crate::ota::platform_fs::read_owned_file(&path, 131072)?;
    let definition = JobDefinition::from_plist(&bytes)?;
    ensure(definition.label == policy.service_label
        && definition.arguments == [policy.takeover_cli().to_string_lossy().into_owned(), "serve".into()])?;
    let job = OwnedJob { definition, plist_path: path, role: CodeRole::Cli };
    let loaded = copy_user_job(&policy.service_label)?.ok_or(OtaError::Identity)?;
    let pid = job.definition.match_loaded(&loaded)?.pid.ok_or(OtaError::Identity)?;
    let process = native::process_details(pid).map_err(|_| OtaError::Identity)?.ok_or(OtaError::Identity)?;
    ensure(process.executable == policy.takeover_cli() && process.uid == policy.uid)?;
    let identity = inspect_legacy_executable(&process.executable, &process.identity)?;
    job.stop_pinned(trust, &process.identity, identity).await?;
    ensure(copy_user_job(&policy.service_label)?.is_none()
        && native::process_details(pid).map_err(|_| OtaError::Identity)?.is_none_or(|p| p.identity != process.identity))?;
    let source = policy.root.join("external/takeover-pacer-alt");
    ensure(policy.permits_path(&source))?;
    ensure(trust.verify_static(&source, CodeRole::Cli).is_err())?;
    let target = policy.takeover_cli();
    let backup = target.with_file_name("pacer.dismissed");
    ensure(!backup.exists())?;
    std::fs::rename(&target, &backup).map_err(|_| OtaError::Io)?;
    std::fs::copy(&source, &target).map_err(|_| OtaError::Io)?;
    ensure(trust.verify_static(&target, CodeRole::Cli) == Err(OtaError::Identity))?;
    job.change(trust, JobChange::Bootstrap).await?;
    fixture_jobs(trust, false).await
}

/// An update or adoption transaction's recovery job: its own helper copy, one
/// recovery mode and the exact installation/transaction directory it serves.
fn recovery_arguments_valid(arguments: &[String], home: &Path) -> bool {
    let valid_tx = |tx: &str| {
        !tx.is_empty()
            && tx.len() <= 128
            && tx
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || matches!(v, b'-' | b'_'))
    };
    // A takeover transaction has no installation ID; its helper copy lives in
    // the takeover journal directory.
    if let [program, mode, tx] = arguments {
        return mode == "--ota-recover-takeover"
            && valid_tx(tx)
            && Path::new(program)
                == home
                    .join("desktop-updates/native/takeover")
                    .join(tx)
                    .join("pacer-update-helper");
    }
    let [program, mode, id, tx] = arguments else {
        return false;
    };
    matches!(mode.as_str(), "--ota-recover" | "--ota-recover-adoption")
        && id.len() == 64
        && id
            .bytes()
            .all(|v| v.is_ascii_hexdigit() && !v.is_ascii_uppercase())
        && valid_tx(tx)
        && Path::new(program)
            == home
                .join("desktop-updates/native")
                .join(id)
                .join(tx)
                .join("pacer-update-helper")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_job_accepts_update_and_adoption_modes_for_its_own_transaction_only() {
        let home = Path::new("/fixture/home");
        let id = "a".repeat(64);
        let helper = format!("/fixture/home/desktop-updates/native/{id}/tx-1/pacer-update-helper");
        let args = |mode: &str, program: &str| {
            vec![program.to_string(), mode.to_string(), id.clone(), "tx-1".to_string()]
        };
        assert!(recovery_arguments_valid(&args("--ota-recover", &helper), home));
        assert!(recovery_arguments_valid(&args("--ota-recover-adoption", &helper), home));
        assert!(!recovery_arguments_valid(&args("--ota-pipe", &helper), home));
        assert!(!recovery_arguments_valid(&args("--ota-recover", "/tmp/pacer-update-helper"), home));
        let mut extra = args("--ota-recover", &helper);
        extra.push("more".into());
        assert!(!recovery_arguments_valid(&extra, home));
    }
    #[test]
    fn recovery_job_accepts_takeover_mode_for_its_own_transaction_only() {
        let home = Path::new("/fixture/home");
        let helper = "/fixture/home/desktop-updates/native/takeover/tx-1/pacer-update-helper";
        let args = |mode: &str, program: &str, tx: &str| vec![program.to_string(), mode.to_string(), tx.to_string()];
        assert!(recovery_arguments_valid(&args("--ota-recover-takeover", helper, "tx-1"), home));
        assert!(!recovery_arguments_valid(&args("--ota-recover-takeover", helper, "tx-2"), home));
        assert!(!recovery_arguments_valid(&args("--ota-recover", helper, "tx-1"), home));
        assert!(!recovery_arguments_valid(&args("--ota-recover-takeover", "/tmp/pacer-update-helper", "tx-1"), home));
        assert!(!recovery_arguments_valid(&args("--ota-recover-takeover", "/fixture/home/desktop-updates/native/takeover/../tx-1/pacer-update-helper", "../tx-1"), home));
    }
    #[test]
    fn diagnostic_binary_requires_private_executable_not_data_file_mode() {
        use std::os::unix::fs::{PermissionsExt,symlink};
        let dir=std::env::temp_dir().join(format!("pacer-diagnostic-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir(&dir).unwrap();let dir=dir.canonicalize().unwrap();std::fs::set_permissions(&dir,std::fs::Permissions::from_mode(0o700)).unwrap();
        let path=dir.join("pacer");std::fs::write(&path,b"fixed executable").unwrap();std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(diagnostic_digest(&path).unwrap(),digest(b"fixed executable"));
        let link=dir.join("redirect");symlink(&path,&link).unwrap();assert!(diagnostic_digest(&link).is_err());
        std::fs::hard_link(&path,dir.join("hardlink")).unwrap();assert!(diagnostic_digest(&path).is_err());std::fs::remove_file(dir.join("hardlink")).unwrap();
        std::fs::set_permissions(&path,std::fs::Permissions::from_mode(0o755)).unwrap();assert!(diagnostic_digest(&path).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
    #[test]
    fn startup_cleanup_requires_never_ready_recorded_lifecycle() {
        let identity=|pid| serde_json::json!({"pid":pid,"birth":format!("birth-{pid}"),"bootId":"boot"});
        let valid=serde_json::json!({"exercise":null,"runtime":{"schema":1,"state":"starting","request":null,"driver":identity(11),"sourceService":identity(12),"desktop":identity(13)}});
        assert_eq!(startup_identities(&valid).unwrap().len(),3);
        for field in ["request","state","desktop"] {
            let mut bad=valid.clone();bad["runtime"][field]=serde_json::json!("changed");
            assert!(startup_identities(&bad).is_err());
        }
        let mut bad=valid.clone();bad["exercise"]=serde_json::json!({});assert!(startup_identities(&bad).is_err());
        let mut bad=valid.clone();bad["runtime"]["extra"]=true.into();assert!(startup_identities(&bad).is_err());
    }
    #[test]
    fn inspection_requires_exact_immutable_ledger_registration() {
        let path = Path::new("/tmp/fixture/registrations/fixed.plist");
        let bytes = b"exact registration";
        let mut record = serde_json::json!({"registrations":[{"label":"fixed","path":path,"state":"intent","sha256":digest(bytes),"processes":[]}]});
        assert_eq!(
            registration(&record, "fixed", path, Some(bytes)).unwrap()["state"],
            "intent"
        );
        assert!(registration(&record, "other", path, Some(bytes)).is_err());
        assert!(registration(&record, "fixed", Path::new("/tmp/other"), Some(bytes)).is_err());
        assert!(registration(&record, "fixed", path, Some(b"changed")).is_err());
        assert!(registration(&record, "fixed", path, None).is_err());
        record["registrations"][0]["state"] = "reserved".into();
        record["registrations"][0]["sha256"] = serde_json::Value::Null;
        assert!(registration(&record, "fixed", path, None).is_ok());
        assert!(registration(&record, "fixed", path, Some(bytes)).is_err());
        record["registrations"][0]["state"] = "unknown".into();
        assert!(registration(&record, "fixed", path, None).is_err());
    }
}
