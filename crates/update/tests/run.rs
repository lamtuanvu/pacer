//! Transcribed cases from `test/update-run.test.ts` for the native `run_update`.
//! The release feed is served from `file://` (and once over loopback HTTP), with an
//! installed shell script standing in for the running pacer pair.
use pacer_update::{
    manifest::{Platform, sha256_hex},
    replace::System,
    run::{RestartOutcome, Step, StepState, UpdateHost, UpdateInputs, UpdateOptions, run_update},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::TcpListener,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    thread::{self, JoinHandle},
};
use tempfile::tempdir;

const MAC: Platform = Platform {
    os: "darwin",
    arch: "arm64",
};
const LINUX: Platform = Platform {
    os: "linux",
    arch: "x64",
};
const NIGHTLY: &str = "0.3.0-nightly.202611170000";
fn script(v: &str) -> String {
    format!("#!/bin/sh\necho \"pacer {v}\"\n")
}

struct Feed {
    root: PathBuf,
}

fn feed() -> Feed {
    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    std::mem::forget(dir);
    Feed { root }
}

impl Feed {
    fn base(&self) -> String {
        format!("file://{}", self.root.display())
    }

    fn release(&self, version: &str, body: &str) -> PathBuf {
        let dir = self.root.join(version);
        fs::create_dir_all(&dir).unwrap();
        let asset = "pacer-darwin-arm64".to_owned();
        fs::write(dir.join(&asset), body).unwrap();
        let manifest = json!({"version": version, "assets": [{
            "os": "darwin", "arch": "arm64", "file": asset,
            "sha256": sha256_hex(body.as_bytes()), "size": body.len()
        }]});
        fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
        fs::write(
            dir.join("SHA256SUMS"),
            format!("{}  pacer-darwin-arm64\n", sha256_hex(body.as_bytes())),
        )
        .unwrap();
        fs::write(
            self.root.join("latest.json"),
            json!({"version": version}).to_string(),
        )
        .unwrap();
        dir
    }

    /// Add a verified companion to an existing release.
    fn pair(&self, version: &str, core_body: &str) {
        let dir = self.root.join(version);
        let file = "pacer-core-darwin-arm64";
        fs::write(dir.join(file), core_body).unwrap();
        let path = dir.join("manifest.json");
        let mut manifest: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        manifest["assets"][0]["companions"] = json!([{
            "name": "pacer-core", "file": file,
            "sha256": sha256_hex(core_body.as_bytes()), "size": core_body.len()
        }]);
        fs::write(&path, manifest.to_string()).unwrap();
        let sums = dir.join("SHA256SUMS");
        let mut text = fs::read_to_string(&sums).unwrap();
        text.push_str(&format!("{}  {file}\n", sha256_hex(core_body.as_bytes())));
        fs::write(&sums, text).unwrap();
    }

    /// Replace a release's asset bytes without touching the recorded hashes.
    fn tamper(&self, version: &str, content: &str) {
        fs::write(self.root.join(version).join("pacer-darwin-arm64"), content).unwrap();
    }

    /// Corrupt a verified companion so its checksum fails before either install.
    fn tamper_companion(&self, version: &str, content: &str) {
        fs::write(
            self.root.join(version).join("pacer-core-darwin-arm64"),
            content,
        )
        .unwrap();
    }
}

struct Install {
    dir: PathBuf,
    exec: PathBuf,
}

fn install(version: &str) -> Install {
    let dir = tempdir().unwrap();
    let root = dir.path().to_path_buf();
    let exec = root.join("pacer");
    fs::write(&exec, script(version)).unwrap();
    fs::set_permissions(&exec, fs::Permissions::from_mode(0o755)).unwrap();
    std::mem::forget(dir);
    Install { dir: root, exec }
}

impl Install {
    fn bytes(&self, suffix: &str) -> String {
        fs::read_to_string(self.dir.join(format!("pacer{suffix}"))).unwrap_or_default()
    }
    fn paths(&self) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(&self.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }
}

