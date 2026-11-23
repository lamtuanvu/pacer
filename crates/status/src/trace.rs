//! `statusTimer` from `src/usage/trace.ts`: prints `[pacer:status:debug] <phase> <ms>ms`
//! to stderr when `PACER_TRACE_STATUS` is enabled.

use pacer_foundation::Ctx;

/// Traces status phases when `PACER_TRACE_STATUS=1`.
pub struct StatusTimer {
    start: std::time::Instant,
    on: bool,
}

impl StatusTimer {
    pub fn new(ctx: &Ctx) -> Self {
        let on = ctx.env.get("PACER_TRACE_STATUS").is_some_and(|v| v == "1");
        Self {
            start: std::time::Instant::now(),
            on,
        }
    }
    pub fn phase(&mut self, name: &str) {
        if self.on {
            eprintln!(
                "[pacer:status:debug] {} {}ms",
                name,
                self.start.elapsed().as_millis()
            );
        }
        self.start = std::time::Instant::now();
    }
}
