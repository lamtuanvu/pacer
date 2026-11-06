//! Native repository messaging policy ops (`src/api/ops-msg.ts`). Absolute
//! checkout paths need the Core repository probe; Node read errors, Zod issues
//! for an unusable policy file, and nested rule or liveness issues are only
//! reproduced by TypeScript. Those inputs stay forwarded.
#![allow(clippy::result_large_err)]
use pacer_config::project_messaging::{self, liveness, project_key, rule, rules};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};
use std::path::Path;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

pub fn project_messaging_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if !op.starts_with("project.messaging.") {
        return false;
    }
    let absolute = params
        .get("repo")
        .and_then(Value::as_str)
        .is_some_and(|repo| Path::new(repo).is_absolute());
    let nested = op == "project.messaging.set"
        && (params
            .get("rules")
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|item| rule(item).is_none()))
            || params
                .get("liveness")
                .is_some_and(|v| liveness(v).is_none()));
    absolute || nested || project_messaging::read_projects(&ctx.pacer_home).is_err()
}

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

/// Zod `number().int()` issues; returns the value when it is an integer.
fn integer(name: &str, value: Option<&Value>, issues: &mut Vec<String>) -> Option<f64> {
    let Some(n) = value.and_then(Value::as_f64) else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received {}",
            received(value)
        ));
        return None;
    };
    if n.fract() != 0.0 {
        issues.push(format!(
            "{name}: Invalid input: expected int, received number"
        ));
        return None;
    }
    if n > MAX_SAFE {
        issues.push(format!(
            "{name}: Too big: expected int to be <=9007199254740991"
        ));
    }
    if n < -MAX_SAFE {
        issues.push(format!(
            "{name}: Too small: expected int to be >=-9007199254740991"
        ));
    }
    Some(n)
}

/// The operation schemas, with Zod issue text and order.
fn parse(op: &str, params: Value) -> Result<Map<String, Value>, CoreError> {
    let params = if params.is_null() { json!({}) } else { params };
    let Some(map) = params.as_object() else {
        return Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                received(Some(&params))
            ),
        ));
    };
    let fields: &[&str] = match op {
        "project.messaging.get" => &["repo"],
        "project.messaging.remove" => &["repo", "expect_rev"],
        _ => &["repo", "expect_rev", "rules", "max_turns", "liveness"],
    };
    let mut issues = Vec::new();
    let mut out = Map::new();
    match map.get("repo") {
        Some(Value::String(repo)) => {
            let length = repo.chars().count();
            if length < 1 {
                issues.push("repo: Too small: expected string to have >=1 characters".into());
            }
            if length > 4096 {
                issues.push("repo: Too big: expected string to have <=4096 characters".into());
            }
            out.insert("repo".into(), json!(repo));
        }
        other => issues.push(format!(
            "repo: Invalid input: expected string, received {}",
            received(other)
        )),
    }
    if fields.contains(&"expect_rev")
        && let Some(n) = integer("expect_rev", map.get("expect_rev"), &mut issues)
    {
        if n < 0.0 {
            issues.push("expect_rev: Too small: expected number to be >=0".into());
        }
        if n > MAX_SAFE {
            issues.push("expect_rev: Too big: expected int to be <=9007199254740991".into());
        }
        if n < -MAX_SAFE {
            issues.push("expect_rev: Too small: expected int to be >=-9007199254740991".into());
        }
        out.insert("expect_rev".into(), json!(n as i64));
    }
    if fields.contains(&"rules") {
        match map.get("rules") {
            Some(value @ Value::Array(items)) => match rules(value) {
                Some(rules) => {
                    out.insert("rules".into(), rules);
                }
                None if items.iter().all(|item| rule(item).is_some()) => {
                    issues.push("rules: Too big: expected array to have <=50 items".into());
                }
                None => issues.push("rules: Invalid input".into()),
            },
            other => issues.push(format!(
                "rules: Invalid input: expected array, received {}",
                received(other)
            )),
        }
    }
    if fields.contains(&"max_turns")
        && let Some(value) = map.get("max_turns")
        && let Some(n) = integer("max_turns", Some(value), &mut issues)
    {
        if n <= 0.0 {
            issues.push("max_turns: Too small: expected number to be >0".into());
        }
        if n > 10000.0 {
            issues.push("max_turns: Too big: expected number to be <=10000".into());
        }
        out.insert("max_turns".into(), json!(n as i64));
    }
    if fields.contains(&"liveness")
        && let Some(value) = map.get("liveness")
    {
        match liveness(value) {
            Some(value) => {
                out.insert("liveness".into(), value);
            }
            None => issues.push("liveness: Invalid input".into()),
        }
    }
    let unknown: Vec<String> = map
        .keys()
        .filter(|key| !fields.contains(&key.as_str()))
        .map(|key| format!("\"{key}\""))
        .collect();
    match unknown.len() {
        0 => {}
        1 => issues.push(format!("params: Unrecognized key: {}", unknown[0])),
        _ => issues.push(format!("params: Unrecognized keys: {}", unknown.join(", "))),
    }
    if issues.is_empty() {
        Ok(out)
    } else {
        Err(CoreError::new(Code::InvalidInput, issues.join("; ")))
    }
}

fn repo_key(params: &Map<String, Value>) -> Result<&str, CoreError> {
    let repo = params["repo"].as_str().unwrap_or("");
    if project_key(repo) {
        Ok(repo)
    } else if Path::new(repo).is_absolute() {
        Err(CoreError::new(
            Code::Unavailable,
            "absolute repository paths require the forwarded project.messaging operation",
        ))
    } else {
        Err(CoreError::new(
            Code::InvalidInput,
            "repo must be an absolute path or a repository key",
        ))
    }
}