#[derive(Default)]
struct Host {
    events: Vec<(Step, StepState, Option<String>)>,
    refresh: Vec<String>,
    migrate: Vec<String>,
    restart: RestartOutcome,
    restart_error: Option<String>,
    restarts: usize,
    refreshes: usize,
}

impl UpdateHost for Host {
    fn progress(&mut self, step: Step, state: StepState, detail: Option<&str>) {
        self.events.push((step, state, detail.map(str::to_owned)));
    }
    fn refresh_integrations(&mut self, _: &Path) -> Vec<String> {
        self.refreshes += 1;
        self.refresh.clone()
    }
    fn migrate_strategy(&mut self) -> Vec<String> {
        self.migrate.clone()
    }
    fn restart_service(&mut self, _: &Path, _: &str) -> Result<RestartOutcome, String> {
        self.restarts += 1;
        match &self.restart_error {
            Some(error) => Err(error.clone()),
            None => Ok(RestartOutcome {
                restarted: self.restart.restarted,
                summary: self.restart.summary.clone(),
                warning: self.restart.warning.clone(),
            }),
        }
    }
    fn staging(&self) -> &dyn pacer_update::replace::Staging {
        &System
    }
}

fn inputs(base: &str, install: &Install) -> UpdateInputs {
    inputs_with(
        base,
        install,
        true,
        "0.1.0",
        Some(MAC),
        false,
        HashMap::new(),
    )
}

#[allow(clippy::too_many_arguments)]
fn inputs_with(
    base: &str,
    install: &Install,
    standalone: bool,
    version: &str,
    platform: Option<Platform>,
    nightly: bool,
    extra: HashMap<String, String>,
) -> UpdateInputs {
    let mut env = HashMap::from([("PACER_RELEASE_BASE".to_owned(), base.to_owned())]);
    env.extend(extra);
    UpdateInputs {
        env,
        pacer_home: install.dir.join(".pacer"),
        exec_path: install.exec.clone(),
        standalone,
        version: version.to_owned(),
        platform,
        nightly,
    }
}

fn run(
    o: &UpdateOptions,
    inputs: &UpdateInputs,
    host: &mut Host,
) -> pacer_update::run::UpdateResult {
    run_update(o, inputs, host)
}

/// A loopback HTTP server serving a release root, for the transport parity case.
fn serve(root: PathBuf) -> (String, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut stream = stream;
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let request = String::from_utf8_lossy(&buf[..n]);
            let path = request.split_whitespace().nth(1).unwrap_or("/");
            let file = root.join(path.trim_start_matches('/'));
            match fs::read(&file) {
                Ok(bytes) => {
                    write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        bytes.len()
                    )
                    .unwrap();
                    stream.write_all(&bytes).unwrap();
                }
                Err(_) => {
                    write!(
                        stream,
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                }
            }
        }
    });
    (format!("http://{addr}"), handle)
}

#[test]
fn check_reports_an_available_update_and_changes_nothing() {
    let f = feed();
    f.release("0.1.0", &script("0.1.0"));
    f.release("0.2.0", &script("0.2.0"));
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions {
            check: true,
            ..Default::default()
        },
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 0);
    assert_eq!(r.out, "update available: 0.1.0 -> 0.2.0\nrun: pacer update");
    assert_eq!(r.err, "");
    assert_eq!(i.bytes(""), script("0.1.0"));
    assert!(!i.dir.join("pacer.bak").exists());
}

