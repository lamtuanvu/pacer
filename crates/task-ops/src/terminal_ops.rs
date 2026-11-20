//! Native `terminal.list`, `terminal.create`, `terminal.rename` and `terminal.close`
//! (`src/api/ops-terminal.ts`, `src/terminal/workspace.ts`). Rust owns parameter validation, the
//! executor refusal, idempotent reservations, revision checks and the registry files under the
//! shared `terminal-registry` lock. Core keeps what only it can do, through the [`TerminalBridge`]:
//! the account's login shell, session liveness and starting or stopping the session host.
//! Registry files JavaScript reads differently from this module forward ([`stays_forwarded`]).
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock_async},
};
use pacer_js_json::{js_semantics, quoted, stringify};
use pacer_lifecycle::files_search::executor_session;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{fs, os::unix::fs::DirBuilderExt, path::PathBuf};

use super::files_search_ops::providers;

const LOCK: &str = "terminal-registry";
const MAX_LIVE: u64 = 16;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const TITLE_RANGE: &str = "Terminal title must be 1\u{2013}80 characters";
const CHANGED: &str = "Terminal changed; refresh and try again";
/// Inherited `Object.prototype` names: `reservations[id]` finds these on an object without the key.
const INHERITED: [&str; 12] = [
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// One Core read or effect per call; requests are `{"kind": ...}` objects
/// (`src/api/terminal-parts-bridge.ts`).
pub trait TerminalBridge: Send {
    fn parts(&mut self, request: Value) -> OpFuture<'_>;
}

/// Ops a front door dispatches through [`call`] with a Core bridge.
pub fn uses_bridge(op: &str) -> bool {
    matches!(
        op,
        "terminal.list" | "terminal.create" | "terminal.rename" | "terminal.close"
    )
}

/// Registry entry for ops that run only through [`call`].
pub fn terminal_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "terminal bridge unavailable",
        ))
    })
}

fn root(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("terminals")
}

fn terminal_id(id: &str) -> bool {
    id.len() == 36
        && id
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

/// Text the bridge's serde decoding cannot carry back from Core: an escaped surrogate, or JSON
/// nested too deeply for the quoted codec.
fn needs_core(bytes: &[u8]) -> bool {
    let escaped = bytes
        .windows(3)
        .any(|w| w[0] == b'\\' && w[1] == b'u' && matches!(w[2], b'd' | b'D'));
    escaped || matches!(quoted::parse_file(bytes), Err(e) if e == quoted::NESTING_FALLBACK)
}

fn record_needs_core(ctx: &Ctx, id: &str) -> bool {
    terminal_id(id)
        && fs::read(root(ctx).join(id).join("record.json")).is_ok_and(|bytes| needs_core(&bytes))
}

/// The reservation file as JavaScript's `JSON.parse` sees it; unreadable or invalid reads as `{}`.
fn reservations(ctx: &Ctx) -> Result<Map<String, Value>, ()> {
    let Ok(bytes) = fs::read(root(ctx).join("requests.json")) else {
        return Ok(Map::new());
    };
    if needs_core(&bytes) {
        return Err(());
    }
    match quoted::parse_file(&bytes) {
        Ok(Value::Object(map)) => Ok(map),
        Ok(_) => Err(()),
        Err(_) => Ok(Map::new()),
    }
}

fn well_formed(entry: &Value) -> bool {
    entry["payload"].is_string() && entry["id"].as_str().is_some()
}

/// Registry state TypeScript handles in ways this module does not reproduce: a reservation file
/// that is not an object of reservations (property reads of arrays and strings, the `TypeError` of
/// `null`), and records holding text the bridge cannot decode.
pub fn stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "terminal.list" => fs::read_dir(root(ctx)).is_ok_and(|entries| {
            entries
                .flatten()
                .any(|entry| record_needs_core(ctx, &entry.file_name().to_string_lossy()))
        }),
        "terminal.rename" | "terminal.close" => params["id"]
            .as_str()
            .is_some_and(|id| record_needs_core(ctx, id)),
        "terminal.create" => {
            let Ok(map) = reservations(ctx) else {
                return true;
            };
            params["request_id"]
                .as_str()
                .and_then(|id| map.get(id))
                .is_some_and(|entry| {
                    !well_formed(entry)
                        || entry["id"]
                            .as_str()
                            .is_some_and(|id| record_needs_core(ctx, id))
                })
        }
        _ => false,
    }
}

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn internal(error: impl std::fmt::Display) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// Zod's name for a parsed value's type.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn expected(kind: &str, value: Option<&Value>) -> String {
    format!(
        "Invalid input: expected {kind}, received {}",
        received(value)
    )
}

