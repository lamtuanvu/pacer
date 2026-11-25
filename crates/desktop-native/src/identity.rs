//! Native desktop installation identity (port of
//! `src/update/desktop/identity.ts`).
//!
//! Trusted native registration only; never accept `appPath` from a public
//! API request. `inspect_installation` statically audits the signed bundle,
//! its release metadata, the user-owned homes and the registered service's
//! plist, then binds a stable fingerprint. It neither installs nor adopts,
//! and it does not prove that launchd loaded the registration — the native
//! adapter must establish that evidence before any mutation.

#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use pacer_foundation::api::{Code, CoreError};
use pacer_update::is_version;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

/// Shared refusal hint, mirroring `refusal` in `identity.ts`.
const REFUSAL_HINT: &str = "Use a writable, user-owned desktop installation. Reconnect or explicitly adopt the intended service; older or coexisting CLIs require verified admission support before any update.";

pub const BUNDLE_ID: &str = super::native_trust::IDENTIFIERS.app;
pub const BUNDLE_RELEASE_PATH: &str = "Contents/Resources/pacer-release.json";
pub const BUNDLED_CLI_PATH: &str = "Contents/Resources/pacer";
pub const BUNDLED_CORE_PATH: &str = "Contents/Resources/pacer-core";
pub const BUNDLED_HELPER_PATH: &str = "Contents/Resources/pacer-update-helper";
/// The default login-service label and default port, mirroring the
/// non-fixture `LABEL` in `src/service/index.ts` and `DEFAULT_PORT`.
pub const DESKTOP_SERVICE_LABEL: &str = "com.pacer.serve";
pub const DEFAULT_PORT: u16 = 4317;

fn refusal(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::NotAllowed, message).hint(REFUSAL_HINT)
}

/// A validated installer-backed bundle release (`BundleRelease` from
/// `identity.ts`), the subset of the release metadata that the native
/// identity and service-owner checks consume. `parse_bundle_release` is
/// permissive on additive fields (failing only on invalid known fields).
#[derive(Clone, Debug)]
pub struct BundleRelease {
    pub schema: u64,
    pub bundle_id: String,
    pub version: String,
    pub arch: String,
    pub protocol_majors: Vec<u64>,
    pub admission_protocol: u64,
    pub rollback_compatible: bool,
    pub native_transport_abi: u64,
    pub cli_layout: Option<String>,
}

/// `parseBundleRelease`: validates the release metadata against the
/// schema-1 contract. Declarations are trusted only after native signature
/// verification.
pub fn parse_bundle_release(value: &Value) -> Result<BundleRelease, CoreError> {
    let unreleased = || {
        CoreError::new(
            Code::NotAllowed,
            "Unsupported desktop release metadata or admission protocol",
        )
        .hint(REFUSAL_HINT)
    };
    let obj = value.as_object().ok_or_else(unreleased)?;
    let schema = obj
        .get("schema")
        .and_then(Value::as_u64)
        .ok_or_else(unreleased)?;
    if schema != 1 {
        return Err(unreleased());
    }
    if obj.get("bundleId").and_then(Value::as_str) != Some(BUNDLE_ID) {
        return Err(unreleased());
    }
    let version = obj
        .get("version")
        .and_then(Value::as_str)
        .filter(|v| is_version(v))
        .map(str::to_owned)
        .ok_or_else(unreleased)?;
    let arch = obj
        .get("arch")
        .and_then(Value::as_str)
        .filter(|a| matches!(*a, "aarch64" | "x86_64"))
        .map(str::to_owned)
        .ok_or_else(unreleased)?;
    let protocol_majors = obj
        .get("protocolMajors")
        .and_then(Value::as_array)
        .filter(|values| {
            !values.is_empty() && values.iter().all(|p| p.as_u64().is_some_and(|n| n > 0))
        })
        .map(|values| values.iter().map(|p| p.as_u64().unwrap_or(0)).collect())
        .ok_or_else(unreleased)?;
    if obj.get("admissionProtocol").and_then(Value::as_u64) != Some(1) {
        return Err(unreleased());
    }
    if obj.get("rollbackCompatible").and_then(Value::as_bool) != Some(true) {
        return Err(unreleased());
    }
    if obj.get("nativeTransportAbi").and_then(Value::as_u64) != Some(1) {
        return Err(unreleased());
    }
    let cli_layout = match obj.get("cliLayout") {
        None => None,
        Some(Value::String(s)) if s == "paired" => Some(s.clone()),
        _ => return Err(unreleased()),
    };
    Ok(BundleRelease {
        schema,
        bundle_id: BUNDLE_ID.to_owned(),
        version,
        arch,
        protocol_majors,
        admission_protocol: 1,
        rollback_compatible: true,
        native_transport_abi: 1,
        cli_layout,
    })
}

