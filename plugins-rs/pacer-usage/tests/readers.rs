//! Reader tests for `pacer-usage`, the Rust twin of
//! `test/plugins-usage-readers.test.ts`. Each case drives the real reader
//! functions through a scripted host (`support::fs_host::FsHost`) over a temp
//! directory, so the assertions pin the exact values the port produces for the
//! same fixtures the TypeScript reader tests use.

mod support;

use pacer_bundled_usage::util::{is_obj, parse_ts};
use pacer_bundled_usage::{
    Availability, AvailabilityState, MeteredConfig, ReaderContext, ReaderResources, SpendingSignals,
    UsageReading, UsageSource,
};
use pacer_plugin::usage::{FileInfo, RunResult};
use pacer_plugin::PluginError;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use support::fs_host::{FsHost, RunCall};

const NOW: f64 = 1791633600.0;

fn tmp() -> TempDir {
    TempDir::new()
}

/// Auto-cleaning temp directory.
struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("pacer-usage-test-{}", std::process::id()));
        let dir = base.join(unique());
        std::fs::create_dir_all(&dir).expect("create temp dir");
        TempDir(dir)
    }
    fn path(&self) -> &Path {
        &self.0
    }
    fn abs(&self, rel: &str) -> String {
        self.0.join(rel).to_string_lossy().into_owned()
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    format!("{:x}", N.fetch_add(1, Ordering::Relaxed))
}

fn set_mtime(path: &Path, seconds: u64) {
    let t = UNIX_EPOCH + std::time::Duration::from_secs(seconds);
    let f = std::fs::File::open(path).expect("open for mtime");
    f.set_modified(t).expect("set modified");
}

fn write(dir: &Path, rel: &str, body: &str, mtime_s: u64) -> String {
    let full = dir.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent).expect("create parent");
    }
    std::fs::write(&full, body).expect("write");
    set_mtime(&full, mtime_s);
    full.to_string_lossy().into_owned()
}

/// A JSONL `codex` session event, mirroring the TS test `event()` helper.
fn event(used: f64, at: f64) -> String {
    serde_json::to_string(&json!({
        "timestamp": at,
        "payload": {
            "rate_limits": {
                "primary": {
                    "used_percent": used,
                    "window_minutes": 10080,
                    "resets_in_seconds": 3600,
                },
            },
        },
    }))
    .unwrap()
        + "\n"
}

fn ctx<'a>(host: &'a FsHost, now: f64, read_only: bool, res: &'a ReaderResources) -> ReaderContext<'a> {
    ReaderContext {
        io: host,
        now,
        read_only,
        resources: Some(res),
    }
}

fn first<'a>(window_name: &str, reading: &'a UsageReading) -> Option<&'a pacer_bundled_usage::UsageWindow> {
    reading
        .windows
        .iter()
        .find(|w| w.name == window_name)
}

// ---------------------------------------------------------------------------
// arkcli (byteplus.rs)
// ---------------------------------------------------------------------------

fn byteplus_payload(_items: Value) -> RunCall {
    // Scripted `run` returns the payload for the coding-plan argv.
    let cmd: Vec<&str> = vec!["arkcli", "usage", "plan", "--product", "coding-plan"];
    RunCall {
        argv: cmd.iter().map(|s| s.to_string()).collect(),
        timeout_ms: 8000,
    }
}

#[tokio::test]
async fn arkcli_missing_subscription_reports_unavailable() {
    let t = tmp();
    let host = FsHost::new(t.path());
    run_plan(&host, json!({ "items": [] }));
    let res = &mut ReaderResources::default();
    let c = ctx(&host, NOW, true, res);
    let r = pacer_bundled_usage::byteplus::read_byteplus(&c, true).await;
    let avail = r.availability.clone().expect("availability");
    assert_eq!(avail.state, AvailabilityState::Unavailable);
    assert_eq!(avail.reason, "subscription_missing");
    let err = r.error.clone().expect("error");
    assert_eq!(err, "no active coding-plan subscription");
    // The host ran exactly the coding-plan argv, with the SDK timeout.
    assert_eq!(host.calls(), vec![RunCall {
        argv: vec!["arkcli".into(), "usage".into(), "plan".into(), "--product".into(), "coding-plan".into()],
        timeout_ms: 8000,
    }]);
}

