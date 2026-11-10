//! `account.list` and `account.signin` from `list` and `signin` in
//! `src/core/accounts.ts`.
//!
//! Rust composes every `account.list` row: the account fields, runners, the
//! lock, the folder, `runnable`, `usageCheck`, the sign-in command and the email
//! redaction. The Core bridge supplies only the reads that need the TypeScript
//! plugin host, the Orca CLI or login probes: the Orca label, the sign-in state,
//! the usage reading and the endpoint row, with the strategy text they were read
//! against. `account.signin` refuses natively; opening the login terminal
//! forwards.
use crate::{
    authorize, forwarded,
    js::{keys, prototype_key},
    model::{account_folder, path_text, ts_account},
    params, strategy_loads,
};
use pacer_config::strategy::{load_strategy, parse_strategy};
use pacer_engine::usage_refresh::refresh_capability;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};
use std::path::Path;

const TARGETS: &[&str] = &["auto", "orca", "terminal", "tmux"];

/// `account.list` composes its rows over the account-list Core bridge.
pub fn needs_account_list_bridge(op: &str) -> bool {
    op == "account.list"
}

/// The Core refuses the bridge to work-grant callers, and TypeScript reports
/// Zod issues and strategy parser errors in its own words.
pub(crate) fn list_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    params::object(params).is_none()
        || ctx
            .env
            .get("PACER_WORK_GRANT")
            .is_some_and(|grant| !grant.is_empty())
        || !strategy_loads(ctx)
}

/// Reached only when the caller has no account-list bridge.
pub fn account_list_stub(ctx: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        Err(CoreError::new(
            Code::Unavailable,
            "account list bridge unavailable",
        ))
    })
}

/// `accounts.list` over the bridge parts
/// `{strategy: {path, name, text}, accounts: [{name, label?, signedIn, usageReading, endpoint}]}`.
///
/// TypeScript reads every part against one strategy load. Rust parses that
/// same strategy text rather than its own read of the file, so a concurrent
/// edit cannot pair one snapshot's account with another snapshot's parts.
pub async fn account_list(
    ctx: &Ctx,
    params: Value,
    parts: OpFuture<'_>,
) -> Result<Value, CoreError> {
    authorize(ctx)?;
    params::object(&params).ok_or_else(forwarded)?;
    let parts = parts.await?;
    let snapshot = &parts["strategy"];
    let (Some(path), Some(name), Some(text)) = (
        snapshot["path"].as_str(),
        snapshot["name"].as_str(),
        snapshot["text"].as_str(),
    ) else {
        return Err(invalid_parts());
    };
    let s = parse_strategy(text, Path::new(path), name).map_err(|_| forwarded())?;
    let parts = parts["accounts"].as_array().ok_or_else(invalid_parts)?;
    let accounts = s["accounts"].as_object().cloned().unwrap_or_default();
    if parts.len() != accounts.len() {
        return Err(invalid_parts());
    }
    let rows = keys(&accounts)
        .into_iter()
        .map(|name| {
            let part = parts
                .iter()
                .find(|p| p["name"] == name.as_str())
                .ok_or_else(invalid_parts)?;
            Ok(row(ctx, &s, &accounts[name], part))
        })
        .collect::<Result<Vec<_>, CoreError>>()?;
    Ok(Value::Array(rows))
}

fn invalid_parts() -> CoreError {
    CoreError::new(Code::Unavailable, "invalid account list bridge response")
}

