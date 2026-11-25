//! Desktop update helper adapter (mirror of `src/update/desktop/adapter.ts`).
//!
//! This is the private wire between the service and the verified desktop
//! helper: a bounded length-prefixed JSON framing (`encode_frame` /
//! `FrameDecoder`), strict parsing of private commands, frames and install
//! authorizations (failing closed on unknown keys and inconsistent
//! cross-field values), and `run_adapter_command`, the state machine that
//! binds a request to a verified pipe and walks it to a terminal result.
//!
//! Messages are kept as ordered `serde_json::Value` so they round-trip
//! byte-for-byte with the TypeScript writer through `pacer-js-json`'s
//! `stringify`.
#![allow(
    clippy::result_large_err,
    clippy::too_many_arguments,
    clippy::type_complexity
)]
use pacer_foundation::api::{Code, CoreError};
use pacer_update::{Channel, is_version};
use serde_json::{Map, Value, json};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

/// The maximum framed payload in bytes, matching `MAX_FRAME_BYTES` in
/// `adapter.ts` and `desktop/src-tauri/src/ota/wire.rs`.
pub const MAX_FRAME_BYTES: usize = 256 * 1024;

/// The largest safe integer, mirroring `Number.MAX_SAFE_INTEGER`.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// The verified desktop bundle identifier, mirroring `DESKTOP_IDENTIFIERS.desktop`.
pub const DESKTOP_BUNDLE_ID: &str = "dev.pacer.desktop";

/// `HandoffState` from `adapter.ts`: how certain we are that the helper has
/// reached a durable boundary. Uncertainty never permits releasing admission.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HandoffState {
    /// No partial write reached the helper.
    None,
    /// A partial write may have reached the helper; only recovery resolves it.
    Uncertain,
    /// The helper acknowledged the durable authorization.
    Acknowledged,
}

/// `AdapterFailure` from `adapter.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterFailure {
    Unavailable,
    Protocol,
    Closed,
    Cancelled,
    Timeout,
    Remote,
}

impl AdapterFailure {
    fn message(self) -> &'static str {
        match self {
            AdapterFailure::Unavailable => "Verified desktop update adapter is unavailable",
            AdapterFailure::Protocol => "Desktop update adapter protocol was rejected",
            AdapterFailure::Closed => "Desktop update adapter closed before successful completion",
            AdapterFailure::Cancelled => "Desktop update adapter operation was cancelled",
            AdapterFailure::Timeout => "Desktop update adapter operation timed out",
            AdapterFailure::Remote => "Desktop update adapter could not complete the operation",
        }
    }
}

/// `AdapterRejection` from `adapter.ts`: the check that rejected a helper
/// stream, without any frame payload.
#[derive(Clone, Debug, PartialEq)]
pub struct AdapterRejection {
    /// `"frame" | "schema" | "binding" | "sequence" | "terminal" | "hello"
    ///   | "identity" | "order"`
    pub check: String,
    pub kind: Option<String>,
    pub sequence: Option<u64>,
    pub expected_sequence: u64,
    pub phase: String,
    pub hello: bool,
}

/// The phases of the install/adopt state machine, used only for rejection
/// reporting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Initial,
    Authorizing,
    Authorized,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Initial => "initial",
            Phase::Authorizing => "authorizing",
            Phase::Authorized => "authorized",
        }
    }
}

/// `AdapterError` from `adapter.ts`, with the same message, hint and code
/// as the TypeScript class.
#[derive(Clone, Debug)]
pub struct AdapterError {
    pub reason: AdapterFailure,
    pub handoff: HandoffState,
    pub rejection: Option<AdapterRejection>,
    pub before_frames: bool,
    pub core: CoreError,
}

impl AdapterError {
    pub fn new(reason: AdapterFailure, handoff: HandoffState) -> Self {
        let hint = if handoff == HandoffState::None {
            "Reconnect the verified desktop and retry."
        } else {
            "Retain the reservation and reconcile the private transaction journal before retrying."
        };
        let core = CoreError::new(Code::NotAllowed, reason.message()).hint(hint);
        Self {
            reason,
            handoff,
            rejection: None,
            before_frames: false,
            core,
        }
    }

    pub fn protocol() -> Self {
        Self::new(AdapterFailure::Protocol, HandoffState::None)
    }

    fn rejection_set(mut self, rejection: Option<AdapterRejection>) -> Self {
        self.rejection = rejection;
        self
    }
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.core.message)
    }
}

impl std::error::Error for AdapterError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.core)
    }
}

fn invalid() -> AdapterError {
    AdapterError::protocol()
}

// ---- private identifier / scalar helpers ------------------------------------

/// `^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`.
fn is_valid_identifier(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 || !bytes[0].is_ascii_alphanumeric() {
        return false;
    }
    bytes
        .iter()
        .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

/// `^[a-f0-9]{64}$`.
fn is_hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| (b'a'..=b'f').contains(&b) || b.is_ascii_digit())
}

