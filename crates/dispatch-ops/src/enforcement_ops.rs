//! Native `dispatch.enforcement`, `dispatch.enforcement.probe` and
//! `dispatch.enforcement.denied` (`enforcementDiagnostics`,
//! `dispatch.enforcement.probe` and `dispatch.enforcement.denied` in
//! `src/api/ops.ts`).
//!
//! Rust owns the handlers and the reply bodies with Zod-order param parity and
//! TypeScript-identical results: the schedule-derived fields of
//! `enforcementDiagnostics` (porting `scheduleFor` / `scheduleReason` /
//! `decideProbe` / `attemptHold` / `isScheduledRunner` /
//! `isListedForRouting` from `src/dispatch/certification-schedule.ts`), the
//! canary-request plan of `dispatch.enforcement.probe`, and the store effects
//! of `dispatch.enforcement.denied` (`authorizeEnforcementToken`,
//! `appendWorkEvent`, `readTask`, `updateWorkDecision`).
//!
//! Only the truly TypeScript-only state crosses the sealed `dispatch-parts`
//! bridge: per runner the enforcement target resolution (`--version`, which
//! fills the in-process `checkedVersions`), the probe-support reason, the
//! certificate status for the requested and scheduled repositories (whose
//! fingerprint hashes `strictClaudeLaunch.toString()` compiled source), and the
//! enforcement key (`dispatch.enforcement-diagnostics`); for `denied` the
//! runner's exclusion reason (`dispatch.enforcement-exclusions`, `cached:
//! false`). `dispatch.enforcement` forwards when the repository or policy
//! needs Core; `dispatch.enforcement.probe` forwards the canary job to the
//! TypeScript core by answering `unavailable`.
//!
//! `dispatch.enforcement` reads with no caller gate (`enforcementDiagnostics`
//! has none). `denied` authorizes the `pet_` enforcement identity and runs
//! under it, so it never calls [`dispatch_ops::authorize`].
#![allow(clippy::result_large_err)]
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{AdmissionState, read_project_strategies};
use rusqlite::OptionalExtension;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::dispatch_ops::{finish, params_object, string_issues};
use crate::planning_ops::{now, read_schedule};
use crate::policy::{internal, policy_error, policy_repo, repo_needs_core};

type Object = Map<String, Value>;

/// Core's per-runner native-control reads for an enforcement request.
pub trait Bridge: Send {
    /// Dispatch parts (`src/api/dispatch-parts-bridge.ts`).
    fn parts(&mut self, params: Value) -> OpFuture<'_>;
}

pub fn needs_dispatch_parts(op: &str) -> bool {
    matches!(op, "dispatch.enforcement" | "dispatch.enforcement.denied")
}

const MAX_PROBES_PER_DAY: f64 = 2.0;
const MAX_COST_PCT: f64 = 2.0;
const BACKOFF_BASE_S: f64 = 900.0;
const BACKOFF_MAX_S: f64 = 86_400.0;
const MAX_REPO_SWITCHES: f64 = 3.0;
const DAY_S: f64 = 86_400.0;
/// `scheduleReason` passes a null headroom read; see `decideProbe`.
const HEADROOM_UNKNOWN: &str = "planner headroom is unknown";
const MAX_BYTES: usize = 256 * 1024;

fn unavailable(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

fn open(ctx: &Ctx) -> Result<AdmissionState, CoreError> {
    AdmissionState::open(&ctx.pacer_home).map_err(|error| internal(error.0))
}

/// `CertificateStatus` from `src/dispatch/enforcement.ts`.
struct Cert {
    state: String,
    reason: Option<String>,
    probed_at: Option<f64>,
    expires_at: Option<f64>,
}

impl Cert {
    fn of(value: &Value) -> Self {
        Cert {
            state: value
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .map(str::to_owned),
            probed_at: value.get("probedAt").and_then(Value::as_f64),
            expires_at: value.get("expiresAt").and_then(Value::as_f64),
        }
    }
}

/// A declining hold from an attempt record (`attemptHold`) or the whole
/// schedule reason (`scheduleReason`).
struct Hold {
    reason: String,
    paused: bool,
}

/// The scheduled repository Core resolves for `enforcementDiagnostics`.
struct Scheduled {
    path: Option<String>,
    label: Option<String>,
}

/// `s.pacing`, `s.runners`, ... with the shape `loadStrategy` returns.
struct StrategyRefs<'a> {
    pacing: &'a Value,
    runners: &'a Value,
    routing: &'a Value,
    planner: &'a Value,
}

