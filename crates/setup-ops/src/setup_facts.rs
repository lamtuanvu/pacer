//! Native facts of `setupCheckFacts` (`src/setup/check.ts:66-105`) and the
//! `setupCheckParts` envelope (`src/api/setup-check-bridge.ts:10-22`).
//!
//! Rust owns the checklist rules (`setup_checklist`) and the gate (`setup_gate`);
//! this module replaces the `/_internal/setup-check` bridge with reads Rust can
//! do itself. Only two readings stay with Core behind [`SetupHost`]: the plugin
//! registry snapshot (policy summary) and the cached status parts (G2, via
//! `status_sync {"cacheOnly":true}`). Key order matches TypeScript so the wire
//! reply is byte-identical after `JSON.stringify`.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{LazyLock, Mutex},
    time::Duration,
};

/// S2's plugin-registry snapshot carrier, defined locally until that slice lands
/// on this stack. A host returns the registry entries Core owns.
pub type EntriesFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Vec<Value>, CoreError>> + Send + 'a>>;

/// The two Core readings the checklist facts need, plus a test seam for the
/// parity driver (which replays the facts TypeScript gathered for the same home).
pub trait SetupHost: Send {
    /// `PluginRegistry.refresh` then its entries (S2 private `snapshot` kind).
    fn plugins<'a>(&'a mut self, ctx: &'a Ctx) -> EntriesFuture<'a>;
    /// Cached status from `status_sync` with `{"cacheOnly": true}` (G2).
    fn cached_status_parts(&mut self) -> OpFuture<'_>;
    /// Parity-driver seam: facts already gathered by TypeScript for this home.
    /// The served doors leave this `None`, so facts are gathered natively.
    fn facts_override(&mut self) -> Option<Value> {
        None
    }
    /// Serve knows its link is reachable; stdio pays for the snapshot probe.
    fn snapshot_probe(&self) -> bool {
        true
    }
}

/// A host built from already-resolved futures, used by both doors and the driver.
pub struct BridgeHost {
    plugins: Option<OpFuture<'static>>,
    status: Option<OpFuture<'static>>,
    status_value: Option<Value>,
    facts: Option<Value>,
    snapshot_probe: bool,
}

impl BridgeHost {
    pub fn new(
        plugins: Option<OpFuture<'static>>,
        status: Option<OpFuture<'static>>,
        facts: Option<Value>,
        snapshot_probe: bool,
    ) -> Self {
        Self {
            plugins,
            status,
            status_value: None,
            facts,
            snapshot_probe,
        }
    }

    /// The stdio door awaits its status bridge before the doctor bridge so the
    /// two calls cannot borrow the child channel at the same time.
    pub fn with_status_value(status: Option<Value>, snapshot_probe: bool) -> Self {
        Self {
            plugins: None,
            status: None,
            status_value: status,
            facts: None,
            snapshot_probe,
        }
    }
}

impl SetupHost for BridgeHost {
    fn plugins<'a>(&'a mut self, _ctx: &'a Ctx) -> EntriesFuture<'a> {
        let pending = self.plugins.take();
        Box::pin(async move {
            match pending {
                None => Ok(Vec::new()),
                Some(future) => {
                    let reply = future.await?;
                    Ok(reply["entries"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default())
                }
            }
        })
    }
    fn cached_status_parts(&mut self) -> OpFuture<'_> {
        let pending = self.status.take();
        let ready = self.status_value.clone();
        Box::pin(async move {
            match pending {
                None => Ok(ready.unwrap_or(Value::Null)),
                Some(future) => future.await,
            }
        })
    }
    fn facts_override(&mut self) -> Option<Value> {
        self.facts.take()
    }
    fn snapshot_probe(&self) -> bool {
        self.snapshot_probe
    }
}

const AGENT_BINS: [(&str, &[&str]); 4] = [
    ("claude-code", &["claude"]),
    ("codex", &["codex"]),
    ("cursor", &["cursor-agent", "cursor"]),
    ("opencode", &["opencode"]),
];
const AGENT_NAMES: [(&str, &str); 4] = [
    ("claude-code", "Claude Code"),
    ("codex", "Codex"),
    ("cursor", "Cursor"),
    ("opencode", "OpenCode"),
];
const AGENTS: [&str; 5] = ["claude-code", "codex", "cursor", "agy", "opencode"];