fn sized(value: Option<&Value>, max: usize) -> Option<String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Some(expected("string", value));
    };
    // This Zod counts code points; the handlers' own title limit counts UTF-16 units.
    let length = text.chars().count();
    if length < 1 {
        Some("Too small: expected string to have >=1 characters".into())
    } else if length > max {
        Some(format!(
            "Too big: expected string to have <={max} characters"
        ))
    } else {
        None
    }
}

fn uuid_issue(value: Option<&Value>) -> Option<String> {
    let Some(text) = value.and_then(Value::as_str) else {
        return Some(expected("string", value));
    };
    let bytes = text.as_bytes();
    let hex = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_hexdigit);
    let shaped = bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|at| bytes[*at] == b'-')
        && hex(0..8)
        && hex(9..13)
        && hex(14..18)
        && hex(19..23)
        && hex(24..36);
    let versioned = shaped
        && matches!(bytes[14], b'1'..=b'8')
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b' | b'A' | b'B');
    let nil = text == "00000000-0000-0000-0000-000000000000"
        || text == "ffffffff-ffff-ffff-ffff-ffffffffffff";
    (!versioned && !nil).then(|| "Invalid UUID".to_owned())
}

/// `z.number().int().positive()`: every failed check reports, except that a fraction ends the chain.
fn revision_issues(value: Option<&Value>) -> Vec<String> {
    let Some(number) = value.and_then(Value::as_f64) else {
        return vec![expected("number", value)];
    };
    if number.fract() != 0.0 {
        return vec!["Invalid input: expected int, received number".into()];
    }
    let mut issues = Vec::new();
    if number > MAX_SAFE {
        issues.push("Too big: expected int to be <=9007199254740991".to_owned());
    } else if number < -MAX_SAFE {
        issues.push("Too small: expected int to be >=-9007199254740991".to_owned());
    }
    if number <= 0.0 {
        issues.push("Too small: expected number to be >0".to_owned());
    }
    issues
}

/// Object keys in JavaScript enumeration order: integer indices ascending, then insertion order.
fn enumerated<'a>(keys: impl Iterator<Item = &'a String>) -> Vec<&'a String> {
    let index = |key: &str| {
        key.parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == key)
    };
    let (mut indices, names): (Vec<_>, Vec<_>) = keys.partition(|key| index(key).is_some());
    indices.sort_by_key(|key| index(key));
    indices.into_iter().chain(names).collect()
}

type Issue = (&'static str, String);

/// Zod's `safeParse` of a strict object: field issues in shape order, then unrecognized keys.
fn parse(
    params: &Value,
    shape: &[&str],
    fields: Vec<Issue>,
) -> Result<Map<String, Value>, CoreError> {
    let empty = Map::new();
    let input = match params {
        Value::Null => &empty,
        Value::Object(map) => map,
        other => {
            let issue = expected("object", Some(other));
            return Err(invalid(format!("params: {issue}")));
        }
    };
    let mut issues: Vec<String> = fields
        .into_iter()
        .map(|(path, message)| format!("{path}: {message}"))
        .collect();
    let extra: Vec<String> = enumerated(input.keys().filter(|k| !shape.contains(&k.as_str())))
        .iter()
        .map(|key| format!("\"{key}\""))
        .collect();
    if !extra.is_empty() {
        let noun = if extra.len() == 1 { "key" } else { "keys" };
        issues.push(format!("params: Unrecognized {noun}: {}", extra.join(", ")));
    }
    if issues.is_empty() {
        Ok(input.clone())
    } else {
        Err(invalid(issues.join("; ")))
    }
}

fn field<'a>(params: &'a Value, name: &str) -> Option<&'a Value> {
    params.as_object().and_then(|map| map.get(name))
}