impl<'a> StrategyRefs<'a> {
    fn of(strategy: &'a Value) -> Option<Self> {
        Some(Self {
            pacing: strategy.get("pacing")?,
            runners: strategy.get("runners")?,
            routing: strategy.get("routing")?,
            planner: strategy.get("planner")?,
        })
    }
    fn planner_probe(&self) -> &'a str {
        self.pacing
            .get("plannerProbe")
            .and_then(Value::as_str)
            .unwrap_or("off")
    }
    fn reserve_headroom(&self) -> f64 {
        self.pacing
            .get("plannerReserveHeadroom")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    }
}

/// `isPlannerRunner` in `src/config/runner-id.ts`: the local runner for one
/// exact agent/account pair. A configured runner always carries a `host` in the
/// loaded strategy JSON, so an absent `host` means the planner.
fn is_planner_runner(s: &StrategyRefs, runner: &Value) -> bool {
    runner.get("host").is_none()
        && runner.get("agent").and_then(Value::as_str)
            == s.planner.get("agent").and_then(Value::as_str)
        && runner.get("account").and_then(Value::as_str)
            == s.planner.get("account").and_then(Value::as_str)
}

/// `findPlannerRunner`: the planner's own runner id and account.
fn find_planner_runner(s: &StrategyRefs) -> Option<(String, String)> {
    if let Some(runners) = s.runners.as_object() {
        for (id, runner) in runners {
            if is_planner_runner(s, runner) {
                let account = runner
                    .get("account")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned();
                return Some((id.clone(), account));
            }
        }
    }
    None
}

/// `isScheduledRunner`: whether `runnerId` is the one runner `tick` probes.
fn is_scheduled_runner(s: &StrategyRefs, runner_id: &str) -> bool {
    find_planner_runner(s).is_some_and(|(id, _)| id == runner_id)
}

/// `isListedForRouting`: any routing rule references the runner.
fn is_listed_for_routing(s: &StrategyRefs, runner_id: &str) -> bool {
    s.routing.as_array().into_iter().flatten().any(|rule| {
        rule.get("executors")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|e| e.as_str() == Some(runner_id))
    })
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64)
}

/// `dayWindow` in `src/dispatch/certification-schedule.ts`.
fn day_window(record: &Value, now: f64) -> (f64, f64) {
    let day_started_at = as_f64(record.get("dayStartedAt")).unwrap_or(0.0);
    let probes_today = as_f64(record.get("probesToday")).unwrap_or(0.0);
    if now < day_started_at || now - day_started_at >= DAY_S {
        (now, 0.0)
    } else {
        (day_started_at, probes_today)
    }
}

/// The reason an attempt record spent its pause on, from the stored
/// `pauseCause` or the counters it carried before the cause was stored.
fn cause_of(record: &Value) -> Option<String> {
    let pause = record.get("pauseCause");
    if matches!(pause, Some(Value::String(s)) if s == "repo-switches") {
        return Some("repo-switches".into());
    }
    if matches!(pause, Some(Value::String(s)) if s == "cost") {
        return Some("cost".into());
    }
    let repo_switches = as_f64(record.get("repoSwitches")).unwrap_or(0.0);
    let last_cost_pct = as_f64(record.get("lastCostPct")).unwrap_or(0.0);
    if repo_switches >= MAX_REPO_SWITCHES {
        return Some("repo-switches".into());
    }
    if last_cost_pct > MAX_COST_PCT {
        return Some("cost".into());
    }
    None
}

/// `attemptHold`: the decline an attempt record alone imposes. `paused` marks a
/// wait that has stopped probing for the maximum period.
fn attempt_hold(record: Option<&Value>, now: f64) -> Option<Hold> {
    let empty = json!({});
    let record = record.unwrap_or(&empty);
    let next_eligible_at = as_f64(record.get("nextEligibleAt")).unwrap_or(0.0);
    if now < next_eligible_at {
        let failures = as_f64(record.get("failures")).unwrap_or(0.0);
        return match cause_of(record).as_deref() {
            Some("repo-switches") => Some(Hold {
                reason: "the certificate keeps being invalidated by switching repositories".into(),
                paused: true,
            }),
            Some("cost") => Some(Hold {
                reason: format!(
                    "the last probe cost {}% of the account window",
                    as_f64(record.get("lastCostPct")).unwrap_or(0.0)
                ),
                paused: true,
            }),
            _ => Some(Hold {
                reason: "waiting out the backoff from an earlier failed probe".into(),
                paused: failures > 0.0
                    && BACKOFF_BASE_S * 2f64.powf(failures - 1.0) >= BACKOFF_MAX_S,
            }),
        };
    }
    let (_, probes_today) = day_window(record, now);
    if probes_today >= MAX_PROBES_PER_DAY {
        return Some(Hold {
            reason: format!("already probed {probes_today} times today"),
            paused: false,
        });
    }
    None
}

struct ProbeInputs {
    key: String,
    account: String,
    runner: String,
    certificate_state: String,
    unsupported_reason: Option<String>,
    headroom_pct: Option<f64>,
    reserve_headroom_pct: f64,
    mode: String,
    planner_executes: bool,
    listed_for_routing: bool,
}

