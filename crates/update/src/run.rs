//! The shared update job: `runUpdate` in `src/update/update.ts`.
//!
//! This is the pure, blocking core. It reads the release feed over [`download`],
//! verifies every asset against `manifest.json` and `SHA256SUMS`, replaces the binary
//! pair through [`replace`], and reports each step to an [`UpdateHost`]. Side effects
//! that belong to caller (integration refresh, strategy migration, service restart,
//! the setup-health stamp) are the host's responsibility, so the CLI and the native
//! front door can supply their own implementations.
use crate::{
    check::compare_versions,
    download::{self, RELEASE_TIMEOUT},
    feed::{self, Channel},
    manager,
    manifest::{self, Platform},
    replace::{self, Staging},
};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

/// The options `pacer update` accepts (`UpdateOptions` in TypeScript).
#[derive(Default)]
pub struct UpdateOptions {
    pub check: bool,
    pub to: Option<String>,
    pub base: Option<String>,
    pub no_restart: bool,
    pub no_reinstall: bool,
}

/// The five steps shared by the CLI's progress display and the native job.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Download,
    Verify,
    Replace,
    RefreshIntegrations,
    Restart,
}

impl Step {
    pub fn name(self) -> &'static str {
        match self {
            Step::Download => "Download",
            Step::Verify => "Verify",
            Step::Replace => "Replace",
            Step::RefreshIntegrations => "Refresh integrations",
            Step::Restart => "Restart",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepState {
    Running,
    Passed,
    Skipped,
}

impl StepState {
    pub fn as_str(self) -> &'static str {
        match self {
            StepState::Running => "running",
            StepState::Passed => "passed",
            StepState::Skipped => "skipped",
        }
    }
}

/// Everything `run_update` needs from its caller, independent of the process.
pub struct UpdateInputs {
    pub env: HashMap<String, String>,
    pub pacer_home: PathBuf,
    pub exec_path: PathBuf,
    pub standalone: bool,
    pub version: String,
    pub platform: Option<Platform>,
    pub nightly: bool,
}

/// Side effects the update job does not own.
pub trait UpdateHost: Send {
    fn progress(&mut self, step: Step, state: StepState, detail: Option<&str>);
    fn refresh_integrations(&mut self, binary: &Path) -> Vec<String>;
    fn migrate_strategy(&mut self) -> Vec<String>;
    fn restart_service(&mut self, binary: &Path, target: &str) -> Result<RestartOutcome, String>;
    fn staging(&self) -> &dyn Staging;
}

/// What a service restart reports back to the update job.
#[derive(Default)]
pub struct RestartOutcome {
    pub restarted: bool,
    pub summary: Option<String>,
    pub warning: Option<String>,
}

/// The TypeScript `Result` shape: `err` always carries the `pacer update: ` prefix.
pub struct UpdateResult {
    pub code: i32,
    pub out: String,
    pub err: String,
}

/// `ctx.env.PACER_BIN || process.execPath`, the binary the update replaces.
pub fn exec_path(env: &HashMap<String, String>) -> PathBuf {
    env.get("PACER_BIN")
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_exe().unwrap_or_default())
}

/// `true` unless a source core is configured (`PACER_CORE_ARGV`), mirroring
/// `Bun.isStandaloneExecutable` of the Core the front door runs.
pub fn standalone(env: &HashMap<String, String>) -> bool {
    !env.contains_key("PACER_CORE_ARGV")
}

/// `pacer update --channel` from the installation's strategy, as `src/update/channel.ts`.
pub fn channel(env: &HashMap<String, String>, pacer_home: &Path) -> bool {
    if let Some(text) = env.get("PACER_UPDATE_CHANNEL") {
        return text == "nightly";
    }
    fs::read_to_string(pacer_home.join("strategy.yaml")).is_ok_and(|text| {
        text.lines()
            .any(|line| line.trim_start().starts_with("update_channel: nightly"))
    })
}

/// A host that performs no side effects, used by `update.apply`'s preflight.
pub struct NoopHost;

