//! The service's login PATH cache (`src/exec/login-env.ts`): run the user's
//! login shell to learn the PATH a terminal would give, and cache it briefly so
//! status can read it without waiting on a shell. Only the composed PATH is
//! kept (the plan's slice); values live in memory only, never logged.

use pacer_js_json::stringify as js_stringify;
use serde_json::json;
use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// Marker strings copied from src/exec/login-env.ts at HEAD.
const MARKER: &str = "__PACER_LOGIN_ENV__";
// A fixed command: no user or API text reaches the shell (SEC-5). `exec`
// skips logout scripts.
const COMMAND: &str =
    "echo __PACER_LOGIN_UMASK__; umask; echo __PACER_LOGIN_ENV__; exec /usr/bin/env -0";
/// `PROFILE_KEYS` (login-env.ts:33): variables withheld from the login shell
/// so their presence in its output means the profile set them.
const PROFILE_KEYS: [&str; 4] = ["NO_COLOR", "FORCE_COLOR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
const LOGIN_ENV_TIMEOUT: Duration = Duration::from_millis(5000);
const TTL: Duration = Duration::from_millis(60_000);
const MAX_STDOUT: usize = 4 * 1024 * 1024;
const NAME_RE: &str = "^[A-Za-z_][A-Za-z0-9_]*$";
/// `SHELL_STATE` (login-env.ts:44): state of the shell, not the profile.
const SHELL_STATE: [&str; 4] = ["_", "PWD", "OLDPWD", "SHLVL"];

fn regex() -> Option<regex::Regex> {
    regex::Regex::new(NAME_RE).ok()
}

/// `pacerOwned` (login-env.ts:46): pacer's own coordinates and capabilities.
fn pacer_owned(key: &str) -> bool {
    key == "HOME" || key.starts_with("PACER_")
}

/// `loginDisabled` (login-env.ts:188).
fn login_disabled(env: &HashMap<String, String>) -> bool {
    let from_ctx = env.get("PACER_LOGIN_ENV").map(String::as_str);
    let from_os = std::env::var("PACER_LOGIN_ENV").ok();
    let value = from_ctx.or(from_os.as_deref());
    value == Some("off")
}

/// `loginShell` (login-env.ts:54-59): `$SHELL` if absolute and existing,
/// else the account's shell from the passwd database.
pub fn login_shell(env: &HashMap<String, String>) -> Option<PathBuf> {
    for candidate in [
        env.get("SHELL").map(String::as_str),
        passwd_shell().as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let p = PathBuf::from(candidate);
        if p.is_absolute() && p.exists() {
            return Some(p);
        }
    }
    None
}

fn passwd_shell() -> Option<String> {
    // Safe port of `os.userInfo().shell` (no unsafe): match the current
    // user's login name ($USER / $LOGNAME) in /etc/passwd and take the
    // account shell. This is the fallback only when $SHELL is unset or
    // not an existing absolute path.
    let name = std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("LOGNAME").ok())?;
    let content = std::fs::read_to_string("/etc/passwd").ok()?;
    let prefix = format!("{name}:");
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix(&prefix) {
            let mut fields = rest.split(':');
            fields.next();
            fields.next();
            fields.next();
            fields.next();
            fields.next();
            return fields.next().map(str::to_string);
        }
    }
    None
}