/// The consent value for `account`: `granted` or `declined`, or none.
fn consent_of(consent: &Object, account: &str) -> Option<&'static str> {
    match consent.get(account) {
        Some(Value::String(s)) if s == "granted" => Some("granted"),
        Some(Value::String(s)) if s == "declined" => Some("declined"),
        _ => None,
    }
}

/// `decideProbe` in `src/dispatch/certification-schedule.ts`. `probe` is the
/// empty reason.
fn decide_probe(inputs: &ProbeInputs, consent: &Object, attempts: &Value, now: f64) -> Hold {
    let no = |reason: String| Hold {
        reason,
        paused: false,
    };
    if !inputs.planner_executes {
        return no("planner execution is turned off".into());
    }
    if !inputs.listed_for_routing {
        return no(format!(
            "{} is not listed in a routing rule or project selection",
            inputs.runner
        ));
    }
    if inputs.mode == "off" {
        return no("certification probing is turned off".into());
    }
    if let Some(r) = inputs.unsupported_reason.as_deref() {
        return no(r.into());
    }
    if inputs.certificate_state == "certified" {
        return no("the certificate is current".into());
    }
    match consent_of(consent, &inputs.account) {
        Some("declined") => {
            return no(format!(
                "certification probing was declined for {}",
                inputs.account
            ));
        }
        None if inputs.mode == "ask" => {
            return no(format!(
                "certification probing needs your consent for {}",
                inputs.account
            ));
        }
        _ => {}
    }
    let record = attempts.as_object().and_then(|m| m.get(&inputs.key));
    if let Some(hold) = attempt_hold(record, now) {
        return no(hold.reason);
    }
    let headroom = inputs.headroom_pct;
    match headroom {
        None => no(HEADROOM_UNKNOWN.into()),
        Some(h) if h <= inputs.reserve_headroom_pct => no(format!(
            "planner reserve: {h}% headroom is at or below the {}% reserve",
            inputs.reserve_headroom_pct
        )),
        Some(_) => Hold {
            reason: String::new(),
            paused: false,
        },
    }
}

/// `scheduleReason`: mostly a list of reasons not to probe, for display.
/// Returns `None` when the schedule would probe (or the only gate it cannot
/// evaluate, live headroom, is all that remains). `key`, `certificate_state`
/// and `unsupported_reason` are for the repository the schedule would probe.
#[allow(clippy::too_many_arguments)]
fn schedule_reason(
    s: &StrategyRefs,
    runner_id: &str,
    key: &str,
    certificate_state: &str,
    unsupported_reason: Option<String>,
    consent: &Object,
    attempts: &Value,
    now: f64,
) -> Option<Hold> {
    if !is_scheduled_runner(s, runner_id) {
        return Some(Hold {
            reason: "scheduled probing covers only the planner's own executor".into(),
            paused: false,
        });
    }
    let Some((_, planner_account)) = find_planner_runner(s) else {
        return Some(Hold {
            reason: "scheduled probing covers only the planner's own executor".into(),
            paused: false,
        });
    };
    let decision = decide_probe(
        &ProbeInputs {
            key: key.to_string(),
            account: planner_account,
            runner: runner_id.to_string(),
            certificate_state: certificate_state.to_string(),
            unsupported_reason,
            headroom_pct: None,
            reserve_headroom_pct: s.reserve_headroom(),
            mode: s.planner_probe().to_string(),
            planner_executes: true,
            listed_for_routing: is_listed_for_routing(s, runner_id),
        },
        consent,
        attempts,
        now,
    );
    if decision.reason.is_empty() || decision.reason == HEADROOM_UNKNOWN {
        return None;
    }
    let hold = attempt_hold(attempts.as_object().and_then(|m| m.get(key)), now);
    let paused = hold
        .as_ref()
        .is_some_and(|h| h.paused && h.reason == decision.reason);
    Some(Hold {
        reason: decision.reason,
        paused,
    })
}

/// The schedule-derived fields of one `enforcementDiagnostics` row.
struct ScheduleFields {
    reason: Option<String>,
    paused: bool,
    repo: Option<String>,
    unsupported_reason: Option<String>,
}

fn field_reason_only(hold: Option<Hold>) -> ScheduleFields {
    ScheduleFields {
        reason: hold.as_ref().map(|h| h.reason.clone()),
        paused: hold.as_ref().map(|h| h.paused).unwrap_or(false),
        repo: None,
        unsupported_reason: None,
    }
}

