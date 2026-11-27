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
use std::{fs, io, path::Path};

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
    "none",
];
const MSG_KINDS: &[&str] = &["message", "question", "answer", "report", "nudge", "close"];
const MODES: &[&str] = &["relaxed", "normal", "strict", "emergency"];

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

fn one_of(value: &Value, options: &[&str]) -> Option<Value> {
    value
        .as_str()
        .filter(|s| options.contains(s))
        .map(|_| value.clone())
}

fn list_of(value: &Value, options: &[&str], min: usize) -> Option<Value> {
    let items = value.as_array()?;
    (items.len() >= min
        && items
            .iter()
            .all(|item| item.as_str().is_some_and(|s| options.contains(&s))))
    .then(|| value.clone())
}

fn text(value: &Value) -> Option<Value> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .map(|_| value.clone())
}

/// `ruleSchema` in `src/messaging/types.ts`.
pub fn rule(value: &Value) -> Option<Value> {
    let limits = |value: &Value| {
        shape(
            value,
            &[
                ("per_minute", false, &|v| int(v, 1.0, MAX_SAFE)),
                ("max_bytes", false, &|v| int(v, 1.0, f64::from(1 << 20))),
                ("confirm", false, &|v| v.is_boolean().then(|| v.clone())),
            ],
        )
    };
    shape(
        value,
        &[
            ("effect", true, &|v| one_of(v, &["allow", "deny"])),
            ("from_kind", false, &|v| one_of(v, KIND_MATCH)),
            ("to_kind", false, &|v| one_of(v, KIND_MATCH)),
            ("from_position", false, &|v| {
                one_of(v, &["top", "child", "any"])
            }),
            ("relation", false, &|v| {
                if *v == "any" {
                    Some(v.clone())
                } else {
                    list_of(v, RELATIONS, 1)
                }
            }),
            ("kinds", false, &|v| list_of(v, MSG_KINDS, 1)),
            ("repo", false, &text),
            ("executor", false, &text),
            ("grant", false, &|v| {
                one_of(v, &["required", "not_required"])
            }),
            ("limits", false, &limits),
        ],
    )
}

/// At most 50 valid rules, as both the operation and the stored entry require.
pub fn rules(value: &Value) -> Option<Value> {
    let items = value.as_array()?;
    if items.len() > 50 {
        return None;
    }
    items
        .iter()
        .map(rule)
        .collect::<Option<Vec<_>>>()
        .map(Value::Array)
}

/// The project liveness override, shared by the operation and stored entries.
pub fn liveness(value: &Value) -> Option<Value> {
    shape(
        value,
        &[
            ("interval_s", false, &|v| int(v, 10.0, MAX_SAFE)),
            ("backoff_max_s", false, &|v| int(v, 10.0, MAX_SAFE)),
            ("max_nudges", false, &|v| int(v, 0.0, MAX_SAFE)),
            ("nudge_in_modes", false, &|v| list_of(v, MODES, 0)),
        ],
    )
}

fn entry(value: &Value) -> Option<Value> {
    shape(
        value,
        &[
            ("rules", true, &rules),
            ("max_turns", false, &|v| int(v, 1.0, 10000.0)),
            ("liveness", false, &liveness),
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

/// Why a present file is not usable. TypeScript reports Node and Zod details
/// (`src/messaging/project-policy.ts:31-41`); both are reproduced here so the
/// native `msg.policy` reply stays byte-identical to the forwarded one.
#[derive(Debug)]
pub enum ReadError {
    Unreadable { path: std::path::PathBuf, error: io::Error },
    Invalid(String),
}
impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreadable { path, error } => {
                write!(f, "Cannot read project messaging: {}", node_io_error(error, path))
            }
            Self::Invalid(issues) => write!(f, "Invalid project messaging: {issues}"),
        }
    }
}

/// Node's `Error.message` for a failed `readFileSync`, including the `code:` prefix.
fn node_io_error(error: &io::Error, path: &Path) -> String {
    let (code, message) = match error.kind() {
        io::ErrorKind::NotFound => ("ENOENT", "no such file or directory".to_owned()),
        io::ErrorKind::PermissionDenied => ("EACCES", "permission denied".to_owned()),
        // `read` on a directory is EISDIR on macOS and Linux; the platform wording is the same.
        _ if error.raw_os_error() == Some(21) => (
            "EISDIR",
            "illegal operation on a directory, read".to_owned(),
        ),
        _ => (
            "EIO",
            error.to_string().trim_end_matches(" (os error 5)").to_owned(),
        ),
    };
    if matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::NotFound) {
        format!("{code}: {message}, open '{}'", path.display())
    } else {
        format!("{code}: {message}")
    }
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn unrecognized(out: &mut Vec<String>, path: &str, map: &Map<String, Value>, known: &[&str]) {
    let unknown: Vec<String> = map
        .keys()
        .filter(|key| !known.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => out.push(format!("{path}: Unrecognized key: {}", unknown[0])),
        _ => out.push(format!("{path}: Unrecognized keys: {}", unknown.join(", "))),
    }
}

