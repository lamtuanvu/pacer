//! Issue #503 privacy and planner restrictions, transcribed from the TS host.
use crate::BrokerError;
use hmac::{Hmac, Mac};
use nix::{
    errno::Errno,
    fcntl::{AtFlags, OFlag, open, openat},
    sys::stat::{Mode, mkdirat},
    unistd::{Uid, UnlinkatFlags, linkat, unlinkat},
};
use serde_json::{Value, json};
use sha2::Sha256;
use std::{
    collections::HashMap,
    fs::{self, File, Permissions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
};

pub fn planner_environment(env: &HashMap<String, String>) -> HashMap<String, String> {
    let allowed = [
        "HOME",
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "OPENCODE_CONFIG_DIR",
    ];
    env.iter()
        .filter(|(key, _)| allowed.contains(&key.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}
pub fn allowed_planner_command(scope: &str, argv: &[String], pacer_argv: &[String]) -> bool {
    if scope != "claude" || argv.is_empty() {
        return false;
    }
    let args = &argv[1..];
    if args == ["mcp", "get", "pacer"] || args == ["mcp", "remove", "-s", "user", "pacer"] {
        return true;
    }
    let expected: Vec<String> = ["mcp", "add", "-s", "user", "pacer", "--"]
        .into_iter()
        .map(str::to_owned)
        .chain(pacer_argv.iter().cloned())
        .chain(["mcp".into()])
        .collect();
    args == expected
}

fn strip_legacy_metadata(params: &mut Value) {
    let keys: &[&str] = match params["decision"].as_str() {
        Some("delegate") => &["goalLength", "goalHash", "repoKey"],
        Some("review") => &["noteLength", "noteHash"],
        _ => &[],
    };
    if let Some(input) = params.get_mut("input").and_then(Value::as_object_mut) {
        for key in keys {
            input.remove(*key);
        }
    }
}
pub struct PolicyPrivacy {
    master: [u8; 32],
}

pub struct PolicyDetailAccess {
    pub manifest: crate::ParsedManifest,
    pub granted: Vec<String>,
    pub bundled: bool,
    pub redaction_metadata: bool,
}
pub struct PrivatePolicyCaller<C> {
    pub caller: C,
    home: std::path::PathBuf,
    access: HashMap<String, PolicyDetailAccess>,
}
impl<C> PrivatePolicyCaller<C> {
    pub fn new(home: &Path, caller: C, access: HashMap<String, PolicyDetailAccess>) -> Self {
        Self {
            caller,
            home: home.into(),
            access,
        }
    }
}
impl<C: crate::PolicyCaller> crate::PolicyCaller for PrivatePolicyCaller<C> {
    async fn call(
        &mut self,
        id: &str,
        params: Value,
        deadline: std::time::Instant,
    ) -> Result<Value, BrokerError> {
        let access = self
            .access
            .get(id)
            .ok_or(BrokerError::Invalid("policy access snapshot"))?;
        let can_read = access
            .manifest
            .capabilities
            .iter()
            .any(|c| c.name.to_string() == "tasks.read")
            && (access.bundled || access.granted.iter().any(|g| g == "tasks.read"));
        let needs_key = !can_read
            && (params["decision"] == "delegate"
                || (params["decision"] == "review" && params["input"].get("note").is_some()));
        let mut wire = if needs_key {
            PolicyPrivacy::load(&self.home)?.redact(
                id,
                &params,
                false,
                access.redaction_metadata,
            )?
        } else {
            params
        };
        if !access.redaction_metadata {
            strip_legacy_metadata(&mut wire);
        }
        self.caller.call(id, wire, deadline).await
    }
    fn failure(&mut self, id: &str, reason: &str) {
        self.caller.failure(id, reason);
    }
    fn veto(&mut self, id: &str, reason: &str) {
        self.caller.veto(id, reason);
    }
}
impl Drop for PolicyPrivacy {
    fn drop(&mut self) {
        self.master.fill(0);
    }
}
fn key_error() -> BrokerError {
    BrokerError::PolicyKey
}
fn hmac(key: &[u8], input: &[u8]) -> Result<[u8; 32], BrokerError> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(|_| key_error())?;
    mac.update(input);
    Ok(mac.finalize().into_bytes().into())
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
impl PolicyPrivacy {
    pub fn from_master(master: [u8; 32]) -> Self {
        Self { master }
    }
    /// Explicit sandbox/home path only. Atomic exclusive publication never replaces a concurrent winner.
    pub fn load(home: &Path) -> Result<Self, BrokerError> {
        let flags = OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC;
        let root = File::from(open(home, flags, Mode::empty()).map_err(|_| key_error())?);
        match mkdirat(&root, "state", Mode::S_IRWXU) {
            Ok(()) | Err(Errno::EEXIST) => {}
            Err(_) => return Err(key_error()),
        }
        let directory =
            File::from(openat(&root, "state", flags, Mode::empty()).map_err(|_| key_error())?);
        let meta = directory.metadata().map_err(|_| key_error())?;
        if meta.uid() != Uid::current().as_raw() {
            return Err(key_error());
        }
        directory
            .set_permissions(Permissions::from_mode(0o700))
            .map_err(|_| key_error())?;
        let read_flags = OFlag::O_RDONLY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC | OFlag::O_NONBLOCK;
        let existing = openat(&directory, "policy-hmac.key", read_flags, Mode::empty());
        let file = match existing {
            Ok(fd) => File::from(fd),
            Err(Errno::ENOENT) => {
                let name = format!("policy-hmac.{}.tmp", uuid::Uuid::new_v4());
                let mut temp = File::from(
                    openat(
                        &directory,
                        name.as_str(),
                        OFlag::O_WRONLY
                            | OFlag::O_CREAT
                            | OFlag::O_EXCL
                            | OFlag::O_NOFOLLOW
                            | OFlag::O_CLOEXEC,
                        Mode::S_IRUSR | Mode::S_IWUSR,
                    )
                    .map_err(|_| key_error())?,
                );
                let created = (|| {
                    let mut key = [0; 32];
                    getrandom::fill(&mut key).map_err(|_| key_error())?;
                    temp.set_permissions(Permissions::from_mode(0o600))
                        .map_err(|_| key_error())?;
                    temp.write_all(&key).map_err(|_| key_error())?;
                    key.fill(0);
                    temp.sync_all().map_err(|_| key_error())?;
                    match linkat(
                        &directory,
                        name.as_str(),
                        &directory,
                        "policy-hmac.key",
                        AtFlags::empty(),
                    ) {
                        Ok(()) | Err(Errno::EEXIST) => Ok(()),
                        Err(_) => Err(key_error()),
                    }
                })();
                unlinkat(&directory, name.as_str(), UnlinkatFlags::NoRemoveDir)
                    .map_err(|_| key_error())?;
                created?;
                File::from(
                    openat(&directory, "policy-hmac.key", read_flags, Mode::empty())
                        .map_err(|_| key_error())?,
                )
            }
            Err(_) => return Err(key_error()),
        };
        let meta = file.metadata().map_err(|_| key_error())?;
        if !meta.is_file()
            || meta.uid() != Uid::current().as_raw()
            || meta.mode() & 0o777 != 0o600
            || meta.len() != 32
        {
            return Err(key_error());
        }
        let named = fs::symlink_metadata(home.join("state")).map_err(|_| key_error())?;
        let opened = directory.metadata().map_err(|_| key_error())?;
        if !named.is_dir() || named.dev() != opened.dev() || named.ino() != opened.ino() {
            return Err(key_error());
        }
        let mut master = [0; 32];
        let mut file = file;
        file.read_exact(&mut master).map_err(|_| key_error())?;
        Ok(Self { master })
    }
    pub fn redact(
        &self,
        plugin_id: &str,
        params: &Value,
        can_read_detail: bool,
        metadata_negotiated: bool,
    ) -> Result<Value, BrokerError> {
        let mut wire = params.clone();
        if !metadata_negotiated {
            strip_legacy_metadata(&mut wire);
        }
        if can_read_detail {
            return Ok(wire);
        }
        let key = hmac(&self.master, plugin_id.as_bytes())?;
        let opaque = |value: &Value| -> Result<String, BrokerError> {
            Ok(hex(&hmac(&key, js_canonical_json(value)?.as_bytes())?))
        };
        match params["decision"].as_str() {
            Some("delegate") => {
                let goal = params["input"]["goal"]
                    .as_str()
                    .ok_or(BrokerError::Invalid("policy goal"))?;
                let repo = &params["input"]["repo"];
                let repo_key = opaque(repo)?;
                wire["input"]["goal"] = json!("");
                wire["input"]["repo"] = json!(format!("repo:{repo_key}"));
                if metadata_negotiated {
                    wire["input"]["goalLength"] = json!(crate::js_semantics::utf16_len(goal));
                    wire["input"]["goalHash"] = json!(opaque(&json!(goal))?);
                    wire["input"]["repoKey"] = json!(repo_key);
                }
            }
            Some("review") => {
                if let Some(note) = params["input"].get("note") {
                    let note = note.as_str().ok_or(BrokerError::Invalid("policy note"))?;
                    wire["input"]
                        .as_object_mut()
                        .ok_or(BrokerError::Invalid("policy input"))?
                        .remove("note");
                    if metadata_negotiated {
                        wire["input"]["noteLength"] = json!(crate::js_semantics::utf16_len(note));
                        wire["input"]["noteHash"] = json!(opaque(&json!(note))?);
                    }
                }
            }
            Some("route") => {}
            _ => return Err(BrokerError::Invalid("policy decision")),
        }
        Ok(wire)
    }
}
/// Canonical UTF-16 key order and ECMAScript number formatting for policy fingerprints.
pub fn js_canonical_json(value: &Value) -> Result<String, BrokerError> {
    match value {
        Value::Number(n) => {
            let f = n.as_f64().ok_or(BrokerError::Invalid("JS number"))?;
            Ok(ryu_js::Buffer::new().format(f).to_owned())
        }
        Value::Array(values) => Ok(format!(
            "[{}]",
            values
                .iter()
                .map(js_canonical_json)
                .collect::<Result<Vec<_>, _>>()?
                .join(",")
        )),
        Value::Object(object) => {
            let mut keys: Vec<_> = object.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            // JS enumerates array-index property names first even after fromEntries sorts keys.
            let mut indices: Vec<_> = keys
                .iter()
                .copied()
                .filter(|key| array_index(key).is_some())
                .collect();
            indices.sort_by_key(|key| key.parse::<u32>().ok());
            let other: Vec<_> = keys
                .into_iter()
                .filter(|key| !indices.contains(key))
                .collect();
            indices.extend(other);
            let pairs = indices
                .into_iter()
                .map(|key| {
                    Ok(format!(
                        "{}:{}",
                        serde_json::to_string(key).map_err(|_| BrokerError::Invalid("JSON key"))?,
                        js_canonical_json(&object[key])?
                    ))
                })
                .collect::<Result<Vec<_>, BrokerError>>()?;
            Ok(format!("{{{}}}", pairs.join(",")))
        }
        _ => serde_json::to_string(value).map_err(|_| BrokerError::Invalid("JSON value")),
    }
}
fn array_index(key: &str) -> Option<u32> {
    key.parse::<u32>()
        .ok()
        .filter(|n| *n < u32::MAX && n.to_string() == key)
}