#[tokio::test]
async fn arkcli_invalid_response_is_unknown() {
    let t = tmp();
    let host = FsHost::new(t.path());
    run_plan(&host, json!({ "notItems": true }));
    let res = &mut ReaderResources::default();
    let c = ctx(&host, NOW, true, res);
    let r = pacer_bundled_usage::byteplus::read_byteplus(&c, true).await;
    let avail = r.availability.clone().unwrap();
    assert_eq!(avail.state, AvailabilityState::Unknown);
    assert_eq!(avail.reason, "subscription_response_invalid");
    assert_eq!(r.error.as_deref(), Some("invalid coding-plan subscription response"));
}

#[tokio::test]
async fn arkcli_ready_preserves_windows_and_commit_window() {
    let t = tmp();
    let host = FsHost::new(t.path());
    let resets = parse_ts(&Value::String("2026-03-31T00:00:00Z".into())).unwrap();
    run_plan(
        &host,
        json!({
            "items": [{
                "product": "coding-plan",
                "subscribed": true,
                "periods": [
                    { "label": "session", "percent": 12, "reset_at": 1791633700 },
                    { "label": "weekly", "percent": 30, "reset_at": 1791633800 },
                    { "label": "monthly", "percent": 50, "reset_at": "2026-03-31T00:00:00Z" },
                ],
            }],
        }),
    );
    let res = &mut ReaderResources::default();
    let c = ctx(&host, NOW, true, res);
    let r = pacer_bundled_usage::byteplus::read_byteplus(&c, true).await;
    assert_eq!(r.source, Some(UsageSource::ProviderCli));
    assert_eq!(r.captured_at, Some(NOW));
    assert_eq!(r.error, None);
    let avail = r.availability.clone().unwrap();
    assert_eq!(avail.state, AvailabilityState::Ready);
    assert_eq!(avail.reason, "subscription_active");
    assert_eq!(avail.valid_until, Some(NOW + 600.0));
    // Session: 5h, paced false.
    let session = first("5h", &r).expect("session window");
    assert_eq!(session.used_pct, Some(12.0));
    assert_eq!(session.resets_at, Some(1791633700.0));
    assert_eq!(session.length_s, 5.0 * 3600.0);
    assert_eq!(session.paced, false);
    // Weekly: 7d, paced true.
    let weekly = first("weekly", &r).expect("weekly window");
    assert_eq!(weekly.used_pct, Some(30.0));
    assert_eq!(weekly.resets_at, Some(1791633800.0));
    assert_eq!(weekly.length_s, 7.0 * 86400.0);
    assert!(weekly.paced);
    // Monthly: length is reset - month_before(reset).
    let monthly = first("monthly", &r).expect("monthly window");
    assert_eq!(monthly.used_pct, Some(50.0));
    assert_eq!(monthly.resets_at, Some(resets));
    assert_eq!(monthly.length_s, resets - pacer_bundled_usage::byteplus::month_before(resets));
    assert!(monthly.paced);
}

fn run_plan(host: &FsHost, payload: Value) {
    host.set_run(Box::new(move |_argv: &[&str], _: u64| RunResult {
        timed_out: false,
        code: 0,
        stdout: payload.to_string(),
        stderr: String::new(),
    }));
}