fn text(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn error_message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// `ctx.which`: an executable file found on the context's PATH. `ctx` carries an
/// explicit environment, so this never consults the process environment.
fn which(ctx: &Ctx, name: &str) -> bool {
    let path = ctx.env.get("PATH").map(String::as_str).unwrap_or("");
    path.split(':').any(|dir| {
        let base = if dir.is_empty() {
            PathBuf::from(".")
        } else {
            PathBuf::from(dir)
        };
        let candidate = base.join(name);
        let meta = fs::metadata(&candidate);
        meta.as_ref().is_ok_and(|meta| meta.is_file())
            && {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    meta.as_ref().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
                }
                #[cfg(not(unix))]
                {
                    true
                }
            }
    })
}

/// `checkParents` of `src/install/atomic.ts`: a redirect outside the macOS root
/// aliases makes an install-file read unsafe.
fn check_parents(path: &Path) -> Result<(), String> {
    for parent in path.ancestors().skip(1) {
        if parent.parent().is_none() {
            break;
        }
        match fs::symlink_metadata(parent) {
            Ok(meta)
                if meta.file_type().is_symlink()
                    && !["/var", "/tmp", "/etc"].contains(&parent.to_string_lossy().as_ref()) =>
            {
                return Err(format!("unsafe integration directory: {}", parent.display()));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string());
            }
            _ => {}
        }
    }
    Ok(())
}

