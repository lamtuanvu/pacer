//! Crash detection, restart floor and start backoff for the native owner.
//!
//! The owner learns of a dead child first. Each lane has a monitor that waits
//! for the exit the process watcher publishes; when the transport closes while
//! the child lives on, the monitor sends it SIGTERM, then SIGKILL after
//! [`TERMINATE_GRACE`], as the TypeScript transport does. An
//! exit that no `terminate` asked for is a crash: the monitor records a restart
//! floor for the plugin id, reports `{id, reason}` to the owning door's sink
//! (which sends Core the private `crashed` kind), and only then marks the lane
//! settled, so [`crate::ProcessOwner::ensure`] never replaces a dead lane
//! before its crash is on record.
//!
//! Core keeps `restarts`, `error`, the backoff and `failing` (the TypeScript
//! registry's `recordCrash`), and seals the earliest start in `spawn_spec`.
//! The owner-side floor mirrors the same ramp per plugin id, and the same
//! [`CRASH_LIMIT`]: after three crashes within the window the owner starts the
//! plugin again only once an enable clears it. So a door whose Core never
//! hears the crash (an attached stdio connection) cannot respawn a
//! crash-looping child faster than the owning door, nor revive a failing one.

use crate::{
    bridge_listener::SharedOwner,
    owner::{OwnerError, PluginLane},
    process::TERMINATE_GRACE,
};
use pacer_plugin_host::SpawnSpec;
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot, watch};

/// Crashes older than this no longer count toward the ramp (`CRASH_WINDOW_S`).
pub const CRASH_WINDOW: Duration = Duration::from_secs(60);
/// Crashes within the window that mark a plugin failing (`CRASH_LIMIT`).
pub const CRASH_LIMIT: usize = 3;
/// The ramp's ceiling (`MAX_BACKOFF_MS`).
pub const MAX_BACKOFF: Duration = Duration::from_secs(30);
/// How long a report may wait for the door to deliver it to Core.
const REPORT_WAIT: Duration = Duration::from_secs(5);
/// How long a failed call waits for its lane's crash to be reported.
const SETTLE_WAIT: Duration = Duration::from_secs(5);
/// How soon a start retries while a dead lane is still being reported.
const RETIRING_RETRY: Duration = Duration::from_millis(25);

/// `min(1 s · 2^(n-1), 30 s)` after the `n`th crash within the window.
pub fn backoff(crashes: usize) -> Duration {
    let exponent = u32::try_from(crashes.saturating_sub(1))
        .unwrap_or(u32::MAX)
        .min(15);
    Duration::from_secs(1u64 << exponent).min(MAX_BACKOFF)
}

/// One crash for the door to deliver to its Core. Send on `done` (or drop the
/// report) once Core has it.
pub struct CrashReport {
    pub id: String,
    pub reason: String,
    pub done: oneshot::Sender<()>,
}

/// Recent crashes of one plugin id.
#[derive(Default)]
struct Crashes {
    times: Vec<Instant>,
    /// [`CRASH_LIMIT`] crashes fell within the window; held until [`CrashBook::clear`].
    failing: bool,
}

/// Restart floors per plugin id and the door's report sink.
#[derive(Default)]
pub struct CrashBook {
    crashes: Mutex<HashMap<String, Crashes>>,
    sink: Mutex<Option<mpsc::UnboundedSender<CrashReport>>>,
}

impl CrashBook {
    fn crashes(&self) -> std::sync::MutexGuard<'_, HashMap<String, Crashes>> {
        self.crashes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Count a crash of `id` now.
    pub fn record(&self, id: &str) {
        let now = Instant::now();
        let mut crashes = self.crashes();
        let entry = crashes.entry(id.to_owned()).or_default();
        entry
            .times
            .retain(|at| now.duration_since(*at) < CRASH_WINDOW);
        entry.times.push(now);
        entry.failing |= entry.times.len() >= CRASH_LIMIT;
    }

    /// The earliest instant this owner may start `id` again, if it crashed recently.
    pub fn floor(&self, id: &str) -> Option<Instant> {
        let crashes = self.crashes();
        let times = &crashes.get(id)?.times;
        let last = *times.last()?;
        Some(last + backoff(times.len()))
    }

    /// True once `id` crashed [`CRASH_LIMIT`] times within the window, until cleared.
    pub fn is_failing(&self, id: &str) -> bool {
        self.crashes().get(id).is_some_and(|entry| entry.failing)
    }