fn create_issues(params: &Value) -> Vec<Issue> {
    let mut issues = Vec::new();
    let request = field(params, "request_id");
    match request.and_then(Value::as_str) {
        Some(id)
            if (1..=128).contains(&id.len())
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => {}
        Some(_) => issues.push((
            "request_id",
            "Invalid string: must match pattern /^[A-Za-z0-9_-]{1,128}$/".to_owned(),
        )),
        None => issues.push(("request_id", expected("string", request))),
    }
    if field(params, "kind").and_then(Value::as_str) != Some("shell") {
        issues.push(("kind", "Invalid input: expected \"shell\"".to_owned()));
    }
    if let Some(cwd) = field(params, "cwd")
        && let Some(issue) = sized(Some(cwd), 4096)
    {
        issues.push(("cwd", issue));
    }
    issues
}

fn revision_fields(params: &Value, title: bool) -> Vec<Issue> {
    let mut issues = Vec::new();
    if let Some(issue) = uuid_issue(field(params, "id")) {
        issues.push(("id", issue));
    }
    if title && let Some(issue) = sized(field(params, "title"), 80) {
        issues.push(("title", issue));
    }
    issues.extend(
        revision_issues(field(params, "expect_rev"))
            .into_iter()
            .map(|issue| ("expect_rev", issue)),
    );
    issues
}

fn require_human(ctx: &Ctx) -> Result<(), CoreError> {
    let cwd = std::env::current_dir().unwrap_or_default();
    if executor_session(ctx, &cwd, || providers(ctx)) {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Executor sessions cannot manage general terminals",
        ));
    }
    Ok(())
}

/// `readStored`: every failure, a closed record included, is the same refusal.
fn read_stored(ctx: &Ctx, id: &str) -> Result<Map<String, Value>, CoreError> {
    let missing = || invalid("Terminal not found");
    if !terminal_id(id) {
        return Err(missing());
    }
    let bytes = fs::read(root(ctx).join(id).join("record.json")).map_err(|_| missing())?;
    match quoted::parse_file(&bytes) {
        Ok(Value::Object(record))
            if record.get("id").and_then(Value::as_str) == Some(id)
                && record.get("state").and_then(Value::as_str) != Some("closed") =>
        {
            Ok(record)
        }
        _ => Err(missing()),
    }
}

fn write_stored(ctx: &Ctx, id: &str, record: &Map<String, Value>) -> Result<(), CoreError> {
    let text = quoted::stringify(&Value::Object(record.clone()));
    write_private(&root(ctx).join(id).join("record.json"), text.as_bytes()).map_err(internal)
}

fn matches_revision(record: &Map<String, Value>, expect: f64) -> bool {
    record.get("rev").and_then(Value::as_f64) == Some(expect)
}

fn advance(record: &mut Map<String, Value>, expect: f64) {
    record.insert("rev".into(), json!(expect + 1.0));
}

fn locked(error: pacer_foundation::lock::LockError) -> CoreError {
    internal(error)
}

async fn present(bridge: &mut dyn TerminalBridge, id: &str) -> Result<Value, CoreError> {
    bridge
        .parts(json!({"kind": "terminal.present", "id": id}))
        .await
}

async fn rename(
    ctx: &Ctx,
    id: &str,
    title: &str,
    expect: f64,
    bridge: &mut dyn TerminalBridge,
) -> Result<Value, CoreError> {
    with_lock_async(ctx, LOCK, LockOptions::default(), || async move {
        let mut stored = read_stored(ctx, id)?;
        let next = js_semantics::trim(title);
        if next.is_empty() || js_semantics::utf16_len(next) > 80 {
            return Err(invalid(TITLE_RANGE));
        }
        if !matches_revision(&stored, expect) {
            return Err(CoreError::new(Code::Conflict, CHANGED));
        }
        stored.insert("title".into(), quoted::from_utf8(json!(next)));
        advance(&mut stored, expect);
        write_stored(ctx, id, &stored)?;
        present(bridge, id).await
    })
    .await
    .map_err(locked)?
}