/// `readInstallFile`: only a missing file reads as `None`.
fn read_install_file(path: &Path) -> Result<Option<String>, String> {
    check_parents(path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(meta) if !meta.is_file() => {
            return Err(format!("unsafe integration file: {}", path.display()));
        }
        Ok(_) => {}
    }
    let bytes = fs::read(path).map_err(error_message)?;
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// `readManifest` (`src/install/manifest.ts:51`) over the safe reader.
fn read_manifest(pacer_home: &Path) -> Result<Value, String> {
    let path = pacer_home.join("install-manifest.json");
    match read_install_file(&path)? {
        None => Ok(json!({"version": 1, "planners": {}})),
        Some(raw) => serde_json::from_str(&raw).map_err(error_message),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// `integrationHashes` (`src/core/setup.ts:226-230`): sha256 of each planner
/// record as `JSON.stringify` writes it.
pub fn integration_hashes(pacer_home: &Path) -> Value {
    let mut hashes = Map::new();
    if let Ok(manifest) = read_manifest(pacer_home)
        && let Some(planners) = manifest["planners"].as_object()
    {
        for (key, record) in planners {
            hashes.insert(key.clone(), json!(sha256_hex(pacer_js_json::stringify(record).as_bytes())));
        }
    }
    Value::Object(hashes)
}

/// The TOML-table removal of `src/install/manifest.ts:58-67`: a dotted key may
/// quote its segments, and the table is present only when removing it changes
/// the text.
fn remove_toml_table(raw: &str, table: &str) -> String {
    let lines: Vec<&str> = raw.split_inclusive('\n').collect();
    let mut names: Vec<String> = Vec::new();
    for segment in table.split('.') {
        names = if names.is_empty() {
            vec![segment.to_owned(), format!("\"{segment}\"")]
        } else {
            names
                .iter()
                .flat_map(|prefix| {
                    vec![
                        format!("{prefix}.{segment}"),
                        format!("{prefix}.\"{segment}\""),
                    ]
                })
                .collect()
        };
    }
    let headers: Vec<String> = names.into_iter().map(|name| format!("[{name}]")).collect();
    let mut start = None;
    for name in &headers {
        if let Some(index) = lines.iter().position(|line| {
            line.starts_with(name)
                && line[name.len()..]
                    .trim_start_matches(['\t', ' '])
                    .trim_start_matches('#')
                    .trim()
                    .is_empty()
        }) && (start.is_none() || index < start.unwrap())
        {
            start = Some(index);
        }
    }
    let Some(start) = start else {
        return raw.to_owned();
    };
    let mut end = start + 1;
    while end < lines.len() && !lines[end].starts_with('[') {
        end += 1;
    }
    lines[..start]
        .iter()
        .chain(lines[end..].iter())
        .copied()
        .collect()
}

/// `piecesPresent` (`src/install/manifest.ts:170-185`): the hash-free integrity
/// fallback after an agent edits a managed file. Each undo op must still be
/// visible in the file's text; the JSONC/TOML/hook readers are the same shapes
/// the installer writes.
fn pieces_present(raw: &str, ops: &[Value]) -> bool {
    ops.iter().all(|op| match op["kind"].as_str().unwrap_or("") {
        "block" => {
            let marks = match op["style"].as_str().unwrap_or("") {
                "md" => ["<!-- >>> pacer >>> -->", "<!-- <<< pacer <<< -->"],
                _ => ["# >>> pacer >>>", "# <<< pacer <<<"],
            };
            raw.find(marks[0])
                .and_then(|start| raw[start..].find(marks[1]).map(|end| start + end))
                .is_some()
        }
        "toml-table" => op["table"]
            .as_str()
            .is_some_and(|table| remove_toml_table(raw, table) != raw),
        "json-member" => {
            let Ok(doc) = pacer_config::doc::parse_value(raw) else {
                return false;
            };
            let mut node = &doc;
            for key in op["path"].as_array().into_iter().flatten() {
                let Some(key) = key.as_str() else {
                    return false;
                };
                let Some(next) = node.get(key) else {
                    return false;
                };
                node = next;
            }
            true
        }
        "json-key" => {
            let Ok(doc) = pacer_config::doc::parse_value(raw) else {
                return false;
            };
            op["key"]
                .as_str()
                .and_then(|key| doc.get(key))
                .is_some()
        }
        "hooks" => {
            let Ok(doc) = pacer_config::doc::parse_value(raw) else {
                return false;
            };
            let commands: Vec<&str> = op["commands"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            op["format"].as_str().is_some_and(|format| {
                commands.iter().all(|command| {
                    doc["hooks"].as_object().is_some_and(|events| {
                        events.values().any(|entries| entries.as_array().is_some_and(|entries| {
                            entries.iter().any(|entry| {
                                if format == "cursor" {
                                    entry["command"].as_str() == Some(*command)
                                } else {
                                    entry["hooks"].as_array().is_some_and(|hooks| {
                                        hooks
                                            .iter()
                                            .any(|hook| hook["command"].as_str() == Some(*command))
                                    })
                                }
                            })
                        }))
                    })
                })
            })
        }
        _ => false,
    })
}

/// `integrationIntact` (`src/setup/check.ts:35-39`).
fn integration_intact(file: &Value) -> bool {
    if file["action"].as_str() == Some("moved") {
        let gone = file["path"]
            .as_str()
            .and_then(|path| read_install_file(Path::new(path)).ok())
            .is_none();
        let backup = file["backup"]
            .as_str()
            .and_then(|path| read_install_file(Path::new(path)).ok())
            .is_some();
        return gone && backup;
    }
    let Some(path) = file["path"].as_str() else {
        return false;
    };
    let Ok(Some(raw)) = read_install_file(Path::new(path)) else {
        return false;
    };
    let after = file["afterHash"].as_str().is_some_and(|hash| sha256_hex(raw.as_bytes()) == hash);
    let undo = file["undo"].as_array().cloned().unwrap_or_default();
    after || (!undo.is_empty() && pieces_present(&raw, &undo))
}

/// `currentVersion` (`src/update/version.ts:13-21`): the build define, else the
/// workspace package version when it is a valid semver, else the dev fallback.
pub fn current_version() -> String {
    static VERSION: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));
    if let Some(locked) = VERSION.lock().ok()
        && let Some(version) = locked.as_ref()
    {
        return version.clone();
    }
    let version = if let Some(build) = option_env!("PACER_BUILD_VERSION") {
        build.to_owned()
    } else {
        let parsed: Option<Value> = serde_json::from_str(include_str!("../../../package.json")).ok();
        parsed
            .and_then(|pkg| pkg["version"].as_str().map(str::to_owned))
            .filter(|v| {
                regex::Regex::new(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$")
                    .is_ok_and(|re| re.is_match(v))
            })
            .unwrap_or_else(|| "0.0.0-dev".to_owned())
    };
    if let Some(mut locked) = VERSION.lock().ok() {
        *locked = Some(version.clone());
    }
    version
}

fn account_kind(agent: &str) -> Option<&'static str> {
    match agent {
        "claude-code" => Some("claude"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        "agy" => Some("agy"),
        "opencode" => Some("endpoint"),
        _ => None,
    }
}

/// `runnerDefaults` + `formatRunnerId` (`src/config/runner-id.ts:11-21`).
fn format_planner(strategy: &Value) -> Option<String> {
    let planner = strategy.get("planner")?;
    let agent = text(planner.get("agent"))?;
    let account = text(planner.get("account"));
    let host = text(planner.get("host"));
    let accounts = strategy["accounts"].as_object();
    let mut defaults: HashMap<&str, String> = HashMap::new();
    if let Some(accounts) = accounts {
        for candidate in AGENTS {
            let matches: Vec<&String> = accounts
                .iter()
                .filter(|(_, value)| {
                    account_kind(candidate).is_some_and(|kind| value["kind"].as_str() == Some(kind))
                        && text(value.get("home")).is_none()
                        && text(value.get("orcaAccount")).is_none()
                })
                .map(|(name, _)| name)
                .collect();
            if matches.len() == 1 {
                defaults.insert(candidate, matches[0].clone());
            }
        }
    }
    let mut out = agent.to_owned();
    if let Some(account) = account
        && defaults.get(agent).is_none_or(|default| default != account)
    {
        out.push('#');
        out.push_str(account);
    }
    if let Some(host) = host.filter(|host| *host != "local") {
        out.push('@');
        out.push_str(host);
    }
    Some(out)
}

/// `accountFolder` (`src/install/role.ts:43-47`); Orca folders are not available
/// to the host without an Orca adapter and read as no folder (TS asks the same
/// question through its Orca account reader).
fn account_folder(ctx: &Ctx, account: &Value) -> Option<PathBuf> {
    if account["home"].as_str().is_none_or(str::is_empty) {
        return None;
    }
    let raw = account["home"].as_str()?;
    let trimmed = raw.strip_prefix('~').filter(|rest| rest.starts_with('/'));
    match trimmed {
        Some(rest) => Some(ctx.home.join(rest.trim_start_matches('/'))),
        None => Some(PathBuf::from(raw)),
    }
}

/// `loginIndicator` (`src/install/login.ts:11-37`), cheap file/env reads only.
fn login_indicator(ctx: &Ctx, id: &str, folder: Option<&Path>) -> (bool, String) {
    let env = |key: &str| ctx.env.get(key).is_some_and(|value| !value.is_empty());
    match id {
        "claude-code" => {
            let file = folder
                .map(|folder| folder.join(".claude.json"))
                .or_else(|| {
                    ctx.env
                        .get("CLAUDE_CONFIG_DIR")
                        .map(|dir| Path::new(dir).join(".claude.json"))
                })
                .unwrap_or_else(|| ctx.home.join(".claude.json"));
            let oauth = fs::read_to_string(&file)
                .is_ok_and(|text| text.contains("\"oauthAccount\""));
            (env("ANTHROPIC_API_KEY") || oauth, "run claude and log in".to_owned())
        }
        "codex" => {
            let file = folder
                .map(|folder| folder.join("auth.json"))
                .or_else(|| {
                    ctx.env
                        .get("CODEX_HOME")
                        .map(|dir| Path::new(dir).join("auth.json"))
                })
                .unwrap_or_else(|| ctx.home.join(".codex/auth.json"));
            (
                env("OPENAI_API_KEY") || env("CODEX_API_KEY") || file.exists(),
                "codex login".to_owned(),
            )
        }
        "cursor" => {
            let file = folder
                .map(|folder| folder.join("cli-config.json"))
                .unwrap_or_else(|| ctx.home.join(".cursor/cli-config.json"));
            let auth = fs::read_to_string(&file)
                .ok()
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .and_then(|config| config["authInfo"].as_object().map(|map| !map.is_empty()))
                .unwrap_or(false);
            (env("CURSOR_API_KEY") || auth, "cursor-agent login".to_owned())
        }
        "opencode" => {
            let file = ctx
                .env
                .get("XDG_DATA_HOME")
                .map(|dir| Path::new(dir).join("opencode/auth.json"))
                .unwrap_or_else(|| ctx.home.join(".local/share/opencode/auth.json"));
            (file.exists(), "opencode auth login --standalone".to_owned())
        }
        _ => (true, String::new()),
    }
}

/// `agentPlans` (`src/install/detection.ts:32-53`) read from the install manifest.
fn agent_plans(ctx: &Ctx, manifest: &Value) -> Vec<Value> {
    let installed = manifest["planners"].as_object();
    AGENT_BINS
        .iter()
        .filter(|(_, bins)| bins.iter().any(|bin| which(ctx, bin)))
        .map(|(id, _)| {
            json!({
                "id": id,
                "installed": installed.is_some_and(|map| map.contains_key(*id)),
            })
        })
        .collect()
}

/// `statusFacts` (`src/setup/check.ts:40-42`): consume the same ranked/excluded
/// status view TypeScript reads. `statusBrokerParts` carries `executors` and
/// `planner` additively, so Rust never re-derives `rankExecutors` (which would
/// drift on disabled runners, aliases, eligibility and multiple routing rules).
fn status_facts(status: &Value) -> (Option<Value>, Option<Value>) {
    let executors = status.get("executors").filter(|value| !value.is_null()).cloned();
    let verdict = status["planner"]
        .as_str()
        .and_then(|planner| {
            status["providers"]
                .as_array()?
                .iter()
                .find(|provider| provider["id"].as_str() == Some(planner))
                .and_then(|provider| provider["verdict"].as_str())
                .map(Value::from)
        });
    (executors, verdict)
}

/// `policySummary` (`src/plugins/policy.ts:78-81`): the config mode and the
/// number of healthy policy-contributing entries. Entries come from the S2 host
/// when present; config grants fill the gap while the registry stays in Core.
fn policy_summary(_ctx: &Ctx, entries: &[Value], config: &Value) -> Value {
    let mode = text(config.get("policy").and_then(|policy| policy.get("mode"))).unwrap_or("open");
    let disabled = config["disabled"].as_array().cloned().unwrap_or_default();
    let mut ids: Vec<String> = entries
        .iter()
        .filter(|entry| {
            let healthy = matches!(
                entry["state"].as_str().unwrap_or(""),
                "idle" | "starting" | "ready" | "failing"
            );
            healthy && entry["manifest"]["contributes"].get("policy").is_some()
        })
        .filter_map(|entry| entry["id"].as_str().map(str::to_owned))
        .collect();
    if let Some(installed) = config["installed"].as_object() {
        for (id, grant) in installed {
            if disabled.iter().any(|value| value == id) {
                continue;
            }
            if grant.get("policy").is_some_and(|policy| policy == &json!(false)) {
                continue;
            }
            if !ids.iter().any(|known| known == id) {
                ids.push(id.clone());
            }
        }
    }
    json!({"mode": mode, "plugins": ids.len()})
}

/// The smallest HTTP/1.1 GET the link probe needs: status line plus headers,
/// with `Connection: close` so a chunked body needs no decoding.
async fn http_ok(port: u16, path: &str, token: Option<&str>) -> Result<bool, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::time::timeout(Duration::from_secs(2), tokio::net::TcpStream::connect(("127.0.0.1", port)))
        .await
        .map_err(|_| "timeout".to_owned())?
        .map_err(|_| "connect".to_owned())?;
    let mut request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n");
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");
    tokio::time::timeout(Duration::from_secs(2), stream.write_all(request.as_bytes()))
        .await
        .map_err(|_| "timeout".to_owned())?
        .map_err(|_| "connect".to_owned())?;
    // Stop at the header terminator: a keep-alive or slow body must not delay
    // the probe (TypeScript cancels the body after the response headers).
    let mut head_bytes = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let count = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut chunk))
            .await
            .map_err(|_| "timeout".to_owned())?
            .map_err(|_| "connect".to_owned())?;
        if count == 0 {
            break;
        }
        head_bytes.extend_from_slice(&chunk[..count]);
        if head_bytes.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if head_bytes.len() > 64 * 1024 {
            break;
        }
    }
    let head = String::from_utf8_lossy(&head_bytes);
    let head = head.split("\r\n\r\n").next().unwrap_or(&head);
    let mut lines = head.lines();
    let ok = lines
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .is_some_and(|code| code.starts_with('2'));
    let pacer = lines
        .any(|line| line.eq_ignore_ascii_case("x-pacer: 1"));
    Ok(ok && pacer)
}

