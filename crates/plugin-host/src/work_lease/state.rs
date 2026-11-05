//! Lossless desktop admission-state projection over the reviewed AST snapshots.
//!
//! A desktop admission row is parsed exactly as `JSON.parse` would be, with
//! UTF-16 units retained (including isolated surrogates) and Overflow numbers
//! as signed infinities. The typed model below is the single source of truth a
//! work-lease mutation operates on; `render` reconstructs the row the way
//! TypeScript's `JSON.stringify` would (unknown members stripped, known keys
//! in shape order, action-appended optional fields at the end).
//!
//! The projection reuses the reviewed `WireReply` AST only. No second parser
//! or `serde_json::Value` of the document is built on this path.
use pacer_js_json::{Utf16String, WireReply, js_semantics};
use serde_json::Value;

pub(super) type Units = Vec<u16>;

/// A stored work phase; maps to the `pending`/`active` enum literals.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    Pending,
    Active,
}

/// Blocker fields of a stored lease. `kind` is R3's public `BlockerKind`.
#[derive(Clone, Debug)]
pub(super) struct Blocker {
    pub kind: super::BlockerKind,
    pub id: Units,
    pub label: Units,
}

/// Process identity (`identity.nullable()`), only ever set by TypeScript.
#[derive(Clone, Debug)]
pub(super) struct Identity {
    pub pid: u64,
    pub boot_id: Units,
    pub birth: Units,
}

/// Remote evidence (`remote.optional()`).
#[derive(Clone, Debug)]
pub(super) struct Remote {
    pub host: Units,
    pub dir: Units,
}

/// Orca binding (`orca.optional()`).
#[derive(Clone, Debug)]
pub(super) struct Orca {
    pub dispatch_id: Units,
    pub terminal: Option<Units>,
    pub incarnation_id: Option<Units>,
}

/// A field first assigned by the current action, in assignment order. Such a
/// field is appended to the lease object rather than emitted at its shape slot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Late {
    RunDir,
    Remote,
    Launched,
    Orca,
}

/// A single admission lease, kept in shape order after decoding.
#[derive(Clone, Debug)]
pub(super) struct Lease {
    pub id: String,
    pub blocker: Blocker,
    pub owner: String,
    pub process: Option<Identity>,
    pub state: Phase,
    pub run_dir: Option<Units>,
    pub remote: Option<Remote>,
    pub launched: Option<bool>,
    pub orca: Option<Orca>,
    /// Optional fields first assigned by this action, in assignment order.
    pub appended: Vec<Late>,
}

impl Lease {
    /// Set `runDir`, marking it an action-appended field when it was absent.
    pub fn set_run_dir(&mut self, u: Units) {
        if self.run_dir.is_none() && !self.appended.contains(&Late::RunDir) {
            self.appended.push(Late::RunDir);
        }
        self.run_dir = Some(u);
    }
    /// Set `remote`, marking it an action-appended field when it was absent.
    pub fn set_remote(&mut self, r: Remote) {
        if self.remote.is_none() && !self.appended.contains(&Late::Remote) {
            self.appended.push(Late::Remote);
        }
        self.remote = Some(r);
    }
    /// Set `orca`, marking it an action-appended field when it was absent.
    pub fn set_orca(&mut self, o: Orca) {
        if self.orca.is_none() && !self.appended.contains(&Late::Orca) {
            self.appended.push(Late::Orca);
        }
        self.orca = Some(o);
    }
}

/// The lossless parent of the whole admission row.
pub(super) struct AdmissionState {
    pub reservation: Option<Units>,
    pub leases: Vec<Lease>,
}

impl AdmissionState {
    /// The TypeScript default row.
    pub fn empty() -> Self {
        Self {
            reservation: None,
            leases: Vec::new(),
        }
    }