fn is_arch(s: &str) -> bool {
    matches!(s, "aarch64" | "x86_64")
}

fn is_absolute_path(s: &str) -> bool {
    s.starts_with('/') && !s.contains('\0') && s.len() <= 4096
}

fn is_channel(s: &str) -> bool {
    matches!(s, "stable" | "nightly")
}

fn is_https_url(s: &str) -> bool {
    s.starts_with("https://") && s.len() <= 2048
}

fn is_nonneg_integer(value: Option<&Value>) -> bool {
    value.is_some_and(|v| v.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER))
}

fn all_keys_only(obj: &Map<String, Value>, allowed: &[&str]) -> bool {
    obj.keys().all(|k| allowed.contains(&k.as_str()))
}

fn check_candidate(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    const KEYS: &[&str] = &[
        "version",
        "arch",
        "sha256",
        "signature",
        "url",
        "protocolMajors",
        "rollbackCompatible",
        "notes",
    ];
    if !all_keys_only(obj, KEYS) {
        return false;
    }
    if !obj
        .get("version")
        .and_then(Value::as_str)
        .is_some_and(is_version)
    {
        return false;
    }
    if !obj.get("arch").and_then(Value::as_str).is_some_and(is_arch) {
        return false;
    }
    if !obj
        .get("sha256")
        .and_then(Value::as_str)
        .is_some_and(is_hash)
    {
        return false;
    }
    if !obj
        .get("signature")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.len() <= 8192)
    {
        return false;
    }
    if !obj
        .get("url")
        .and_then(Value::as_str)
        .is_some_and(is_https_url)
    {
        return false;
    }
    if !obj
        .get("rollbackCompatible")
        .and_then(Value::as_bool)
        .is_some()
    {
        return false;
    }
    if !obj
        .get("notes")
        .and_then(Value::as_str)
        .is_some_and(|s| s.len() <= 32_768)
    {
        return false;
    }
    let Some(protos) = obj.get("protocolMajors").and_then(Value::as_array) else {
        return false;
    };
    !protos.is_empty()
        && protos.len() <= 32
        && protos
            .iter()
            .all(|p| p.as_u64().is_some_and(|n| n > 0 && n <= MAX_SAFE_INTEGER))
}

fn check_target(value: &Value, attached_only: bool) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    const KEYS: &[&str] = &[
        "id",
        "appPath",
        "bundleId",
        "ownerUid",
        "arch",
        "pacerHome",
        "port",
        "serviceLabel",
        "ownership",
        "version",
    ];
    if !all_keys_only(obj, KEYS) {
        return false;
    }
    if !obj
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(is_valid_identifier)
    {
        return false;
    }
    if !obj
        .get("appPath")
        .and_then(Value::as_str)
        .is_some_and(is_absolute_path)
    {
        return false;
    }
    if obj.get("bundleId").and_then(Value::as_str) != Some(DESKTOP_BUNDLE_ID) {
        return false;
    }
    if !is_nonneg_integer(obj.get("ownerUid")) {
        return false;
    }
    if !obj.get("arch").and_then(Value::as_str).is_some_and(is_arch) {
        return false;
    }
    if !obj
        .get("pacerHome")
        .and_then(Value::as_str)
        .is_some_and(is_absolute_path)
    {
        return false;
    }
    if !obj
        .get("port")
        .and_then(Value::as_u64)
        .is_some_and(|n| (1..=65_535).contains(&n))
    {
        return false;
    }
    if !obj
        .get("serviceLabel")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty() && s.len() <= 128)
    {
        return false;
    }
    let ownership = obj.get("ownership").and_then(Value::as_str);
    if attached_only {
        if ownership != Some("attached") {
            return false;
        }
    } else if !matches!(ownership, Some("managed" | "attached")) {
        return false;
    }
    obj.get("version")
        .and_then(Value::as_str)
        .is_some_and(is_version)
}

/// Binding checks shared by commands, frames and authorizations.
fn check_binding(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.get("schema").and_then(Value::as_u64) == Some(1)
        && obj
            .get("commandId")
            .and_then(Value::as_str)
            .is_some_and(is_valid_identifier)
        && obj
            .get("installationId")
            .and_then(Value::as_str)
            .is_some_and(is_valid_identifier)
        && match obj.get("transactionId") {
            None => false,
            Some(Value::Null) => true,
            Some(Value::String(s)) => is_valid_identifier(s),
            Some(_) => false,
        }
        && is_nonneg_integer(obj.get("revision"))
        && obj
            .get("nonce")
            .and_then(Value::as_str)
            .is_some_and(is_hash)
}

fn tx_is_null(value: &Value) -> bool {
    value.get("transactionId").is_some_and(Value::is_null)
}

fn tx_is_identifier(value: &Value) -> bool {
    value
        .get("transactionId")
        .and_then(Value::as_str)
        .is_some_and(is_valid_identifier)
}

// ---- parse entry points -----------------------------------------------------