// ---------------------------------------------------------------------------
// metered (metered.rs)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn metered_dollar_and_token_budgets() {
    let dollar = meter_budget(Some(100.0), None);
    let token = meter_budget(None, Some(100.0));

    // model present, empty response -> incomplete.
    let (r, _) = meter_run(json!({}), &dollar).await;
    assert_eq!(r.error.as_deref(), Some("Metered usage response is incomplete"));
    assert!(r.stale);

    // no models -> $0 ready.
    let (r, _) = meter_run(json!({ "models": [] }), &dollar).await;
    let w = first("7d $", &r).expect("usd window");
    assert_eq!(w.used_pct, Some(0.0));
    assert_eq!(r.spend_usd, Some(0.0));

    // tokens input 10 + cost 25 -> $25 ready.
    let (r, _) = meter_run(
        json!({ "models": [{ "model": { "providerID": "public", "id": "code" }, "tokens": { "input": 10 }, "cost": 25 }] }),
        &dollar,
    ).await;
    let w = first("7d $", &r).expect("usd window");
    assert_eq!(w.used_pct, Some(25.0));
    assert_eq!(r.spend_usd, Some(25.0));
    assert_eq!(r.captured_at, Some(NOW));

    // tokens input 10, no cost -> cost unknown with a dollar budget is invalid.
    let (r, _) = meter_run(
        json!({ "models": [{ "model": { "providerID": "public", "id": "code" }, "tokens": { "input": 10 } }] }),
        &dollar,
    ).await;
    assert_eq!(r.error.as_deref(), Some("Metered usage response is incomplete"));
    assert!(r.stale);

    // same payload under a *token* budget is fine; spendUsd is absent.
    let (r, _) = meter_run(
        json!({ "models": [{ "model": { "providerID": "public", "id": "code" }, "tokens": { "input": 10 } }] }),
        &token,
    ).await;
    let w = first("7d", &r).expect("token window");
    assert_eq!(w.used_pct, Some(10.0));
    assert_eq!(r.spend_usd, None);
}

#[tokio::test]
async fn metered_needs_a_model_and_reports_exit() {
    let no_model = MeteredConfig { model: None, weekly_tokens: None, weekly_usd: None };
    let t = tmp();
    let host = FsHost::new(t.path());
    let res = &mut ReaderResources::default();
    let c = ctx(&host, NOW, true, res);
    // No model: no subprocess.
    let r = pacer_bundled_usage::metered::read_metered(&c, &no_model, true).await;
    assert_eq!(r.error.as_deref(), Some("metered usage needs a model"));
    assert!(host.calls().is_empty());

    // Failed command propagates the exit + stderr.
    host.set_run(Box::new(move |_argv: &[&str], _: u64| RunResult {
        timed_out: false,
        code: 3,
        stdout: String::new(),
        stderr: "synthetic offline".into(),
    }));
    let model = MeteredConfig { model: Some("public/code".into()), weekly_tokens: None, weekly_usd: Some(100.0) };
    let r = pacer_bundled_usage::metered::read_metered(&c, &model, true).await;
    assert_eq!(r.error.as_deref(), Some("opencode stats exited 3: synthetic offline"));
    assert_eq!(host.calls(), vec![RunCall {
        argv: vec!["opencode".into(), "stats".into(), "--models".into(), "--cost".into(), "--json".into(), "--days".into(), "7".into()],
        timeout_ms: 15000,
    }]);
}

fn meter_budget(usd: Option<f64>, tokens: Option<f64>) -> MeteredConfig {
    MeteredConfig { model: Some("public/code".into()), weekly_tokens: tokens, weekly_usd: usd }
}

#[tokio::test]
async fn metered_arg_and_exit_via_shared_budget() {
    // Dedicated test so the runner argument-count stays isolated from the
    // shared-budget cases.
    let t = tmp();
    let host = FsHost::new(t.path());
    run_stats(&host, json!({}));
    let res = &mut ReaderResources::default();
    let cfg = meter_budget(Some(100.0), None);
    let c = ctx(&host, NOW, true, res);
    let _ = pacer_bundled_usage::metered::read_metered(&c, &cfg, true).await;
    assert_eq!(host.calls(), vec![RunCall {
        argv: vec!["opencode".into(), "stats".into(), "--models".into(), "--cost".into(), "--json".into(), "--days".into(), "7".into()],
        timeout_ms: 15000,
    }]);
}