    /// Project and validate `text` (plan §3.3). Returns `None` on any parse
    /// or schema failure. Unknown members are stripped; known keys are
    /// validated against exact UTF-16 units.
    pub fn decode(text: &str) -> Option<Self> {
        let doc = WireReply::parse(text).ok()?;
        if !matches!(doc.preview(), Value::Object(_)) {
            return None;
        }
        let schema = doc.number_at("/schema")?;
        if schema != 1.0 {
            return None;
        }
        let reservation = required_nullable_str(&doc, "/reservation")?;
        if !matches!(doc.preview().pointer("/leases"), Some(Value::Array(_))) {
            return None;
        }
        let leases_snap = doc.subtree("/leases").ok()?;
        drop(doc);
        let n = match leases_snap.preview() {
            Value::Array(items) => items.len(),
            _ => return None,
        };
        let mut leases = Vec::with_capacity(n);
        for i in 0..n {
            let snap = leases_snap.subtree(&format!("/{i}")).ok()?;
            let lease = project_lease(&snap)?;
            drop(snap);
            leases.push(lease);
        }
        Some(Self {
            reservation,
            leases,
        })
    }

    /// Reconstruct the row the way TypeScript's `JSON.stringify` does.
    pub fn render(&self) -> Result<String, serde_json::Error> {
        let mut out = String::new();
        out.push_str("{\"schema\":1,\"reservation\":");
        write_optional_units(&mut out, self.reservation.as_deref())?;
        out.push_str(",\"leases\":[");
        for (i, lease) in self.leases.iter().enumerate() {
            if i != 0 {
                out.push(',');
            }
            render_lease(&mut out, lease)?;
        }
        out.push_str("]}");
        Ok(out)
    }
}

/// Snapshot a lease starting from `snap` (an `E` snapshot, plan §3.3).
fn project_lease(snap: &WireReply) -> Option<Lease> {
    if !matches!(snap.preview(), Value::Object(_)) {
        return None;
    }
    let id = uuid_str(snap, "/id")?;
    let owner = uuid_str(snap, "/owner")?;
    let blocker = project_blocker(snap)?;
    let process = project_process(snap)?;
    let state = match enum_at(snap, "/state", &["pending", "active"])? {
        "pending" => Phase::Pending,
        _ => Phase::Active,
    };
    let run_dir = match opt_str(snap, "/runDir") {
        Some(None) => None,
        Some(Some(v)) => Some(v),
        None => return None,
    };
    let remote = match opt_remote(snap) {
        Some(None) => None,
        Some(Some(v)) => Some(v),
        None => return None,
    };
    let launched = match opt_bool(snap, "/launched") {
        Some(None) => None,
        Some(Some(v)) => Some(v),
        None => return None,
    };
    let orca = match opt_orca(snap) {
        Some(None) => None,
        Some(Some(v)) => Some(v),
        None => return None,
    };
    Some(Lease {
        id,
        blocker,
        owner,
        process,
        state,
        run_dir,
        remote,
        launched,
        orca,
        appended: Vec::new(),
    })
}

fn project_blocker(snap: &WireReply) -> Option<Blocker> {
    let kind = enum_at(
        snap,
        "/blocker/kind",
        &["task", "session", "launch", "operation"],
    )?;
    let kind = match kind {
        "task" => super::BlockerKind::Task,
        "session" => super::BlockerKind::Session,
        "launch" => super::BlockerKind::Launch,
        _ => super::BlockerKind::Operation,
    };
    let id = str_nonempty(snap, "/blocker/id")?;
    let label = str_at(snap, "/blocker/label")?;
    Some(Blocker { kind, id, label })
}

fn project_process(snap: &WireReply) -> Option<Option<Identity>> {
    // `identity.nullable()`: null ok, missing rejects.
    if exact_null(snap, "/process") {
        return Some(None);
    }
    if !matches!(snap.preview().pointer("/process"), Some(Value::Object(_))) {
        return None;
    }
    let pid = number_at(snap, "/process/pid")?;
    let pid = js_semantics::safe_u64(&Value::from(pid))?;
    if pid == 0 {
        return None;
    }
    let boot_id = str_nonempty(snap, "/process/bootId")?;
    let birth = str_nonempty(snap, "/process/birth")?;
    Some(Some(Identity {
        pid,
        boot_id,
        birth,
    }))
}

fn opt_remote(snap: &WireReply) -> Option<Option<Remote>> {
    match snap.preview().pointer("/remote") {
        Some(Value::Object(_)) => {
            let host = str_at(snap, "/remote/host")?;
            let dir = str_at(snap, "/remote/dir")?;
            Some(Some(Remote { host, dir }))
        }
        // Missing ok, null rejects.
        Some(_) => None,
        None => Some(None),
    }
}