/// `spawnEnvOf` (login-env.ts:189): the service env the login shell sees.
fn spawn_env_of(service: &HashMap<String, String>) -> HashMap<String, String> {
    service
        .iter()
        .filter(|(k, _)| !k.starts_with("PACER_") && !PROFILE_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// `cacheKey` (login-env.ts:191): sha256 of the fixed input, so the cache
/// never holds the service environment's values as keys.
fn cache_key(shell: &Path, cwd: &Path, spawn_env: &HashMap<String, String>) -> String {
    use sha2::{Digest, Sha256};
    let mut entries: Vec<(&String, &String)> = spawn_env.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    let arr: serde_json::Value = json!([
        shell.display().to_string(),
        cwd.display().to_string(),
        entries
            .iter()
            .map(|(k, v)| json!([k, v]))
            .collect::<Vec<_>>(),
    ]);
    let text = js_stringify(&arr);
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

/// `parseLoginEnv` (login-env.ts:62-72): `env -0` output after the marker;
/// profile output before it is ignored.
fn parse_login_env(stdout: &str) -> Option<HashMap<String, String>> {
    let marker = format!("{MARKER}\n");
    let at = stdout.find(&marker)?;
    let rest = &stdout[at + marker.len()..];
    let name = regex()?;
    let mut env = HashMap::new();
    for entry in rest.split('\0') {
        // Skip entries without `=` and empty keys, matching TS `eq > 0`.
        let Some(eq) = entry.find('=') else { continue };
        if eq == 0 {
            continue;
        }
        let key = &entry[..eq];
        let value = &entry[eq + 1..];
        if name.is_match(key) && !SHELL_STATE.contains(&key) {
            env.insert(key.to_string(), value.to_string());
        }
    }
    if env.is_empty() { None } else { Some(env) }
}

/// `composeTerminalEnv(service, login).PATH` (login-env.ts:92-97): login
/// variables over the service's, then pacer's own on top.
fn compose_path(service: &HashMap<String, String>, login: &HashMap<String, String>) -> String {
    let mut env = service.clone();
    for (k, v) in login {
        if !pacer_owned(k) {
            env.insert(k.clone(), v.clone());
        }
    }
    for (k, v) in service {
        if pacer_owned(k) {
            env.insert(k.clone(), v.clone());
        }
    }
    env.get("PATH").cloned().unwrap_or_default()
}

/// Run the login shell and learn the PATH it would set (the `capture`
/// reduced to the composed PATH). `tokio::process::Command` with stdin
/// `/dev/null`, `kill_on_drop`, a 5 s timeout and a 4 MiB stdout cap.
async fn capture(
    shell: &Path,
    spawn_env: &HashMap<String, String>,
    cwd: &Path,
) -> Result<String, String> {
    let mut command = tokio::process::Command::new(shell);
    command
        .args(["-l", "-i", "-c", COMMAND])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .env_clear()
        .env("PWD", cwd);
    for (k, v) in spawn_env {
        command.env(k, v);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("the login shell could not be started: {e}"))?;
    let stdout = child.stdout.take();
    let read = async {
        let mut buf: Vec<u8> = Vec::new();
        if let Some(mut s) = stdout {
            use tokio::io::AsyncReadExt;
            let mut limited = (&mut s).take((MAX_STDOUT + 1) as u64);
            let _ = limited.read_to_end(&mut buf).await;
        }
        let overflow = buf.len() > MAX_STDOUT;
        (buf, overflow)
    };
    let res = tokio::time::timeout(LOGIN_ENV_TIMEOUT, read).await;
    let (out, overflow) = match res {
        Err(_) => {
            return Err(format!(
                "the login shell did not finish within {}s",
                LOGIN_ENV_TIMEOUT.as_secs()
            ));
        }
        Ok((buf, overflow)) => (buf, overflow),
    };
    let _ = child.wait().await;
    if overflow {
        return Err("the login shell printed too much output".to_string());
    }
    let text = String::from_utf8_lossy(&out);
    match parse_login_env(&text) {
        Some(login) => Ok(compose_path(spawn_env, &login)),
        None => Err("the login shell printed no environment".to_string()),
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

struct Entry {
    at: f64,
}

/// `terminalEnv` / `cachedLoginPath` port for the login PATH (login-env.ts:
/// 193-233). `warm` may spawn a login shell; `cached` never does.
pub struct LoginPaths {
    cache: Mutex<HashMap<String, Entry>>,
    known: Mutex<HashMap<String, String>>,
    spawn_serial: tokio::sync::Mutex<()>,
}

impl LoginPaths {
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            cache: Mutex::new(HashMap::new()),
            known: Mutex::new(HashMap::new()),
            spawn_serial: tokio::sync::Mutex::new(()),
        })
    }

    /// `terminalEnv(service, {cwd})` reduced to the PATH it records. Spawns
    /// nothing when `PACER_LOGIN_ENV=off`, when there is no login shell, or
    /// when a fresh entry for the key already exists (failures are cached,
    /// login-env.ts:211). Single-flight per key.
    pub async fn warm(&self, service_env: &HashMap<String, String>, cwd: &Path) {
        if login_disabled(service_env) {
            return;
        }
        let Some(shell) = login_shell(service_env) else {
            return;
        };
        let spawn_env = spawn_env_of(service_env);
        let key = cache_key(&shell, cwd, &spawn_env);
        let now = now_ms();
        {
            let mut cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            cache.retain(|_, e| now - e.at < TTL.as_millis() as f64);
            if let Some(entry) = cache.get(&key)
                && now - entry.at < TTL.as_millis() as f64
            {
                return;
            }
        }
        let _guard = self.spawn_serial.lock().await;
        {
            let cache = self.cache.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(entry) = cache.get(&key)
                && now - entry.at < TTL.as_millis() as f64
            {
                return;
            }
        }
        let outcome = capture(&shell, &spawn_env, cwd).await;
        match outcome {
            Ok(path) => {
                self.known
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(key.clone(), path);
                self.cache
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(key, Entry { at: now });
            }
            Err(_) => {
                self.known
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&key);
                self.cache
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .insert(key, Entry { at: now });
            }
        }
    }

    /// `cachedLoginPath` (login-env.ts:229-234): never spawns. Returns the
    /// last login PATH for this service environment, kept past the TTL.
    pub fn cached(&self, service_env: &HashMap<String, String>, cwd: &Path) -> Option<String> {
        if login_disabled(service_env) {
            return None;
        }
        let shell = login_shell(service_env)?;
        let key = cache_key(&shell, cwd, &spawn_env_of(service_env));
        self.known
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .cloned()
    }
}

/// `onPath` (login-env.ts:111-118): an executable named `name` on `PATH`
/// as an absolute path. Skips relative entries and non-executable files.
pub fn on_path(path_var: &str, name: &str) -> Option<PathBuf> {
    for dir in path_var.split(':') {
        if dir.is_empty() || !Path::new(dir).is_absolute() {
            continue;
        }
        let file = Path::new(dir).join(name);
        if let Ok(meta) = std::fs::metadata(&file)
            && meta.is_file()
            && meta.permissions().mode() & 0o111 != 0
        {
            return Some(file);
        }
    }
    None
}