struct NoopStaging;
impl Staging for NoopStaging {
    fn smoke(&self, _: &Path) -> String {
        String::new()
    }
    fn sign(&self, _: &Path) {}
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        fs::rename(from, to)
    }
}

impl UpdateHost for NoopHost {
    fn progress(&mut self, _: Step, _: StepState, _: Option<&str>) {}
    fn refresh_integrations(&mut self, _: &Path) -> Vec<String> {
        Vec::new()
    }
    fn migrate_strategy(&mut self) -> Vec<String> {
        Vec::new()
    }
    fn restart_service(&mut self, _: &Path, _: &str) -> Result<RestartOutcome, String> {
        Ok(RestartOutcome {
            restarted: false,
            summary: None,
            warning: None,
        })
    }
    fn staging(&self) -> &dyn Staging {
        &NoopStaging
    }
}

/// A failure with the TypeScript error code (`2` before the feed, `1` inside it).
fn fail(code: i32, message: impl Into<String>) -> UpdateResult {
    UpdateResult {
        code,
        out: String::new(),
        err: format!("pacer update: {}", message.into()),
    }
}

fn ok(out: String) -> UpdateResult {
    UpdateResult {
        code: 0,
        out,
        err: String::new(),
    }
}

/// `JSON.parse` with the JavaScriptCore error wording the TypeScript client stores.
fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|_| {
        let rest = text.trim_start_matches([' ', '\t', '\n', '\r']);
        match rest.chars().next() {
            None => "JSON Parse error: Unexpected EOF".into(),
            Some(c) if !"{[\"-0123456789tfn".contains(c) => {
                format!("JSON Parse error: Unrecognized token '{c}'")
            }
            Some(_) => "JSON Parse error: Unable to parse JSON string".into(),
        }
    })
}

fn platform_name(p: Option<Platform>) -> &'static str {
    p.map_or("unknown", |p| {
        if p.os == "darwin" && p.arch == "arm64" {
            "darwin-arm64"
        } else if p.os == "darwin" {
            "darwin-x64"
        } else if p.arch == "arm64" {
            "linux-arm64"
        } else {
            "linux-x64"
        }
    })
}

fn migration_lines(host: &mut dyn UpdateHost, check: bool) -> String {
    if check {
        return String::new();
    }
    let lines = host.migrate_strategy();
    if lines.is_empty() {
        String::new()
    } else {
        format!("\n{}", lines.join("\n"))
    }
}