/// `scheduleFor` in `src/dispatch/enforcement.ts`. `key`, `cert` and
/// `unsupported` describe the requested repository; `cert_for_scheduled` and
/// `unsupported_for_scheduled` the scheduled repository when it differs;
/// `scheduled` is the scheduled repository's path/label (or `None`).
#[allow(clippy::too_many_arguments)]
fn schedule_for(
    s: &StrategyRefs,
    runner_id: &str,
    key: &str,
    requested_repo: &str,
    cert: &Cert,
    unsupported: Option<String>,
    scheduled: Option<&Scheduled>,
    cert_for_scheduled: Option<&Cert>,
    unsupported_for_scheduled: Option<String>,
    consent: &Object,
    attempts: &Value,
    now: f64,
) -> ScheduleFields {
    // tick only ever probes the planner's own runner; display the reason.
    if !is_scheduled_runner(s, runner_id) {
        return field_reason_only(schedule_reason(
            s,
            runner_id,
            key,
            &cert.state,
            unsupported,
            consent,
            attempts,
            now,
        ));
    }
    // The request's repo IS the scheduled repo.
    if scheduled
        .as_ref()
        .is_some_and(|sd| sd.path.as_deref() == Some(requested_repo))
    {
        let hold = schedule_reason(
            s,
            runner_id,
            key,
            &cert.state,
            unsupported.clone(),
            consent,
            attempts,
            now,
        );
        let reason = match &hold {
            Some(h) if h.reason == unsupported.as_deref().unwrap_or_default() => None,
            _ => hold.as_ref().map(|h| h.reason.clone()),
        };
        let paused = hold.as_ref().map(|h| h.paused).unwrap_or(false);
        return ScheduleFields {
            reason,
            paused,
            repo: None,
            unsupported_reason: unsupported,
        };
    }
    // Turned off is a setting a person chose, and it holds wherever the
    // schedule would run.
    if scheduled.is_none() {
        if s.planner_probe() == "off" {
            return field_reason_only(schedule_reason(
                s,
                runner_id,
                key,
                &cert.state,
                unsupported,
                consent,
                attempts,
                now,
            ));
        }
        return ScheduleFields {
            reason: Some("no repository is registered, so there is nothing to certify".into()),
            paused: false,
            repo: None,
            unsupported_reason: None,
        };
    }
    // A different scheduled repository: the schedule would probe there.
    let Some(scheduled) = scheduled else {
        unreachable!("guarded by the `scheduled.is_none` branch above")
    };
    let there_cert = cert_for_scheduled;
    let there_state = there_cert.map(|c| c.state.as_str()).unwrap_or(&cert.state);
    let there_unsupported = unsupported_for_scheduled;
    let hold = schedule_reason(
        s,
        runner_id,
        key,
        there_state,
        there_unsupported.clone(),
        consent,
        attempts,
        now,
    );
    let reason = match &hold {
        Some(h) if h.reason == there_unsupported.as_deref().unwrap_or_default() => None,
        _ => hold.as_ref().map(|h| h.reason.clone()),
    };
    let paused = hold.as_ref().map(|h| h.paused).unwrap_or(false);
    ScheduleFields {
        reason,
        paused,
        repo: scheduled.label.clone(),
        unsupported_reason: there_unsupported,
    }
}

