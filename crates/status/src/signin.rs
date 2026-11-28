//! Local native sign-in state for an account, ported from `src/usage/signin.ts`
//! and `src/install/login.ts` (B12-2).

use pacer_foundation::Ctx;
use pacer_foundation::fsutil::read_json;
use serde_json::{Map, Value, json};
use std::path::Path;

use crate::evidence::{applies_to, current_evidence, evidence_fact, read_evidence};
use crate::folders::orca_account_home;
use crate::freshness::AUTH_LIFETIME_S;
use crate::marks::auth_observation;

/// `AGENT` (signin.ts:28): the login indicator per account kind.
fn agent(kind: &str) -> Option<&'static str> {
    match kind {
        "claude" => Some("claude-code"),
        "codex" => Some("codex"),
        "cursor" => Some("cursor"),
        _ => None,
    }
}

/// A cheap login indicator for an agent (`loginIndicator`).
pub struct LoginIndicator {
    pub logged_in: bool,
    pub fix: String,
    pub file: std::path::PathBuf,
}

/// `loginIndicator` (login.ts:11-36). Cheap checks only: never a CLI or
/// credential inspection.
pub fn login_indicator(ctx: &Ctx, id: &str, folder: Option<&Path>) -> Option<LoginIndicator> {
    match id {
        "claude-code" => {
            let root = folder.or_else(|| ctx.env.get("CLAUDE_CONFIG_DIR").map(Path::new));
            let file = root
                .map(|r| r.join(".claude.json"))
                .unwrap_or_else(|| ctx.home.join(".claude.json"));
            let text = std::fs::read_to_string(&file).unwrap_or_else(|_| String::new());
            Some(LoginIndicator {
                logged_in: ctx.env.contains_key("ANTHROPIC_API_KEY")
                    || text.contains("\"oauthAccount\""),
                fix: "run claude and log in".to_string(),
                file,
            })
        }
        "codex" => {
            let base = folder
                .map(|f| f.to_path_buf())
                .or_else(|| ctx.env.get("CODEX_HOME").map(std::path::PathBuf::from))
                .unwrap_or_else(|| ctx.home.join(".codex"));
            let file = base.join("auth.json");
            Some(LoginIndicator {
                logged_in: ctx.env.contains_key("OPENAI_API_KEY")
                    || ctx.env.contains_key("CODEX_API_KEY")
                    || file.exists(),
                fix: "codex login".to_string(),
                file,
            })
        }
        "cursor" => {
            let file = folder
                .map(|f| f.join("cli-config.json"))
                .unwrap_or_else(|| ctx.home.join(".cursor").join("cli-config.json"));
            let config = read_json::<Value>(&file);
            let auth_info = config
                .as_ref()
                .and_then(Value::as_object)
                .and_then(|c| c.get("authInfo"))
                .and_then(Value::as_object)
                .is_some();
            Some(LoginIndicator {
                logged_in: ctx.env.contains_key("CURSOR_API_KEY") || auth_info,
                fix: "cursor-agent login".to_string(),
                file,
            })
        }
        "opencode" => {
            let file = ctx
                .env
                .get("XDG_DATA_HOME")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|| ctx.home.join(".local").join("share"))
                .join("opencode")
                .join("auth.json");
            Some(LoginIndicator {
                logged_in: file.exists(),
                fix: "opencode auth login".to_string(),
                file,
            })
        }
        _ => None,
    }
}

/// `localAccountFolder` (signin.ts:31-35). `Ok(None)` is the agent's default
/// folder; `Err(())` is TypeScript's `null` (an Orca account whose folder is
/// missing).
#[allow(clippy::result_unit_err)]
pub fn local_account_folder(ctx: &Ctx, account: &Value) -> Result<Option<std::path::PathBuf>, ()> {
    if let Some(home) = account.get("home").and_then(Value::as_str) {
        let replaced = if let Some(rest) = home.strip_prefix("~/") {
            ctx.home.join(rest)
        } else {
            Path::new(home).to_path_buf()
        };
        return Ok(Some(replaced));
    }
    let source = account.get("source").and_then(Value::as_str).unwrap_or("");
    let kind = account.get("kind").and_then(Value::as_str).unwrap_or("");
    if source == "orca" && (kind == "claude" || kind == "codex") {
        let orca = account
            .get("orcaAccount")
            .and_then(Value::as_str)
            .unwrap_or("");
        return match orca_account_home(ctx, kind, orca) {
            Some(path) => Ok(Some(path)),
            None => Err(()),
        };
    }
    Ok(None)
}