async fn close(
    ctx: &Ctx,
    id: &str,
    expect: f64,
    bridge: &mut dyn TerminalBridge,
) -> Result<Value, CoreError> {
    with_lock_async(ctx, LOCK, LockOptions::default(), || async move {
        let mut stored = read_stored(ctx, id)?;
        if !matches_revision(&stored, expect) {
            return Err(CoreError::new(Code::Conflict, CHANGED));
        }
        bridge
            .parts(json!({"kind": "terminal.stop", "id": id}))
            .await?;
        stored.insert("state".into(), json!("closed"));
        advance(&mut stored, expect);
        write_stored(ctx, id, &stored)?;
        Ok(json!({"closed": true}))
    })
    .await
    .map_err(locked)?
}

/// `canonicalDirectory`.
fn canonical_directory(path: &str) -> Result<String, CoreError> {
    if !path.starts_with('/') {
        return Err(invalid("Terminal folder must be absolute"));
    }
    fs::canonicalize(path)
        .ok()
        .filter(|resolved| resolved.is_dir())
        .map(|resolved| resolved.to_string_lossy().into_owned())
        .ok_or_else(|| invalid("Terminal folder is unavailable"))
}

/// `basename` of the shell path: its last segment, ignoring trailing slashes.
fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

fn new_id() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = |range: std::ops::Range<usize>| -> String {
        b[range].iter().map(|byte| format!("{byte:02x}")).collect()
    };
    format!(
        "{}-{}-{}-{}-{}",
        hex(0..4),
        hex(4..6),
        hex(6..8),
        hex(8..10),
        hex(10..16)
    )
}

fn ensure_root(ctx: &Ctx) -> Result<PathBuf, CoreError> {
    use std::os::unix::fs::PermissionsExt;
    let path = root(ctx);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&path)
        .map_err(internal)?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(internal)?;
    Ok(path)
}

/// Answers a repeated request from its reservation, or `None` when `request_id` is new.
async fn replay(
    ctx: &Ctx,
    request_id: &str,
    payload: &str,
    known: &Map<String, Value>,
    bridge: &mut dyn TerminalBridge,
) -> Result<Option<Value>, CoreError> {
    let reused = || {
        CoreError::new(
            Code::Conflict,
            "Terminal request ID was used with different details",
        )
    };
    let Some(prior) = known.get(request_id) else {
        return if INHERITED.contains(&request_id) {
            Err(reused())
        } else {
            Ok(None)
        };
    };
    if prior["payload"].as_str() != Some(payload) {
        return Err(reused());
    }
    let id = prior["id"].as_str().unwrap_or_default();
    let stored = read_stored(ctx, id)?;
    if stored.get("state").and_then(Value::as_str) == Some("failed") {
        let refused = CoreError::new(
            Code::Conflict,
            "Terminal launch failed; start a new request",
        );
        return Err(match stored.get("error").and_then(Value::as_str) {
            Some(error) => refused.hint(error),
            None => refused,
        });
    }
    present(bridge, id).await.map(Some)
}