/// The claimed native installation (port of `Installation` in `types.ts`).
#[derive(Clone, Debug)]
pub struct Installation {
    pub id: String,
    pub app_path: PathBuf,
    pub bundle_id: String,
    pub owner_uid: u64,
    pub arch: String,
    pub pacer_home: PathBuf,
    pub port: u64,
    pub service_label: String,
    /// `"managed"` when the service binary is the bundle payload, else
    /// `"attached"`.
    pub ownership: String,
    pub version: String,
}

/// Inputs to `inspect_installation`, mirroring the `Ctx` fields it reads:
/// the pacer state home, the owning user home, and the optional
/// `PACER_PORT` override.
pub struct InspectInputs {
    pub pacer_home: PathBuf,
    pub user_home: PathBuf,
    pub port_env: Option<String>,
}

/// `isBundledExecutable`: a conservative guard for whether a path lives
/// under `<app>.app/Contents/Resources|MacOS/`, either directly or via
/// `realpath`.
pub fn is_absolute_bounded(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    let text = path.as_os_str().to_str().unwrap_or_default();
    text.len() <= 4096 && !text.contains('\0')
}

fn bundled(path: &Path) -> bool {
    let Some(text) = path.to_str().map(str::to_ascii_lowercase) else {
        return false;
    };
    // Match `isBundledExecutable`'s `\.app\/Contents\/(?:Resources|MacOS)\/.+`: a
    // payload directly beneath the app bundle's payload dirs.
    const MARKERS: [&str; 2] = [".app/contents/macos/", ".app/contents/resources/"];
    MARKERS.iter().any(|marker| text.contains(marker))
}

/// `isBundledExecutable`: the absolute resolved path either direct or via a
/// symlink alias resolves under the bundle payload directories.
pub fn is_bundled_executable(exec_path: &Path) -> bool {
    if bundled(exec_path) {
        return true;
    }
    match fs::canonicalize(exec_path) {
        Ok(path) => bundled(&path),
        Err(_) => false,
    }
}

/// `owned` in `identity.ts`: lstat a path and require it be the requested
/// kind, owned by `uid`, not writable by group/other, and (optionally)
/// executable. Symlinks always fail closed.
fn owned(path: &Path, uid: u64, directory: bool, executable: bool) -> Result<(), CoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| {
        refusal("Desktop installation contains an unowned, writable-by-others, or redirected path")
    })?;
    let is_dir = metadata.is_dir();
    if metadata.file_type().is_symlink()
        || (if directory {
            !is_dir
        } else {
            !metadata.is_file()
        })
        || metadata.mode() & 0o022 != 0
        || metadata.uid() as u64 != uid
        || executable && metadata.mode() & 0o100 == 0
    {
        return Err(refusal(
            "Desktop installation contains an unowned, writable-by-others, or redirected path",
        ));
    }
    Ok(())
}