/// `parseAdapterCommand`: a strict discriminated union on `command`, with
/// `.strict()` key rejection and install/adopt cross-field checks.
pub fn parse_adapter_command(value: &Value) -> Result<(), AdapterError> {
    let obj = value.as_object().ok_or_else(invalid)?;
    let () = check_binding(value).then_some(()).ok_or_else(invalid)?;
    let command = obj
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    match command {
        "check" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "command",
                "channel",
            ];
            if !all_keys_only(obj, KEYS) || !tx_is_null(value) {
                return Err(invalid());
            }
            if let Some(channel) = obj.get("channel").and_then(Value::as_str)
                && !is_channel(channel)
            {
                return Err(invalid());
            }
        }
        "download" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "command",
                "candidate",
            ];
            let candidate = obj.get("candidate");
            if !all_keys_only(obj, KEYS)
                || !tx_is_null(value)
                || !candidate.is_some_and(check_candidate)
            {
                return Err(invalid());
            }
        }
        "install" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "command",
                "candidate",
                "target",
            ];
            let candidate = obj.get("candidate");
            let target = obj.get("target");
            if !all_keys_only(obj, KEYS)
                || !tx_is_identifier(value)
                || !candidate.is_some_and(check_candidate)
                || !target.is_some_and(|t| check_target(t, false))
            {
                return Err(invalid());
            }
            let (target, candidate) = match (target, candidate) {
                (Some(t), Some(c)) => (t, c),
                _ => return Err(invalid()),
            };
            let target_id = target.get("id").and_then(Value::as_str);
            let target_arch = target.get("arch").and_then(Value::as_str);
            let candidate_arch = candidate.get("arch").and_then(Value::as_str);
            let rollback = candidate.get("rollbackCompatible").and_then(Value::as_bool);
            if target_id != obj.get("installationId").and_then(Value::as_str)
                || target_arch != candidate_arch
                || rollback != Some(true)
            {
                return Err(invalid());
            }
        }
        "recover" | "recover-adoption" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "command",
            ];
            if !all_keys_only(obj, KEYS) || !tx_is_identifier(value) {
                return Err(invalid());
            }
        }
        "adopt" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "command",
                "target",
            ];
            let target = obj.get("target");
            if !all_keys_only(obj, KEYS)
                || !tx_is_identifier(value)
                || !target.is_some_and(|t| check_target(t, true))
            {
                return Err(invalid());
            }
            let target = match target {
                Some(t) => t,
                None => return Err(invalid()),
            };
            let target_id = target.get("id").and_then(Value::as_str);
            if target_id != obj.get("installationId").and_then(Value::as_str) {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

/// `parseAdapterFrame`: a strict discriminated union on `kind`, plus
/// sequence and cross-field frame checks.
pub fn parse_adapter_frame(value: &Value) -> Result<(), AdapterError> {
    let obj = value.as_object().ok_or_else(invalid)?;
    let () = check_binding(value).then_some(()).ok_or_else(invalid)?;
    if !is_nonneg_integer(obj.get("sequence")) {
        return Err(invalid());
    }
    let kind = obj
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    match kind {
        "hello" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "sequence",
                "kind",
                "version",
                "bundleId",
                "arch",
            ];
            if !all_keys_only(obj, KEYS) {
                return Err(invalid());
            }
            let version = obj.get("version").and_then(Value::as_str);
            let bundle = obj.get("bundleId").and_then(Value::as_str);
            let arch = obj.get("arch").and_then(Value::as_str);
            if version.is_none_or(|s| !is_version(s))
                || bundle != Some(DESKTOP_BUNDLE_ID)
                || arch.is_none_or(|s| !is_arch(s))
            {
                return Err(invalid());
            }
        }
        "progress" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "sequence",
                "kind",
                "downloadedBytes",
                "totalBytes",
            ];
            if !all_keys_only(obj, KEYS) || !is_nonneg_integer(obj.get("downloadedBytes")) {
                return Err(invalid());
            }
            match obj.get("totalBytes") {
                None => return Err(invalid()),
                Some(Value::Null) => {}
                Some(v) => {
                    if !v.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER) {
                        return Err(invalid());
                    }
                }
            }
        }
        "checked" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "sequence",
                "kind",
                "candidate",
            ];
            if !all_keys_only(obj, KEYS) {
                return Err(invalid());
            }
            match obj.get("candidate") {
                None => return Err(invalid()),
                Some(Value::Null) => {}
                Some(c) => {
                    if !check_candidate(c) {
                        return Err(invalid());
                    }
                }
            }
        }
        "downloaded" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "sequence",
                "kind",
                "candidate",
                "downloadedBytes",
                "totalBytes",
            ];
            let candidate = obj.get("candidate");
            let downloaded = obj.get("downloadedBytes");
            let total = obj.get("totalBytes").and_then(Value::as_u64);
            if !all_keys_only(obj, KEYS)
                || !candidate.is_some_and(check_candidate)
                || !downloaded.is_some_and(|d| d.as_u64().is_some_and(|n| n <= MAX_SAFE_INTEGER))
                || !total.is_some_and(|n| n > 0 && n <= MAX_SAFE_INTEGER)
            {
                return Err(invalid());
            }
        }
        "prepared" | "authorized" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "sequence",
                "kind",
                "reservationId",
                "journalSha256",
            ];
            let reservation = obj.get("reservationId").and_then(Value::as_str);
            let journal = obj.get("journalSha256").and_then(Value::as_str);
            if !all_keys_only(obj, KEYS)
                || reservation.is_none_or(|s| !is_valid_identifier(s))
                || journal.is_none_or(|s| !is_hash(s))
            {
                return Err(invalid());
            }
        }
        "outcome" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "sequence",
                "kind",
                "outcome",
            ];
            if !all_keys_only(obj, KEYS) {
                return Err(invalid());
            }
            let outcome = obj.get("outcome").and_then(Value::as_str);
            if !matches!(
                outcome,
                Some("committed") | Some("restored") | Some("recovery-failed")
            ) {
                return Err(invalid());
            }
            if !obj.get("transactionId").is_some_and(Value::is_string) {
                return Err(invalid());
            }
        }
        "error" => {
            const KEYS: &[&str] = &[
                "schema",
                "commandId",
                "installationId",
                "transactionId",
                "revision",
                "nonce",
                "sequence",
                "kind",
                "code",
            ];
            let code = obj.get("code").and_then(Value::as_str);
            if !all_keys_only(obj, KEYS)
                || !matches!(
                    code,
                    Some("network")
                        | Some("signature")
                        | Some("compatibility")
                        | Some("disk")
                        | Some("permission")
                        | Some("verification")
                        | Some("recovery")
                )
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

/// `parseInstallAuthorization`: the `authorize-install` continuation, which
/// must bind to the same transaction as the prepared reservation.
pub fn parse_install_authorization(value: &Value) -> Result<(), AdapterError> {
    let obj = value.as_object().ok_or_else(invalid)?;
    let () = check_binding(value).then_some(()).ok_or_else(invalid)?;
    const KEYS: &[&str] = &[
        "schema",
        "commandId",
        "installationId",
        "transactionId",
        "revision",
        "nonce",
        "kind",
        "reservationId",
        "journalSha256",
    ];
    if !all_keys_only(obj, KEYS) {
        return Err(invalid());
    }
    if obj.get("kind").and_then(Value::as_str) != Some("authorize-install") {
        return Err(invalid());
    }
    let tx = obj.get("transactionId").and_then(Value::as_str);
    let reservation = obj.get("reservationId").and_then(Value::as_str);
    let journal = obj.get("journalSha256").and_then(Value::as_str);
    if tx.is_none_or(|s| !is_valid_identifier(s))
        || reservation.is_none_or(|s| !is_valid_identifier(s))
        || journal.is_none_or(|s| !is_hash(s))
        || reservation != tx
    {
        return Err(invalid());
    }
    Ok(())
}

// ---- framing ---------------------------------------------------------------

/// `encodeFrame`: bounded length-prefixed JSON using `JSON.stringify`
/// semantics (byte parity with TypeScript).
pub fn encode_frame(value: &Value) -> Result<Vec<u8>, AdapterError> {
    let json = pacer_js_json::stringify(value);
    if json.len() > MAX_FRAME_BYTES {
        return Err(invalid());
    }
    let payload = json.into_bytes();
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(invalid());
    }
    let mut bytes = Vec::with_capacity(payload.len() + 4);
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&payload);
    Ok(bytes)
}