/// The `repo` a `dispatch.enforcement` request names; `""` when missing.
fn repo_input(params: &Value) -> &str {
    params
        .get("repo")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

/// `dispatch.enforcement` forwards when the repository or policy needs Core.
fn enforcement_forwarded(ctx: &Ctx, repo: &str) -> bool {
    repo_needs_core(ctx, repo, true)
}

/// A per-runner diagnostics row from the bridge: success carries the pieces
/// TypeScript computed, failure an error message.
#[allow(clippy::large_enum_variant)]
enum DiagRow {
    Ok(DiagOk),
    Err(String),
}

struct DiagOk {
    version: String,
    unsupported: Option<String>,
    cert: Cert,
    scheduled_cert: Option<Cert>,
    scheduled_unsupported: Option<String>,
    key: String,
    /// The repository the `dispatch.enforcement` request named (the requested,
    /// not scheduled, repository). Set by `draft_ok_row` from the request.
    requested_repo: String,
}

fn diag_for(entry: &Value, _id: &str) -> DiagRow {
    if let Some(error) = entry.get("error") {
        return DiagRow::Err(error.as_str().unwrap_or_default().to_owned());
    }
    DiagRow::Ok(DiagOk {
        version: entry
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        unsupported: entry
            .get("unsupportedReason")
            .and_then(Value::as_str)
            .map(str::to_owned),
        cert: Cert::of(entry.get("cert").unwrap_or(&Value::Null)),
        scheduled_cert: entry
            .get("scheduledCert")
            .and_then(|v| (v != &Value::Null).then(|| Cert::of(v))),
        scheduled_unsupported: entry
            .get("scheduledUnsupported")
            .and_then(Value::as_str)
            .map(str::to_owned),
        key: entry
            .get("key")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        requested_repo: String::new(),
    })
}

/// The row for a runner the target could not be resolved for: tick cannot probe
/// it either, so every schedule field reports the resolution error.
fn diag_error_row(id: &str, runner: &Value, probe_mode: &str, error: &str) -> Value {
    let mut row = Object::new();
    row.insert("runner".into(), json!(id));
    row.insert(
        "account".into(),
        json!(
            runner
                .get("account")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
    );
    row.insert(
        "agent".into(),
        json!(
            runner
                .get("agent")
                .and_then(Value::as_str)
                .unwrap_or_default()
        ),
    );
    row.insert("version".into(), Value::Null);
    row.insert("probeSupported".into(), json!(false));
    row.insert("unsupportedReason".into(), Value::Null);
    row.insert("probeMode".into(), json!(probe_mode));
    row.insert("state".into(), json!("uncertified"));
    row.insert("reason".into(), json!(error));
    row.insert("lastProbedAt".into(), Value::Null);
    row.insert("expiresAt".into(), Value::Null);
    row.insert("nextEligibleAt".into(), json!(0));
    row.insert("probesToday".into(), json!(0));
    row.insert("lastCostPct".into(), Value::Null);
    row.insert("consent".into(), json!("unasked"));
    row.insert("scheduleReason".into(), json!(error));
    row.insert("schedulePaused".into(), json!(false));
    row.insert("scheduleRepo".into(), Value::Null);
    row.insert("scheduleUnsupportedReason".into(), Value::Null);
    Value::Object(row)
}

/// The row for a runner whose target resolved: certificate, attempt counters,
/// consent and the schedule-derived fields.
#[allow(clippy::too_many_arguments)]
fn diag_ok_row(
    s: &StrategyRefs,
    id: &str,
    runner: &Value,
    probe_mode: &str,
    scheduled: Option<&Scheduled>,
    details: &DiagOk,
    consent: &Object,
    attempts: &Value,
    now: f64,
) -> Value {
    let account = runner
        .get("account")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let agent = runner
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let attempt = attempts
        .as_object()
        .and_then(|m| m.get(details.key.as_str()));
    let mut row = Object::new();
    row.insert("runner".into(), json!(id));
    row.insert("account".into(), json!(account));
    row.insert("agent".into(), json!(agent));
    row.insert("version".into(), json!(details.version));
    row.insert(
        "probeSupported".into(),
        json!(details.unsupported.is_none()),
    );
    match &details.unsupported {
        Some(reason) => {
            row.insert("unsupportedReason".into(), json!(reason));
            row.insert("probeMode".into(), json!(probe_mode));
            row.insert("state".into(), json!("uncertified"));
            row.insert("reason".into(), json!(reason));
            row.insert("lastProbedAt".into(), Value::Null);
            row.insert("expiresAt".into(), Value::Null);
        }
        None => {
            row.insert("unsupportedReason".into(), Value::Null);
            row.insert("probeMode".into(), json!(probe_mode));
            row.insert("state".into(), json!(details.cert.state));
            if let Some(reason) = &details.cert.reason {
                row.insert("reason".into(), json!(reason));
            }
            if let Some(probed_at) = details.cert.probed_at {
                row.insert("probedAt".into(), json!(probed_at));
            }
            row.insert(
                "lastProbedAt".into(),
                details
                    .cert
                    .probed_at
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            row.insert(
                "expiresAt".into(),
                details
                    .cert
                    .expires_at
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
        }
    }
    row.insert(
        "nextEligibleAt".into(),
        json!(as_f64(attempt.and_then(|a| a.get("nextEligibleAt"))).unwrap_or(0.0)),
    );
    row.insert(
        "probesToday".into(),
        json!(as_f64(attempt.and_then(|a| a.get("probesToday"))).unwrap_or(0.0)),
    );
    row.insert(
        "lastCostPct".into(),
        as_f64(attempt.and_then(|a| a.get("lastCostPct")))
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    row.insert(
        "consent".into(),
        json!(consent_of(consent, account).unwrap_or("unasked")),
    );
    let schedule = schedule_for(
        s,
        id,
        details.key.as_str(),
        &details.requested_repo,
        &details.cert,
        details.unsupported.clone(),
        scheduled,
        details.scheduled_cert.as_ref(),
        details.scheduled_unsupported.clone(),
        consent,
        attempts,
        now,
    );
    row.insert(
        "scheduleReason".into(),
        schedule.reason.map(Value::from).unwrap_or(Value::Null),
    );
    row.insert("schedulePaused".into(), json!(schedule.paused));
    row.insert(
        "scheduleRepo".into(),
        schedule.repo.map(Value::from).unwrap_or(Value::Null),
    );
    row.insert(
        "scheduleUnsupportedReason".into(),
        schedule
            .unsupported_reason
            .map(Value::from)
            .unwrap_or(Value::Null),
    );
    Value::Object(row)
}

/// `dispatch.enforcement` (`enforcementDiagnostics` in `src/api/ops.ts`): the
/// certification and exclusion read for a repository. No caller gate. Forwards
/// (answers `unavailable`) when the strategy needs Core, so the front door
/// forwards the request.
pub fn dispatch_enforcement<'a>(
    ctx: &'a Ctx,
    params: Value,
    bridge: &'a mut dyn Bridge,
) -> OpFuture<'a> {
    Box::pin(async move {
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("repo", p.get("repo"), Some(4096), &mut issues);
        finish(issues)?;
        let repo_input = p["repo"].as_str().unwrap_or_default();
        let strategy = load_strategy(&ctx.pacer_home).map_err(internal)?;
        if enforcement_forwarded(ctx, repo_input) {
            return Err(unavailable("pacer core must resolve the repository"));
        }
        let projects = read_project_strategies(&ctx.pacer_home).map_err(policy_error)?;
        let repo = policy_repo(ctx, repo_input, &projects)?;
        let repo_path = repo["path"].as_str().unwrap_or_default().to_owned();
        let now = now(ctx);
        let Some((consent, attempts)) = read_schedule(ctx) else {
            return Err(unavailable(
                "pacer core must read the certification schedule",
            ));
        };
        let Some(srefs) = StrategyRefs::of(&strategy) else {
            return Err(CoreError::new(
                Code::Internal,
                "strategy is missing pacing, runners, routing or planner",
            ));
        };
        let probe_mode = srefs.planner_probe().to_owned();
        let runner_ids: Vec<String> = srefs
            .runners
            .as_object()
            .map(|runners| runners.keys().cloned().collect())
            .unwrap_or_default();
        let parts = bridge
            .parts(json!({
                "kind": "dispatch.enforcement-diagnostics",
                "repo": repo_path,
                "runners": runner_ids,
            }))
            .await?;
        let scheduled = match parts.get("scheduled") {
            Some(Value::Object(scheduled)) => Some(Scheduled {
                path: scheduled
                    .get("path")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                label: scheduled
                    .get("label")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            }),
            _ => None,
        };
        let mut rows = Vec::new();
        if let Some(runners) = srefs.runners.as_object() {
            for (id, runner) in runners {
                let entry = parts
                    .get("runners")
                    .and_then(Value::as_array)
                    .and_then(|items| items.iter().find(|e| e.get("runner").and_then(Value::as_str) == Some(id)))
                    .cloned()
                    .unwrap_or(json!({ "runner": id, "error": "native subagent resolution was unavailable" }));
                match diag_for(&entry, id) {
                    DiagRow::Err(error) => {
                        rows.push(diag_error_row(id, runner, &probe_mode, &error));
                    }
                    DiagRow::Ok(mut details) => {
                        details.requested_repo = repo_path.clone();
                        rows.push(diag_ok_row(
                            &srefs,
                            id,
                            runner,
                            &probe_mode,
                            scheduled.as_ref(),
                            &details,
                            &consent,
                            &attempts,
                            now,
                        ));
                    }
                }
            }
        }
        Ok(json!({
            "repo": repo_path,
            "scope": "native subagent entry points at admission",
            "runners": rows,
        }))
    })
}

/// Whether `dispatch.enforcement` (or `dispatch.enforcement.denied`) should
/// stay forwarded: the repository or policy needs Core.
pub fn dispatch_enforcement_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "dispatch.enforcement" => enforcement_forwarded(ctx, repo_input(params)),
        "dispatch.enforcement.denied" => false,
        _ => false,
    }
}

/// The repository `dispatch.enforcement.probe` would certify.
pub fn dispatch_enforcement_probe_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    probe_stays_forwarded(ctx, params)
}