/// `bundleFile` in `identity.ts`: verify every ancestor directory between
/// the app and the file, then the file itself, and that it (once resolved)
/// is not redirected.
fn bundle_file(
    app: &Path,
    relative: &str,
    uid: u64,
    executable: bool,
) -> Result<PathBuf, CoreError> {
    let path = app.join(relative);
    let mut parent = path.parent().ok_or_else(|| {
        refusal("Desktop installation contains an unowned, writable-by-others, or redirected path")
    })?;
    while parent != app {
        owned(parent, uid, true, false)?;
        parent = parent
            .parent()
            .ok_or_else(|| refusal("Desktop bundle payload was redirected"))?;
    }
    owned(&path, uid, false, executable)?;
    let real =
        fs::canonicalize(&path).map_err(|_| refusal("Desktop bundle payload was redirected"))?;
    if real != path {
        return Err(refusal("Desktop bundle payload was redirected"));
    }
    Ok(path)
}

/// `accessSync(path, W_OK | X_OK)`: as `owned` already requires the owner,
/// an explicit parent writable-and-searchable check only needs mode bits.
fn access_write_exec(path: &Path) -> Result<(), CoreError> {
    let metadata = fs::metadata(path).map_err(|_| refusal("Desktop destination is read-only"))?;
    if metadata.mode() & 0o200 != 0 && metadata.mode() & 0o100 != 0 {
        Ok(())
    } else {
        Err(refusal("Desktop destination is read-only"))
    }
}

// ---- strict XML plist subset (port of `parsePlistDictionary`) ---------------

enum PlistValue {
    String(String),
    // Integer and Bool are parsed and validated (their payloads ensure the
    // subset accepts numeric and boolean plist values like ThrottleInterval
    // and RunAtLoad), but the service registration checks only string keys
    // and arrays; the values themselves are never read.
    #[allow(dead_code)]
    Integer(i64),
    #[allow(dead_code)]
    Bool(bool),
    Array(Vec<PlistValue>),
    Dict(BTreeMap<String, PlistValue>),
}

impl PlistValue {
    fn as_str(&self) -> Option<&str> {
        match self {
            PlistValue::String(s) => Some(s),
            _ => None,
        }
    }
}

struct PlistError;

/// A strict parser over the plist XML subset written by the front door.
/// Duplicate keys and unsupported values fail closed.
fn parse_plist_dictionary(text: &str) -> Result<BTreeMap<String, PlistValue>, PlistError> {
    if text.len() > 256 * 1024 {
        return Err(PlistError);
    }
    let text = text.trim_start();
    let text = text.strip_prefix("<?xml").map_or(text, |rest| rest);
    // Strip the XML declaration, comments, and the DOCTYPE line.
    let text = strip_comments(text);
    let text = text
        .strip_prefix("<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">")
        .unwrap_or(&text)
        .trim();
    let (content, at) = plist_wrapper(text)?;
    let mut parser = Parser {
        source: content,
        at,
        bytes: content.as_bytes(),
    };
    let result = parser.value(0)?;
    parser.space();
    let valid = parser.at == parser.bytes.len();
    match (valid, result) {
        (true, PlistValue::Dict(map)) => Ok(map),
        _ => Err(PlistError),
    }
}

/// Remove `<!-- ... -->` comment spans, mirroring the TS
/// `text.replace(/<!--[^]*?-->/g, "")`. An unterminated comment is left
/// in place (the TS regex leaves it too, and later checks fail closed).
fn strip_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("<!--") {
        out.push_str(&rest[..start]);
        match rest[start + 4..].find("-->") {
            Some(end) => rest = &rest[start + 4 + end + 3..],
            None => break,
        }
    }
    out.push_str(rest);
    out
}

fn plist_wrapper(text: &str) -> Result<(&str, usize), PlistError> {
    // Expects `<plist  version="1.0"> ... </plist>` form used by the writer.
    let Some(open) = text.find("<plist") else {
        return Err(PlistError);
    };
    let head = &text[open..];
    let Some(gt) = head.find('>') else {
        return Err(PlistError);
    };
    let tag = &head[..=gt];
    if !tag.starts_with("<plist") || !tag.ends_with('>') {
        return Err(PlistError);
    }
    let after_open = open + gt + 1;
    let Some(close) = text[after_open..].rfind("</plist>") else {
        return Err(PlistError);
    };
    let close = after_open + close;
    if !text[close + "</plist>".len()..].trim_end().is_empty() {
        return Err(PlistError);
    }
    Ok((&text[after_open..close], 0))
}