pub fn project_messaging_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = parse("project.messaging.get", params)?;
        project_messaging::get(&ctx.pacer_home, repo_key(&p)?)
    })
}

pub fn project_messaging_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let mut p = parse("project.messaging.set", params)?;
        let repo = repo_key(&p)?.to_owned();
        let expect_rev = p["expect_rev"].as_i64().unwrap_or(-1);
        let mut policy = Map::new();
        for key in ["rules", "max_turns", "liveness"] {
            if let Some(value) = p.remove(key) {
                policy.insert(key.into(), value);
            }
        }
        project_messaging::write(ctx, &repo, expect_rev, Some(policy))
    })
}

pub fn project_messaging_remove(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = parse("project.messaging.remove", params)?;
        let expect_rev = p["expect_rev"].as_i64().unwrap_or(-1);
        project_messaging::write(ctx, repo_key(&p)?, expect_rev, None)
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn message(op: &str, params: Value) -> String {
        parse(op, params).unwrap_err().message
    }

    #[test]
    fn param_issues_match_zod_text_and_order() {
        let get = "project.messaging.get";
        let remove = "project.messaging.remove";
        let set = "project.messaging.set";
        assert_eq!(
            message(get, json!({"x":1})),
            "repo: Invalid input: expected string, received undefined; params: Unrecognized key: \"x\""
        );
        assert_eq!(
            message(get, json!("x")),
            "params: Invalid input: expected object, received string"
        );
        assert_eq!(
            message(get, json!({"repo":"a/b/c","x":1,"y":2})),
            "params: Unrecognized keys: \"x\", \"y\""
        );
        assert_eq!(
            message(get, json!({"repo":"a".repeat(4097)})),
            "repo: Too big: expected string to have <=4096 characters"
        );
        assert!(parse(get, json!({"repo":"\u{1F600}".repeat(2049)})).is_ok());
        assert_eq!(
            message(
                remove,
                json!({"repo":"a/b/c","expect_rev":-9007199254740992.0})
            ),
            "expect_rev: Too small: expected int to be >=-9007199254740991; expect_rev: Too small: expected number to be >=0; expect_rev: Too small: expected int to be >=-9007199254740991"
        );
        assert_eq!(
            message(remove, json!({"repo":"a/b/c","expect_rev":1e300})),
            "expect_rev: Too big: expected int to be <=9007199254740991; expect_rev: Too big: expected int to be <=9007199254740991"
        );
        assert_eq!(
            message(remove, json!({"repo":"a/b/c","expect_rev":1.5})),
            "expect_rev: Invalid input: expected int, received number"
        );
        assert_eq!(
            message(set, json!({"b":1,"a":2})),
            "repo: Invalid input: expected string, received undefined; expect_rev: Invalid input: expected number, received undefined; rules: Invalid input: expected array, received undefined; params: Unrecognized keys: \"b\", \"a\""
        );
        assert_eq!(
            message(
                set,
                json!({"repo":"a/b/c","expect_rev":0,"rules":[],"max_turns":-1e18})
            ),
            "max_turns: Too small: expected int to be >=-9007199254740991; max_turns: Too small: expected number to be >0"
        );
        assert_eq!(
            message(
                set,
                json!({"repo":"a/b/c","expect_rev":0,"rules":vec![json!({"effect":"allow"}); 51]})
            ),
            "rules: Too big: expected array to have <=50 items"
        );
    }

    #[test]
    fn set_params_normalize_to_schema_order() {
        let p = parse(
            "project.messaging.set",
            json!({"liveness":{"nudge_in_modes":["strict"],"interval_s":10.0},"max_turns":5,"rules":[{"limits":{"confirm":true,"per_minute":2},"effect":"deny","relation":["self"]}],"expect_rev":0,"repo":"a/b/c"}),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"repo":"a/b/c","expect_rev":0,"rules":[{"effect":"deny","relation":["self"],"limits":{"per_minute":2,"confirm":true}}],"max_turns":5,"liveness":{"interval_s":10,"nudge_in_modes":["strict"]}}"#
        );
    }

    #[test]
    fn forwards_paths_nested_issues_and_unusable_files() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().into(),
            Default::default(),
            1.0,
        );
        let set = "project.messaging.set";
        let base = json!({"repo":"github.com/a/b","expect_rev":0,"rules":[]});
        assert!(!project_messaging_stays_forwarded(&ctx, set, &base));
        assert!(!project_messaging_stays_forwarded(
            &ctx,
            "config.set",
            &json!({"repo":"/x"})
        ));
        assert!(project_messaging_stays_forwarded(
            &ctx,
            "project.messaging.get",
            &json!({"repo":"/tmp/checkout"})
        ));
        let mut bad_rule = base.clone();
        bad_rule["rules"] = json!([{"effect":"maybe"}]);
        assert!(project_messaging_stays_forwarded(&ctx, set, &bad_rule));
        let mut bad_liveness = base.clone();
        bad_liveness["liveness"] = json!({"interval_s":1});
        assert!(project_messaging_stays_forwarded(&ctx, set, &bad_liveness));
        std::fs::write(dir.path().join("project-messaging.json"), "{}").unwrap();
        assert!(project_messaging_stays_forwarded(&ctx, set, &base));
    }

    #[tokio::test]
    async fn relative_repo_is_rejected_like_typescript() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().into(),
            Default::default(),
            1.0,
        );
        let error = project_messaging_get(&ctx, json!({"repo":"checkout"}))
            .await
            .unwrap_err();
        assert_eq!(
            error.message,
            "repo must be an absolute path or a repository key"
        );
        assert!(error.hint.is_none());
    }
}
