use std::{collections::HashMap, path::PathBuf, time::SystemTime};

/// Explicit process context, also constructible without changing process environment.
#[derive(Debug, Clone)]
pub struct Ctx {
    pub home: PathBuf,
    pub pacer_home: PathBuf,
    pub env: HashMap<String, String>,
    pub now: f64,
}

/// Seconds since the Unix epoch, as the TypeScript `Date.now() / 1000`.
pub fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

impl Ctx {
    pub fn from_env() -> Self {
        let env: HashMap<String, String> = std::env::vars().collect();
        #[allow(deprecated)]
        let home = env
            .get("HOME")
            .map(PathBuf::from)
            .or_else(std::env::home_dir)
            .unwrap_or_else(|| PathBuf::from("/"));
        let pacer_home = env
            .get("PACER_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".pacer"));
        Self::with(home, pacer_home, env, unix_now())
    }

    /// The same context at the current time; long-running servers call this per request.
    pub fn at_now(&self) -> Self {
        Self {
            now: unix_now(),
            ..self.clone()
        }
    }

    pub fn with(
        home: PathBuf,
        pacer_home: PathBuf,
        env: HashMap<String, String>,
        now: f64,
    ) -> Self {
        Self {
            home,
            pacer_home,
            env,
            now,
        }
    }
}
