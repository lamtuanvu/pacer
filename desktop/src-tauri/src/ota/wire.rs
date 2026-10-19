//! Schema-1 contracts shared with the service. Parsing validates semantics as well
//! as serde shape. State/public readers ignore benign additive fields; private
//! messages reject unknown fields. None of these types establish OS trust.
use serde::{de::DeserializeOwned, Deserialize, Deserializer, Serialize};
use serde_json::{Number, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::io::{ErrorKind, Read, Write};

pub const MAX_FRAME_BYTES: usize = 262_144;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const BUNDLE_ID: &str = "dev.pacer.desktop";

/// Sanitized errors: never include private payloads or underlying I/O diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WireError {
    Invalid,
    Io,
}
impl fmt::Display for WireError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Invalid => "Invalid desktop update wire data",
            Self::Io => "Desktop update pipe I/O failed",
        })
    }
}
impl std::error::Error for WireError {}
type Result<T> = std::result::Result<T, WireError>;
fn require(valid: bool) -> Result<()> {
    if valid {
        Ok(())
    } else {
        Err(WireError::Invalid)
    }
}

// Unlike serde's default Option handling, schema-1 nullable fields must be present.
fn required_option<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}
fn optional_nonnull<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Arch {
    #[serde(rename = "aarch64")]
    Aarch64,
    #[serde(rename = "x86_64")]
    X86_64,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Ownership {
    Managed,
    Attached,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Checking,
    Downloading,
    Ready,
    Waiting,
    Reserved,
    Installing,
    Verifying,
    Complete,
    RollingBack,
    Restored,
    Error,
    RecoveryFailed,
}
impl Phase {
    fn requires_restart(self) -> bool {
        matches!(
            self,
            Self::Waiting | Self::Reserved | Self::Installing | Self::Verifying | Self::RollingBack
        )
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Check,
    Download,
    Restart,
    Cancel,
    Configure,
    Adopt,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StatusAction {
    Check,
    Download,
    Restart,
    Cancel,
    Retry,
    Adopt,
    Configure,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BlockerKind {
    Task,
    Session,
    Launch,
    Operation,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub version: String,
    pub arch: Arch,
    pub sha256: String,
    pub signature: String,
    pub url: String,
    pub protocol_majors: Vec<u64>,
    pub rollback_compatible: bool,
    pub notes: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub id: String,
    pub app_path: String,
    pub bundle_id: String,
    pub owner_uid: u64,
    pub arch: Arch,
    pub pacer_home: String,
    pub port: u16,
    pub service_label: String,
    pub ownership: Ownership,
    pub version: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Blocker {
    pub kind: BlockerKind,
    pub id: String,
    pub label: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct UpdateError {
    pub code: String,
    pub message: String,
    #[serde(
        default,
        deserialize_with = "optional_nonnull",
        skip_serializing_if = "Option::is_none"
    )]
    pub hint: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RequestReceipt {
    pub request_id: String,
    pub action: Action,
    pub fingerprint: String,
    #[serde(deserialize_with = "required_option")]
    pub transaction_id: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRecord {
    pub schema: u32,
    pub installation_id: String,
    pub revision: u64,
    pub phase: Phase,
    #[serde(deserialize_with = "required_option")]
    pub candidate: Option<Candidate>,
    #[serde(deserialize_with = "required_option")]
    pub transaction_id: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub request_id: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub requested_by: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub requester_boot_id: Option<String>,
    pub auto_download: bool,
    #[serde(deserialize_with = "required_option")]
    pub checked_at: Option<Number>,
    pub blockers: Vec<Blocker>,
    pub downloaded_bytes: u64,
    #[serde(deserialize_with = "required_option")]
    pub total_bytes: Option<u64>,
    #[serde(deserialize_with = "required_option")]
    pub failed_version: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub error: Option<UpdateError>,
    pub request_history: Vec<RequestReceipt>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub installation_id: String,
    pub revision: u64,
    pub phase: Phase,
    #[serde(deserialize_with = "required_option")]
    pub transaction_id: Option<String>,
    pub auto_download: bool,
    #[serde(deserialize_with = "required_option")]
    pub checked_at: Option<Number>,
    pub blockers: Vec<Blocker>,
    pub downloaded_bytes: u64,
    #[serde(deserialize_with = "required_option")]
    pub total_bytes: Option<u64>,
    #[serde(deserialize_with = "required_option")]
    pub error: Option<UpdateError>,
    pub current: String,
    #[serde(deserialize_with = "required_option")]
    pub target: Option<String>,
    #[serde(deserialize_with = "required_option")]
    pub release_notes: Option<String>,
    pub ownership: Ownership,
    pub actions: Vec<StatusAction>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub schema: u32,
    pub command_id: String,
    pub installation_id: String,
    #[serde(deserialize_with = "required_option")]
    pub transaction_id: Option<String>,
    pub revision: u64,
    pub nonce: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ResponseBinding {
    #[serde(flatten)]
    pub binding: Binding,
    pub sequence: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "command", rename_all = "lowercase")]
pub enum AdapterCommand {
    Check {
        #[serde(flatten)]
        binding: Binding,
    },
    Download {
        #[serde(flatten)]
        binding: Binding,
        candidate: Candidate,
    },
    Install {
        #[serde(flatten)]
        binding: Binding,
        candidate: Candidate,
        target: Installation,
    },
    Recover {
        #[serde(flatten)]
        binding: Binding,
    },
}
impl AdapterCommand {
    pub fn binding(&self) -> &Binding {
        match self {
            Self::Check { binding }
            | Self::Download { binding, .. }
            | Self::Install { binding, .. }
            | Self::Recover { binding } => binding,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Outcome {
    Committed,
    Restored,
    RecoveryFailed,
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RemoteError {
    Network,
    Signature,
    Compatibility,
    Disk,
    Permission,
    Verification,
    Recovery,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AdapterFrame {
    Hello {
        #[serde(flatten)]
        response: ResponseBinding,
        version: String,
        #[serde(rename = "bundleId")]
        bundle_id: String,
        arch: Arch,
    },
    Progress {
        #[serde(flatten)]
        response: ResponseBinding,
        #[serde(rename = "downloadedBytes")]
        downloaded_bytes: u64,
        #[serde(rename = "totalBytes", deserialize_with = "required_option")]
        total_bytes: Option<u64>,
    },
    Checked {
        #[serde(flatten)]
        response: ResponseBinding,
        #[serde(deserialize_with = "required_option")]
        candidate: Option<Candidate>,
    },
    Downloaded {
        #[serde(flatten)]
        response: ResponseBinding,
        candidate: Candidate,
        #[serde(rename = "downloadedBytes")]
        downloaded_bytes: u64,
        #[serde(rename = "totalBytes")]
        total_bytes: u64,
    },
    Prepared {
        #[serde(flatten)]
        response: ResponseBinding,
        #[serde(rename = "reservationId")]
        reservation_id: String,
        #[serde(rename = "journalSha256")]
        journal_sha256: String,
    },
    Authorized {
        #[serde(flatten)]
        response: ResponseBinding,
        #[serde(rename = "reservationId")]
        reservation_id: String,
        #[serde(rename = "journalSha256")]
        journal_sha256: String,
    },
    Outcome {
        #[serde(flatten)]
        response: ResponseBinding,
        outcome: Outcome,
    },
    Error {
        #[serde(flatten)]
        response: ResponseBinding,
        code: RemoteError,
    },
}
impl AdapterFrame {
    pub fn response(&self) -> &ResponseBinding {
        match self {
            Self::Hello { response, .. }
            | Self::Progress { response, .. }
            | Self::Checked { response, .. }
            | Self::Downloaded { response, .. }
            | Self::Prepared { response, .. }
            | Self::Authorized { response, .. }
            | Self::Outcome { response, .. }
            | Self::Error { response, .. } => response,
        }
    }
}
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum AuthorizationKind {
    #[serde(rename = "authorize-install")]
    AuthorizeInstall,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InstallAuthorization {
    #[serde(flatten)]
    pub binding: Binding,
    pub kind: AuthorizationKind,
    pub reservation_id: String,
    pub journal_sha256: String,
}

/// Always use validated parse/read/write entry points at a trust boundary.
/// A bare serde deserialize only constructs the representation, not authority.
pub trait WireMessage: Serialize + DeserializeOwned {
    fn validate(&self) -> Result<()>;
    fn validate_shape(_value: &Value) -> Result<()> {
        Ok(())
    }
}
fn identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn hash(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn integer(n: u64) -> bool {
    n <= MAX_SAFE_INTEGER
}
fn optional_id(value: &Option<String>) -> bool {
    value.as_deref().is_none_or(identifier)
}
fn text_len(value: &str) -> usize {
    value.encode_utf16().count()
}
fn absolute_path(value: &str) -> bool {
    value.starts_with('/') && !value.contains('\0') && text_len(value) <= 4096
}
/// Match the service's isVersion grammar, including its accepted numeric prerelease identifiers.
fn version(value: &str) -> bool {
    let identifiers = |s: &str| {
        !s.is_empty()
            && s.split('.').all(|part| {
                !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
    };
    let (base, build) = value
        .split_once('+')
        .map_or((value, None), |(a, b)| (a, Some(b)));
    if build.is_some_and(|s| !identifiers(s)) {
        return false;
    }
    let (core, pre) = base
        .split_once('-')
        .map_or((base, None), |(a, b)| (a, Some(b)));
    if pre.is_some_and(|s| !identifiers(s)) {
        return false;
    }
    let parts: Vec<_> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|s| {
            !s.is_empty()
                && s.bytes().all(|b| b.is_ascii_digit())
                && (s.len() == 1 || !s.starts_with('0'))
        })
}
fn candidate_valid(value: &Candidate, private: bool) -> bool {
    version(&value.version)
        && hash(&value.sha256)
        && !value.signature.is_empty()
        && url::Url::parse(&value.url).is_ok()
        && !value.protocol_majors.is_empty()
        && value.protocol_majors.iter().all(|n| integer(*n))
        && (!private
            || (text_len(&value.signature) <= 8192
                && text_len(&value.url) <= 2048
                && value.url.starts_with("https://")
                && value.protocol_majors.len() <= 32
                && value.protocol_majors.iter().all(|n| *n > 0)
                && text_len(&value.notes) <= 32768))
}
fn progress_valid(downloaded: u64, total: Option<u64>) -> bool {
    integer(downloaded) && total.is_none_or(|n| integer(n) && downloaded <= n)
}
fn presentation_valid(
    checked: &Option<Number>,
    blockers: &[Blocker],
    error: &Option<UpdateError>,
) -> bool {
    checked
        .as_ref()
        .is_none_or(|n| n.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0))
        && blockers.iter().all(|b| !b.id.is_empty())
        && error.as_ref().is_none_or(|e| !e.code.is_empty())
}
fn binding_valid(binding: &Binding) -> bool {
    binding.schema == 1
        && identifier(&binding.command_id)
        && identifier(&binding.installation_id)
        && optional_id(&binding.transaction_id)
        && integer(binding.revision)
        && hash(&binding.nonce)
}

/// SHA256 of JSON.stringify(sorted array-of-pairs), not a JSON object's encoding.
/// UTF-16 key ordering matches JavaScript even for non-ASCII caller keys.
pub fn request_fingerprint(parameters: &BTreeMap<String, Value>) -> Result<String> {
    require(parameters.values().all(|v| v.is_string() || v.is_boolean()))?;
    let mut pairs: Vec<_> = parameters.iter().collect();
    pairs.sort_by(|(a, _), (b, _)| a.encode_utf16().cmp(b.encode_utf16()));
    let canonical = serde_json::to_vec(&pairs).map_err(|_| WireError::Invalid)?;
    Ok(format!("{:x}", Sha256::digest(canonical)))
}

impl WireMessage for UpdateRecord {
    fn validate(&self) -> Result<()> {
        require(
            self.schema == 1
                && identifier(&self.installation_id)
                && integer(self.revision)
                && optional_id(&self.transaction_id)
                && optional_id(&self.request_id)
                && optional_id(&self.requested_by)
                && optional_id(&self.requester_boot_id)
                && self
                    .candidate
                    .as_ref()
                    .is_none_or(|c| candidate_valid(c, false))
                && self.failed_version.as_deref().is_none_or(version)
                && progress_valid(self.downloaded_bytes, self.total_bytes)
                && presentation_valid(&self.checked_at, &self.blockers, &self.error),
        )?;
        let mut ids = HashSet::new();
        for receipt in &self.request_history {
            require(
                identifier(&receipt.request_id)
                    && hash(&receipt.fingerprint)
                    && optional_id(&receipt.transaction_id)
                    && ids.insert(&receipt.request_id),
            )?;
        }
        if self.phase == Phase::Ready || self.phase.requires_restart() {
            require(
                self.candidate.is_some()
                    && self
                        .total_bytes
                        .is_some_and(|n| n > 0 && n == self.downloaded_bytes),
            )?;
        }
        if self.phase.requires_restart() {
            let receipt = self
                .request_history
                .iter()
                .find(|r| Some(&r.request_id) == self.request_id.as_ref())
                .ok_or(WireError::Invalid)?;
            require(
                self.transaction_id.is_some()
                    && self.requested_by.is_some()
                    && self.requester_boot_id.is_some()
                    && receipt.action == Action::Restart
                    && receipt.transaction_id == self.transaction_id,
            )?;
            let parameters = BTreeMap::from([
                (
                    "version".to_owned(),
                    Value::String(
                        self.candidate
                            .as_ref()
                            .ok_or(WireError::Invalid)?
                            .version
                            .clone(),
                    ),
                ),
                (
                    "clientId".to_owned(),
                    Value::String(self.requested_by.clone().ok_or(WireError::Invalid)?),
                ),
            ]);
            require(receipt.fingerprint == request_fingerprint(&parameters)?)?;
        }
        Ok(())
    }
}
impl WireMessage for UpdateStatus {
    fn validate(&self) -> Result<()> {
        require(
            identifier(&self.installation_id)
                && integer(self.revision)
                && optional_id(&self.transaction_id)
                && version(&self.current)
                && self.target.as_deref().is_none_or(version)
                && progress_valid(self.downloaded_bytes, self.total_bytes)
                && presentation_valid(&self.checked_at, &self.blockers, &self.error),
        )
    }
    fn validate_shape(value: &Value) -> Result<()> {
        reject_private_status_fields(value)?;
        if let Some(blockers) = value.get("blockers").and_then(Value::as_array) {
            for blocker in blockers {
                reject_private_status_fields(blocker)?;
            }
        }
        if let Some(error) = value.get("error").filter(|v| !v.is_null()) {
            reject_private_status_fields(error)?;
        }
        Ok(())
    }
}

// Public readers remain additive-compatible, but known private authority/storage
// fields are rejected rather than quietly normalizing a leaked private record.
fn reject_private_status_fields(value: &Value) -> Result<()> {
    const PRIVATE: &[&str] = &[
        "candidate",
        "appPath",
        "pacerHome",
        "signature",
        "nonce",
        "requestHistory",
        "requestId",
        "requestedBy",
        "requesterBootId",
        "url",
        "sha256",
        "fingerprint",
        "commandId",
        "reservationId",
        "journalSha256",
        "journalPath",
        "helperPath",
        "executable",
        "executablePath",
        "pipePath",
        "descriptorPath",
        "cachePath",
        "backupPath",
        "archivePath",
        "targetPath",
        "registrationPath",
        "privateDescriptor",
    ];
    require(
        value
            .as_object()
            .is_some_and(|object| object.keys().all(|key| !PRIVATE.contains(&key.as_str()))),
    )
}

const BINDING_KEYS: &[&str] = &[
    "schema",
    "commandId",
    "installationId",
    "transactionId",
    "revision",
    "nonce",
];
const CANDIDATE_KEYS: &[&str] = &[
    "version",
    "arch",
    "sha256",
    "signature",
    "url",
    "protocolMajors",
    "rollbackCompatible",
    "notes",
];
fn only_keys(value: &Value, allowed: &[&str]) -> Result<()> {
    require(
        value
            .as_object()
            .is_some_and(|o| o.keys().all(|key| allowed.contains(&key.as_str()))),
    )
}
fn envelope_keys(value: &Value, additional: &[&str]) -> Result<()> {
    let mut allowed = BINDING_KEYS.to_vec();
    allowed.extend_from_slice(additional);
    only_keys(value, &allowed)
}
fn strict_candidate(value: &Value) -> Result<()> {
    only_keys(value, CANDIDATE_KEYS)
}
impl WireMessage for AdapterCommand {
    fn validate(&self) -> Result<()> {
        let binding = self.binding();
        require(binding_valid(binding))?;
        match self {
            Self::Check { .. } => require(binding.transaction_id.is_none()),
            Self::Download { candidate, .. } => {
                require(binding.transaction_id.is_none() && candidate_valid(candidate, true))
            }
            Self::Recover { .. } => require(binding.transaction_id.is_some()),
            Self::Install {
                candidate, target, ..
            } => require(
                binding.transaction_id.is_some()
                    && candidate_valid(candidate, true)
                    && candidate.rollback_compatible
                    && target.id == binding.installation_id
                    && target.arch == candidate.arch
                    && target.bundle_id == BUNDLE_ID
                    && integer(target.owner_uid)
                    && target.port > 0
                    && absolute_path(&target.app_path)
                    && absolute_path(&target.pacer_home)
                    && !target.service_label.is_empty()
                    && text_len(&target.service_label) <= 128
                    && version(&target.version),
            ),
        }
    }
    fn validate_shape(value: &Value) -> Result<()> {
        let extra: &[&str] = match value.get("command").and_then(Value::as_str) {
            Some("check" | "recover") => &["command"],
            Some("download") => &["command", "candidate"],
            Some("install") => &["command", "candidate", "target"],
            _ => return Err(WireError::Invalid),
        };
        envelope_keys(value, extra)?;
        if let Some(candidate) = value.get("candidate") {
            strict_candidate(candidate)?;
        }
        if let Some(target) = value.get("target") {
            only_keys(
                target,
                &[
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
                ],
            )?;
        }
        Ok(())
    }
}
impl WireMessage for AdapterFrame {
    fn validate(&self) -> Result<()> {
        let response = self.response();
        require(binding_valid(&response.binding) && integer(response.sequence))?;
        match self {
            Self::Hello {
                version: v,
                bundle_id,
                ..
            } => require(version(v) && bundle_id == BUNDLE_ID),
            Self::Progress {
                downloaded_bytes,
                total_bytes,
                ..
            } => require(progress_valid(*downloaded_bytes, *total_bytes)),
            Self::Checked { candidate, .. } => {
                require(candidate.as_ref().is_none_or(|c| candidate_valid(c, true)))
            }
            Self::Downloaded {
                candidate,
                downloaded_bytes,
                total_bytes,
                ..
            } => require(
                candidate_valid(candidate, true)
                    && progress_valid(*downloaded_bytes, Some(*total_bytes))
                    && *total_bytes > 0
                    && downloaded_bytes == total_bytes,
            ),
            Self::Prepared {
                reservation_id,
                journal_sha256,
                ..
            }
            | Self::Authorized {
                reservation_id,
                journal_sha256,
                ..
            } => require(
                identifier(reservation_id)
                    && Some(reservation_id) == response.binding.transaction_id.as_ref()
                    && hash(journal_sha256),
            ),
            Self::Outcome { .. } => require(response.binding.transaction_id.is_some()),
            Self::Error { .. } => Ok(()),
        }
    }
    fn validate_shape(value: &Value) -> Result<()> {
        let fields: &[&str] = match value.get("kind").and_then(Value::as_str) {
            Some("hello") => &["version", "bundleId", "arch"],
            Some("progress") => &["downloadedBytes", "totalBytes"],
            Some("checked") => &["candidate"],
            Some("downloaded") => &["candidate", "downloadedBytes", "totalBytes"],
            Some("prepared" | "authorized") => &["reservationId", "journalSha256"],
            Some("outcome") => &["outcome"],
            Some("error") => &["code"],
            _ => return Err(WireError::Invalid),
        };
        let mut additional = vec!["kind", "sequence"];
        additional.extend_from_slice(fields);
        envelope_keys(value, &additional)?;
        if let Some(candidate) = value.get("candidate").filter(|v| !v.is_null()) {
            strict_candidate(candidate)?;
        }
        Ok(())
    }
}
impl WireMessage for InstallAuthorization {
    fn validate(&self) -> Result<()> {
        require(
            binding_valid(&self.binding)
                && identifier(&self.reservation_id)
                && Some(&self.reservation_id) == self.binding.transaction_id.as_ref()
                && hash(&self.journal_sha256),
        )
    }
    fn validate_shape(value: &Value) -> Result<()> {
        envelope_keys(value, &["kind", "reservationId", "journalSha256"])
    }
}

pub fn parse_json<T: WireMessage>(bytes: &[u8]) -> Result<T> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| WireError::Invalid)?;
    T::validate_shape(&value)?;
    let parsed: T = serde_json::from_value(value).map_err(|_| WireError::Invalid)?;
    parsed.validate()?;
    Ok(parsed)
}
pub fn parse_record(bytes: &[u8]) -> Result<UpdateRecord> {
    parse_json(bytes)
}
pub fn parse_status(bytes: &[u8]) -> Result<UpdateStatus> {
    parse_json(bytes)
}
pub fn parse_command(bytes: &[u8]) -> Result<AdapterCommand> {
    parse_json(bytes)
}
pub fn parse_frame(bytes: &[u8]) -> Result<AdapterFrame> {
    parse_json(bytes)
}
pub fn parse_authorization(bytes: &[u8]) -> Result<InstallAuthorization> {
    parse_json(bytes)
}

/// One frame per call; clean EOF is None, EOF in a header/body is invalid.
/// Reads exactly the declared body, leaving a coalesced next frame untouched.
pub fn read_message<T: WireMessage>(reader: &mut impl Read) -> Result<Option<T>> {
    let mut header = [0_u8; 4];
    loop {
        match reader.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(_) => return Err(WireError::Io),
        }
    }
    reader
        .read_exact(&mut header[1..])
        .map_err(|_| WireError::Invalid)?;
    let length = u32::from_be_bytes(header) as usize;
    require(length > 0 && length <= MAX_FRAME_BYTES)?;
    let mut payload = vec![0_u8; length];
    reader
        .read_exact(&mut payload)
        .map_err(|_| WireError::Invalid)?;
    parse_json(&payload).map(Some)
}
pub fn read_command(reader: &mut impl Read) -> Result<Option<AdapterCommand>> {
    read_message(reader)
}
pub fn write_message<T: WireMessage>(writer: &mut impl Write, message: &T) -> Result<()> {
    message.validate()?;
    // Cap serialization itself, including large additive state histories. Do not
    // first allocate an unbounded JSON value/string and check its size afterward.
    let mut buffer = FrameBuffer(Vec::new());
    serde_json::to_writer(&mut buffer, message).map_err(|_| WireError::Invalid)?;
    let payload = buffer.0;
    let value: Value = serde_json::from_slice(&payload).map_err(|_| WireError::Invalid)?;
    T::validate_shape(&value)?;
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .map_err(|_| WireError::Io)?;
    writer.write_all(&payload).map_err(|_| WireError::Io)?;
    writer.flush().map_err(|_| WireError::Io)
}

struct FrameBuffer(Vec<u8>);
impl Write for FrameBuffer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_FRAME_BYTES - self.0.len() {
            return Err(std::io::Error::from(ErrorKind::InvalidData));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    fn state() -> Value {
        serde_json::from_str::<Value>(include_str!(
            "../../../../test/fixtures/desktop-update/wire.json"
        ))
        .unwrap()["record"]
            .clone()
    }
    fn adapter() -> Value {
        serde_json::from_str(include_str!(
            "../../../../test/fixtures/desktop-update/adapter-wire.json"
        ))
        .unwrap()
    }
    fn bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).unwrap()
    }
    fn active(phase: &str) -> Value {
        let mut value = state();
        value["phase"] = json!(phase);
        value["transactionId"] = json!("transaction-1");
        value["requestId"] = json!("request-1");
        value["requestedBy"] = json!("desktop-client");
        value["requesterBootId"] = json!("boot-1");
        value["requestHistory"] = json!([{"requestId":"request-1", "action":"restart", "transactionId":"transaction-1", "fingerprint":"5f15427e53f002b80235dbaf5bfe3a46d980446faee043ffe75c96a014660be8"}]);
        value
    }

    #[test]
    fn state_fixture_roundtrips_and_additive_fields_do_not_become_authority() {
        let original = state();
        let mut added = original.clone();
        added["futureField"] = json!(true);
        added["candidate"]["futureMetadata"] = json!("ignored");
        let parsed = parse_record(&bytes(&added)).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), original);
    }

    #[test]
    fn schema_and_required_history_fail_closed() {
        let mut missing = state();
        missing.as_object_mut().unwrap().remove("requestHistory");
        assert!(parse_record(&bytes(&missing)).is_err());
        for (key, value) in [
            ("schema", json!(2)),
            ("revision", json!(9007199254740992_u64)),
            ("phase", json!("future-phase")),
            ("totalBytes", json!(10)),
            ("checkedAt", json!(-1)),
        ] {
            let mut record = state();
            record[key] = value;
            assert!(parse_record(&bytes(&record)).is_err(), "{key}");
        }
    }

    #[test]
    fn nullable_fields_must_be_present_and_optional_hint_cannot_be_null() {
        for key in [
            "candidate",
            "transactionId",
            "requestId",
            "requestedBy",
            "requesterBootId",
            "checkedAt",
            "totalBytes",
            "failedVersion",
            "error",
        ] {
            let mut missing = state();
            missing.as_object_mut().unwrap().remove(key);
            assert!(parse_record(&bytes(&missing)).is_err(), "missing {key}");
        }
        let mut command = adapter()["commands"][0].clone();
        command.as_object_mut().unwrap().remove("transactionId");
        assert!(parse_command(&bytes(&command)).is_err());
        let mut invalid_hint = state();
        invalid_hint["error"] = json!({"code":"permission", "message":"Try again", "hint":null});
        assert!(parse_record(&bytes(&invalid_hint)).is_err());
    }

    #[test]
    fn every_active_phase_requires_complete_candidate_and_matching_restart_receipt() {
        for phase in [
            "waiting",
            "reserved",
            "installing",
            "verifying",
            "rolling-back",
        ] {
            let original = active(phase);
            assert!(parse_record(&bytes(&original)).is_ok(), "{phase}");
            for key in [
                "candidate",
                "totalBytes",
                "transactionId",
                "requestId",
                "requestedBy",
                "requesterBootId",
            ] {
                let mut bad = original.clone();
                bad[key] = Value::Null;
                assert!(parse_record(&bytes(&bad)).is_err(), "{phase}: {key}");
            }
            for key in ["fingerprint", "transactionId", "action"] {
                let mut bad = original.clone();
                bad["requestHistory"][0][key] = if key == "fingerprint" {
                    json!("a".repeat(64))
                } else {
                    json!("check")
                };
                assert!(
                    parse_record(&bytes(&bad)).is_err(),
                    "{phase}: receipt {key}"
                );
            }
            let mut bad = original.clone();
            bad["candidate"]["version"] = json!("1.2.0");
            assert!(parse_record(&bytes(&bad)).is_err());
            let mut duplicate = original.clone();
            duplicate["requestHistory"]
                .as_array_mut()
                .unwrap()
                .push(original["requestHistory"][0].clone());
            assert!(parse_record(&bytes(&duplicate)).is_err());
        }
    }

    #[test]
    fn fingerprints_match_typescript_sorted_pair_json() {
        let parameters = BTreeMap::from([
            ("version".into(), json!("1.1.0")),
            ("clientId".into(), json!("desktop-client")),
        ]);
        assert_eq!(
            request_fingerprint(&parameters).unwrap(),
            "5f15427e53f002b80235dbaf5bfe3a46d980446faee043ffe75c96a014660be8"
        );
        let parameters = BTreeMap::from([
            ("version".into(), json!("1.1.0")),
            ("autoDownload".into(), json!(true)),
        ]);
        assert_eq!(
            request_fingerprint(&parameters).unwrap(),
            "1c2601ffbb0a75af77df5c496973964115655c2693f13fc5c8c0457c6f2f7f98"
        );
        assert!(request_fingerprint(&BTreeMap::from([("invalid".into(), json!(10))])).is_err());
    }

    #[test]
    fn all_shared_private_variants_roundtrip_as_typed_messages() {
        let fixture = adapter();
        for value in fixture["commands"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(parse_command(&bytes(value)).unwrap()).unwrap(),
                *value
            );
        }
        for value in fixture["frames"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(parse_frame(&bytes(value)).unwrap()).unwrap(),
                *value
            );
        }
        for value in fixture["continuations"].as_array().unwrap() {
            assert_eq!(
                serde_json::to_value(parse_authorization(&bytes(value)).unwrap()).unwrap(),
                *value
            );
        }
    }

    #[test]
    fn private_commands_reject_extra_authority_and_inconsistent_target() {
        let fixture = adapter();
        for (key, value) in [
            ("command", json!("execute-shell")),
            ("executable", json!("/tmp/evil")),
            ("schema", json!(2)),
            ("transactionId", json!("not-null")),
            ("nonce", json!("wrong")),
        ] {
            let mut command = fixture["commands"][0].clone();
            command[key] = value;
            assert!(parse_command(&bytes(&command)).is_err(), "{key}");
        }
        for (path, key, value) in [
            ("candidate", "extra", json!(true)),
            ("candidate", "rollbackCompatible", json!(false)),
            ("candidate", "arch", json!("x86_64")),
            ("candidate", "url", json!("http://example.invalid/x")),
            ("target", "appPath", json!("relative.app")),
            ("target", "id", json!("other")),
            ("target", "bundleId", json!("other.app")),
        ] {
            let mut command = fixture["commands"][2].clone();
            command[path][key] = value;
            assert!(parse_command(&bytes(&command)).is_err(), "{path}.{key}");
        }
        let mut authorization = fixture["continuations"][0].clone();
        authorization["reservationId"] = json!("other");
        assert!(parse_authorization(&bytes(&authorization)).is_err());
    }

    #[test]
    fn public_status_has_no_private_fields_or_nested_receipts() {
        let status = json!({"installationId":"fixture", "revision":0, "phase":"ready", "transactionId":null, "autoDownload":true, "checkedAt":100, "blockers":[], "downloadedBytes":1024, "totalBytes":1024, "error":null, "current":"1.0.0", "target":"1.1.0", "releaseNotes":"A release", "ownership":"managed", "actions":["restart"]});
        assert_eq!(
            serde_json::to_value(parse_status(&bytes(&status)).unwrap()).unwrap(),
            status
        );
        for key in [
            "candidate",
            "appPath",
            "pacerHome",
            "signature",
            "nonce",
            "requestHistory",
            "requestId",
            "requestedBy",
        ] {
            let mut leaked = status.clone();
            leaked[key] = json!("private");
            assert!(parse_status(&bytes(&leaked)).is_err(), "{key}");
        }
        let mut leaked = status.clone();
        leaked["blockers"] =
            json!([{"kind":"task", "id":"task", "label":"Task", "nonce":"private"}]);
        assert!(parse_status(&bytes(&leaked)).is_err());
    }

    #[test]
    fn public_status_ignores_benign_additive_fields_at_each_boundary() {
        let status = json!({"installationId":"fixture", "revision":0, "phase":"error", "transactionId":null, "autoDownload":true, "checkedAt":100, "blockers":[{"kind":"task", "id":"task", "label":"Task"}], "downloadedBytes":0, "totalBytes":null, "error":{"code":"network", "message":"Retry"}, "current":"1.0.0", "target":null, "releaseNotes":null, "ownership":"managed", "actions":["retry"]});
        let mut additive = status.clone();
        additive["futureStatusField"] = json!({"enabled":true});
        additive["blockers"][0]["futureBlockerField"] = json!(4);
        additive["error"]["futureErrorField"] = json!("detail");
        assert_eq!(
            serde_json::to_value(parse_status(&bytes(&additive)).unwrap()).unwrap(),
            status
        );
        for boundary in ["error", "blocker"] {
            let mut leaked = additive.clone();
            if boundary == "error" {
                leaked["error"]["requesterBootId"] = json!("secret");
            } else {
                leaked["blockers"][0]["journalPath"] = json!("/private/journal");
            }
            assert!(parse_status(&bytes(&leaked)).is_err());
        }
    }

    struct Fragmented<R>(R);
    impl<R: Read> Read for Fragmented<R> {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            let length = buf.len().min(1);
            self.0.read(&mut buf[..length])
        }
    }

    #[test]
    fn framed_messages_survive_fragmentation_and_coalescing() {
        let fixture = adapter();
        let command = parse_command(&bytes(&fixture["commands"][0])).unwrap();
        let mut bytes = Vec::new();
        write_message(&mut bytes, &command).unwrap();
        let payload_len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
        assert_eq!(payload_len, bytes.len() - 4);
        let mut combined = bytes.clone();
        combined.extend(bytes);
        let mut input = Fragmented(Cursor::new(combined));
        for _ in 0..2 {
            assert_eq!(
                serde_json::to_value(read_command(&mut input).unwrap().unwrap()).unwrap(),
                fixture["commands"][0]
            );
        }
        assert!(read_command(&mut input).unwrap().is_none());
    }

    #[test]
    fn framing_refuses_bad_lengths_truncation_utf8_and_unknown_commands() {
        for bytes in [
            vec![0],
            vec![0, 0, 0, 0],
            vec![0, 4, 0, 1],
            vec![0, 0, 0, 2, b'{'],
            vec![0, 0, 0, 1, 255],
        ] {
            assert!(read_command(&mut Cursor::new(bytes)).is_err());
        }
        let mut bad = adapter()["commands"][0].clone();
        bad["command"] = json!("shell");
        let payload = bytes(&bad);
        let mut encoded = (payload.len() as u32).to_be_bytes().to_vec();
        encoded.extend(payload);
        assert!(read_command(&mut Cursor::new(encoded)).is_err());
    }

    #[test]
    fn outbound_frames_refuse_oversize_before_writing_any_header() {
        let mut record = parse_record(&bytes(&state())).unwrap();
        record.candidate.as_mut().unwrap().notes = "x".repeat(MAX_FRAME_BYTES);
        let mut output = Vec::new();
        assert!(write_message(&mut output, &record).is_err());
        assert!(output.is_empty());
        record.candidate.as_mut().unwrap().notes = "ok".into();
        write_message(&mut output, &record).unwrap();
        let parsed: UpdateRecord = read_message(&mut Cursor::new(output)).unwrap().unwrap();
        assert_eq!(parsed, record);
    }

    #[test]
    fn response_variants_enforce_numeric_bounds_and_private_shape() {
        let mut base = adapter()["frames"][0].clone();
        for key in ["version", "bundleId", "arch"] {
            base.as_object_mut().unwrap().remove(key);
        }
        base["sequence"] = json!(1);
        for extra in [
            json!({"kind":"progress", "downloadedBytes":5, "totalBytes":10}),
            json!({"kind":"checked", "candidate":null}),
            json!({"kind":"downloaded", "candidate":adapter()["commands"][1]["candidate"], "downloadedBytes":10, "totalBytes":10}),
            json!({"kind":"error", "code":"signature"}),
        ] {
            let mut value = base.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            let parsed = parse_frame(&bytes(&value)).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            value["privateDiagnostic"] = json!("secret");
            assert!(parse_frame(&bytes(&value)).is_err());
        }
        for extra in [
            json!({"kind":"progress", "downloadedBytes":11, "totalBytes":10}),
            json!({"kind":"progress", "downloadedBytes":9007199254740992_u64, "totalBytes":null}),
            json!({"kind":"downloaded", "candidate":adapter()["commands"][1]["candidate"], "downloadedBytes":9, "totalBytes":10}),
            json!({"kind":"error", "code":"private-diagnostic-secret"}),
        ] {
            let mut value = base.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            assert!(parse_frame(&bytes(&value)).is_err());
        }
    }
}