/// The issues `schema.safeParse` reports for one rule, in `ruleSchema` field order.
fn rule_issues(out: &mut Vec<String>, path: &str, rule: &Value) {
    let Some(map) = rule.as_object() else {
        out.push(format!(
            "{path}: Invalid input: expected object, received {}",
            kind(rule)
        ));
        return;
    };
    if !matches!(map.get("effect").and_then(Value::as_str), Some("allow" | "deny")) {
        out.push(format!(
            "{path}.effect: Invalid option: expected one of \"allow\"|\"deny\""
        ));
    }
    for key in ["from_kind", "to_kind", "grant"] {
        if let Some(value) = map.get(key)
            && !value.is_string()
        {
            out.push(format!(
                "{path}.{key}: Invalid input: expected string, received {}",
                kind(value)
            ));
        }
    }
    for key in ["relation", "kinds"] {
        if let Some(value) = map.get(key)
            && value.as_array().is_none()
        {
            out.push(format!(
                "{path}.{key}: Invalid input: expected array, received {}",
                kind(value)
            ));
        }
    }
    if let Some(limits) = map.get("limits").and_then(Value::as_object) {
        if let Some(max) = limits.get("max_bytes").and_then(Value::as_f64)
            && max > (1 << 20) as f64
        {
            out.push(format!(
                "{path}.limits.max_bytes: Too big: expected number to be <=1048576"
            ));
        }
        unrecognized(out, &format!("{path}.limits"), limits, &["per_minute", "max_bytes", "confirm"]);
    }
    unrecognized(
        out,
        path,
        map,
        &[
            "effect", "from_kind", "to_kind", "from_position", "relation", "kinds", "repo",
            "executor", "grant", "limits",
        ],
    );
}

/// The issues `entrySchema.safeParse` reports for one repository entry.
fn entry_issues(out: &mut Vec<String>, path: &str, entry: &Value) {
    let Some(map) = entry.as_object() else {
        out.push(format!(
            "{path}: Invalid input: expected object, received {}",
            kind(entry)
        ));
        return;
    };
    match map.get("rules") {
        None => out.push(format!("{path}.rules: Invalid input: expected array, received undefined")),
        Some(Value::Array(rules)) => {
            if rules.len() > 50 {
                out.push(format!("{path}.rules: Too big: expected array to have <=50 items"));
            }
            for (index, rule) in rules.iter().enumerate() {
                rule_issues(out, &format!("{path}.rules.{index}"), rule);
            }
        }
        Some(other) => out.push(format!(
            "{path}.rules: Invalid input: expected array, received {}",
            kind(other)
        )),
    }
    if let Some(turns) = map.get("max_turns").and_then(Value::as_f64) {
        if turns.fract() != 0.0 {
            out.push(format!("{path}.max_turns: Invalid input: expected int, received number"));
        } else if turns < 1.0 {
            out.push(format!("{path}.max_turns: Too small: expected number to be >0"));
        } else if turns > 10000.0 {
            out.push(format!("{path}.max_turns: Too big: expected number to be <=10000"));
        }
    }
    if let Some(liveness) = map.get("liveness").and_then(Value::as_object) {
        for (key, min) in [
            ("interval_s", 10.0),
            ("backoff_max_s", 10.0),
            ("max_nudges", 0.0),
            ("escalate_after_s", 10.0),
        ] {
            if let Some(number) = liveness.get(key).and_then(Value::as_f64)
                && number < min
            {
                out.push(format!(
                    "{path}.liveness.{key}: Too small: expected number to be >={min}"
                ));
            }
        }
        unrecognized(
            out,
            &format!("{path}.liveness"),
            liveness,
            &["interval_s", "backoff_max_s", "max_nudges", "nudge_in_modes", "escalate_after_s"],
        );
    }
    match map.get("rev") {
        None => out.push(format!("{path}.rev: Invalid input: expected number, received undefined")),
        Some(value) if value.as_f64().is_none() => out.push(format!(
            "{path}.rev: Invalid input: expected number, received {}",
            kind(value)
        )),
        Some(value) => {
            let rev = value.as_f64().unwrap_or_default();
            if rev.fract() != 0.0 {
                out.push(format!("{path}.rev: Invalid input: expected int, received number"));
            } else if rev > MAX_SAFE {
                // Zod 4 issues both the int and safe-integer checks for this value.
                out.push(format!("{path}.rev: Too big: expected int to be <=9007199254740991"));
                out.push(format!("{path}.rev: Too big: expected int to be <=9007199254740991"));
            } else if rev < 1.0 {
                out.push(format!("{path}.rev: Too small: expected number to be >0"));
            }
        }
    }
    unrecognized(out, path, map, &["rules", "max_turns", "liveness", "rev", "max_bytes"]);
}