/// `FrameDecoder`: stateful length-prefixed frame decoder that also bounds a
/// single transport chunk and rejects truncated frames on `finish`.
pub struct FrameDecoder {
    header: [u8; 4],
    header_at: usize,
    payload: Option<Vec<u8>>,
    payload_at: usize,
    failed: bool,
}

impl Default for FrameDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self {
            header: [0; 4],
            header_at: 0,
            payload: None,
            payload_at: 0,
            failed: false,
        }
    }

    /// `push`: feed a raw chunk and return any complete decoded values.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, AdapterError> {
        if self.failed {
            return Err(invalid());
        }
        if chunk.len() > MAX_FRAME_BYTES * 4 {
            self.failed = true;
            return Err(invalid());
        }
        let mut values = Vec::new();
        let mut at = 0;
        while at < chunk.len() {
            if self.payload.is_none() {
                let take = (4 - self.header_at).min(chunk.len() - at);
                self.header[self.header_at..self.header_at + take]
                    .copy_from_slice(&chunk[at..at + take]);
                at += take;
                self.header_at += take;
                if self.header_at != 4 {
                    continue;
                }
                let length = u32::from_be_bytes(self.header) as usize;
                if length == 0 || length > MAX_FRAME_BYTES {
                    self.failed = true;
                    return Err(invalid());
                }
                self.payload = Some(vec![0; length]);
                self.payload_at = 0;
            }
            let length = self.payload.as_ref().map_or(0, Vec::len);
            let take = (length - self.payload_at).min(chunk.len() - at);
            if let Some(payload) = self.payload.as_mut() {
                payload[self.payload_at..self.payload_at + take]
                    .copy_from_slice(&chunk[at..at + take]);
            }
            at += take;
            self.payload_at += take;
            if self.payload_at == length {
                let payload = self.payload.take().unwrap_or_default();
                let text = String::from_utf8(payload).map_err(|_| {
                    self.failed = true;
                    invalid()
                })?;
                let value = serde_json::from_str::<Value>(&text).map_err(|_| {
                    self.failed = true;
                    invalid()
                })?;
                values.push(value);
                self.header_at = 0;
                self.payload_at = 0;
            }
        }
        Ok(values)
    }

    /// `finish`: must be called after EOF; errors if a frame was truncated.
    pub fn finish(&mut self) -> Result<(), AdapterError> {
        if self.failed || self.header_at != 0 || self.payload.is_some() {
            self.failed = true;
            return Err(invalid());
        }
        Ok(())
    }
}