fn probe_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    let Ok(p) = params_object(params) else {
        return false;
    };
    let mut issues = Vec::new();
    string_issues("repo", p.get("repo"), Some(4096), &mut issues);
    string_issues("runner", p.get("runner"), Some(128), &mut issues);
    if !issues.is_empty() {
        return false;
    }
    !enforcement_forwarded(ctx, p["repo"].as_str().unwrap_or_default())
}

/// `dispatch.enforcement.probe` (`dispatch.enforcement.probe` in `src/api/ops.ts`):
/// Rust owns the params validation, the caller refusals and the repo
/// resolution; a valid probe would run the quota-using canary in Core, so it
/// forwards by answering `unavailable`.
pub fn dispatch_enforcement_probe(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, &params)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("repo", p.get("repo"), Some(4096), &mut issues);
        string_issues("runner", p.get("runner"), Some(128), &mut issues);
        finish(issues)?;
        let repo_input = p["repo"].as_str().unwrap_or_default();
        // Match the TypeScript handler's order: resolve the policy repository
        // before loading the strategy, so an unregistered or non-absolute
        // repo is refused before a missing strategy file could fail.
        let projects = read_project_strategies(&ctx.pacer_home).map_err(policy_error)?;
        let _repo = policy_repo(ctx, repo_input, &projects)?;
        let _strategy = load_strategy(&ctx.pacer_home).map_err(internal)?;
        Err(unavailable("core must start the probe job"))
    })
}

