//! Repository messaging policies in `project-messaging.json`
//! (`src/messaging/project-policy.ts`). Values are normalized to the Zod
//! schema key order, which is the order TypeScript writes and returns.
#![allow(clippy::result_large_err)]

use crate::host::canonical;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use serde_json::{Map, Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const FILE: &str = "project-messaging.json";
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const KIND_MATCH: &[&str] = &["human", "external", "launched", "broker", "any"];
const RELATIONS: &[&str] = &[
    "self",
    "parent",
    "child",
    "sibling",
    "descendant",
    "ancestor",
    "top_peer",
    "same_tree",
    "run_peer",
    "none",
];
const MSG_KINDS: &[&str] = &["message", "question", "answer", "report", "nudge", "close"];
const MODES: &[&str] = &["relaxed", "normal", "strict", "emergency"];
const RULE_FIELDS: &[&str] = &[
    "effect",
    "from_kind",
    "to_kind",
    "from_position",
    "relation",
    "kinds",
    "repo",
    "executor",
    "grant",
    "limits",
];
const LIVENESS_FIELDS: &[&str] = &[
    "interval_s",
    "backoff_max_s",
    "max_nudges",
    "nudge_in_modes",
    "caller_wake_in_modes",
];

/// `projectKey` in `src/config/project-strategies.ts`.
pub fn project_key(key: &str) -> bool {
    canonical(key)
        || key.strip_prefix("local:").is_some_and(|hex| {
            hex.len() == 12
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

type Check<'a> = &'a dyn Fn(&Value) -> Option<Value>;

/// A strict Zod object: unknown keys or a missing required field reject it.
fn shape(value: &Value, spec: &[(&str, bool, Check<'_>)]) -> Option<Value> {
    let map = value.as_object()?;
    if map
        .keys()
        .any(|key| !spec.iter().any(|(name, ..)| name == key))
    {
        return None;
    }
    let mut out = Map::new();
    for (name, required, check) in spec {
        match map.get(*name) {
            Some(value) => {
                out.insert((*name).into(), check(value)?);
            }
            None if *required => return None,
            None => {}
        }
    }
    Some(Value::Object(out))
}

/// A Zod `int()` within bounds; JavaScript writes it without a fraction.
fn int(value: &Value, min: f64, max: f64) -> Option<Value> {
    let n = value.as_f64()?;
    (n.fract() == 0.0 && n >= min && n <= max).then(|| json!(n as i64))
}

fn one_of(path: &str, value: &Value, options: &[&str], issues: &mut Vec<String>) -> Option<Value> {
    if value.as_str().is_some_and(|s| options.contains(&s)) {
        return Some(value.clone());
    }
    issues.push(issue(path, wrong_option(options)));
    None
}

/// Zod `Invalid option` message for an enum (`z.enum`) whose value did not match.
fn wrong_option(options: &[&str]) -> String {
    format!(
        "Invalid option: expected one of {}",
        options
            .iter()
            .map(|option| format!("\"{option}\""))
            .collect::<Vec<_>>()
            .join("|")
    )
}

/// `z.string().min(1)` at `path`.
fn nonempty(path: &str, value: &Value, issues: &mut Vec<String>) -> Option<Value> {
    let Some(s) = value.as_str() else {
        issues.push(expected(path, "string", Some(value)));
        return None;
    };
    if s.is_empty() {
        issues.push(issue(
            path,
            "Too small: expected string to have >=1 characters".into(),
        ));
        return None;
    }
    Some(value.clone())
}

/// `z.union([z.literal("any"), z.array(z.enum(RELATIONS)).min(1)])` at `path`.
/// The union reports a generic `Invalid input` for a non-matching value or an
/// invalid element, and `Too small` for an empty array.
fn relation(path: &str, value: &Value, issues: &mut Vec<String>) -> Option<Value> {
    if value == "any" {
        return Some(value.clone());
    }
    let Some(items) = value.as_array() else {
        issues.push(issue(path, "Invalid input".into()));
        return None;
    };
    if items.is_empty() {
        issues.push(issue(
            path,
            "Too small: expected array to have >=1 items".into(),
        ));
        return None;
    }
    if items
        .iter()
        .all(|item| item.as_str().is_some_and(|s| RELATIONS.contains(&s)))
    {
        Some(value.clone())
    } else {
        issues.push(issue(path, "Invalid input".into()));
        None
    }
}

/// `z.array(z.enum(MSG_KINDS)).min(1)` at `path`.
fn kinds_list(path: &str, value: &Value, issues: &mut Vec<String>) -> Option<Value> {
    let Some(items) = value.as_array() else {
        issues.push(expected(path, "array", Some(value)));
        return None;
    };
    if items.is_empty() {
        issues.push(issue(
            path,
            "Too small: expected array to have >=1 items".into(),
        ));
        return None;
    }
    let all_valid = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            if item.as_str().is_some_and(|s| MSG_KINDS.contains(&s)) {
                true
            } else {
                issues.push(issue(&format!("{path}.{i}"), wrong_option(MSG_KINDS)));
                false
            }
        })
        .all(|ok| ok);
    all_valid.then(|| value.clone())
}

/// `z.number().int()` with bounds at `path`, reporting the first Zod issue.
fn bounded_int(
    path: &str,
    value: &Value,
    lower: (f64, bool),
    upper: Option<(f64, bool)>,
    issues: &mut Vec<String>,
) -> Option<i64> {
    let Some(n) = value.as_f64() else {
        issues.push(expected(path, "number", Some(value)));
        return None;
    };
    if n.fract() != 0.0 || n.abs() > MAX_SAFE {
        issues.push(issue(
            path,
            "Invalid input: expected int, received number".into(),
        ));
        return None;
    }
    let (lo, strict) = lower;
    if (strict && n <= lo) || (!strict && n < lo) {
        let message = if strict {
            "Too small: expected number to be >0".to_owned()
        } else {
            format!("Too small: expected number to be >={}", lo as i64)
        };
        issues.push(issue(path, message));
        return None;
    }
    if let Some((hi, exclusive)) = upper
        && (n > hi || (exclusive && n >= hi))
    {
        issues.push(issue(
            path,
            format!("Too big: expected number to be <={hi}"),
        ));
        return None;
    }
    Some(n as i64)
}

/// `z.boolean()` at `path`.
fn boolean(path: &str, value: &Value, issues: &mut Vec<String>) -> Option<Value> {
    if value.is_boolean() {
        return Some(value.clone());
    }
    issues.push(expected(path, "boolean", Some(value)));
    None
}

/// Zod `strict()` reports unknown keys on the object's own path, after all known fields.
fn unrecognized(path: &str, map: &Map<String, Value>, known: &[&str], issues: &mut Vec<String>) {
    for key in map.keys().filter(|key| !known.contains(&key.as_str())) {
        issues.push(issue(path, format!("Unrecognized key: \"{key}\"")));
    }
}

/// `limits` inside a rule (`z.object({...}).strict().optional()`).
fn limits(path: &str, value: &Value, issues: &mut Vec<String>) -> Option<Value> {
    let Some(map) = value.as_object() else {
        issues.push(expected(path, "object", Some(value)));
        return None;
    };
    let mut local = Vec::new();
    let mut out = Map::new();
    if let Some(v) = map.get("per_minute")
        && let Some(n) = bounded_int(&format!("{path}.per_minute"), v, (0.0, true), None, &mut local)
    {
        out.insert("per_minute".into(), json!(n));
    }
    if let Some(v) = map.get("max_bytes")
        && let Some(n) = bounded_int(
            &format!("{path}.max_bytes"),
            v,
            (0.0, true),
            Some((f64::from(1 << 20), false)),
            &mut local,
        )
    {
        out.insert("max_bytes".into(), json!(n));
    }
    if let Some(v) = map.get("confirm")
        && let Some(b) = boolean(&format!("{path}.confirm"), v, &mut local)
    {
        out.insert("confirm".into(), b);
    }
    unrecognized(path, map, &["per_minute", "max_bytes", "confirm"], &mut local);
    let ok = local.is_empty();
    issues.extend(local);
    ok.then(|| Value::Object(out))
}

/// `ruleSchema` in `src/messaging/types.ts`; `path` is the rule's array slot
/// (`rules.0` for an operation, `projects.<key>.rules.0` for a stored file).
pub fn rule(value: &Value, path: &str, issues: &mut Vec<String>) -> Option<Value> {
    let Some(map) = value.as_object() else {
        issues.push(expected(path, "object", Some(value)));
        return None;
    };
    // Zod emits known-field issues in schema order, then strict-object unknown keys.
    let mut local = Vec::new();
    let mut out = Map::new();
    let effect = map.get("effect").and_then(Value::as_str);
    if matches!(effect, Some("allow" | "deny")) {
        out.insert("effect".into(), json!(effect));
    } else {
        local.push(issue(
            &format!("{path}.effect"),
            wrong_option(&["allow", "deny"]),
        ));
    }
    for (field, options) in [
        ("from_kind", KIND_MATCH),
        ("to_kind", KIND_MATCH),
        ("from_position", &["top", "child", "any"][..]),
    ] {
        if let Some(Value::String(_)) = map.get(field)
            && let Some(valid) =
                one_of(&format!("{path}.{field}"), &map[field], options, &mut local)
        {
            out.insert(field.into(), valid);
        }
    }
    if map.get("relation").is_some()
        && let Some(valid) = relation(&format!("{path}.relation"), &map["relation"], &mut local)
    {
        out.insert("relation".into(), valid);
    }
    if map.get("kinds").is_some()
        && let Some(valid) = kinds_list(&format!("{path}.kinds"), &map["kinds"], &mut local)
    {
        out.insert("kinds".into(), valid);
    }
    for field in ["repo", "executor"] {
        if let Some(Value::String(_)) = map.get(field)
            && let Some(valid) = nonempty(&format!("{path}.{field}"), &map[field], &mut local)
        {
            out.insert(field.into(), valid);
        }
    }
    if let Some(Value::String(_)) = map.get("grant")
        && let Some(valid) = one_of(
            &format!("{path}.grant"),
            &map["grant"],
            &["required", "not_required"],
            &mut local,
        )
    {
        out.insert("grant".into(), valid);
    }
    if map.get("limits").is_some()
        && let Some(valid) = limits(&format!("{path}.limits"), &map["limits"], &mut local)
    {
        out.insert("limits".into(), valid);
    }
    unrecognized(path, map, RULE_FIELDS, &mut local);
    let ok = local.is_empty();
    issues.extend(local);
    ok.then(|| Value::Object(out))
}

/// At most 50 rules, validating each with the `rules.<i>` path prefix. Returns
/// the normalized array, or `None` recording each invalid item's Zod issue.
pub fn rules(value: &Value, path: &str, issues: &mut Vec<String>) -> Option<Value> {
    let Some(items) = value.as_array() else {
        issues.push(expected(path, "array", Some(value)));
        return None;
    };
    if items.len() > 50 {
        issues.push(issue(
            path,
            "Too big: expected array to have <=50 items".into(),
        ));
        return None;
    }
    let mut out = Vec::new();
    let mut ok = true;
    for (i, item) in items.iter().enumerate() {
        match rule(item, &format!("{path}.{i}"), issues) {
            Some(valid) => out.push(valid),
            None => ok = false,
        }
    }
    ok.then(|| Value::Array(out))
}

/// The project liveness override (`src/messaging/project-policy.ts`), reporting
/// Zod issues at `path`.
pub fn liveness(value: &Value, path: &str, issues: &mut Vec<String>) -> Option<Value> {
    let Some(map) = value.as_object() else {
        issues.push(expected(path, "object", Some(value)));
        return None;
    };
    let mut local = Vec::new();
    let mut out = Map::new();
    for (field, lower) in [
        ("interval_s", (10.0, false)),
        ("backoff_max_s", (10.0, false)),
        ("max_nudges", (0.0, false)),
    ] {
        if let Some(Value::Number(_)) = map.get(field)
            && let Some(n) =
                bounded_int(&format!("{path}.{field}"), &map[field], lower, None, &mut local)
        {
            out.insert(field.into(), json!(n));
        }
    }
    for field in ["nudge_in_modes", "caller_wake_in_modes"] {
        if let Some(Value::Array(_)) = map.get(field)
            && let Some(valid) = modes(&format!("{path}.{field}"), &map[field], &mut local)
        {
            out.insert(field.into(), valid);
        }
    }
    unrecognized(path, map, LIVENESS_FIELDS, &mut local);
    let ok = local.is_empty();
    issues.extend(local);
    ok.then(|| Value::Object(out))
}

/// `z.array(z.enum(MODES))` at `path` (no minimum for liveness modes).
fn modes(path: &str, value: &Value, issues: &mut Vec<String>) -> Option<Value> {
    let Some(items) = value.as_array() else {
        issues.push(expected(path, "array", Some(value)));
        return None;
    };
    let all_valid = items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            if item.as_str().is_some_and(|s| MODES.contains(&s)) {
                true
            } else {
                issues.push(issue(&format!("{path}.{i}"), wrong_option(MODES)));
                false
            }
        })
        .all(|ok| ok);
    all_valid.then(|| value.clone())
}

fn entry(value: &Value) -> Option<Value> {
    let discard = |v: &Value| rules(v, "", &mut Vec::new());
    shape(
        value,
        &[
            ("rules", true, &discard),
            ("max_turns", false, &|v| int(v, 1.0, 10000.0)),
            ("liveness", false, &|v: &Value| {
                liveness(v, "", &mut Vec::new())
            }),
            ("rev", true, &|v| int(v, 1.0, MAX_SAFE)),
        ],
    )
}

fn parse(bytes: &[u8]) -> Option<Map<String, Value>> {
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let top = value.as_object()?;
    if top.len() != 2 || top.get("version")?.as_f64() != Some(1.0) {
        return None;
    }
    let mut projects = Map::new();
    for (key, value) in top.get("projects")?.as_object()? {
        if !project_key(key) {
            return None;
        }
        projects.insert(key.clone(), entry(value)?);
    }
    Some(projects)
}

/// Why a present file is not usable. TypeScript reports the Node error message and
/// Zod's joined issues verbatim in `readProjectMessaging`, so both are reproduced here.
#[derive(Debug)]
pub enum ReadError {
    Unreadable { path: PathBuf, error: io::Error },
    Invalid { issues: Vec<String> },
}
impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable { path, error } => {
                write!(
                    f,
                    "Cannot read project messaging: {}",
                    node_error(path, error)
                )
            }
            Self::Invalid { issues } => {
                write!(f, "Invalid project messaging: {}", issues.join("; "))
            }
        }
    }
}