// ---- verified pipe and factory ---------------------------------------------

/// `NativeSessionRef`: identity of a verified native desktop session. This
/// library only needs the installation identifier; the composition root's
/// factory provides the rest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeSessionRef {
    pub installation_id: String,
}

impl NativeSessionRef {
    pub fn new(installation_id: impl Into<String>) -> Self {
        Self {
            installation_id: installation_id.into(),
        }
    }
}

/// `VerifiedPipe`: the established, verified byte pipe to a helper. The
/// identity here is from local verification, not copied from the helper's
/// hello. `send` writes one frame; `recv` returns `Ok(None)` on clean EOF
/// and an `io` error on a failed/closed transport.
///
/// The methods are dyn-compatible (boxed futures) so `run_adapter_command`
/// can take a `&mut dyn VerifiedPipe`.
pub trait VerifiedPipe: Send {
    /// Expected identity from local verification, used to validate the
    /// helper's `hello` frame (never copied from the helper itself).
    fn identity(&self) -> (&str, &str, &str);
    /// Write one frame. An `io` error means the transport is closed.
    fn send(
        &mut self,
        frame: &[u8],
    ) -> Pin<Box<dyn Future<Output = std::io::Result<()>> + Send + '_>>;
    /// Read one raw chunk; `Ok(None)` is a clean EOF.
    fn recv(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = std::io::Result<Option<Vec<u8>>>> + Send + '_>>;
    /// Pre-handoff cleanup only. Must address the verified process, never a
    /// reused PID.
    fn abort(&mut self);
}

/// `PipeFactory`: only a trusted composition root may implement this.
pub trait PipeFactory: Send + Sync {
    fn open(
        &self,
        session: &NativeSessionRef,
    ) -> Pin<Box<dyn Future<Output = Result<Box<dyn VerifiedPipe>, AdapterError>> + Send + '_>>;
}

// ---- run adapter command (state machine) -----------------------------------

/// `AdapterRequest`: the private command request (mirror of the TS
/// `AdapterRequest` union). A missing channel means stable.
#[derive(Clone, Debug)]
pub enum AdapterRequest {
    Check {
        installation_id: String,
        revision: u64,
        /// `None` means stable.
        channel: Option<Channel>,
    },
    Download {
        installation_id: String,
        revision: u64,
        candidate: Value,
    },
    Install {
        installation_id: String,
        revision: u64,
        transaction_id: String,
        candidate: Value,
        target: Value,
    },
    Recover {
        installation_id: String,
        revision: u64,
        transaction_id: String,
    },
    Adopt {
        installation_id: String,
        revision: u64,
        transaction_id: String,
        target: Value,
    },
    RecoverAdoption {
        installation_id: String,
        revision: u64,
        transaction_id: String,
    },
}

impl AdapterRequest {
    fn installation_id(&self) -> &str {
        match self {
            AdapterRequest::Check {
                installation_id, ..
            }
            | AdapterRequest::Download {
                installation_id, ..
            }
            | AdapterRequest::Install {
                installation_id, ..
            }
            | AdapterRequest::Recover {
                installation_id, ..
            }
            | AdapterRequest::Adopt {
                installation_id, ..
            }
            | AdapterRequest::RecoverAdoption {
                installation_id, ..
            } => installation_id,
        }
    }
    fn revision(&self) -> u64 {
        match self {
            AdapterRequest::Check { revision, .. }
            | AdapterRequest::Download { revision, .. }
            | AdapterRequest::Install { revision, .. }
            | AdapterRequest::Recover { revision, .. }
            | AdapterRequest::Adopt { revision, .. }
            | AdapterRequest::RecoverAdoption { revision, .. } => *revision,
        }
    }
    fn command(&self) -> &'static str {
        match self {
            AdapterRequest::Check { .. } => "check",
            AdapterRequest::Download { .. } => "download",
            AdapterRequest::Install { .. } => "install",
            AdapterRequest::Recover { .. } => "recover",
            AdapterRequest::Adopt { .. } => "adopt",
            AdapterRequest::RecoverAdoption { .. } => "recover-adoption",
        }
    }
    fn requires_authorization(&self) -> bool {
        matches!(
            self,
            AdapterRequest::Install { .. } | AdapterRequest::Adopt { .. }
        )
    }
    fn is_recovery(&self) -> bool {
        matches!(
            self,
            AdapterRequest::Recover { .. } | AdapterRequest::RecoverAdoption { .. }
        )
    }
}