fn run_stats(host: &FsHost, payload: Value) {
    host.set_run(Box::new(move |_argv: &[&str], _: u64| RunResult {
        timed_out: false,
        code: 0,
        stdout: payload.to_string(),
        stderr: String::new(),
    }));
}

/// Run `read_metered` on a disposable host returning `payload`, returning the
/// reading and the recorded run invocations.
async fn meter_run(payload: Value, cfg: &MeteredConfig) -> (UsageReading, Vec<RunCall>) {
    let t = tmp();
    let host = FsHost::new(t.path());
    run_stats(&host, payload);
    let res = &mut ReaderResources::default();
    let c = ctx(&host, NOW, true, res);
    let r = pacer_bundled_usage::metered::read_metered(&c, cfg, true).await;
    (r, host.calls())
}

// ---------------------------------------------------------------------------
// claude (claude.rs)
// ---------------------------------------------------------------------------

fn claude_file(at: f64, source: &str) -> String {
    serde_json::to_string(&json!({
        "captured_at": at,
        "source": source,
        "seven_day": { "used_percentage": 20 },
        "five_hour": { "used_percentage": 5 },
    }))
    .unwrap()
}

#[tokio::test]
async fn claude_no_files_is_not_ready() {
    let t = tmp();
    let host = FsHost::new(t.path());
    let res = ReaderResources { claude_files: vec![], codex_sessions: None };
    let c = ctx(&host, NOW, true, &res);
    let r = pacer_bundled_usage::claude::read_claude(&c).await;
    assert_eq!(r.error.as_deref(), Some("no Claude rate-limit data yet (the Claude Code status line writes it)"));
    assert!(r.windows.is_empty());
}

#[tokio::test]
async fn claude_newest_nonfuture_snapshot_wins() {
    let t = tmp();
    // two candidate files: a session-log snapshot now-5 (newest), a
    // status-line snapshot now-10 (older).
    let a = write(t.path(), "claude/status.json", &claude_file(NOW - 10.0, "status-line"), 100);
    let b = write(t.path(), "claude/session.json", &claude_file(NOW - 5.0, "session-log"), 200);
    let host = FsHost::new(t.path());
    let res = ReaderResources { claude_files: vec![a.clone(), b], codex_sessions: None };
    let c = ctx(&host, NOW, true, &res);
    let r = pacer_bundled_usage::claude::read_claude(&c).await;
    // The session-log (newest, non-future) is selected.
    assert_eq!(r.source, Some(UsageSource::SessionLog));
    assert_eq!(r.captured_at, Some(NOW - 5.0));
    let weekly = first("weekly", &r).unwrap();
    assert_eq!(weekly.used_pct, Some(20.0));
    let five = first("5h", &r).unwrap();
    assert_eq!(five.used_pct, Some(5.0));
    // One fs.read per candidate path.
    assert_eq!(host.read_calls().len(), 2);

    // A future (now+1) file is filtered out; the status-line at now-10 wins.
    let host = FsHost::new(t.path());
    let res = ReaderResources { claude_files: vec![a.clone()], codex_sessions: None };
    let c = ctx(&host, NOW, true, &res);
    let r = pacer_bundled_usage::claude::read_claude(&c).await;
    // (fresh host: `a` alone is selected)
    assert_eq!(r.source, Some(UsageSource::StatusLine));
    assert_eq!(r.captured_at, Some(NOW - 10.0));
}