    /// Forget `id`'s crashes and failing mark, as enabling a plugin clears Core's backoff.
    pub fn clear(&self, id: &str) {
        self.crashes().remove(id);
    }

    /// Where crash reports go; `None` drops them (the owner still keeps floors).
    pub fn set_sink(&self, sink: Option<mpsc::UnboundedSender<CrashReport>>) {
        *self
            .sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = sink;
    }

    async fn report(&self, id: &str, reason: &str) {
        let sink = self
            .sink
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let Some(sink) = sink else {
            return;
        };
        let (done, delivered) = oneshot::channel();
        let report = CrashReport {
            id: id.to_owned(),
            reason: reason.to_owned(),
            done,
        };
        if sink.send(report).is_ok() {
            let _ = tokio::time::timeout(REPORT_WAIT, delivered).await;
        }
    }
}

/// Watch one lane until its child exits; report the exit unless it was a stop.
pub(crate) async fn monitor(book: Arc<CrashBook>, id: String, lane: Weak<PluginLane>) {
    let Some((mut exit, mut closed)) = lane
        .upgrade()
        .map(|lane| (lane.process().exit_watch(), lane.process().closed_watch()))
    else {
        return;
    };
    let closed_first = tokio::select! {
        _ = exit.wait_for(Option::is_some) => false,
        _ = closed.wait_for(|closed| *closed) => true,
    };
    if closed_first {
        match lane.upgrade() {
            Some(lane) => lane.process().term(),
            None => return,
        }
        if tokio::time::timeout(TERMINATE_GRACE, exit.wait_for(Option::is_some))
            .await
            .is_err()
        {
            match lane.upgrade() {
                Some(lane) => lane.process().kill(),
                None => return,
            }
        }
    }
    let Some(reason) = exit
        .wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|reason| reason.clone())
    else {
        return;
    };
    let Some(lane) = lane.upgrade() else {
        return;
    };
    if !lane.process().is_stopping() {
        book.record(&id);
        book.report(&id, &reason).await;
    }
    lane.settle();
}

/// The call's error once its lane died: `<method>: plugin <id> exited on SIGKILL`.
/// Waits (bounded) until the crash is on record, so Core's backoff already
/// covers the caller's retry. `None` while the lane lives.
pub async fn crash_message(lane: &PluginLane, id: &str, method: &str) -> Option<String> {
    if lane.process().is_alive() {
        return None;
    }
    Some(format!("{method}: {}", crash_text(lane, id).await))
}

async fn crash_text(lane: &PluginLane, id: &str) -> String {
    lane.wait_settled(SETTLE_WAIT).await;
    let reason = lane
        .process()
        .exit_reason()
        .unwrap_or_else(|| "stopped responding".into());
    format!("plugin {id} {reason}")
}

/// Why a start did not produce a live lane.
#[derive(Debug)]
pub enum StartFailure {
    Owner(OwnerError),
    /// The child died while this call was starting it: `plugin <id> exited on SIGKILL`.
    /// Core's state predates the crash, so the call fails as an in-flight one would.
    Crashed(String),
    /// The owner lock was not free before the call's deadline.
    Deadline,
    /// The restart backoff ends after the call's deadline.
    BeforeStartup,
    Cancelled,
}

impl std::fmt::Display for StartFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Owner(error) => error.fmt(f),
            Self::Crashed(text) => f.write_str(text),
            Self::Deadline => f.write_str("plugin call passed its absolute deadline"),
            Self::BeforeStartup => f.write_str("plugin call expired before startup"),
            Self::Cancelled => f.write_str("plugin call was cancelled"),
        }
    }
}

/// The instant a Core-sealed `nextStartAt` (epoch milliseconds) falls at.
pub fn instant_at_epoch_ms(at: u64) -> Option<Instant> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    let ahead = u128::from(at).checked_sub(now).filter(|ms| *ms > 0)?;
    Some(Instant::now() + Duration::from_millis(u64::try_from(ahead).ok()?))
}