/// `AdapterOutcome`: the terminal result of a successful command run.
#[derive(Clone, Debug, PartialEq)]
pub struct AdapterOutcome {
    /// The terminal frame: `checked`, `downloaded` or `outcome`.
    pub frame: Value,
    /// Intermediate frames pushed to a caller that wants to observe progress.
    pub frames: Vec<Value>,
    /// Final handoff classification.
    pub handoff: HandoffState,
}

fn build_command(request: &AdapterRequest) -> Value {
    let mut obj = Map::new();
    obj.insert("schema".into(), json!(1));
    obj.insert("command".into(), json!(request.command()));
    obj.insert("commandId".into(), json!(uuid::Uuid::new_v4().to_string()));
    obj.insert("installationId".into(), json!(request.installation_id()));
    obj.insert("revision".into(), json!(request.revision()));
    obj.insert("nonce".into(), json!(random_hash()));
    match request {
        AdapterRequest::Check { channel, .. } => {
            obj.insert("transactionId".into(), Value::Null);
            if let Some(Channel::Nightly) = channel {
                obj.insert("channel".into(), json!("nightly"));
            }
        }
        AdapterRequest::Download { candidate, .. } => {
            obj.insert("transactionId".into(), Value::Null);
            obj.insert("candidate".into(), candidate.clone());
        }
        AdapterRequest::Install {
            transaction_id,
            candidate,
            target,
            ..
        } => {
            obj.insert("transactionId".into(), json!(transaction_id));
            obj.insert("candidate".into(), candidate.clone());
            obj.insert("target".into(), target.clone());
        }
        AdapterRequest::Adopt {
            transaction_id,
            target,
            ..
        } => {
            obj.insert("transactionId".into(), json!(transaction_id));
            obj.insert("target".into(), target.clone());
        }
        AdapterRequest::Recover { transaction_id, .. }
        | AdapterRequest::RecoverAdoption { transaction_id, .. } => {
            obj.insert("transactionId".into(), json!(transaction_id));
        }
    }
    Value::Object(obj)
}

fn random_hash() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        // uuid is already available; fall back to a v4-nonce derived value so
        // the 64-hex invariant still holds.
        let uuid = uuid::Uuid::new_v4();
        return uuid.simple().to_string() + &uuid.simple().to_string();
    }
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Variant of `AdapterError::new` that also aborts the helper when no
/// handoff has been reached yet (`adapter.ts` `fail`: abort when
/// `handoff === "none"` and a pipe exists). `before_frames` records that
/// the helper ended before sending any frame.
fn abort_and_fail(
    pipe: &mut dyn VerifiedPipe,
    handoff: HandoffState,
    before_frames: bool,
    reason: AdapterFailure,
    rejection: Option<AdapterRejection>,
) -> AdapterError {
    if handoff == HandoffState::None {
        pipe.abort();
    }
    AdapterError {
        reason,
        handoff,
        rejection,
        before_frames,
        core: AdapterError::new(reason, handoff).core,
    }
}

/// Protocol rejection detail without leaking frame payloads, plus abort if
/// the helper still needs it (mirror of `adapter` `rejected` + `fail`).
fn protocol_reject(
    pipe: &mut dyn VerifiedPipe,
    handoff: HandoffState,
    sequence: u64,
    hello: bool,
    phase: Phase,
    check: &str,
    frame: &Value,
    expected: u64,
) -> AdapterError {
    let detail = AdapterRejection {
        check: check.to_string(),
        kind: frame
            .get("kind")
            .and_then(Value::as_str)
            .map(|s| s.to_string()),
        sequence: frame.get("sequence").and_then(Value::as_u64),
        expected_sequence: expected,
        phase: phase.as_str().to_string(),
        hello,
    };
    abort_and_fail(
        pipe,
        handoff,
        sequence == 0,
        AdapterFailure::Protocol,
        Some(detail),
    )
}