struct Parser<'a> {
    source: &'a str,
    at: usize,
    bytes: &'a [u8],
}

impl<'a> Parser<'a> {
    fn space(&mut self) {
        while self.at < self.source.len()
            && (self.source.as_bytes()[self.at] as char).is_whitespace()
        {
            self.at += 1;
        }
    }
    fn take(&mut self, token: &str) -> bool {
        self.space();
        if self.source[self.at..].starts_with(token) {
            self.at += token.len();
            true
        } else {
            false
        }
    }
    fn expect(&mut self, token: &str) -> Result<(), PlistError> {
        if self.take(token) {
            Ok(())
        } else {
            Err(PlistError)
        }
    }
    /// `content(tag)`: read a `<tag>raw</tag>` value, XML-unescaping the raw
    /// text after rejecting any unescaped delimiter.
    fn content(&mut self, tag: &str) -> Result<String, PlistError> {
        self.expect(&format!("<{tag}>"))?;
        let end = self.source[self.at..]
            .find(&format!("</{tag}>"))
            .ok_or(PlistError)?;
        let raw = &self.source[self.at..self.at + end];
        self.at += end + tag.len() + 3;
        if raw.contains('<') || has_bad_amp(raw) {
            return Err(PlistError);
        }
        Ok(unxml(raw))
    }
    fn value(&mut self, depth: usize) -> Result<PlistValue, PlistError> {
        if depth > 16 {
            return Err(PlistError);
        }
        self.space();
        if self.take("<dict>") {
            let mut map = BTreeMap::new();
            while !self.take("</dict>") {
                let key = self.content("key")?;
                if map.contains_key(&key) {
                    return Err(PlistError);
                }
                let value = self.value(depth + 1)?;
                map.insert(key, value);
            }
            return Ok(PlistValue::Dict(map));
        }
        if self.take("<array>") {
            let mut values = Vec::new();
            while !self.take("</array>") {
                values.push(self.value(depth + 1)?);
            }
            return Ok(PlistValue::Array(values));
        }
        if self.take("<true/>") {
            return Ok(PlistValue::Bool(true));
        }
        if self.take("<false/>") {
            return Ok(PlistValue::Bool(false));
        }
        if self.take("<string/>") {
            return Ok(PlistValue::String(String::new()));
        }
        if self.source[self.at..].starts_with("<string>") {
            return Ok(PlistValue::String(self.content("string")?));
        }
        if self.source[self.at..].starts_with("<integer>") {
            let raw = self.content("integer")?;
            if !raw.bytes().all(|b| b.is_ascii_digit() || b == b'-') || raw.is_empty() || raw == "-"
            {
                return Err(PlistError);
            }
            let number = raw.parse::<i64>().map_err(|_| PlistError)?;
            return Ok(PlistValue::Integer(number));
        }
        Err(PlistError)
    }
}

fn has_bad_amp(raw: &str) -> bool {
    let bytes = raw.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'&' {
            let tail = &raw[at..];
            if !tail.starts_with("&amp;")
                && !tail.starts_with("&lt;")
                && !tail.starts_with("&gt;")
                && !tail.starts_with("&quot;")
                && !tail.starts_with("&apos;")
            {
                return true;
            }
            while at < bytes.len() && bytes[at] != b';' {
                at += 1;
            }
        }
        at += 1;
    }
    false
}

fn unxml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

// ---- service registration (port of `parseDesktopServiceRegistration`) -------

struct DesktopServiceRegistration {
    label: String,
    argv: Vec<String>,
    home: String,
    pacer_home: String,
    port: u64,
}