/// Node's `Error.message` for a failed `readFileSync`, using `code: message` with the
/// path only where Node includes it (an `EISDIR` read has no path in the message).
fn node_error(path: &Path, error: &io::Error) -> String {
    let shown = path.display();
    match error.kind() {
        io::ErrorKind::NotFound => format!("ENOENT: no such file or directory, open '{shown}'"),
        io::ErrorKind::PermissionDenied => format!("EACCES: permission denied, open '{shown}'"),
        io::ErrorKind::IsADirectory => "EISDIR: illegal operation on a directory, read".into(),
        _ => error.to_string(),
    }
}

/// A missing file is an empty policy set.
pub fn read_projects(home: &Path) -> Result<Map<String, Value>, ReadError> {
    let path = home.join(FILE);
    match fs::read(&path) {
        Ok(bytes) => match parse(&bytes) {
            Some(projects) => Ok(projects),
            None => Err(ReadError::Invalid {
                issues: zod_issues(&bytes),
            }),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(ReadError::Unreadable { path, error }),
    }
}

fn js_kind(value: Option<&Value>) -> &'static str {
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

fn issue(path: &str, message: String) -> String {
    format!("{path}: {message}")
}

fn expected(path: &str, want: &str, got: Option<&Value>) -> String {
    issue(
        path,
        format!("Invalid input: expected {want}, received {}", js_kind(got)),
    )
}

/// Zod issue paths and messages for the `schema` above, in schema field order.
/// Only the strict outer document and the fields TypeScript validates are checked.
fn zod_issues(bytes: &[u8]) -> Vec<String> {
    let value: Value = match serde_json::from_slice(bytes) {
        Ok(value) => value,
        Err(_) => return vec![expected("", "object", None)],
    };
    let Some(top) = value.as_object() else {
        return vec![expected("", "object", Some(&value))];
    };
    let mut out = Vec::new();
    for key in top
        .keys()
        .filter(|k| k.as_str() != "version" && k.as_str() != "projects")
    {
        out.push(issue("", format!("Unrecognized key: \"{key}\"")));
    }
    match top.get("version") {
        Some(Value::Number(n)) if n.as_f64() == Some(1.0) => {}
        Some(_) => out.push(issue("version", "Invalid input: expected 1".into())),
        None => out.push(issue("version", "Invalid input: expected 1".into())),
    }
    let Some(projects) = top.get("projects").and_then(Value::as_object) else {
        out.push(expected("projects", "record", top.get("projects")));
        return out;
    };
    for (key, entry) in projects {
        if !project_key(key) {
            out.push(issue(
                &format!("projects.{key}"),
                "Invalid key in record".into(),
            ));
            continue;
        }
        let path = format!("projects.{key}");
        let Some(map) = entry.as_object() else {
            out.push(expected(&path, "object", Some(entry)));
            continue;
        };
        for extra in map
            .keys()
            .filter(|k| !["rev", "rules", "max_turns", "liveness"].contains(&k.as_str()))
        {
            out.push(issue(&path, format!("Unrecognized key: \"{extra}\"")));
        }
        match map.get("rules") {
            Some(Value::Array(items)) if items.len() <= 50 => {
                for (n, item) in items.iter().enumerate() {
                    rule(item, &format!("{path}.rules.{n}"), &mut out);
                }
            }
            Some(value) => out.push(expected(&format!("{path}.rules"), "array", Some(value))),
            None => out.push(expected(&format!("{path}.rules"), "array", None)),
        }
        if let Some(lin) = map.get("liveness") {
            liveness(lin, &format!("{path}.liveness"), &mut out);
        }
        match map.get("rev") {
            Some(value) if int(value, 1.0, MAX_SAFE).is_some() => {}
            Some(value) => out.push(expected(&format!("{path}.rev"), "number", Some(value))),
            None => out.push(expected(&format!("{path}.rev"), "number", None)),
        }
    }
    out
}

fn view(repo: &str, projects: &Map<String, Value>, error: Option<String>) -> Value {
    let entry = projects.get(repo);
    let mut out = json!({
        "repo": repo,
        "rev": entry.map_or(json!(0), |e| e["rev"].clone()),
        "rules": entry.map_or(json!([]), |e| e["rules"].clone()),
    });
    for key in ["max_turns", "liveness"] {
        if let Some(value) = entry.and_then(|e| e.get(key)) {
            out[key] = value.clone();
        }
    }
    if let Some(error) = error {
        out["error"] = json!(error);
    }
    out
}

/// `projectMessagingGet`: an unusable file reads as empty with an error.
pub fn get(home: &Path, repo: &str) -> Result<Value, CoreError> {
    if !project_key(repo) {
        return Err(CoreError::new(Code::InvalidInput, "Invalid repository key"));
    }
    Ok(match read_projects(home) {
        Ok(projects) => view(repo, &projects, None),
        Err(error) => view(repo, &Map::new(), Some(error.to_string())),
    })
}

/// `projectMessagingWrite`: `policy` is the normalized `{rules, max_turns?,
/// liveness?}` object, or `None` to clear the rules while keeping the revision.
pub fn write(
    ctx: &Ctx,
    repo: &str,
    expect_rev: i64,
    policy: Option<Map<String, Value>>,
) -> Result<Value, CoreError> {
    if !project_key(repo) || !(0..9_007_199_254_740_991).contains(&expect_rev) {
        return Err(CoreError::new(
            Code::InvalidInput,
            "Invalid project messaging revision or repository",
        ));
    }
    with_lock(ctx, "project-messaging", LockOptions::default(), || {
        let mut projects = read_projects(&ctx.pacer_home).map_err(|error| {
            CoreError::new(Code::InvalidInput, error.to_string())
                .hint("Repair project-messaging.json before changing it.")
        })?;
        let actual = projects
            .get(repo)
            .and_then(|e| e["rev"].as_i64())
            .unwrap_or(0);
        if actual != expect_rev {
            let mut data = Map::new();
            data.insert("expected".into(), json!(expect_rev));
            data.insert("actual".into(), json!(actual));
            return Err(CoreError::new(
                Code::Conflict,
                "Project messaging changed in another client",
            )
            .hint("Reload the policy and review your changes.")
            .data(data));
        }
        let mut entry = Map::new();
        entry.insert("rev".into(), json!(actual + 1));
        match policy {
            Some(policy) => entry.extend(policy),
            None => {
                entry.insert("rules".into(), json!([]));
            }
        }
        projects.insert(repo.into(), Value::Object(entry));
        let document = json!({"version": 1, "projects": projects});
        let mut bytes = serde_json::to_vec_pretty(&document)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        bytes.push(b'\n');
        write_private(&ctx.pacer_home.join(FILE), &bytes)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        get(&ctx.pacer_home, repo)
    })
    .map_err(|error| CoreError::new(Code::Unavailable, error.to_string()))?
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn ctx(home: &Path) -> Ctx {
        Ctx::with(home.into(), home.into(), Default::default(), 1.0)
    }

    #[test]
    fn project_keys_match_typescript() {
        for key in [
            "github.com/a/b",
            "git.example.org/a_b/c.d-e",
            "local:0123456789ab",
        ] {
            assert!(project_key(key), "{key}");
        }
        for key in [
            "github.com/a/b.git",
            "GitHub.com/a/b",
            "github.com/a",
            "github.com/a/b/c",
            "git_hub.com/a/b",
            "local:0123456789AB",
            "local:0123456789a",
            "/abs/path",
        ] {
            assert!(!project_key(key), "{key}");
        }
    }

    #[test]
    fn stored_entries_normalize_to_schema_order_and_integers() {
        let raw = br#"{"projects":{"github.com/a/b":{"rev":2.0,"liveness":{"max_nudges":-0,"interval_s":60},"max_turns":5,"rules":[{"limits":{"confirm":true,"per_minute":3},"relation":"any","effect":"deny"}]}},"version":1}"#;
        let projects = parse(raw).unwrap();
        assert_eq!(
            serde_json::to_string(&projects).unwrap(),
            r#"{"github.com/a/b":{"rules":[{"effect":"deny","relation":"any","limits":{"per_minute":3,"confirm":true}}],"max_turns":5,"liveness":{"interval_s":60,"max_nudges":0},"rev":2}}"#
        );
    }

    #[test]
    fn caller_wake_in_modes_is_accepted_on_project_liveness() {
        let mut issues = Vec::new();
        let value = liveness(
            &json!({"caller_wake_in_modes":["strict"],"nudge_in_modes":["normal"]}),
            "liveness",
            &mut issues,
        )
        .unwrap();
        assert!(issues.is_empty());
        assert_eq!(value["caller_wake_in_modes"], json!(["strict"]));
        assert_eq!(value["nudge_in_modes"], json!(["normal"]));
        let mut issues = Vec::new();
        assert!(
            liveness(
                &json!({"caller_wake_in_modes":["nope"]}),
                "liveness",
                &mut issues
            )
            .is_none()
        );
        assert_eq!(
            issues,
            vec!["liveness.caller_wake_in_modes.0: Invalid option: expected one of \"relaxed\"|\"normal\"|\"strict\"|\"emergency\""]
        );
    }

    #[test]
    fn nested_issues_match_zod_paths_messages_and_order() {
        let mut issues = Vec::new();
        assert!(rules(&json!([{"from":"x"}]), "rules", &mut issues).is_none());
        assert_eq!(
            issues,
            vec![
                "rules.0.effect: Invalid option: expected one of \"allow\"|\"deny\"",
                "rules.0: Unrecognized key: \"from\"",
            ]
        );
        let mut issues = Vec::new();
        assert!(liveness(&json!({"idle_s":-1}), "liveness", &mut issues).is_none());
        assert_eq!(issues, vec!["liveness: Unrecognized key: \"idle_s\""]);
        let mut issues = Vec::new();
        assert!(
            rules(
                &json!([{"effect":"allow","limits":{"unknown":1}}]),
                "rules",
                &mut issues
            )
            .is_none()
        );
        assert_eq!(
            issues,
            vec!["rules.0.limits: Unrecognized key: \"unknown\""]
        );
    }

    #[test]
    fn anything_zod_rejects_is_invalid() {
        for raw in [
            r#"{"version":1}"#,
            r#"{"version":2,"projects":{}}"#,
            r#"{"version":1,"projects":{},"x":1}"#,
            r#"{"version":1,"projects":{"bad":{"rev":1,"rules":[]}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":0,"rules":[]}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1,"rules":[],"x":1}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1,"rules":[],"max_turns":null}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1,"rules":[{"effect":"maybe"}]}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1,"rules":[{"effect":"allow","kinds":[]}]}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1,"rules":[{"effect":"allow","limits":{"max_bytes":1048577}}]}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1,"rules":[],"liveness":{"interval_s":9}}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":1.5,"rules":[]}}}"#,
            r#"{"version":1,"projects":{"a.b/c/d":{"rev":9007199254740992,"rules":[]}}}"#,
            "not json",
        ] {
            assert!(parse(raw.as_bytes()).is_none(), "{raw}");
        }
    }

    #[test]
    fn write_checks_revision_and_keeps_project_positions() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        let policy = |rules: Value| {
            let mut map = Map::new();
            map.insert("rules".into(), rules);
            Some(map)
        };
        write(&ctx, "github.com/a/b", 0, policy(json!([]))).unwrap();
        write(
            &ctx,
            "github.com/a/c",
            0,
            policy(json!([{"effect":"allow"}])),
        )
        .unwrap();
        let removed = write(&ctx, "github.com/a/b", 1, None).unwrap();
        assert_eq!(removed, json!({"repo":"github.com/a/b","rev":2,"rules":[]}));
        let error = write(&ctx, "github.com/a/b", 1, None).unwrap_err();
        assert_eq!(error.code, Code::Conflict);
        assert_eq!(error.data.unwrap()["actual"], json!(2));
        assert_eq!(
            fs::read_to_string(dir.path().join(FILE)).unwrap(),
            "{\n  \"version\": 1,\n  \"projects\": {\n    \"github.com/a/b\": {\n      \"rev\": 2,\n      \"rules\": []\n    },\n    \"github.com/a/c\": {\n      \"rules\": [\n        {\n          \"effect\": \"allow\"\n        }\n      ],\n      \"rev\": 1\n    }\n  }\n}\n"
        );
    }

    #[test]
    fn unusable_files_read_empty_with_an_error_and_block_writes() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), "{").unwrap();
        let read = get(dir.path(), "github.com/a/b").unwrap();
        assert_eq!(read["rev"], json!(0));
        let error = read["error"].as_str().unwrap();
        assert!(error.starts_with("Invalid project messaging: "), "{error}");
        assert!(
            error.ends_with(": Invalid input: expected object, received undefined"),
            "{error}"
        );
        let error = write(&ctx(dir.path()), "github.com/a/b", 0, None).unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(
            error.hint.as_deref(),
            Some("Repair project-messaging.json before changing it.")
        );
    }
}