fn row(ctx: &Ctx, s: &Value, account: &Value, part: &Value) -> Value {
    let name = account["name"].as_str().unwrap_or("");
    let kind = account["kind"].as_str().unwrap_or("");
    let mut runners: Vec<String> = s["runners"]
        .as_object()
        .into_iter()
        .flat_map(|runners| runners.values())
        .filter(|r| r["account"] == name)
        .filter_map(|r| r["id"].as_str().map(str::to_owned))
        .collect();
    runners.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let folder = account_folder(ctx, account);
    let mut row = ts_account(account);
    row.insert(
        "label".into(),
        json!(part["label"].as_str().unwrap_or(name)),
    );
    row.insert(
        "folder".into(),
        folder
            .as_deref()
            .map_or(Value::Null, |f| json!(path_text(f))),
    );
    row.insert("runners".into(), json!(runners));
    row.insert("executors".into(), json!(runners));
    if s["planner"]["account"] == name {
        row.insert("locked".into(), json!("Planner — can't remove"));
    } else if !runners.is_empty() {
        row.insert(
            "locked".into(),
            json!(format!("In use by {} executor(s)", runners.len())),
        );
    }
    let signed_in = match &part["signedIn"] {
        Value::Bool(b) => Value::Bool(*b),
        _ => Value::Null,
    };
    row.insert("signedIn".into(), signed_in.clone());
    row.insert("usageCheck".into(), usage_check(account));
    row.insert(
        "runnable".into(),
        json!(account["source"] != "orca" || folder.is_some()),
    );
    row.insert("usageReading".into(), part["usageReading"].clone());
    for (key, value) in part["endpoint"].as_object().into_iter().flatten() {
        row.insert(key.clone(), value.clone());
    }
    if matches!(kind, "claude" | "codex") && signed_in == false {
        let codex = kind == "codex";
        let folder =
            folder.unwrap_or_else(|| ctx.home.join(if codex { ".codex" } else { ".claude" }));
        let command = format!(
            "{}={} {}",
            if codex {
                "CODEX_HOME"
            } else {
                "CLAUDE_CONFIG_DIR"
            },
            shq(&path_text(&folder)),
            if codex {
                "codex login"
            } else {
                "claude\n# Then run /login to sign in."
            },
        );
        row.insert("signin_command".into(), json!(command));
    }
    // Runner ids are validated identifiers; their @host suffix is not an email.
    let Value::Object(mut row) = public_value(Value::Object(row)) else {
        unreachable!("public_value keeps objects");
    };
    row.insert("runners".into(), json!(runners));
    row.insert("executors".into(), json!(runners));
    Value::Object(row)
}

/// `accountUsageCapability`.
fn usage_check(account: &Value) -> Value {
    let (action, consent, description) = if account["usage"] == "unmetered" {
        (
            "unmetered",
            false,
            "Unmetered. This account has no quota to check.",
        )
    } else if account["kind"] == "claude" && account["usage"] == "quota" {
        (
            "probe",
            true,
            "Runs a small Claude Code task using this account’s quota to collect new usage telemetry.",
        )
    } else if refresh_capability(account) != "unavailable" {
        (
            "refresh",
            false,
            "Reads the provider’s available usage source. Old observations remain historical.",
        )
    } else {
        (
            "unsupported",
            false,
            "Only limit hits are observable for this account. A current quota balance is unavailable.",
        )
    };
    json!({"action": action, "consentRequired": consent, "description": description})
}