fn opt_orca(snap: &WireReply) -> Option<Option<Orca>> {
    match snap.preview().pointer("/orca") {
        Some(Value::Object(_)) => {
            let dispatch_id = str_at(snap, "/orca/dispatchId")?;
            let terminal = required_nullable_str(snap, "/orca/terminal")?;
            let incarnation_id = match opt_str(snap, "/orca/incarnationId") {
                Some(None) => None,
                Some(Some(v)) => Some(v),
                None => return None,
            };
            Some(Some(Orca {
                dispatch_id,
                terminal,
                incarnation_id,
            }))
        }
        // Missing ok, null (or Overflow projected to null) rejects.
        Some(_) => None,
        None => Some(None),
    }
}

/// Exact lookups on an `E` snapshot (plan §2.1). Returns `None` on reject.
/// The value at `p` is an exact string of ≥ 1 UTF-16 units.
fn str_nonempty(snap: &WireReply, p: &str) -> Option<Units> {
    let units = str_at(snap, p)?;
    (!units.is_empty()).then_some(units)
}

/// The value at `p` is an exact string (possibly empty) of UTF-16 units.
fn str_at(snap: &WireReply, p: &str) -> Option<Units> {
    Some(snap.string_at(p).ok()?.units().to_vec())
}

/// A required field that is either exact `null` or a string (`None` = null).
fn required_nullable_str(snap: &WireReply, p: &str) -> Option<Option<Units>> {
    if exact_null(snap, p) {
        return Some(None);
    }
    str_at(snap, p).map(Some)
}

/// An optional string field; `Some(None)` means the member is absent.
fn opt_str(snap: &WireReply, p: &str) -> Option<Option<Units>> {
    match snap.preview().pointer(p) {
        Some(_) => str_at(snap, p).map(Some),
        None => Some(None),
    }
}

/// An optional boolean field; `Some(None)` means the member is absent.
fn opt_bool(snap: &WireReply, p: &str) -> Option<Option<bool>> {
    match snap.preview().pointer(p) {
        Some(Value::Bool(b)) => Some(Some(*b)),
        Some(_) => None,
        None => Some(None),
    }
}

/// Exact `null` and not Overflow. Overflow also previews as null, so it is
/// separated via `number_at`.
fn exact_null(snap: &WireReply, p: &str) -> bool {
    matches!(snap.preview().pointer(p), Some(Value::Null)) && snap.number_at(p).is_none()
}

/// A finite number (safe integer rule applied by the caller) or Overflow.
fn number_at(snap: &WireReply, p: &str) -> Option<f64> {
    snap.number_at(p).filter(|n| n.is_finite())
}

/// A UUID string compared against exact units (A5), kept from `valid_state`.
fn uuid_str(snap: &WireReply, p: &str) -> Option<String> {
    let units = str_at(snap, p)?;
    let text = String::from_utf16(&units).ok()?;
    valid_uuid(&Value::String(text.clone())).then_some(text)
}

/// The exact A5 UUID predicate, kept unchanged from the retired `valid_state`.
fn valid_uuid(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        s.len() == 36
            && [8, 13, 18, 23].iter().all(|i| s.as_bytes()[*i] == b'-')
            && uuid::Uuid::parse_str(s).is_ok()
            && (s == "00000000-0000-0000-0000-000000000000"
                || s == "ffffffff-ffff-ffff-ffff-ffffffffffff"
                || (matches!(s.as_bytes()[14], b'1'..=b'8')
                    && matches!(
                        s.as_bytes()[19].to_ascii_lowercase(),
                        b'8' | b'9' | b'a' | b'b'
                    )))
    })
}

/// Exact member whose units equal one of `choices`. Overflow, null and
/// non-scalar objects never match.
fn enum_at<'a>(snap: &WireReply, p: &str, choices: &'a [&str]) -> Option<&'a str> {
    let units = str_at(snap, p)?;
    choices.iter().copied().find(|c| same(&units, c))
}

/// The only stored-string comparator: exact UTF-16 units against `&str`.
pub(super) fn same(units: &[u16], text: &str) -> bool {
    units.iter().copied().eq(text.encode_utf16())
}

// ---------- reconstruction (plan §3.6) ----------