/// Registry placeholder for [`dispatch_enforcement`] and
/// [`dispatch_enforcement_denied`]: those run only through the
/// `dispatch-parts` bridge paths (HTTP and stdio), exactly like
/// `dispatch.preview`. The generic registry entry answers `unavailable` if a
/// surface reaches them without a bridge.
pub fn enforcement_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "dispatch enforcement requires the dispatch parts bridge",
        ))
    })
}

/// `dispatch.enforcement.denied` (`dispatch.enforcement.denied` in
/// `src/api/ops.ts`): `authorizeEnforcementToken`, then the store effects. The
/// callable runs under the `pet_` enforcement identity, so it never calls
/// [`dispatch_ops::authorize`].
pub fn dispatch_enforcement_denied<'a>(
    ctx: &'a Ctx,
    params: Value,
    bridge: &'a mut dyn Bridge,
) -> OpFuture<'a> {
    Box::pin(async move {
        // `authorizeWorkOperation` for `dispatch.enforcement.denied`: the
        // enforcement identity gate runs before the params are validated, so a
        // strict attempt with no identity gets this refusal even for invalid
        // params (see `src/core/work.ts`).
        if !ctx
            .env
            .get("PACER_ENFORCEMENT_TOKEN")
            .is_some_and(|token| !token.is_empty())
        {
            return Err(CoreError::new(
                Code::NotAllowed,
                "An enforcement identity is required",
            ));
        }
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        enum_issues(
            "agent",
            p.get("agent"),
            &["claude-code", "codex", "cursor"],
            &mut issues,
        );
        finish(issues)?;
        let token = ctx
            .env
            .get("PACER_ENFORCEMENT_TOKEN")
            .cloned()
            .unwrap_or_default();
        let (task_id, attempt) = authorize_enforcement_token(ctx, &token)?;
        let mut state = open(ctx)?;
        let task = state
            .read(&task_id)
            .map_err(internal)?
            .ok_or_else(|| CoreError::new(Code::UnknownTask, "Unknown work"))?;
        append_work_event(
            ctx,
            &task_id,
            "native-child.denied",
            &json!({ "agent": p["agent"].as_str().unwrap_or_default(), "attempt": attempt }),
        )?;
        if let Some(executor) = task.get("executor").and_then(Value::as_str) {
            let repo = task
                .get("repo")
                .and_then(|r| r.get("path"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    task.get("brief")
                        .and_then(|b| b.get("repo"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .unwrap_or_default();
            let reason = exclusion_reason(executor, &repo, bridge).await?;
            if let Some(reason) = reason {
                let loss = json!({ "at": ctx.now, "reason": reason });
                update_work_decision_loss(ctx, &task_id, attempt, &loss)?;
                append_work_event(
                    ctx,
                    &task_id,
                    "enforcement.lost",
                    &json!({
                        "attempt": attempt,
                        "runner": executor,
                        "reason": reason,
                    }),
                )?;
            }
        }
        Ok(json!({ "recorded": true }))
    })
}

fn enum_issues(name: &str, value: Option<&Value>, options: &[&str], issues: &mut Vec<String>) {
    if !value.is_some_and(|v| v.as_str().is_some_and(|x| options.contains(&x))) {
        let expected = options
            .iter()
            .map(|o| format!("\"{o}\""))
            .collect::<Vec<_>>()
            .join("|");
        issues.push(format!(
            "{name}: Invalid option: expected one of {expected}"
        ));
    }
}

fn authorize(ctx: &Ctx, params: &Value) -> Result<(), CoreError> {
    crate::dispatch_ops::authorize(ctx, "dispatch.enforcement.probe", params)
}

fn sha256_hex(value: &str) -> String {
    hex::encode(Sha256::digest(value.as_bytes()))
}

/// `authorizeEnforcementToken` in `src/dispatch/enforcement-token.ts`: the
/// `pet_` token must be live for the current attempt of a running strict task.
fn authorize_enforcement_token(ctx: &Ctx, token: &str) -> Result<(String, f64), CoreError> {
    let valid = token
        .strip_prefix("pet_")
        .is_some_and(|rest| rest.len() == 64 && rest.bytes().all(|b| b.is_ascii_hexdigit()));
    if !valid {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Invalid enforcement identity",
        ));
    }
    let mut state = open(ctx)?;
    let db = state.tasks.connection().map_err(internal)?;
    let row = db
        .query_row(
            "SELECT task_id, attempt, expires, revoked FROM enforcement_tokens WHERE hash=?",
            [sha256_hex(token)],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, f64>(1)?,
                    r.get::<_, f64>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(internal)?;
    let Some((task_id, attempt, expires, revoked)) = row else {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Expired or revoked enforcement identity",
        ));
    };
    let task = state.read(&task_id).map_err(internal)?;
    let task = task.ok_or_else(|| {
        CoreError::new(Code::NotAllowed, "Expired or revoked enforcement identity")
    })?;
    let running = task.get("state").and_then(Value::as_str) == Some("running");
    let attempts_len = task
        .get("attempts")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0) as f64;
    let strict = state
        .work(&task_id)
        .map_err(internal)?
        .and_then(|w| w.pointer("/options/delegationEnforcement").cloned())
        == Some(Value::String("strict".into()));
    if revoked != 0 || expires <= ctx.now || !running || attempt != attempts_len + 1.0 || !strict {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Expired or revoked enforcement identity",
        ));
    }
    Ok((task_id, attempt))
}