/// `fetch` failure wording used by the TS core for the two loopback probe paths.
fn fetch_probe_error(reason: String) -> String {
    if reason == "timeout" {
        "The operation was aborted due to timeout".to_owned()
    } else {
        "Unable to connect. Is the computer able to access the url?".to_owned()
    }
}

/// The link probe of `src/setup/check.ts:71-81`: `/health`, then a bearer probe
/// of `/v2/snapshot`. The token is read but never logged or returned.
async fn link_probe(ctx: &Ctx) -> Result<bool, String> {
    let port = ctx
        .env
        .get("PACER_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(4317);
    // `fetch` in the TS core reports a refused loopback connect with this
    // message; keep the checklist's error detail byte-identical.
    let healthy = http_ok(port, "/health", None)
        .await
        .map_err(fetch_probe_error)?;
    if !healthy {
        return Ok(false);
    }
    let token = fs::read_to_string(ctx.pacer_home.join("token"))
        .map_err(error_message)?
        .trim()
        .to_owned();
    http_ok(port, "/v2/snapshot", Some(&token))
        .await
        .map_err(fetch_probe_error)
}

/// `anyReviewed` (`src/setup/check.ts:24-32`): reviewed is monotonic, so a
/// negative answer is cached until the task store's version changes.
fn any_reviewed(ctx: &Ctx) -> bool {
    static CACHE: LazyLock<Mutex<HashMap<String, (String, bool)>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let Ok(mut store) = pacer_store::TaskStore::open(&ctx.pacer_home) else {
        return false;
    };
    let Ok(version) = store.version() else {
        return false;
    };
    let key = ctx.pacer_home.to_string_lossy().into_owned();
    if let Ok(cache) = CACHE.lock()
        && cache.get(&key).is_some_and(|cached| cached.0 == version)
    {
        return cache.get(&key).is_some_and(|cached| cached.1);
    }
    let reviewed = store.has_reviewed().unwrap_or(false);
    if let Ok(mut cache) = CACHE.lock() {
        cache.insert(key, (version, reviewed));
    }
    reviewed
}

/// `setupCheckFacts` (`src/setup/check.ts:66-105`) plus `setupCheckParts`' extra
/// `policy` field, in TypeScript key order.
pub async fn setup_facts(ctx: &Ctx, snapshot_probe: bool, host: &mut dyn SetupHost) -> Value {
    if let Some(facts) = host.facts_override() {
        return facts;
    }
    let mut errors = Map::new();

    // `loadStrategy` and the planner id.
    let strategy = match pacer_config::strategy::load_strategy(&ctx.pacer_home) {
        Ok(strategy) => Some(strategy),
        Err(error) => {
            errors.insert("strategy".into(), json!(error.to_string()));
            None
        }
    };
    let planner = strategy.as_ref().and_then(|strategy| {
        text(strategy.get("planner").and_then(|planner| planner.get("agent"))).map(str::to_owned)
    });

    // `serviceBackend(ctx).status(2000)`, reduced to the two fields the rules read.
    // When this home has no registration file there is no service to ask about:
    // report both false without probing the machine's real launchd/systemd label.
    let registration = if cfg!(target_os = "macos") {
        ctx.home
            .join("Library/LaunchAgents/com.pacer.serve.plist")
    } else {
        ctx.home.join(".config/systemd/user/pacer-serve.service")
    };
    let service = if !registration.exists() {
        json!({"installed": false, "running": false})
    } else {
        match pacer_update::service_status(ctx, json!({})).await {
            Ok(status) => json!({
                "installed": status["installed"] == json!(true),
                "running": status["running"] == json!(true),
            }),
            Err(error) => {
                errors.insert("service".into(), json!(error.message));
                json!({"installed": false, "running": false})
            }
        }
    };

    // Serve-side checks know the link is reachable; the probe is a stdio-only cost.
    let link = if !snapshot_probe {
        true
    } else {
        match link_probe(ctx).await {
            Ok(link) => link,
            Err(error) => {
                errors.insert("link".into(), json!(error));
                false
            }
        }
    };

    let manifest = match read_manifest(&ctx.pacer_home) {
        Ok(manifest) => manifest,
        Err(error) => {
            errors.insert("connect".into(), json!(error));
            json!({"version": 1, "planners": {}})
        }
    };
    let plans = agent_plans(ctx, &manifest);
    let agents: Vec<Value> = AGENT_NAMES
        .iter()
        .map(|(id, name)| {
            json!({
                "id": id,
                "name": name,
                "installed": plans.iter().any(|plan| plan["id"] == json!(id) && plan["installed"] == json!(true)),
                "cliInstalled": plans.iter().any(|plan| plan["id"] == json!(id)),
            })
        })
        .collect();

    // Integration readiness: one generic record check, no plugin startup.
    let account = strategy.as_ref().and_then(|strategy| {
        let name = strategy["planner"]["account"].as_str()?;
        strategy["accounts"].get(name)
    });
    let folder = account.and_then(|account| account_folder(ctx, account));
    let logged_in = planner
        .as_deref()
        .map(|planner| login_indicator(ctx, planner, folder.as_deref()));
    let mut connected = false;
    match recorder_key(strategy.as_ref(), planner.as_deref()) {
        None => {}
        Some(key) => match manifest["planners"].get(&key) {
            None => {}
            Some(record) => {
                let live: Vec<Value> = record["files"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|file| file["action"].as_str() != Some("moved"))
                    .collect();
                connected = !live.is_empty() && live.iter().all(integration_intact);
            }
        },
    }
    // A warn-level Claude hook check invalidates an otherwise intact integration.
    if planner.as_deref() == Some("claude-code")
        && claude_hooks_warn(ctx, strategy.as_ref())
    {
        connected = false;
    }
    let signed_in = logged_in.as_ref().is_none_or(|(logged_in, _)| *logged_in);
    let login_command = logged_in
        .as_ref()
        .and_then(|(_, fix)| (!fix.is_empty()).then(|| fix.clone()));

    // Cached status (G2). A missing Core reply leaves the status-derived rows pending.
    let status = match host.cached_status_parts().await {
        Ok(status) => status,
        Err(error) => {
            errors.insert("status".into(), json!(error.message));
            Value::Null
        }
    };
    let (executors, verdict) = status_facts(&status);

    let skipped = ctx.pacer_home.join("onboarding/skipped").exists();
    let entries = match host.plugins(ctx).await {
        Ok(entries) => entries,
        Err(error) => {
            errors.insert("policy".into(), json!(error.message));
            Vec::new()
        }
    };
    let config = match pacer_plugin_ops::config::read_config(ctx) {
        Ok(config) => config,
        Err(error) => {
            errors.insert("policy".into(), json!(error.message));
            json!({"policy":{"mode":"open"},"disabled":[],"installed":{},"config":{}})
        }
    };

    let mut facts = Map::new();
    facts.insert("version".into(), json!(current_version()));
    // TS formats with `host: null`: a configured remote host is not part of the
    // planner fact (`src/setup/check.ts:105`).
    facts.insert(
        "planner".into(),
        strategy
            .as_ref()
            .and_then(|strategy| {
                let mut local = strategy.clone();
                if let Some(planner) = local.get_mut("planner") {
                    planner["host"] = Value::Null;
                }
                format_planner(&local)
            })
            .map(Value::from)
            .or_else(|| planner.as_deref().map(Value::from))
            .unwrap_or(Value::Null),
    );
    facts.insert("signedIn".into(), json!(signed_in));
    match login_command {
        Some(command) => {
            facts.insert("loginCommand".into(), json!(command));
        }
        None => {}
    }
    facts.insert("connected".into(), json!(connected));
    facts.insert("service".into(), service);
    facts.insert("link".into(), json!(link));
    if let Some(executors) = executors {
        facts.insert("executors".into(), executors);
    }
    if let Some(verdict) = verdict {
        facts.insert("verdict".into(), verdict);
    }
    facts.insert("reviewed".into(), json!(any_reviewed(ctx)));
    facts.insert("skipped".into(), json!(skipped));
    facts.insert("agents".into(), Value::Array(agents));
    facts.insert("errors".into(), Value::Object(errors));
    facts.insert("policy".into(), policy_summary(ctx, &entries, &config));
    Value::Object(facts)
}

/// The manifest key TS reads: `<planner>#<account>` for a named account, else
/// the planner id (`src/setup/check.ts:89`).
fn recorder_key(strategy: Option<&Value>, planner: Option<&str>) -> Option<String> {
    let planner = planner?;
    let strategy = strategy?;
    let account = strategy["planner"]["account"].as_str()?;
    let named = strategy["accounts"].get(account)?["source"].as_str() != Some("default");
    if named {
        Some(format!("{planner}#{account}"))
    } else {
        Some(planner.to_owned())
    }
}

/// `executablePresent` of `src/install/doctor-hooks.ts:29-33`.
fn executable_present(ctx: &Ctx, command: &str) -> bool {
    if command.contains('/') {
        let path = Path::new(command);
        let meta = fs::metadata(path);
        let file = meta.as_ref().is_ok_and(|meta| meta.is_file());
        let executable = {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                meta.as_ref().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
            }
            #[cfg(not(unix))]
            {
                true
            }
        };
        file && executable
    } else {
        which(ctx, command)
    }
}