fn render_lease(out: &mut String, lease: &Lease) -> Result<(), serde_json::Error> {
    out.push_str("{\"id\":");
    out.push_str(&serde_json::to_string(&lease.id)?);
    out.push_str(",\"blocker\":{\"kind\":");
    let blocker = &lease.blocker;
    out.push_str(&serde_json::to_string(blocker.kind.as_str())?);
    out.push_str(",\"id\":");
    write_units(out, &blocker.id)?;
    out.push_str(",\"label\":");
    write_units(out, &blocker.label)?;
    out.push('}');
    out.push_str(",\"owner\":");
    out.push_str(&serde_json::to_string(&lease.owner)?);
    out.push_str(",\"process\":");
    match &lease.process {
        Some(process) => {
            out.push_str("{\"pid\":");
            out.push_str(&process.pid.to_string());
            out.push_str(",\"bootId\":");
            write_units(out, &process.boot_id)?;
            out.push_str(",\"birth\":");
            write_units(out, &process.birth)?;
            out.push('}');
        }
        None => out.push_str("null"),
    }
    out.push_str(",\"state\":");
    out.push_str(&serde_json::to_string(match &lease.state {
        Phase::Pending => "pending",
        Phase::Active => "active",
    })?);
    if lease.run_dir.is_some() && !lease.appended.contains(&Late::RunDir) {
        out.push_str(",\"runDir\":");
        write_units(out, lease.run_dir.as_deref().unwrap_or_default())?;
    }
    if let Some(remote) = &lease.remote
        && !lease.appended.contains(&Late::Remote)
    {
        render_remote(out, remote)?;
    }
    if let Some(launched) = lease.launched
        && !lease.appended.contains(&Late::Launched)
    {
        out.push_str(",\"launched\":");
        out.push_str(if launched { "true" } else { "false" });
    }
    if let Some(orca) = &lease.orca
        && !lease.appended.contains(&Late::Orca)
    {
        render_orca(out, orca)?;
    }
    for late in &lease.appended {
        match late {
            Late::RunDir => {
                out.push_str(",\"runDir\":");
                write_units(out, lease.run_dir.as_deref().unwrap_or_default())?;
            }
            Late::Remote => {
                if let Some(remote) = &lease.remote {
                    render_remote(out, remote)?;
                }
            }
            Late::Launched => {
                out.push_str(",\"launched\":");
                out.push_str(if lease.launched == Some(true) {
                    "true"
                } else {
                    "false"
                });
            }
            Late::Orca => {
                if let Some(orca) = &lease.orca {
                    render_orca(out, orca)?;
                }
            }
        }
    }
    out.push('}');
    Ok(())
}

fn render_remote(out: &mut String, remote: &Remote) -> Result<(), serde_json::Error> {
    out.push_str(",\"remote\":{\"host\":");
    write_units(out, &remote.host)?;
    out.push_str(",\"dir\":");
    write_units(out, &remote.dir)?;
    out.push('}');
    Ok(())
}

fn render_orca(out: &mut String, orca: &Orca) -> Result<(), serde_json::Error> {
    out.push_str(",\"orca\":{\"dispatchId\":");
    write_units(out, &orca.dispatch_id)?;
    out.push_str(",\"terminal\":");
    write_optional_units(out, orca.terminal.as_deref())?;
    if let Some(incarnation) = &orca.incarnation_id {
        out.push_str(",\"incarnationId\":");
        write_units(out, incarnation)?;
    }
    out.push('}');
    Ok(())
}

/// Write a JSON string from exact units: scalar strings through serde, unit
/// strings carrying isolated surrogates through the reviewed `Utf16String`
/// serializer (lowercase `\uXXXX`). Matches `JSON.stringify`.
fn write_units(out: &mut String, units: &[u16]) -> Result<(), serde_json::Error> {
    match String::from_utf16(units) {
        Ok(text) => out.push_str(&serde_json::to_string(&text)?),
        Err(_) => {
            let raw = Utf16String::from_units(units.to_vec());
            out.push_str(&serde_json::to_string(&raw)?);
        }
    }
    Ok(())
}

/// Write `null` or a JSON string.
fn write_optional_units(out: &mut String, units: Option<&[u16]>) -> Result<(), serde_json::Error> {
    match units {
        Some(units) => write_units(out, units),
        None => {
            out.push_str("null");
            Ok(())
        }
    }
}