/// Runs one adapter command against a verified pipe within `deadline`,
/// walking the helper to a terminal `checked` / `downloaded` / `outcome`.
/// Mirrors `runAdapterCommand`, reduced to the library's `VerifiedPipe`
/// surface (no external authorize callback — the continuation is written on
/// `prepared`, and cancellation is expressed through `deadline`).
///
/// A command resolves only after the helper has sent a terminal frame **and**
/// then closed the pipe cleanly (EOF), matching the TypeScript harness
/// (`finish` after clean EOF + exit). A terminal frame is not enough on its
/// own. Protocol errors record the failing predicate without leaking frame
/// payloads, and a failure before any handoff aborts the helper.
pub async fn run_adapter_command(
    pipe: &mut dyn VerifiedPipe,
    request: &AdapterRequest,
    deadline: Duration,
) -> Result<AdapterOutcome, AdapterError> {
    if deadline.is_zero() {
        return Err(invalid());
    }
    let command = build_command(request);
    parse_adapter_command(&command)?;
    let command_id = command
        .get("commandId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let nonce = command
        .get("nonce")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    // Recovery is authorized only by the helper's private recorded journal;
    // sending this command may resume mutation.
    let mut handoff = if request.is_recovery() {
        HandoffState::Uncertain
    } else {
        HandoffState::None
    };
    let mut hello = false;
    let mut sequence: u64 = 0;
    let mut phase = Phase::Initial;
    let rejection: Option<AdapterRejection> = None;
    let mut prepared: Option<Value> = None;
    let mut terminal: Option<Value> = None;
    let mut frames: Vec<Value> = Vec::new();
    let mut downloaded_bytes: u64 = 0;
    let mut total_bytes: Option<u64> = None;

    let start = tokio::time::Instant::now();
    let deadline_instant = start + deadline;

    let mut decoder = FrameDecoder::new();

    // Send the command frame.
    let bytes = encode_frame(&command)?;
    pipe.send(&bytes)
        .await
        .map_err(|_| abort_and_fail(pipe, handoff, sequence == 0, AdapterFailure::Closed, None))?;

    loop {
        if tokio::time::Instant::now() >= deadline_instant {
            return Err(abort_and_fail(
                pipe,
                handoff,
                sequence == 0,
                AdapterFailure::Timeout,
                None,
            ));
        }
        let remaining = deadline_instant.saturating_duration_since(tokio::time::Instant::now());
        let recv = tokio::time::timeout(remaining, pipe.recv()).await;
        let raw = match recv {
            Ok(Ok(Some(chunk))) => chunk,
            Ok(Ok(None)) => {
                // Clean EOF: the helper is done. A truncated frame is a
                // protocol rejection before we can hand over a terminal.
                if let Err(error) = decoder.finish() {
                    let detail = rejection.clone().unwrap_or(AdapterRejection {
                        check: "frame".to_string(),
                        kind: None,
                        sequence: None,
                        expected_sequence: sequence,
                        phase: phase.as_str().to_string(),
                        hello,
                    });
                    return Err(error.rejection_set(Some(detail)));
                }
                if let Some(frame) = terminal {
                    return Ok(AdapterOutcome {
                        frame,
                        frames,
                        handoff,
                    });
                }
                return Err(abort_and_fail(
                    pipe,
                    handoff,
                    sequence == 0,
                    AdapterFailure::Closed,
                    None,
                ));
            }
            Ok(Err(_)) => {
                return Err(abort_and_fail(
                    pipe,
                    handoff,
                    sequence == 0,
                    AdapterFailure::Closed,
                    None,
                ));
            }
            Err(_) => {
                return Err(abort_and_fail(
                    pipe,
                    handoff,
                    sequence == 0,
                    AdapterFailure::Timeout,
                    None,
                ));
            }
        };
        let values = match decoder.push(&raw) {
            Ok(values) => values,
            Err(error) => {
                let detail = AdapterRejection {
                    check: "frame".to_string(),
                    kind: None,
                    sequence: None,
                    expected_sequence: sequence,
                    phase: phase.as_str().to_string(),
                    hello,
                };
                return Err(error.rejection_set(Some(detail)));
            }
        };
        for value in values {
            let expected = sequence;
            // Every accepted or rejected frame advances the expected sequence
            // (mirror of `accept`: `const expected = sequence++`).
            sequence += 1;
            // Schema: the frame must match the private frame schema. A
            // schema rejection never carries kind/sequence payloads.
            if parse_adapter_frame(&value).is_err() {
                return Err(protocol_reject(
                    pipe,
                    handoff,
                    sequence,
                    hello,
                    phase,
                    "schema",
                    &Value::Null,
                    expected,
                ));
            }
            // Binding: every frame must match the command envelope.
            if value.get("schema") != command.get("schema")
                || value.get("commandId") != command.get("commandId")
                || value.get("installationId") != command.get("installationId")
                || value.get("transactionId") != command.get("transactionId")
                || value.get("revision") != command.get("revision")
                || value.get("nonce") != command.get("nonce")
            {
                return Err(protocol_reject(
                    pipe, handoff, sequence, hello, phase, "binding", &value, expected,
                ));
            }
            if value.get("sequence").and_then(Value::as_u64) != Some(expected) {
                return Err(protocol_reject(
                    pipe, handoff, sequence, hello, phase, "sequence", &value, expected,
                ));
            }
            if terminal.is_some() {
                return Err(protocol_reject(
                    pipe, handoff, sequence, hello, phase, "terminal", &value, expected,
                ));
            }
            let kind = value
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if !hello {
                // A bound, correctly sequenced error before hello is the
                // helper refusing the command, not a malformed stream.
                if kind == "error" {
                    return Err(abort_and_fail(
                        pipe,
                        handoff,
                        sequence == 0,
                        AdapterFailure::Remote,
                        None,
                    ));
                }
                if kind != "hello" {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "hello", &value, expected,
                    ));
                }
                // Identity comes from local verification, not the helper's hello.
                let (version, bundle_id, arch) = pipe.identity();
                if value.get("version").and_then(Value::as_str) != Some(version)
                    || value.get("arch").and_then(Value::as_str) != Some(arch)
                    || value.get("bundleId").and_then(Value::as_str) != Some(bundle_id)
                {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "identity", &value, expected,
                    ));
                }
                hello = true;
                continue;
            }
            if kind == "hello" {
                return Err(protocol_reject(
                    pipe, handoff, sequence, hello, phase, "order", &value, expected,
                ));
            }
            if kind == "error" {
                return Err(abort_and_fail(
                    pipe,
                    handoff,
                    sequence == 0,
                    AdapterFailure::Remote,
                    None,
                ));
            }
            if kind == "checked" {
                if request.command() != "check" {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                terminal = Some(value);
                continue;
            }
            if kind == "progress" || kind == "downloaded" {
                if request.command() != "download" {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                let downloaded = value.get("downloadedBytes").and_then(Value::as_u64);
                let total = value.get("totalBytes").and_then(Value::as_u64);
                let monotonic = match downloaded {
                    Some(d) => {
                        d >= downloaded_bytes
                            && total.is_none_or(|t| d <= t)
                            && (total.is_none() || total_bytes.is_none_or(|old| total == Some(old)))
                            && (total.is_some() || total_bytes.is_none())
                    }
                    None => false,
                };
                if !monotonic {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                if let Some(d) = downloaded {
                    downloaded_bytes = downloaded_bytes.max(d);
                }
                if let Some(t) = total {
                    total_bytes = Some(t);
                }
                if kind == "progress" {
                    frames.push(value);
                    continue;
                }
                // downloaded: completion must match every selected field.
                let complete = value
                    .get("totalBytes")
                    .and_then(Value::as_u64)
                    .is_some_and(|t| t > 0)
                    && value.get("downloadedBytes").and_then(Value::as_u64)
                        == value.get("totalBytes").and_then(Value::as_u64)
                    && value.get("candidate") == command.get("candidate");
                if !complete {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                terminal = Some(value);
                continue;
            }
            if kind == "prepared" {
                if !request.requires_authorization() || phase != Phase::Initial {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                if value.get("reservationId").and_then(Value::as_str)
                    != command.get("transactionId").and_then(Value::as_str)
                {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                prepared = Some(value.clone());
                // The write of the continuation is the possible mutation boundary.
                handoff = HandoffState::Uncertain;
                phase = Phase::Authorizing;
                let reservation = value
                    .get("reservationId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let journal = value
                    .get("journalSha256")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let continuation = json!({
                    "schema": command.get("schema"),
                    "commandId": command_id,
                    "installationId": command.get("installationId"),
                    "transactionId": command.get("transactionId"),
                    "revision": command.get("revision"),
                    "nonce": nonce,
                    "kind": "authorize-install",
                    "reservationId": reservation,
                    "journalSha256": journal,
                });
                parse_install_authorization(&continuation)?;
                let bytes = encode_frame(&continuation)?;
                pipe.send(&bytes).await.map_err(|_| {
                    abort_and_fail(pipe, handoff, sequence == 0, AdapterFailure::Closed, None)
                })?;
                continue;
            }
            if kind == "authorized" {
                if !request.requires_authorization() || phase != Phase::Authorizing {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                let prepared_value = prepared.clone().unwrap_or_default();
                if value.get("reservationId") != prepared_value.get("reservationId")
                    || value.get("journalSha256") != prepared_value.get("journalSha256")
                {
                    // A different prepared journal was acknowledged.
                    return Err(abort_and_fail(
                        pipe,
                        HandoffState::Uncertain,
                        false,
                        AdapterFailure::Protocol,
                        Some(AdapterRejection {
                            check: "order".to_string(),
                            kind: Some(kind),
                            sequence: Some(expected),
                            expected_sequence: expected,
                            phase: phase.as_str().to_string(),
                            hello,
                        }),
                    ));
                }
                handoff = HandoffState::Acknowledged;
                phase = Phase::Authorized;
                frames.push(value);
                continue;
            }
            if kind == "outcome" {
                let terminal_ok = if request.is_recovery() {
                    true
                } else {
                    request.requires_authorization() && phase == Phase::Authorized
                };
                if !terminal_ok {
                    return Err(protocol_reject(
                        pipe, handoff, sequence, hello, phase, "order", &value, expected,
                    ));
                }
                terminal = Some(value);
                continue;
            }
            return Err(protocol_reject(
                pipe, handoff, sequence, hello, phase, "order", &value, expected,
            ));
        }
    }
}