/// Run one update (or `--check`) to completion. Call this from `spawn_blocking`.
pub fn run_update(
    o: &UpdateOptions,
    inputs: &UpdateInputs,
    host: &mut dyn UpdateHost,
) -> UpdateResult {
    let manager_hint = manager::install_manager(&inputs.env, &inputs.exec_path, inputs.nightly)
        .map(|manager| manager.message);
    if manager_hint.is_some() && !o.check {
        return fail(2, manager_hint.unwrap());
    }
    let checked = |out: String| -> String {
        match &manager_hint {
            Some(hint) => format!("{out}\n{hint}"),
            None => out,
        }
    };

    let raw = o
        .base
        .as_deref()
        .or_else(|| inputs.env.get("PACER_RELEASE_BASE").map(String::as_str));
    let base = match raw.map(feed::normalize_base).transpose() {
        Ok(base) => base,
        Err(error) => return fail(2, error),
    };

    if !o.check && !inputs.standalone {
        return fail(
            2,
            "this pacer runs from source (bun src/cli.ts), not from an installed binary, so there is nothing to replace. Update the checkout instead (git pull, then bun run build), or install a release with install.sh",
        );
    }
    let Some(platform) = inputs.platform else {
        return fail(
            2,
            "this OS/CPU is not supported (release builds exist for darwin and linux on arm64 and x64)",
        );
    };

    let deadline = Instant::now() + RELEASE_TIMEOUT;
    let mut feed_warning = String::new();
    let outcome = (|| -> Result<String, (i32, String)> {
        if !o.check {
            host.progress(Step::Download, StepState::Running, None);
        }
        let target = match &o.to {
            Some(to) => to.clone(),
            None => {
                let channel = if inputs.nightly {
                    Channel::Nightly
                } else {
                    Channel::Stable
                };
                match feed::latest_for(base.as_deref(), channel) {
                    Ok((latest, error)) => {
                        if let Some(error) = error {
                            feed_warning = format!("\nWARNING: {error}");
                        }
                        latest
                    }
                    Err(error) => {
                        // A JSON parse failure is a `SyntaxError` in TypeScript, which
                        // `runUpdate` reports under the release-metadata envelope.
                        return Err((
                            1,
                            if error.starts_with("JSON Parse error") {
                                format!("release metadata is not valid JSON ({error})")
                            } else {
                                error
                            },
                        ));
                    }
                }
            }
        };
        let cmp = compare_versions(&target, &inputs.version);
        if !o.check && o.to.is_none() && cmp <= 0 {
            host.progress(Step::Download, StepState::Passed, None);
            for step in [
                Step::Verify,
                Step::Replace,
                Step::RefreshIntegrations,
                Step::Restart,
            ] {
                host.progress(step, StepState::Skipped, Some("Already up to date"));
            }
        }
        if o.to.is_none() && cmp <= 0 {
            let out = if cmp == 0 {
                format!("pacer {} is up to date", inputs.version)
            } else {
                format!(
                    "pacer {} is up to date (latest release: {})",
                    inputs.version, target
                )
            };
            return Ok(out + &migration_lines(host, o.check));
        }
        if o.check && o.to.is_some() && cmp == 0 {
            return Ok(format!("pacer {} is already installed", inputs.version));
        }

        let raw = download::fetch_text(
            &manifest::release_url(base.as_deref(), &target, "manifest.json"),
            deadline,
        )
        .map_err(|error| (1, error))?;
        let value = parse_json(&raw)
            .map_err(|error| (1, format!("release metadata is not valid JSON ({error})")))?;
        let manifest = manifest::parse_manifest(&value).map_err(|e| (1, e.0))?;
        if manifest.version != target {
            return Err((
                1,
                format!("manifest.json is for {}, not {}", manifest.version, target),
            ));
        }
        let Some(asset) = manifest
            .assets
            .iter()
            .find(|a| a.os == platform.os && a.arch == platform.arch)
        else {
            return Err((
                1,
                format!(
                    "release {target} has no build for {}",
                    platform_name(Some(platform))
                ),
            ));
        };
        if o.check {
            let out = if cmp > 0 {
                let run = if manager_hint.is_none() {
                    if o.to.is_some() {
                        format!("\nrun: pacer update --to {target}")
                    } else {
                        "\nrun: pacer update".into()
                    }
                } else {
                    String::new()
                };
                format!("update available: {} -> {}{}", inputs.version, target, run)
            } else {
                let run = if manager_hint.is_none() {
                    format!("; run pacer update --to {target} to downgrade")
                } else {
                    String::new()
                };
                format!(
                    "{target} is older than the installed {}{}",
                    inputs.version, run
                )
            };
            return Ok(out);
        }

        let sums = manifest::parse_sha256_sums(
            &download::fetch_text(
                &manifest::release_url(base.as_deref(), &target, "SHA256SUMS"),
                deadline,
            )
            .map_err(|error| (1, error))?,
        )
        .map_err(|e| (1, e.0))?;
        let real_target = fs::canonicalize(&inputs.exec_path).map_err(|error| {
            (
                1,
                format!(
                    "cannot find the running binary at {}: {error}",
                    inputs.exec_path.display()
                ),
            )
        })?;
        let install_dir = real_target
            .parent()
            .ok_or_else(|| (1, "executable has no parent".to_owned()))?;

        let companions: Vec<(PathBuf, &manifest::Companion)> = asset
            .companions
            .as_ref()
            .map(|list| {
                list.iter()
                    .map(|c| (install_dir.join(&c.name), c))
                    .collect()
            })
            .unwrap_or_default();
        let mut front_bytes = Vec::new();
        let mut pair: Vec<replace::PairEntry> = Vec::new();
        let items = std::iter::once((&asset.file, &asset.sha256, asset.size, String::new())).chain(
            companions.iter().map(|(path, c)| {
                (
                    &c.file,
                    &c.sha256,
                    c.size,
                    path.to_string_lossy().into_owned(),
                )
            }),
        );
        for (file, sha256, size, install_as) in items {
            let recorded = sums.get(file).map(String::as_str);
            if recorded != Some(sha256.as_str()) {
                return Err((
                    1,
                    format!(
                        "SHA256SUMS and manifest.json disagree about {file}; refusing to install"
                    ),
                ));
            }
            let bytes = download::fetch_bytes(
                &manifest::release_url(base.as_deref(), &target, file),
                size,
                deadline,
            )
            .map_err(|error| (1, error))?;
            let got = manifest::sha256_hex(&bytes);
            if got != *sha256 || bytes.len() as u64 != size {
                return Err((
                    1,
                    format!(
                        "checksum mismatch for {file} (expected {sha256}, got {got}); nothing was changed"
                    ),
                ));
            }
            if install_as.is_empty() {
                front_bytes = bytes;
            } else {
                pair.push(replace::PairEntry {
                    target: PathBuf::from(install_as),
                    bytes,
                });
            }
        }

        host.progress(Step::Download, StepState::Passed, None);
        host.progress(Step::Verify, StepState::Running, None);
        host.progress(Step::Verify, StepState::Passed, None);
        host.progress(Step::Replace, StepState::Running, None);
        let result = if pair.is_empty() {
            replace::replace_binary(&real_target, &front_bytes, &target, host.staging())
                .map_err(|e| (1, e.0))?
        } else {
            replace::replace_pair(&real_target, &front_bytes, &pair, &target, host.staging())
                .map_err(|e| (1, e.0))?
                .0
        };
        host.progress(Step::Replace, StepState::Passed, None);

        host.progress(Step::RefreshIntegrations, StepState::Running, None);
        let mut refresh_note = String::new();
        if !o.no_reinstall {
            let lines = host.refresh_integrations(&result.path);
            if !lines.is_empty() {
                refresh_note = format!("\n{}", lines.join("\n"));
            }
            host.progress(Step::RefreshIntegrations, StepState::Passed, None);
        } else {
            host.progress(Step::RefreshIntegrations, StepState::Skipped, None);
        }
        refresh_note.push_str(&migration_lines(host, o.check));

        host.progress(
            Step::Restart,
            if o.no_restart {
                StepState::Skipped
            } else {
                StepState::Running
            },
            Some(&target),
        );
        let mut service_note = String::new();
        if !o.no_restart {
            match host.restart_service(&result.path, &target) {
                Ok(outcome) => {
                    if !outcome.restarted {
                        host.progress(
                            Step::Restart,
                            StepState::Skipped,
                            Some("Service was not restarted"),
                        );
                    }
                    if outcome.restarted {
                        service_note.push_str("\nrestarted pacer serve");
                    }
                    if let Some(summary) = outcome.summary {
                        service_note.push_str(&format!("\n{summary}"));
                    }
                    if let Some(warning) = outcome.warning {
                        service_note.push_str(&format!("\nWARNING: {warning}"));
                    }
                }
                Err(error) => {
                    host.progress(Step::Restart, StepState::Skipped, Some(&error));
                    service_note = format!("\nWARNING: could not restart pacer serve: {error}");
                }
            }
        }

        Ok(format!(
            "updated pacer {} -> {}\nbinary: {}\nprevious binary: {}{}{}",
            inputs.version,
            target,
            result.path.display(),
            result.backup.display(),
            refresh_note,
            service_note,
        ))
    })();

    match outcome {
        Ok(out) => ok(checked(out + &feed_warning)),
        Err((code, message)) => fail(code, message),
    }
}