fn fix_text(fix: &str) -> String {
    if fix.starts_with("run ") {
        fix.to_string()
    } else {
        format!("run {fix}")
    }
}

/// `accountSignIn` (signin.ts:46-74): the single source of local native
/// sign-in, combining the login indicator with recorded auth failures.
pub fn account_sign_in(ctx: &Ctx, account: &Value, scope: &Value) -> Value {
    let Some(agent_id) = agent(account.get("kind").and_then(Value::as_str).unwrap_or("")) else {
        return json!({ "signedIn": Value::Null });
    };
    let folder = match local_account_folder(ctx, account) {
        Err(()) => return json!({ "signedIn": Value::Null }),
        Ok(folder) => folder,
    };
    let Some(login) = login_indicator(ctx, agent_id, folder.as_deref()) else {
        return json!({ "signedIn": Value::Null });
    };
    let fix = fix_text(&login.fix);
    if !login.logged_in {
        return json!({ "signedIn": false, "reason": format!("signed out \u{2014} {fix}"), "fix": fix });
    }
    let snapshot = read_evidence(ctx, scope);
    let observation = auth_observation(ctx, scope);
    let mut facts: Vec<Value> = snapshot["evidence"]["facts"]["availability"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if let Some((at, obs_scope)) = observation {
        facts.push(evidence_fact(
            &obs_scope,
            "execution",
            Some(at),
            Some(at + AUTH_LIFETIME_S),
            "authentication_failed",
            json!("unavailable"),
            None,
        ));
    }
    let now = ctx.now;
    let retired_at = snapshot.get("retiredAt").and_then(Value::as_f64);
    let failures: Vec<Value> = facts
        .iter()
        .filter(|f| {
            let obs = f
                .get("observedAt")
                .and_then(Value::as_f64)
                .unwrap_or(f64::MIN);
            let recovered = facts.iter().any(|recovery| {
                let rec_obs = recovery.get("observedAt").and_then(Value::as_f64);
                recovery.get("value").and_then(Value::as_str) == Some("ready")
                    && current_evidence(recovery, now, None)
                    && rec_obs.is_some_and(|t| t > obs)
                    && ["account", "identity", "runner", "model", "host"]
                        .iter()
                        .all(|key| {
                            recovery.get("scope").and_then(|s| s.get(key))
                                == f.get("scope").and_then(|s| s.get(key))
                        })
            });
            f.get("reason").and_then(Value::as_str) == Some("authentication_failed")
                && f.get("value").and_then(Value::as_str) == Some("unavailable")
                && applies_to(f, scope)
                && current_evidence(f, now, None)
                && obs > retired_at.unwrap_or(-1.0)
                && !recovered
        })
        .cloned()
        .collect();
    if !failures.is_empty() {
        let failed_at = failures
            .iter()
            .filter_map(|f| f.get("observedAt").and_then(Value::as_f64))
            .fold(f64::MIN, f64::max);
        let changed_at = mtime_secs(&login.file);
        if changed_at <= failed_at || changed_at > now {
            return json!({
                "signedIn": false,
                "reason": format!("signed out \u{2014} authentication failed; {fix}"),
                "fix": fix
            });
        }
        let scopes: Vec<Value> = failures
            .iter()
            .map(|f| f.get("scope").cloned().unwrap_or(Value::Null))
            .collect();
        let mut out = Map::new();
        out.insert("signedIn".to_owned(), json!(true));
        out.insert("recoveredAt".to_owned(), js_number(changed_at));
        out.insert("recoveredScopes".to_owned(), Value::Array(scopes));
        return Value::Object(out);
    }
    json!({ "signedIn": true })
}

/// The login file's mtime in unix seconds; 0 when it cannot be read.
fn mtime_secs(path: &Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map(|t| {
            t.duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs_f64())
                .unwrap_or(0.0)
        })
        .unwrap_or(0.0)
}

/// A JSON number in TypeScript's spelling (integral values stay integers).
fn js_number(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v >= i64::MIN as f64 && v <= i64::MAX as f64 {
        Value::Number(serde_json::Number::from(v as i64))
    } else {
        Value::from(v)
    }
}