/// `parseDesktopServiceRegistration`: static provenance only. Loaded launchd
/// state and running process identity need native verification.
fn parse_desktop_service_registration(
    text: &str,
    expected_label: &str,
) -> Result<DesktopServiceRegistration, CoreError> {
    let data =
        parse_plist_dictionary(text).map_err(|_| refusal("Unrecognized service registration"))?;
    const ALLOWED: [&str; 9] = [
        "Label",
        "ProgramArguments",
        "EnvironmentVariables",
        "RunAtLoad",
        "KeepAlive",
        "ThrottleInterval",
        "ProcessType",
        "StandardOutPath",
        "StandardErrorPath",
    ];
    if data.keys().any(|key| !ALLOWED.contains(&key.as_str())) {
        return Err(refusal("Unsupported service launch configuration"));
    }
    let argv = data.get("ProgramArguments");
    let env = data.get("EnvironmentVariables");
    let argv_all_strings = |a: &PlistValue| match a {
        PlistValue::Array(items) => items.iter().all(|i| matches!(i, PlistValue::String(_))),
        _ => false,
    };
    if data.get("Label").and_then(PlistValue::as_str) != Some(expected_label)
        || env.is_none()
        || !matches!(env, Some(PlistValue::Dict(_)))
        || !argv.is_some_and(argv_all_strings)
    {
        return Err(refusal("Unrecognized service registration"));
    }
    let argv = match argv {
        Some(PlistValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                PlistValue::String(s) => s.clone(),
                _ => unreachable!(),
            })
            .collect::<Vec<_>>(),
        _ => Vec::new(),
    };
    let env_map = match env {
        Some(PlistValue::Dict(map)) => map,
        _ => return Err(refusal("Unrecognized service registration")),
    };
    const ENV_ALLOWED: [&str; 4] = ["HOME", "PATH", "PACER_HOME", "PACER_PORT"];
    if env_map
        .keys()
        .any(|key| !ENV_ALLOWED.contains(&key.as_str()))
        || env_map.get("HOME").and_then(PlistValue::as_str).is_none()
        || env_map
            .get("PACER_HOME")
            .and_then(PlistValue::as_str)
            .is_none()
    {
        return Err(refusal("Ambiguous service environment"));
    }
    let home = env_map
        .get("HOME")
        .and_then(PlistValue::as_str)
        .unwrap_or_default()
        .to_owned();
    let pacer_home = env_map
        .get("PACER_HOME")
        .and_then(PlistValue::as_str)
        .unwrap_or_default()
        .to_owned();
    if argv.get(1).map(String::as_str) != Some("serve")
        || !(argv.len() == 2
            || (argv.len() == 4 && argv.get(2).map(String::as_str) == Some("--port")))
    {
        return Err(refusal(
            "Unsupported or older service command; use a standalone CLI with verified admission support",
        ));
    }
    let configured_port = env_map
        .get("PACER_PORT")
        .and_then(PlistValue::as_str)
        .map_or_else(|| DEFAULT_PORT.to_string(), str::to_owned);
    if !configured_port.bytes().all(|b| b.is_ascii_digit()) || configured_port.is_empty() {
        return Err(refusal("Invalid service port"));
    }
    if argv.len() == 4 && argv.get(3).map(String::as_str) != Some(configured_port.as_str()) {
        return Err(refusal("Conflicting service ports"));
    }
    let port = configured_port
        .parse::<u64>()
        .map_err(|_| refusal("Invalid service port"))?;
    if port == 0 || port > 65_535 {
        return Err(refusal("Invalid service port"));
    }
    Ok(DesktopServiceRegistration {
        label: expected_label.to_owned(),
        argv,
        home,
        pacer_home,
        port,
    })
}

/// The service registration path for the owning user, mirroring the
/// non-fixture `servicePath(ctx, "darwin")`.
pub fn service_registration_path(user_home: &Path) -> PathBuf {
    user_home
        .join("Library/LaunchAgents")
        .join(format!("{DESKTOP_SERVICE_LABEL}.plist"))
}