/// The Zod issues `schema.safeParse` reports for a file TypeScript cannot use,
/// in schema field order and joined the way `project-policy.ts` joins them.
/// A failed `JSON.parse` yields `undefined`, which is distinct from JSON `null`.
fn issues(value: &Value, parse_failed: bool) -> Vec<String> {
    let received = |value: &Value| {
        if parse_failed && value.is_null() {
            "undefined"
        } else {
            kind(value)
        }
    };
    let mut out = Vec::new();
    let Some(top) = value.as_object() else {
        return vec![format!(
            ": Invalid input: expected object, received {}",
            received(value)
        )];
    };
    if top.get("version").and_then(Value::as_f64) != Some(1.0) {
        out.push("version: Invalid input: expected 1".into());
    }
    match top.get("projects") {
        None => out.push("projects: Invalid input: expected record, received undefined".into()),
        Some(Value::Object(projects)) => {
            for (key, entry) in projects {
                let path = format!("projects.{key}");
                if !project_key(key) {
                    out.push(format!("{path}: Invalid key in record"));
                    continue;
                }
                entry_issues(&mut out, &path, entry);
            }
        }
        Some(other) => out.push(format!(
            "projects: Invalid input: expected record, received {}",
            kind(other)
        )),
    }
    unrecognized(&mut out, "", top, &["version", "projects"]);
    out
}

/// A missing file is an empty policy set.
pub fn read_projects(home: &Path) -> Result<Map<String, Value>, ReadError> {
    let path = home.join(FILE);
    match fs::read(&path) {
        Ok(bytes) => match parse(&bytes) {
            Some(projects) => Ok(projects),
            None => {
                let parsed = serde_json::from_slice::<Value>(&bytes);
                let parse_failed = parsed.is_err();
                let value = parsed.unwrap_or(Value::Null);
                Err(ReadError::Invalid(issues(&value, parse_failed).join("; ")))
            }
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Map::new()),
        Err(error) => Err(ReadError::Unreadable { path, error }),
    }
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
    fn unusable_file_error_text_matches_typescript_zod() {
        let cases: &[(&str, &str)] = &[
            ("null", ": Invalid input: expected object, received null"),
            ("{", ": Invalid input: expected object, received undefined"),
            ("3", ": Invalid input: expected object, received number"),
            (
                r#"{"version":1,"projects":{"github.com/a/b":{"rev":1,"rules":[{"effect":"allow","bogus":1}]}}}"#,
                "projects.github.com/a/b.rules.0: Unrecognized key: \"bogus\"",
            ),
            (
                r#"{"version":1,"projects":{"github.com/a/b":{"rev":1,"rules":[{"effect":"allow","limits":{"max_bytes":1048577}}]}}}"#,
                "projects.github.com/a/b.rules.0.limits.max_bytes: Too big: expected number to be <=1048576",
            ),
            (
                r#"{"version":1,"projects":{"github.com/a/b":{"rev":9007199254740992,"rules":[]}}}"#,
                "projects.github.com/a/b.rev: Too big: expected int to be <=9007199254740991; projects.github.com/a/b.rev: Too big: expected int to be <=9007199254740991",
            ),
            (
                r#"{"version":1,"projects":{"github.com/a/b":{"rev":1.5,"rules":[]}}}"#,
                "projects.github.com/a/b.rev: Invalid input: expected int, received number",
            ),
            (
                r#"{"version":1,"projects":{"github.com/a/b":{"rev":1,"rules":[],"liveness":{"interval_s":9}}}}"#,
                "projects.github.com/a/b.liveness.interval_s: Too small: expected number to be >=10",
            ),
            (
                r#"{"version":2,"projects":{"github.com/a/b":{"rules":5}}}"#,
                "version: Invalid input: expected 1; projects.github.com/a/b.rules: Invalid input: expected array, received number; projects.github.com/a/b.rev: Invalid input: expected number, received undefined",
            ),
        ];
        for (raw, expected) in cases {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join(FILE), raw).unwrap();
            assert_eq!(
                get(dir.path(), "github.com/a/b").unwrap()["error"],
                json!(format!("Invalid project messaging: {expected}")),
                "{raw}"
            );
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
        assert_eq!(
            read["error"],
            json!("Invalid project messaging: : Invalid input: expected object, received undefined")
        );
        let error = write(&ctx(dir.path()), "github.com/a/b", 0, None).unwrap_err();
        assert_eq!(error.code, Code::InvalidInput);
        assert_eq!(
            error.hint.as_deref(),
            Some("Repair project-messaging.json before changing it.")
        );
    }
}
