//! Time for the direct executor: `Date.now()` and `Bun.sleep(…)` (M3 C10).
//!
//! [`Clock::now_ms`] mirrors `Date.now()` (monotonic wall ms as a float, so
//! `endedAt = now_ms / 1000` carries the same integral value as the TS), and
//! [`Clock::sleep`] mirrors `Bun.sleep`, advancing virtual time in tests so a
//! deadline is crossed deterministically without sleeping for real.

use std::future::Future;
use std::pin::Pin;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// The wall clock the direct executor needs: a `Date.now()` and a `Bun.sleep`.
pub trait Clock: Send + Sync {
    /// Milliseconds since the UNIX epoch (`Date.now()`).
    fn now_ms(&self) -> f64;
    /// Pause until the given number of milliseconds have elapsed (`Bun.sleep`).
    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
}

/// The production clock: real wall time and `tokio::time::sleep`.
pub struct TokioClock;

impl Clock for TokioClock {
    fn now_ms(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as f64
    }

    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        Box::pin(async move {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await
        })
    }
}

/// A test clock that starts at a caller-set virtual time, advances only on
/// `sleep`, and can be repositioned so a poll loop crosses a deadline.
pub struct FakeClock {
    now: Mutex<f64>,
    sleeps: Mutex<Vec<u64>>,
}

impl FakeClock {
    /// A clock positioned at `now` ms since the epoch.
    pub fn at(now: f64) -> Self {
        Self {
            now: Mutex::new(now),
            sleeps: Mutex::new(Vec::new()),
        }
    }

    /// Reposition the clock (used to place `now` just past a deadline).
    pub fn set_now(&self, now: f64) {
        if let Ok(mut guard) = self.now.lock() {
            *guard = now;
        }
    }

    /// Every requested pause, in order.
    pub fn sleeps(&self) -> Vec<u64> {
        self.sleeps.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> f64 {
        self.now.lock().map(|g| *g).unwrap_or_default()
    }

    fn sleep(&self, ms: u64) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        if let Ok(mut sleeps) = self.sleeps.lock() {
            sleeps.push(ms);
        }
        if let Ok(mut now) = self.now.lock() {
            *now += ms as f64;
        }
        Box::pin(async {})
    }
}