/// `installationFingerprint`: byte-parity with TypeScript. The object is
/// stringified in the exact field order of `JSON.stringify({...})` using
/// `pacer_js_json`, then SHA-256 hashed.
pub fn installation_fingerprint(
    identity: &Installation,
    binary: &str,
    registration_text: &str,
) -> String {
    let mut obj = serde_json::Map::new();
    obj.insert("appPath".into(), file_string(identity.app_path.as_path()));
    obj.insert("bundleId".into(), identity.bundle_id.clone().into());
    obj.insert("ownerUid".into(), serde_json::json!(identity.owner_uid));
    obj.insert("arch".into(), identity.arch.clone().into());
    obj.insert(
        "pacerHome".into(),
        file_string(identity.pacer_home.as_path()),
    );
    obj.insert("port".into(), serde_json::json!(identity.port));
    obj.insert("serviceLabel".into(), identity.service_label.clone().into());
    obj.insert("ownership".into(), identity.ownership.clone().into());
    obj.insert("binary".into(), binary.into());
    obj.insert("registrationText".into(), registration_text.into());
    let json = pacer_js_json::stringify(&serde_json::Value::Object(obj));
    let mut hasher = Sha256::new();
    hasher.update(json.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn file_string(path: &Path) -> serde_json::Value {
    serde_json::Value::String(path.to_string_lossy().into_owned())
}

/// `inspectInstallation`: static ownership audit that returns the native
/// `Installation` and its stable id. Inputs come only from native
/// verification, never API claims.
pub fn inspect_installation(
    inputs: &InspectInputs,
    app_path: &Path,
) -> Result<Installation, CoreError> {
    if !app_path.is_absolute() {
        return Err(refusal("Desktop app path must be absolute"));
    }
    let app = fs::canonicalize(app_path)
        .map_err(|_| refusal("Unsupported or translocated desktop installation"))?;
    let uid = nix::unistd::getuid().as_raw() as u64;
    if !app
        .as_os_str()
        .to_str()
        .is_some_and(|s| s.ends_with(".app"))
        || app
            .components()
            .any(|c| c.as_os_str() == "AppTranslocation")
    {
        return Err(refusal("Unsupported or translocated desktop installation"));
    }
    owned(&app, uid, true, false)?;
    let parent = app
        .parent()
        .ok_or_else(|| refusal("Desktop destination is read-only"))?;
    if fs::metadata(parent)
        .map(|m| m.mode() & 0o222 == 0)
        .unwrap_or(true)
    {
        return Err(refusal("Desktop destination is read-only"));
    }
    access_write_exec(parent)?;
    access_write_exec(&app)?;
    let metadata_path = bundle_file(&app, BUNDLE_RELEASE_PATH, uid, false)?;
    let metadata_size = fs::metadata(&metadata_path)
        .map_err(|_| refusal("Desktop bundle payload was redirected"))?;
    if metadata_size.len() > 64 * 1024 {
        return Err(refusal("Desktop release metadata exceeds inspection limit"));
    }
    let release_text = read_to_string(&metadata_path)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    let release_value: Value = serde_json::from_str(&release_text)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    let release = parse_bundle_release(&release_value)?;
    let host_arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        _ => {
            return Err(refusal("Desktop architecture does not match this process"));
        }
    };
    if release.arch != host_arch {
        return Err(refusal("Desktop architecture does not match this process"));
    }
    let info_path = bundle_file(&app, "Contents/Info.plist", uid, false)?;
    let info_text = read_to_string(&info_path)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    let info = parse_plist_dictionary(&info_text)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    let cf = |key: &str| {
        PlistValue::as_str(info.get(key).unwrap_or(&PlistValue::String(String::new())))
            .map(str::to_owned)
    };
    if cf("CFBundleIdentifier").as_deref() != Some(release.bundle_id.as_str())
        || cf("CFBundleShortVersionString").as_deref() != Some(release.version.as_str())
        || cf("CFBundleExecutable").as_deref() != Some("pacer")
    {
        return Err(refusal(
            "Desktop bundle identity or version does not match its release metadata",
        ));
    }
    bundle_file(&app, "Contents/MacOS/pacer", uid, true)?;
    let cli = bundle_file(&app, BUNDLED_CLI_PATH, uid, true)?;
    if release.cli_layout.as_deref() == Some("paired") {
        bundle_file(&app, BUNDLED_CORE_PATH, uid, true)?;
    }
    bundle_file(&app, BUNDLED_HELPER_PATH, uid, true)?;
    let pacer_home = fs::canonicalize(&inputs.pacer_home)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    let home = fs::canonicalize(&inputs.user_home)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    owned(&pacer_home, uid, true, false)?;
    let port_text = inputs
        .port_env
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| DEFAULT_PORT.to_string());
    let port = port_text
        .parse::<u64>()
        .map_err(|_| refusal("Invalid installation port"))?;
    if !port_text.bytes().all(|b| b.is_ascii_digit()) || !(1..=65_535).contains(&port) {
        return Err(refusal("Invalid installation port"));
    }
    let registration_path = service_registration_path(&home);
    owned(&registration_path, uid, false, false)?;
    let real_registration = fs::canonicalize(&registration_path)
        .map_err(|_| refusal("Service registration path was redirected"))?;
    if real_registration != registration_path {
        return Err(refusal("Service registration path was redirected"));
    }
    let registration_text = read_to_string(&registration_path)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    let registration =
        parse_desktop_service_registration(&registration_text, DESKTOP_SERVICE_LABEL)?;
    if !registration.home.starts_with('/')
        || !registration.pacer_home.starts_with('/')
        || fs::canonicalize(&registration.home).ok().as_deref() != Some(home.as_path())
        || fs::canonicalize(&registration.pacer_home).ok().as_deref() != Some(pacer_home.as_path())
        || registration.port != port
    {
        return Err(refusal(
            "Registered service belongs to a different home or port",
        ));
    }
    let executable = registration
        .argv
        .first()
        .ok_or_else(|| refusal("Service executable must be an absolute standalone path"))?;
    if !executable.starts_with('/') {
        return Err(refusal(
            "Service executable must be an absolute standalone path",
        ));
    }
    let binary = PathBuf::from(executable);
    let binary = fs::canonicalize(&binary)
        .map_err(|_| refusal("Cannot establish desktop installation ownership"))?;
    owned(&binary, uid, false, true)?;
    if binary != cli && is_bundled_executable(&binary) {
        return Err(refusal("Service belongs to another desktop installation"));
    }
    let ownership = if binary == cli { "managed" } else { "attached" };
    let identity = Installation {
        id: String::new(),
        app_path: app.clone(),
        bundle_id: release.bundle_id.clone(),
        owner_uid: uid,
        arch: release.arch.clone(),
        pacer_home: pacer_home.clone(),
        port,
        service_label: registration.label.clone(),
        ownership: ownership.to_owned(),
        version: release.version.clone(),
    };
    let id = installation_fingerprint(&identity, &binary.to_string_lossy(), &registration_text);
    Ok(Installation { id, ..identity })
}