#[test]
fn already_latest_downloads_nothing() {
    let f = feed();
    f.release("0.1.0", &script("0.1.0"));
    let i = install("0.0.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!((r.code, r.out.as_str()), (0, "pacer 0.1.0 is up to date"));
    let r = run(
        &UpdateOptions {
            check: true,
            ..Default::default()
        },
        &inputs_with(
            &f.base(),
            &i,
            true,
            "0.3.0",
            Some(MAC),
            false,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(r.out, "pacer 0.3.0 is up to date (latest release: 0.1.0)");
    assert_eq!(i.paths(), vec!["pacer"]);
}

#[test]
fn dev_builds_never_offer_equal_or_older() {
    let f = feed();
    let i = install("0.1.0");
    for latest in ["0.2.2", "0.2.3"] {
        fs::write(
            f.root.join("latest.json"),
            json!({"version": latest}).to_string(),
        )
        .unwrap();
        for check in [true, false] {
            let r = run(
                &UpdateOptions {
                    check,
                    ..Default::default()
                },
                &inputs_with(
                    &f.base(),
                    &i,
                    true,
                    "0.2.3+12.gabc1234",
                    Some(MAC),
                    false,
                    HashMap::new(),
                ),
                &mut Host::default(),
            );
            assert_eq!(r.code, 0);
            assert!(r.out.contains("is up to date"));
            assert!(!r.out.contains("update available"));
            assert_eq!(i.paths(), vec!["pacer"]);
        }
    }
}

#[test]
fn update_replaces_keeps_bak_no_temp_files() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!((r.code, r.err.as_str()), (0, ""));
    assert!(r.out.contains("updated pacer 0.1.0 -> 0.2.0"));
    assert!(r.out.contains("previous binary: "));
    assert_eq!(i.bytes(""), script("0.2.0"));
    assert_eq!(i.bytes(".bak"), script("0.1.0"));
    assert_eq!(i.paths(), vec!["pacer", "pacer.bak"]);
}

#[test]
fn loopback_http_and_base_override() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    let (base, server) = serve(f.root.clone());
    let i = install("0.1.0");
    let mut env = HashMap::new();
    env.insert(
        "PACER_RELEASE_BASE".to_owned(),
        "file:///nonexistent/release".to_owned(),
    );
    let r = run(
        &UpdateOptions {
            base: Some(base),
            ..Default::default()
        },
        &inputs_with(&f.base(), &i, true, "0.1.0", Some(MAC), false, env),
        &mut Host::default(),
    );
    assert_eq!(r.code, 0, "{}", r.err);
    assert_eq!(i.bytes(""), script("0.2.0"));
    drop(server);
}

#[test]
fn to_installs_a_specific_version_including_downgrade() {
    let f = feed();
    f.release("0.1.0", &script("0.1.0"));
    f.release("0.2.0", &script("0.2.0"));
    let i = install("0.2.0");
    let r = run(
        &UpdateOptions {
            to: Some("0.1.0".into()),
            ..Default::default()
        },
        &inputs_with(
            &f.base(),
            &i,
            true,
            "0.2.0",
            Some(MAC),
            false,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(r.code, 0, "{}", r.err);
    assert!(r.out.contains("updated pacer 0.2.0 -> 0.1.0"));
    assert_eq!(i.bytes(""), script("0.1.0"));

    let r = run(
        &UpdateOptions {
            to: Some("9.9.9".into()),
            ..Default::default()
        },
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert!(r.err.contains("9.9.9/manifest.json"), "{}", r.err);
}

#[test]
fn tampered_download_refused() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    f.tamper("0.2.0", &format!("{}# evil\n", script("0.2.0")));
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert!(r.err.contains("exceeds "), "{}", r.err);
    assert_eq!(i.bytes(""), script("0.1.0"));
    assert_eq!(i.paths(), vec!["pacer"]);
}

#[test]
fn same_length_tamper_fails_checksum() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    f.tamper("0.2.0", &script("0.2.1"));
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert!(r.err.contains("checksum mismatch"), "{}", r.err);
    assert_eq!(i.bytes(""), script("0.1.0"));
    assert_eq!(i.paths(), vec!["pacer"]);
}

#[test]
fn sums_disagree_with_manifest_refused() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    fs::write(
        f.root.join("0.2.0/SHA256SUMS"),
        format!("{}  pacer-darwin-arm64\n", "0".repeat(64)),
    )
    .unwrap();
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert!(
        r.err
            .contains("SHA256SUMS and manifest.json disagree about pacer-darwin-arm64"),
        "{}",
        r.err
    );
    assert_eq!(i.bytes(""), script("0.1.0"));
}

#[test]
fn binary_that_does_not_run_refused() {
    let f = feed();
    f.release("0.2.0", "#!/bin/sh\nexit 1\n");
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert!(r.err.contains("did not report version 0.2.0"), "{}", r.err);
    assert_eq!(i.bytes(""), script("0.1.0"));
    assert_eq!(i.paths(), vec!["pacer"]);
}

#[test]
fn refuses_from_source_but_check_works() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs_with(
            &f.base(),
            &i,
            false,
            "0.1.0",
            Some(MAC),
            false,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(r.code, 2);
    assert!(
        r.err.contains("runs from source (bun src/cli.ts)"),
        "{}",
        r.err
    );
    assert_eq!(i.bytes(""), script("0.1.0"));
    let r = run(
        &UpdateOptions {
            check: true,
            ..Default::default()
        },
        &inputs_with(
            &f.base(),
            &i,
            false,
            "0.1.0",
            Some(MAC),
            false,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert!(r.out.contains("update available: 0.1.0 -> 0.2.0"));
}

#[test]
fn insecure_explicit_base_refused() {
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions {
            base: Some("http://example.com/r".into()),
            ..Default::default()
        },
        &inputs(&i.dir.join("none").to_string_lossy(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 2);
    assert!(r.err.contains("must start with https://"), "{}", r.err);
}

#[test]
fn unsupported_platform_missing_build_bad_latest() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions::default(),
        &inputs_with(&f.base(), &i, true, "0.1.0", None, false, HashMap::new()),
        &mut Host::default(),
    );
    assert_eq!(r.code, 2);
    let r = run(
        &UpdateOptions::default(),
        &inputs_with(
            &f.base(),
            &i,
            true,
            "0.1.0",
            Some(LINUX),
            false,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert!(
        r.err.contains("release 0.2.0 has no build for linux-x64"),
        "{}",
        r.err
    );
    fs::write(
        f.root.join("latest.json"),
        json!({"version": "../../etc"}).to_string(),
    )
    .unwrap();
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert!(r.err.contains("latest.json has no valid"), "{}", r.err);
    fs::write(f.root.join("latest.json"), "{oops").unwrap();
    let r = run(
        &UpdateOptions::default(),
        &inputs(&f.base(), &i),
        &mut Host::default(),
    );
    assert!(r.err.contains("not valid JSON"), "{}", r.err);
}

#[test]
fn restarts_after_replacement_warns_on_failure_honors_no_restart() {
    for mode in ["success", "failure", "skip", "check", "not-installed"] {
        let f = feed();
        f.release("0.2.0", &script("0.2.0"));
        let i = install("0.1.0");
        let mut host = Host::default();
        host.restart.restarted = mode != "not-installed";
        if mode == "failure" {
            host.restart_error = Some("kickstart failed".into());
        }
        let r = run(
            &UpdateOptions {
                check: mode == "check",
                no_restart: mode == "skip",
                ..Default::default()
            },
            &inputs(&f.base(), &i),
            &mut host,
        );
        assert_eq!(r.code, 0, "{}", r.err);
        assert_eq!(
            host.restarts,
            if mode == "skip" || mode == "check" {
                0
            } else {
                1
            }
        );
        if mode == "success" {
            assert!(r.out.contains("restarted pacer serve"));
        }
        if mode == "failure" {
            assert!(
                r.out
                    .contains("WARNING: could not restart pacer serve: kickstart failed")
            );
        }
        if mode == "skip" || mode == "not-installed" {
            assert!(!r.out.contains("restarted pacer serve"));
        }
    }
}

#[test]
fn restart_report_and_warning() {
    for warning in [None, Some("could not restart pacer serve: unavailable")] {
        let f = feed();
        f.release("0.2.0", &script("0.2.0"));
        let i = install("0.1.0");
        let mut host = Host::default();
        host.restart.restarted = warning.is_none();
        host.restart.warning = warning.map(str::to_owned);
        let r = run(&UpdateOptions::default(), &inputs(&f.base(), &i), &mut host);
        assert_eq!(r.code, 0, "{}", r.err);
        assert!(!r.out.contains("pacer consoles"));
        if let Some(warning) = warning {
            assert!(r.out.contains(&format!("WARNING: {warning}")));
        } else {
            assert!(r.out.contains("restarted pacer serve"));
        }
    }
    let f = feed();
    f.release("0.13.1", &script("0.13.1"));
    let i = install("0.1.0");
    let mut host = Host::default();
    host.restart.restarted = true;
    host.restart.summary = Some(
        "Updated to v0.13.1. 1 task and 1 session kept running; 0 stayed on the previous runner."
            .into(),
    );
    let r = run(&UpdateOptions::default(), &inputs(&f.base(), &i), &mut host);
    assert!(r.out.contains("restarted pacer serve\nUpdated to v0.13.1. 1 task and 1 session kept running; 0 stayed on the previous runner."));
}

#[test]
fn refresh_only_after_replacement() {
    for mode in [
        "update",
        "check",
        "unchanged",
        "forced",
        "skip",
        "failure",
        "tampered",
    ] {
        let f = feed();
        let target = if mode == "unchanged" || mode == "forced" {
            "0.1.0"
        } else {
            "0.2.0"
        };
        f.release(target, &script(target));
        if mode == "tampered" {
            f.tamper(target, "bad download");
        }
        let i = install("0.1.0");
        let mut host = Host::default();
        host.refresh = vec![
            "claude-code: refreshed".into(),
            "codex: unchanged".into(),
            "WARNING: cursor: failed: bad config".into(),
        ];
        if mode == "failure" {
            host.refresh = vec!["WARNING: broken manifest".into()];
        }
        let r = run(
            &UpdateOptions {
                check: mode == "check",
                to: if mode == "forced" {
                    Some(target.into())
                } else {
                    None
                },
                no_reinstall: mode == "skip",
                no_restart: true,
                ..Default::default()
            },
            &inputs(&f.base(), &i),
            &mut host,
        );
        let refreshed = ["update", "forced", "failure"].contains(&mode);
        assert_eq!(host.refreshes, if refreshed { 1 } else { 0 }, "{mode}");
        assert_eq!(r.code, if mode == "tampered" { 1 } else { 0 }, "{mode}");
        if refreshed {
            if mode == "failure" {
                assert!(r.out.contains("WARNING: broken manifest"), "{}", r.out);
            } else {
                assert!(r
                    .out
                    .contains("claude-code: refreshed\ncodex: unchanged\nWARNING: cursor: failed: bad config"), "{}", r.out);
            }
        } else {
            assert!(!r.out.contains("refreshed"), "{mode}: {}", r.out);
        }
    }
}

#[test]
fn progress_follows_the_five_steps() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    let i = install("0.1.0");
    let mut host = Host::default();
    host.restart.restarted = true;
    let r = run(&UpdateOptions::default(), &inputs(&f.base(), &i), &mut host);
    assert_eq!(r.code, 0, "{}", r.err);
    let events: Vec<(Step, StepState, Option<&str>)> = host
        .events
        .iter()
        .map(|(s, st, d)| (*s, *st, d.as_deref()))
        .collect();
    assert_eq!(
        events,
        vec![
            (Step::Download, StepState::Running, None),
            (Step::Download, StepState::Passed, None),
            (Step::Verify, StepState::Running, None),
            (Step::Verify, StepState::Passed, None),
            (Step::Replace, StepState::Running, None),
            (Step::Replace, StepState::Passed, None),
            (Step::RefreshIntegrations, StepState::Running, None),
            (Step::RefreshIntegrations, StepState::Passed, None),
            (Step::Restart, StepState::Running, Some("0.2.0")),
        ]
    );
}

#[test]
fn companion_downloads_are_verified_before_either_install() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    f.pair("0.2.0", &script("0.2.0"));
    f.tamper_companion("0.2.0", "x");
    let i = install("0.1.0");
    let mut host = Host::default();
    let r = run(&UpdateOptions::default(), &inputs(&f.base(), &i), &mut host);
    assert_eq!(r.code, 1);
    assert!(
        r.err
            .starts_with("pacer update: checksum mismatch for pacer-core-"),
        "{}",
        r.err
    );
    assert_eq!(i.bytes(""), script("0.1.0"));
    assert!(!i.dir.join("pacer-core").exists());
    assert_eq!(host.refreshes, 0);
}

#[test]
fn companion_pair_installs_and_refreshes_once() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    f.pair("0.2.0", &script("0.2.0"));
    let i = install("0.1.0");
    fs::write(i.dir.join("pacer-core"), script("0.1.0")).unwrap();
    let mut host = Host::default();
    host.restart.restarted = true;
    let r = run(&UpdateOptions::default(), &inputs(&f.base(), &i), &mut host);
    assert_eq!(r.code, 0, "{}", r.err);
    assert_eq!(i.bytes(""), script("0.2.0"));
    assert_eq!(
        fs::read_to_string(i.dir.join("pacer-core")).unwrap(),
        script("0.2.0")
    );
    assert_eq!(host.refreshes, 1);
    assert_eq!(host.restarts, 1);
}

#[test]
fn nightly_installs_newest_nightly_and_to_pins_any_channel() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    f.release(NIGHTLY, &script(NIGHTLY));
    fs::write(
        f.root.join("latest.json"),
        json!({"version": "0.2.0"}).to_string(),
    )
    .unwrap();
    fs::write(
        f.root.join("cli-nightly.json"),
        json!({"version": NIGHTLY}).to_string(),
    )
    .unwrap();
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions {
            check: true,
            ..Default::default()
        },
        &inputs_with(
            &f.base(),
            &i,
            true,
            "0.1.0",
            Some(MAC),
            true,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(
        r.out,
        format!("update available: 0.1.0 -> {NIGHTLY}\nrun: pacer update")
    );
    let r = run(
        &UpdateOptions::default(),
        &inputs_with(
            &f.base(),
            &i,
            true,
            "0.1.0",
            Some(MAC),
            true,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(r.code, 0, "{}", r.err);
    assert!(
        r.out
            .starts_with(&format!("updated pacer 0.1.0 -> {NIGHTLY}"))
    );
    assert_eq!(i.bytes(""), script(NIGHTLY));

    let i2 = install("0.1.0");
    for nightly in [false, true] {
        let r = run(
            &UpdateOptions {
                to: Some("0.2.0".into()),
                ..Default::default()
            },
            &inputs_with(
                &f.base(),
                &i2,
                true,
                "0.1.0",
                Some(MAC),
                nightly,
                HashMap::new(),
            ),
            &mut Host::default(),
        );
        assert!(
            r.out.starts_with("updated pacer 0.1.0 -> 0.2.0"),
            "{}",
            r.err
        );
    }
}

#[test]
fn nightly_falls_back_to_stable_and_says_so() {
    let f = feed();
    f.release("0.2.0", &script("0.2.0"));
    f.release(NIGHTLY, &script(NIGHTLY));
    fs::write(
        f.root.join("latest.json"),
        json!({"version": "0.2.0"}).to_string(),
    )
    .unwrap();
    fs::write(f.root.join("cli-nightly.json"), "<html>").unwrap();
    let i = install("0.1.0");
    let r = run(
        &UpdateOptions {
            check: true,
            ..Default::default()
        },
        &inputs_with(
            &f.base(),
            &i,
            true,
            "0.1.0",
            Some(MAC),
            true,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(
        r.out,
        "update available: 0.1.0 -> 0.2.0\nrun: pacer update\nWARNING: JSON Parse error: Unrecognized token '<'"
    );
    fs::write(f.root.join("latest.json"), "<html>").unwrap();
    let r = run(
        &UpdateOptions {
            check: true,
            ..Default::default()
        },
        &inputs_with(
            &f.base(),
            &i,
            true,
            "0.1.0",
            Some(MAC),
            true,
            HashMap::new(),
        ),
        &mut Host::default(),
    );
    assert_eq!(r.code, 1);
    assert_eq!(
        r.err,
        "pacer update: release metadata is not valid JSON (JSON Parse error: Unrecognized token '<')"
    );
}