/// `resolve` of the TS hook check: both sides of the CLAUDE_CONFIG_DIR
/// comparison are absolute paths in the service environment.
fn resolve_like(ctx: &Ctx, value: &str) -> PathBuf {
    let path = Path::new(value);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        ctx.home.join(path)
    }
}

/// Only the "Claude hook configuration" check matters to `setupCheckFacts`:
/// a warn level invalidates the integration. This mirrors
/// `claudeHookChecks` (`src/install/doctor-hooks.ts:36-100`) exactly: the guard
/// group's matcher, exact command equality and executable availability all
/// participate in the verdict.
fn claude_hooks_warn(ctx: &Ctx, strategy: Option<&Value>) -> bool {
    let account = strategy.and_then(|strategy| {
        let name = strategy["planner"]["account"].as_str()?;
        strategy["accounts"].get(name)
    });
    if account.is_some_and(|account| {
        account["source"].as_str() != Some("default") && account_folder(ctx, account).is_none()
    }) {
        return true;
    }
    let folder = account
        .and_then(|account| account_folder(ctx, account))
        .unwrap_or_else(|| ctx.home.join(".claude"));
    let mismatch = ctx
        .env
        .get("CLAUDE_CONFIG_DIR")
        .is_some_and(|dir| resolve_like(ctx, dir) != folder);
    if mismatch {
        return true;
    }
    let Some(raw) = fs::read_to_string(folder.join("settings.json")).ok() else {
        return true;
    };
    let Ok(settings) = pacer_config::doc::parse_value(&raw) else {
        return true;
    };
    if matches!(settings.get("disableAllHooks"), Some(value) if !value.is_boolean()) {
        return true;
    }
    if settings["disableAllHooks"] == json!(true) {
        return true;
    }

    // `prefixes` starts with pacer itself, then the pacerArgv of each installed
    // Claude integration. A registered command whose executable is missing
    // invalidates the check even when another prefix matches.
    let mut prefixes: Vec<(String, bool)> =
        vec![("pacer".to_owned(), executable_present(ctx, "pacer"))];
    if let Ok(manifest) = read_manifest(&ctx.pacer_home)
        && let Some(planners) = manifest["planners"].as_object()
    {
        for record in planners.values() {
            if record["planner"].as_str().is_some_and(|id| id.starts_with("claude-code")) {
                let argv = record["pacerArgv"].as_array().cloned().unwrap_or_default();
                let prefix = argv
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
                let available = executable_present(ctx, argv.first().and_then(Value::as_str).unwrap_or("pacer"));
                if let Some(entry) = prefixes.iter_mut().find(|entry| entry.0 == prefix) {
                    entry.1 = available;
                } else {
                    prefixes.push((prefix, available));
                }
            }
        }
    }

    let missing = std::cell::Cell::new(false);
    let has = |event: &str, suffix: &str, matcher: Option<&str>| -> bool {
        settings["hooks"][event].as_array().is_some_and(|groups| {
            groups.iter().any(|group| {
                let group_matches = match matcher {
                    Some(expected) => group["matcher"].as_str() == Some(expected),
                    None => group["matcher"]
                        .as_str()
                        .is_none_or(|value| value.is_empty() || value == "*"),
                };
                group_matches
                    && group["hooks"].as_array().is_some_and(|hooks| {
                        hooks.iter().any(|hook| {
                            hook["type"].as_str() == Some("command")
                                && hook["async"] != json!(true)
                                && hook["command"].as_str().is_some_and(|command| {
                                    prefixes.iter().any(|(prefix, available)| {
                                        if command == format!("{prefix} {suffix}") {
                                            if !available {
                                                missing.set(true);
                                            }
                                            *available
                                        } else {
                                            false
                                        }
                                    })
                                })
                        })
                    })
            })
        })
    };
    let session = has("SessionStart", "status --hook claude-code", None)
        || has("SessionStart", "msg hook session --planner claude-code", None);
    let guard = has("PreToolUse", "guard --planner claude-code", Some("Agent|Task|Bash"));
    !(session && guard && !missing.get())
}

#[cfg(test)]
mod tests;