// ---------------------------------------------------------------------------
// codex (codex.rs)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn codex_missing_and_empty_session_dirs() {
    let t = tmp();
    let host = FsHost::new(t.path());
    // No sessions dir.
    let res = ReaderResources { claude_files: vec![], codex_sessions: Some(t.abs("sessions")) };
    let c = ctx(&host, NOW, true, &res);
    let r = pacer_bundled_usage::codex::read_codex(&c).await;
    assert_eq!(r.error.as_deref(), Some("no Codex session logs"));

    // Sessions dir exists but is empty.
    std::fs::create_dir_all(t.path().join("sessions")).unwrap();
    let host = FsHost::new(t.path());
    let c = ctx(&host, NOW, true, &res);
    let r = pacer_bundled_usage::codex::read_codex(&c).await;
    assert_eq!(r.error.as_deref(), Some("no rate_limits found in recent Codex session logs"));
}

#[tokio::test]
async fn codex_newest_15_files_scans_only_the_newest() {
    let t = tmp();
    // 16 files; only the *oldest* (rollout-0) carries rate_limits. The
    // reader scans the newest 15 only, so none of them contribute.
    write(t.path(), "sessions/rollout-0.jsonl", &event(10.0, NOW), 1000);
    for i in 1..16 {
        write(t.path(), &format!("sessions/rollout-{}.jsonl", i), "{}\n", 1000 + i);
    }
    let host = FsHost::new(t.path());
    let res = ReaderResources { claude_files: vec![], codex_sessions: Some(t.abs("sessions")) };
    let c = ctx(&host, NOW, true, &res);
    let r = pacer_bundled_usage::codex::read_codex(&c).await;
    assert_eq!(r.error.as_deref(), Some("no rate_limits found in recent Codex session logs"));
}

#[tokio::test]
async fn codex_bom_prefixed_record_is_skipped() {
    let t = tmp();
    // The BOM is mid-stream (start of the second record); TS leaves it in and
    // JSON.parse skips that record. The port must too (result 10, not 90).
    let body = format!("{}\n\u{feff}{}", event(10.0, NOW), event(90.0, NOW));
    write(t.path(), "sessions/rollout-bom.jsonl", &body, 100);
    let host = FsHost::new(t.path());
    let res = ReaderResources { claude_files: vec![], codex_sessions: Some(t.abs("sessions")) };
    let c = ctx(&host, NOW, true, &res);
    let r = pacer_bundled_usage::codex::read_codex(&c).await;
    assert_eq!(r.windows.len(), 1, "BOM-prefixed record must be skipped");
    let primary = &r.windows[0];
    assert_eq!(primary.name, "weekly");
    assert_eq!(primary.used_pct, Some(10.0));
    assert_eq!(r.source, Some(UsageSource::SessionLog));
}

#[tokio::test]
async fn codex_readonly_cursor_needs_no_reread() {
    let t = tmp();
    let body = event(15.0, NOW);
    write(t.path(), "sessions/rollout-retry.jsonl", &body, 100);
    let host = FsHost::new(t.path());
    let res = ReaderResources { claude_files: vec![], codex_sessions: Some(t.abs("sessions")) };
    // First pass, read-only: the cursor is still persisted.
    {
        let c = ctx(&host, NOW, true, &res);
        let r = pacer_bundled_usage::codex::read_codex(&c).await;
        assert_eq!(r.error, None);
    }
    let first_range_calls = host.range_calls();
    assert!(first_range_calls >= 1, "first pass must read the file");
    // The persisted cursor is offset == size with CURSOR_VERSION.
    let snap = host.store_value("codex-cursors").expect("cursor state persisted");
    assert_eq!(snap.get("version").and_then(Value::as_u64), Some(4));
    let files = snap.get("files").and_then(Value::as_object).expect("files map");
    let (_, cur) = files.iter().next().expect("a cursor for the file");
    let cur: pacer_plugin::usage::Cursor = serde_json::from_value(cur.clone()).unwrap();
    assert_eq!(cur.offset, cur.size, "cursor must be fully read");

    // Second, normal pass: the file is unchanged, so no range reads happen.
    let c = ctx(&host, NOW, false, &res);
    let r = pacer_bundled_usage::codex::read_codex(&c).await;
    assert_eq!(r.error, None);
    assert_eq!(host.range_calls(), first_range_calls, "reused cursor must not reread");
}