/// `verifyInstallation`: recheck every persisted field, which does not
/// replace the native checks the caller must independently perform.
pub fn verify_installation(
    inputs: &InspectInputs,
    expected: &Installation,
) -> Result<(), CoreError> {
    let actual = inspect_installation(inputs, &expected.app_path)?;
    macro_rules! same {
        ($a:expr, $b:expr, $field:literal) => {
            if $a != $b {
                return Err(CoreError::new(
                    Code::Conflict,
                    format!("Desktop installation {field} changed", field = $field),
                )
                .hint("Reconnect the desktop and verify its service before retrying."));
            }
        };
    }
    same!(actual.app_path, expected.app_path, "appPath");
    same!(actual.bundle_id, expected.bundle_id, "bundleId");
    same!(actual.owner_uid, expected.owner_uid, "ownerUid");
    same!(actual.arch, expected.arch, "arch");
    same!(actual.pacer_home, expected.pacer_home, "pacerHome");
    same!(actual.port, expected.port, "port");
    same!(actual.service_label, expected.service_label, "serviceLabel");
    same!(actual.ownership, expected.ownership, "ownership");
    same!(actual.version, expected.version, "version");
    same!(actual.id, expected.id, "id");
    Ok(())
}

fn read_to_string(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    Ok(text)
}

#[cfg(test)]
#[path = "tests/identity.rs"]
mod tests;
