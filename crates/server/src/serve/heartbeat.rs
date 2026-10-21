//! Core liveness for `/health`, matching the Bun listener: the core answers a probe every
//! second, and health turns 503 once the last answer is older than 45 seconds.
use super::core_child::CoreChild;
use axum::{
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use hyper_util::{
    client::legacy::{Client, connect::HttpConnector},
    rt::TokioExecutor,
};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::time::Instant;

pub const MAX_AGE: Duration = Duration::from_secs(45);

pub struct Heartbeat {
    origin: Instant,
    /// Milliseconds after `origin` of the last answered probe.
    last: AtomicU64,
}
impl Default for Heartbeat {
    fn default() -> Self {
        Self::new()
    }
}
impl Heartbeat {
    /// Starts fresh, so a core that is still starting gets the full grace period.
    pub fn new() -> Self {
        Self {
            origin: Instant::now(),
            last: AtomicU64::new(0),
        }
    }
    pub fn beat(&self) {
        let ms = u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.last.store(ms, Ordering::Relaxed);
    }
    pub fn lag(&self) -> Duration {
        self.origin
            .elapsed()
            .saturating_sub(Duration::from_millis(self.last.load(Ordering::Relaxed)))
    }
    pub fn response(&self) -> Response {
        let lag = self.lag();
        let ok = lag <= MAX_AGE;
        let status = if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        (
            status,
            [("x-pacer", "1")],
            axum::Json(serde_json::json!({
                "ok": ok,
                "pid": std::process::id(),
                "backendLagS": lag.as_secs_f64(),
            })),
        )
            .into_response()
    }
}

/// Probes the current core generation once a second until the task is aborted.
pub async fn run(core: Arc<CoreChild>, heartbeat: Arc<Heartbeat>) {
    let client: Client<HttpConnector, Body> = Client::builder(TokioExecutor::new()).build_http();
    loop {
        tokio::time::sleep(Duration::from_secs(1)).await;
        let Some((port, token)) = core.target().await else {
            continue;
        };
        let request = Request::get(format!("http://127.0.0.1:{port}/health"))
            .header("host", format!("127.0.0.1:{port}"))
            .header("authorization", format!("Bearer {token}"))
            .body(Body::empty());
        let Ok(request) = request else { continue };
        if client
            .request(request)
            .await
            .is_ok_and(|response| response.status().is_success())
        {
            heartbeat.beat();
        }
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test(start_paused = true)]
    async fn health_turns_503_after_45_seconds_without_a_beat() {
        let heartbeat = Heartbeat::new();
        tokio::time::advance(Duration::from_secs(30)).await;
        assert_eq!(heartbeat.response().status(), StatusCode::OK);
        heartbeat.beat();
        tokio::time::advance(Duration::from_secs(46)).await;
        let response = heartbeat.response();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(response.headers()["x-pacer"], "1");
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["ok"], false);
        assert_eq!(body["pid"], std::process::id());
        assert!(body["backendLagS"].as_f64().unwrap() >= 46.0);
        heartbeat.beat();
        assert_eq!(heartbeat.response().status(), StatusCode::OK);
    }
}