/// `appendWorkEvent` in `src/dispatch/store.ts`.
fn append_work_event(ctx: &Ctx, task_id: &str, kind: &str, data: &Value) -> Result<(), CoreError> {
    let data = bounded(data)?;
    let mut state = open(ctx)?;
    let db = state.tasks.connection().map_err(internal)?;
    db.execute(
        "INSERT INTO work_events(root_id,task_id,at,kind,data) SELECT root_id,task_id,?,?,? FROM work_nodes WHERE task_id=?",
        rusqlite::params![ctx.now, kind, data, task_id],
    )
    .map_err(internal)?;
    Ok(())
}

/// `boundedJson` in `src/dispatch/store.ts`.
fn bounded(value: &Value) -> Result<String, CoreError> {
    let text = serde_json::to_string(value).map_err(internal)?;
    if text.len() > MAX_BYTES {
        return Err(CoreError::new(
            Code::TooLarge,
            "Work record exceeds 256 KiB",
        ));
    }
    Ok(text)
}

/// `updateWorkDecision(..., {enforcement: {...existing, loss}})` in
/// `src/dispatch/store.ts`: merge the prior `enforcement` patch with the new
/// loss and write it back. Throws a conflict when the attempt has no decision.
fn update_work_decision_loss(
    ctx: &Ctx,
    task_id: &str,
    attempt: f64,
    loss: &Value,
) -> Result<(), CoreError> {
    let mut state = open(ctx)?;
    let db = state.tasks.connection().map_err(internal)?;
    let row: Option<String> = db
        .query_row(
            "SELECT data FROM work_decisions WHERE task_id=? AND attempt=?",
            rusqlite::params![task_id, attempt as i64],
            |r| r.get(0),
        )
        .optional()
        .map_err(internal)?;
    let Some(row) = row else {
        return Err(CoreError::new(
            Code::Conflict,
            "Dispatch decision is missing for this attempt",
        ));
    };
    let existing: Value =
        serde_json::from_str(&row).map_err(|_| internal("invalid work decision"))?;
    let enforcement = existing.get("enforcement").cloned().unwrap_or(json!({}));
    let mut enforcement = enforcement.as_object().cloned().unwrap_or_default();
    enforcement.insert("loss".into(), loss.clone());
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    merged.insert("enforcement".into(), Value::Object(enforcement));
    let data = bounded(&Value::Object(merged))?;
    db.execute(
        "UPDATE work_decisions SET data=? WHERE task_id=? AND attempt=?",
        rusqlite::params![data, task_id, attempt as i64],
    )
    .map_err(internal)?;
    Ok(())
}

/// The runner's native-control exclusion reason for `repo`, via the existing
/// `dispatch.enforcement-exclusions` bridge kind (`cached: false`).
async fn exclusion_reason(
    runner: &str,
    repo: &str,
    bridge: &mut dyn Bridge,
) -> Result<Option<String>, CoreError> {
    let parts = bridge
        .parts(json!({
            "kind": "dispatch.enforcement-exclusions",
            "repo": repo,
            "runners": [runner],
            "cached": false,
        }))
        .await?;
    let entry = parts
        .as_array()
        .into_iter()
        .flatten()
        .find(|e| e.get("runner").and_then(Value::as_str) == Some(runner));
    match entry.and_then(|e| e.get("reason")) {
        Some(Value::Null) | None => Ok(None),
        Some(reason) => Ok(Some(reason.as_str().unwrap_or_default().to_owned())),
    }
}

#[cfg(test)]
#[path = "enforcement_ops/tests.rs"]
mod tests;