/// `publicValue`: Orca ids, labels and resolved folder paths may contain an account email.
fn public_value(value: Value) -> Value {
    match value {
        Value::String(s) if s.contains('@') => json!("[redacted]"),
        Value::Array(items) => Value::Array(items.into_iter().map(public_value).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (k, public_value(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

/// `shq`.
fn shq(s: &str) -> String {
    let plain = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_/.:=@%+-".contains(&b));
    if plain {
        s.to_owned()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// A canonical RFC 9562 UUID that `z.uuid()` accepts.
fn uuid(v: &Value) -> bool {
    let Some(s) = v.as_str() else { return false };
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
        && (b'1'..=b'8').contains(&b[14])
        && b"89abAB".contains(&b[19])
}

/// The `{name, target?, request_id?}` branch; interactive flows forward.
fn signin_params(params: &Value) -> Option<String> {
    let p = params::object(params)?;
    if p.contains_key("interactive") {
        return None;
    }
    let name = params::id(p.get("name")?)?;
    let target = p
        .get("target")
        .is_none_or(|t| t.as_str().is_some_and(|t| TARGETS.contains(&t)));
    (target && p.get("request_id").is_none_or(uuid)).then(|| name.to_owned())
}

/// `accounts.signin` before it opens the login terminal.
pub(crate) fn signin_refusal(ctx: &Ctx, params: &Value) -> Option<CoreError> {
    let name = signin_params(params)?;
    if prototype_key(&name) || !strategy_loads(ctx) {
        return None;
    }
    let s = load_strategy(&ctx.pacer_home).ok()?;
    let Some(account) = s["accounts"].get(&name) else {
        return Some(CoreError::new(
            Code::InvalidInput,
            format!("unknown account: {name}"),
        ));
    };
    if !matches!(account["kind"].as_str(), Some("claude" | "codex")) {
        return Some(CoreError::new(
            Code::NotAllowed,
            format!("account {name} has no supported login"),
        ));
    }
    (account["source"] == "orca" && account_folder(ctx, account).is_none())
        .then(|| CoreError::new(Code::NotAllowed, "Orca account folder not found"))
}

/// Reached only for the native refusals; opening the login forwards.
pub fn account_signin_stub(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        Err(signin_refusal(ctx, &params).unwrap_or_else(forwarded))
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const ON_DISK: &str = "planner: claude-code\naccounts:\n  work: {kind: codex, home: ~/.codex-work}\nrunners:\n  claude-code: {}\n  codex#work: {}\n";
    // `work` was removed and recreated as a Claude account after the forward check read ON_DISK.
    const SNAPSHOT: &str = "planner: claude-code\naccounts:\n  work: {kind: claude}\n  extra: {kind: codex}\nrunners:\n  claude-code: {}\n";

    fn ctx(root: &Path) -> Ctx {
        let ctx = Ctx {
            home: root.join("home"),
            pacer_home: root.join("pacer"),
            env: HashMap::new(),
            now: 1_000.0,
        };
        std::fs::create_dir_all(&ctx.pacer_home).unwrap();
        std::fs::write(ctx.pacer_home.join("strategy.yaml"), ON_DISK).unwrap();
        ctx
    }

    fn parts(ctx: &Ctx, names: &[&str]) -> Value {
        let path = ctx.pacer_home.join("strategy.yaml");
        let accounts: Vec<Value> = names
            .iter()
            .map(|name| json!({"name": name, "label": format!("snapshot {name}"), "signedIn": true, "usageReading": {"source": "snapshot"}, "endpoint": {}}))
            .collect();
        json!({"strategy": {"path": path_text(&path), "name": "default", "text": SNAPSHOT}, "accounts": accounts})
    }

    fn snapshot_names(ctx: &Ctx) -> Vec<String> {
        let s = parse_strategy(SNAPSHOT, &ctx.pacer_home.join("strategy.yaml"), "default").unwrap();
        keys(s["accounts"].as_object().unwrap())
            .into_iter()
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn rows_come_from_the_bridge_snapshot_not_a_concurrent_file_read() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        let names = snapshot_names(&ctx);
        let names: Vec<&str> = names.iter().map(String::as_str).collect();
        assert!(names.contains(&"work") && names.contains(&"extra"));
        let reply = parts(&ctx, &names);
        let rows = account_list(&ctx, json!({}), Box::pin(async move { Ok(reply) }))
            .await
            .unwrap();
        let rows = rows.as_array().unwrap();
        assert_eq!(
            rows.iter()
                .map(|r| r["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            names
        );
        let work = rows.iter().find(|r| r["name"] == "work").unwrap();
        assert_eq!(work["kind"], "claude");
        assert_eq!(work["home"], Value::Null);
        assert_eq!(work["folder"], Value::Null);
        // The snapshot binds `claude-code` to the recreated account; the file still has `codex#work`.
        assert_eq!(work["runners"], json!(["claude-code"]));
        assert_eq!(work["locked"], "Planner — can't remove");
        assert_eq!(work["label"], "snapshot work");
        assert_eq!(work["usageReading"], json!({"source": "snapshot"}));
    }

    #[tokio::test]
    async fn parts_that_do_not_cover_the_snapshot_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(dir.path());
        // Parts read against the on-disk accounts cannot describe the snapshot's accounts.
        let reply = parts(&ctx, &["work"]);
        let error = account_list(&ctx, json!({}), Box::pin(async move { Ok(reply) }))
            .await
            .unwrap_err();
        assert_eq!(error.code, Code::Unavailable);
        assert_eq!(error.message, "invalid account list bridge response");
        let mut reply = parts(&ctx, &["work", "extra", "claude"]);
        reply["strategy"] = json!({"path": "x"});
        let error = account_list(&ctx, json!({}), Box::pin(async move { Ok(reply) }))
            .await
            .unwrap_err();
        assert_eq!(error.message, "invalid account list bridge response");
    }

    #[test]
    fn shq_quotes_like_typescript() {
        assert_eq!(shq("/home/me/.codex"), "/home/me/.codex");
        assert_eq!(shq("/home/me/team's home"), "'/home/me/team'\\''s home'");
        assert_eq!(shq(""), "''");
    }

    #[test]
    fn signin_params_accept_only_the_name_branch() {
        assert_eq!(signin_params(&json!({"name": "a"})).as_deref(), Some("a"));
        assert!(signin_params(&json!({"name": "a", "target": "tmux"})).is_some());
        assert!(signin_params(&json!({"name": "a", "target": "bad"})).is_none());
        assert!(signin_params(&json!({"name": "a", "interactive": "init"})).is_none());
        assert!(signin_params(&json!({"name": ""})).is_none());
        let id = "123e4567-e89b-42d3-a456-426614174000";
        assert!(signin_params(&json!({"name": "a", "request_id": id})).is_some());
        assert!(signin_params(&json!({"name": "a", "request_id": "nope"})).is_none());
    }

    #[test]
    fn public_value_redacts_emails_only() {
        assert_eq!(
            public_value(json!({"a": "me@x.test", "b": ["ok", "x@y"], "c": 1})),
            json!({"a": "[redacted]", "b": ["ok", "[redacted]"], "c": 1})
        );
    }
}