async fn bounded<T>(
    until: Instant,
    cancel: Option<&watch::Receiver<bool>>,
    work: impl Future<Output = T>,
    late: StartFailure,
) -> Result<T, StartFailure> {
    let mut cancel = cancel.cloned();
    if cancel.as_ref().is_some_and(|signal| *signal.borrow()) {
        return Err(StartFailure::Cancelled);
    }
    let cancelled = async {
        let fired = match cancel.as_mut() {
            Some(signal) => signal.wait_for(|cancelled| *cancelled).await.is_ok(),
            None => false,
        };
        if !fired {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        out = tokio::time::timeout_at(until.into(), work) => out.map_err(|_| late),
        () = cancelled => Err(StartFailure::Cancelled),
    }
}

/// The live lane for `id`, starting the child when it has none. A start waits
/// for Core's sealed `next_start_at` (epoch ms) and this owner's restart floor,
/// never holding the owner lock while it waits, and refuses when the wait
/// would pass `until`, as the registry's `plugin call expired before startup`.
/// A lane whose crash is still being reported fails the call
/// ([`StartFailure::Crashed`]) instead of restarting a child Core may be about
/// to mark `failing`; a failing plugin or a closing owner fails it at once.
pub async fn start_lane(
    owner: &SharedOwner,
    id: &str,
    spec: &SpawnSpec,
    next_start_at: Option<u64>,
    until: Instant,
    cancel: Option<&watch::Receiver<bool>>,
) -> Result<Arc<PluginLane>, StartFailure> {
    let mut sealed = next_start_at.and_then(instant_at_epoch_ms);
    loop {
        let wait = {
            let mut guard = bounded(until, cancel, owner.lock(), StartFailure::Deadline).await?;
            if guard.is_closing() {
                return Err(StartFailure::Owner(OwnerError::Closing));
            }
            if let Some(lane) = guard.lane(id).filter(|lane| lane.process().is_alive()) {
                return Ok(lane);
            }
            match sealed.take().filter(|at| *at > Instant::now()) {
                Some(at) => at,
                None => match guard.ensure(id, spec) {
                    Ok(_) => {
                        return guard.lane(id).ok_or_else(|| {
                            StartFailure::Owner(OwnerError::UnknownPlugin(id.into()))
                        });
                    }
                    Err(OwnerError::Backoff { at, .. }) => at,
                    Err(OwnerError::Retiring(_)) => {
                        let dead = guard.lane(id);
                        drop(guard);
                        match dead {
                            Some(lane) => {
                                return Err(StartFailure::Crashed(crash_text(&lane, id).await));
                            }
                            None => Instant::now() + RETIRING_RETRY,
                        }
                    }
                    Err(error) => return Err(StartFailure::Owner(error)),
                },
            }
        };
        if wait > until {
            return Err(StartFailure::BeforeStartup);
        }
        bounded(
            until,
            cancel,
            tokio::time::sleep_until(wait.into()),
            StartFailure::BeforeStartup,
        )
        .await?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_ramps_like_the_registry() {
        let ms: Vec<u128> = (1..=7).map(|n| backoff(n).as_millis()).collect();
        assert_eq!(ms, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
        assert_eq!(backoff(usize::MAX), MAX_BACKOFF);
    }

    #[test]
    fn floor_follows_the_last_crash_and_clears() {
        let book = CrashBook::default();
        assert!(book.floor("fx").is_none());
        let before = Instant::now();
        book.record("fx");
        let first = book.floor("fx").map(|at| at.duration_since(before));
        assert!(first.is_some_and(|wait| wait >= Duration::from_secs(1)));
        book.record("fx");
        let second = book.floor("fx").map(|at| at.duration_since(before));
        assert!(second.is_some_and(|wait| wait >= Duration::from_secs(2)));
        assert!(book.floor("other").is_none());
        book.clear("fx");
        assert!(book.floor("fx").is_none());
    }

    #[test]
    fn the_third_crash_marks_failing_until_cleared() {
        let book = CrashBook::default();
        book.record("fx");
        book.record("fx");
        assert!(!book.is_failing("fx"));
        book.record("fx");
        assert!(book.is_failing("fx") && !book.is_failing("other"));
        book.clear("fx");
        assert!(!book.is_failing("fx"));
    }

    #[test]
    fn sealed_start_converts_only_future_epochs() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|now| u64::try_from(now.as_millis()).unwrap_or(u64::MAX))
            .unwrap_or_default();
        assert!(instant_at_epoch_ms(0).is_none());
        assert!(instant_at_epoch_ms(now.saturating_sub(5)).is_none());
        let ahead = instant_at_epoch_ms(now + 1500).map(|at| at.duration_since(Instant::now()));
        assert!(ahead.is_some_and(|wait| wait > Duration::from_millis(1000)));
    }
}