async fn create(
    ctx: &Ctx,
    request_id: &str,
    cwd: Option<&str>,
    bridge: &mut dyn TerminalBridge,
) -> Result<Value, CoreError> {
    let shell = bridge.parts(json!({"kind": "terminal.shell"})).await?;
    let argv: Vec<String> = shell["argv"]
        .as_array()
        .map(|argv| {
            argv.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let Some(program) = argv.first() else {
        return Err(CoreError::new(
            Code::Unavailable,
            "invalid terminal bridge response",
        ));
    };
    let title = js_semantics::trim(basename(program)).to_owned();
    if title.is_empty() || js_semantics::utf16_len(&title) > 80 {
        return Err(invalid(TITLE_RANGE));
    }
    let home = ctx.home.to_string_lossy();
    let cwd = canonical_directory(cwd.unwrap_or(&home))?;
    if argv.iter().any(|arg| arg.contains('\0')) {
        return Err(invalid("Invalid terminal command"));
    }
    let details = stringify(&json!({"kind": "shell", "title": title, "cwd": cwd, "argv": argv}));
    let payload: String = Sha256::digest(details.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    with_lock_async(ctx, LOCK, LockOptions::default(), || async move {
        let base = ensure_root(ctx)?;
        // The door checked the shape before taking this lock; a file replaced since reads as empty.
        let mut known = reservations(ctx).unwrap_or_default();
        if let Some(reply) = replay(ctx, request_id, &payload, &known, bridge).await? {
            return Ok(reply);
        }
        let live = bridge.parts(json!({"kind": "terminal.live"})).await?;
        if live["live"].as_u64().unwrap_or(0) >= MAX_LIVE {
            return Err(CoreError::new(
                Code::NotAllowed,
                "Too many live terminals; close one before opening another",
            ));
        }
        let id = new_id();
        fs::DirBuilder::new()
            .mode(0o700)
            .create(base.join(&id))
            .map_err(internal)?;
        let record = quoted::from_utf8(json!({
            "id": id, "kind": "shell", "title": title, "cwd": cwd,
            "createdAt": ctx.now, "rev": 1, "state": "starting",
        }));
        let Value::Object(mut record) = record else {
            return Err(internal("terminal record is not an object"));
        };
        write_stored(ctx, &id, &record)?;
        known.insert(request_id.to_owned(), json!({"payload": payload, "id": id}));
        let text = quoted::stringify(&Value::Object(known));
        write_private(&base.join("requests.json"), text.as_bytes()).map_err(internal)?;
        let started = bridge
            .parts(json!({"kind": "terminal.start", "id": id}))
            .await;
        let failure = match &started {
            Ok(reply) => reply["error"].as_str().map(str::to_owned),
            Err(error) => Some(error.message.clone()),
        };
        if let Some(error) = failure {
            record.insert("state".into(), json!("failed"));
            record.insert("error".into(), quoted::from_utf8(json!(error)));
            write_stored(ctx, &id, &record)?;
            started?;
            return Err(CoreError::new(Code::NotAllowed, "Could not start terminal").hint(error));
        }
        record.insert("state".into(), json!("running"));
        write_stored(ctx, &id, &record)?;
        present(bridge, &id).await
    })
    .await
    .map_err(locked)?
}

/// Runs one `terminal.*` operation: the enforcement-identity refusal first (before the params, as
/// `authorizeWorkOperation` in `parseOpParams`), Zod's parameter issues next, then the executor refusal.
pub async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    bridge: &mut dyn TerminalBridge,
) -> Result<Value, CoreError> {
    if let Some(identity) = ctx.env.get("PACER_ASSISTANT_GRANT")
        && !identity.is_empty()
    {
        // Mirror authorizeAssistantGrant (dispatch/work.ts:129): a malformed, unknown, expired or
        // revoked `pag_` is refused here first, before the op-name rule ("runs assistant.tool only.")
        // or the schema (spec §2). The driver only supplies well-formed tokens, so an invalid
        // format can never reach the "assistant.tool only" message.
        let valid_grant = identity.len() == 68
            && identity.starts_with("pag_")
            && identity[4..].bytes().all(|b| b.is_ascii_hexdigit());
        if !valid_grant {
            return Err(CoreError::new(Code::NotAllowed, "Invalid assistant grant"));
        }
        return Err(CoreError::new(
            Code::NotAllowed,
            "An assistant grant runs assistant.tool only.",
        ));
    }
    if let Some(token) = ctx.env.get("PACER_ENFORCEMENT_TOKEN")
        && !token.is_empty()
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    let text = |input: &Map<String, Value>, name: &str| {
        input
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let revision = |input: &Map<String, Value>| {
        input
            .get("expect_rev")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    };
    match op {
        "terminal.list" => {
            parse(&params, &[], Vec::new())?;
            require_human(ctx)?;
            bridge.parts(json!({"kind": "terminal.list"})).await
        }
        "terminal.create" => {
            let input = parse(
                &params,
                &["request_id", "kind", "cwd"],
                create_issues(&params),
            )?;
            require_human(ctx)?;
            let cwd = input.get("cwd").and_then(Value::as_str);
            create(ctx, &text(&input, "request_id"), cwd, bridge).await
        }
        "terminal.rename" => {
            let shape = ["id", "title", "expect_rev"];
            let input = parse(&params, &shape, revision_fields(&params, true))?;
            require_human(ctx)?;
            let (id, title) = (text(&input, "id"), text(&input, "title"));
            rename(ctx, &id, &title, revision(&input), bridge).await
        }
        "terminal.close" => {
            let shape = ["id", "expect_rev"];
            let input = parse(&params, &shape, revision_fields(&params, false))?;
            require_human(ctx)?;
            close(ctx, &text(&input, "id"), revision(&input), bridge).await
        }
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    struct Recorder;
    impl TerminalBridge for Recorder {
        fn parts(&mut self, request: Value) -> OpFuture<'_> {
            Box::pin(async move { Ok(json!({"kind": request["kind"]})) })
        }
    }

    fn ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
        let env = env
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<HashMap<_, _>>();
        Ctx::with(
            dir.path().into(),
            dir.path().join(".pacer"),
            env,
            1_700_000_000.0,
        )
    }

    async fn run(
        dir: &tempfile::TempDir,
        env: &[(&str, &str)],
        op: &str,
        params: Value,
    ) -> Result<Value, CoreError> {
        call(&ctx(dir, env), op, params, &mut Recorder).await
    }

    #[tokio::test]
    async fn enforcement_and_assistant_identities_are_refused_before_the_params() {
        let dir = tempfile::tempdir().unwrap();
        let valid = json!({"request_id": "one", "kind": "shell", "cwd": "/"});
        // A well-formed grant token: `pag_` + 64 hex, so the refusal is the op-name rule, not the
        // format check. 68 chars, "pag_" + "a"*64.
        let well_formed = format!("pag_{}", "a".repeat(64));
        // Every param shape, valid or not, is refused with the identity error before the schema runs.
        for op in [
            "terminal.list",
            "terminal.create",
            "terminal.rename",
            "terminal.close",
        ] {
            for params in [json!({}), json!({ "x": 1 }), json!([]), valid.clone()] {
                let assistant = run(
                    &dir,
                    &[("PACER_ASSISTANT_GRANT", well_formed.as_str())],
                    op,
                    params.clone(),
                )
                .await
                .unwrap_err();
                assert_eq!(
                    (assistant.code, assistant.message.as_str()),
                    (
                        Code::NotAllowed,
                        "An assistant grant runs assistant.tool only."
                    )
                );
                let enforced = run(&dir, &[("PACER_ENFORCEMENT_TOKEN", "pet_x")], op, params)
                    .await
                    .unwrap_err();
                assert_eq!(
                    (enforced.code, enforced.message.as_str()),
                    (
                        Code::NotAllowed,
                        "Enforcement identity only reports a native child denial"
                    )
                );
            }
        }
        // A malformed `pag_` is refused by the format check before the op-name rule.
        let malformed = run(
            &dir,
            &[("PACER_ASSISTANT_GRANT", "pag_x")],
            "terminal.list",
            json!({}),
        )
        .await
        .unwrap_err();
        assert_eq!(
            (malformed.code, malformed.message.as_str()),
            (Code::NotAllowed, "Invalid assistant grant")
        );
        // An empty enforcement token is not an enforcement identity: the schema still runs first.
        let listed = run(
            &dir,
            &[("PACER_ENFORCEMENT_TOKEN", "")],
            "terminal.list",
            json!({ "x": 1 }),
        )
        .await
        .unwrap_err();
        assert_eq!(listed.code, Code::InvalidInput);
    }
}
