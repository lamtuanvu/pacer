//! `readPluginUsage` without the call (`src/plugins/usage-broker.ts:13-52`):
//! the provider choice, the fixed host-owned resource set and the sealed call
//! params. No credential configuration ever crosses this boundary.

use pacer_foundation::Ctx;
use pacer_plugin_ops::{extension::find, public::Entry};
use serde_json::{Value, json};
use std::path::PathBuf;

use crate::folders::{claude_cache_paths, default_account_folder, orca_account_home};

/// The proxy variables `codex-live` may pass to a provider command
/// (`src/plugins/capability-spawn.ts:48`). No keys or secrets are included.
const NETWORK_ENV: &[&str] = &[
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "ssl_cert_file", "ssl_cert_dir", "node_extra_ca_certs",
];

/// `readPluginUsage` without the call: an immediate reading when no plugin is
/// needed, or the plugin and the exact params/resources it must be called with.
pub enum UsageCall {
    Immediate(Value),
    Plugin {
        plugin: String,
        params: Value,
        resources: Value,
        account_home: Option<String>,
    },
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// JavaScript writes an integral `Date.now()/1000` without a decimal point;
/// serde_json otherwise spells an `f64` as `1798000000.0`.
fn number(value: f64) -> Value {
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

fn resolve(path: &str, ctx: &Ctx) -> String {
    let p = PathBuf::from(path);
    if p.is_absolute() {
        p.to_string_lossy().into_owned()
    } else {
        ctx.pacer_home.join(p).to_string_lossy().into_owned()
    }
}

fn tilde(path: &str, ctx: &Ctx) -> String {
    if let Some(rest) = path.strip_prefix('~') {
        if rest.is_empty() || rest.starts_with('/') {
            return format!("{}{}", ctx.home.to_string_lossy(), rest);
        }
    }
    path.to_string()
}

fn path_text(path: &PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// The ProviderCfg `readAccountUsage` derives (`src/usage/index.ts:85-94`).
pub fn provider_cfg(account: &Value, runners: &[Value]) -> Value {
    let kind = text(account, "kind");
    let id = if kind == "claude" {
        "claude-code".to_string()
    } else if kind == "endpoint" {
        text(account, "name").to_string()
    } else {
        kind.to_string()
    };
    let model = runners
        .first()
        .and_then(|r| r.get("model"))
        .filter(|m| !m.is_null())
        .cloned()
        .or_else(|| account.get("model").cloned())
        .unwrap_or(Value::Null);
    let arkcli = text(account, "quotaSource") == "arkcli" || text(account, "usageSource") == "arkcli";
    let mut cfg = json!({
        "id": id,
        "via": if kind == "endpoint" { Value::from("opencode") } else { Value::Null },
        "model": model,
        "usage": account.get("usage").cloned().unwrap_or(Value::Null),
        "allowPaid": account.get("allowPaid").cloned().unwrap_or(json!(false)),
        "cooldownS": account.get("cooldownS").cloned().unwrap_or(json!(0)),
        "quotaSource": if arkcli { Value::from("arkcli") } else { Value::Null },
        "weeklyTokens": account.get("weeklyTokens").cloned().unwrap_or(Value::Null),
        "weeklyUsd": account.get("weeklyUsd").cloned().unwrap_or(Value::Null),
    });
    // Orca is never a usage source; a legacy usage_source: orca reads natively or reactively.
    if text(account, "usageSource") == "orca" && kind != "claude" && kind != "codex" {
        cfg["usage"] = Value::from("reactive");
    }
    cfg
}

fn immediate(error: Option<String>, source: Option<&str>) -> UsageCall {
    let mut reading = json!({"windows": [], "capturedAt": null, "stale": false});
    if let Some(source) = source {
        reading["source"] = Value::from(source);
    }
    if let Some(error) = error {
        reading["error"] = Value::from(error);
    }
    UsageCall::Immediate(reading)
}

/// The host-derived call spec, ported one-to-one from `usageCallSpec`.
pub fn usage_call_spec(
    ctx: &Ctx,
    cfg: &Value,
    account: Option<&Value>,
    refresh: bool,
    read_only: bool,
    entries: &[Entry],
) -> UsageCall {
    let usage = text(cfg, "usage");
    if usage == "reactive" {
        return immediate(None, Some("reactive"));
    }
    if usage == "unmetered" {
        return immediate(None, Some("unmetered"));
    }
    let id = text(cfg, "id");
    let quota_source = text(cfg, "quotaSource");
    let provider = if usage == "metered" {
        "metered".to_string()
    } else if id == "claude-code" || id == "codex" {
        id.to_string()
    } else if quota_source == "arkcli" {
        "arkcli".to_string()
    } else {
        return immediate(Some(format!("no quota source for {id}")), None);
    };
    let plugin = find(entries, "usage", |contribution| {
        contribution["providers"].as_array().is_some_and(|providers| {
            providers.iter().any(|candidate| candidate == &Value::from(provider.as_str()))
        })
    });
    let Some(plugin) = plugin else {
        return immediate(Some(format!("no enabled plugin reads {provider} usage (pacer plugin list)")), None);
    };

    let mut resources = json!({"reads": [], "commands": [], "stores": []});
    let mut account_home: Option<String> = None;
    let mut input_resources = json!({});
    if usage == "quota" && id == "claude-code" {
        let files: Vec<Value> = claude_cache_paths(ctx, account)
            .iter()
            .map(|path| Value::from(path_text(path)))
            .collect();
        input_resources["claudeFiles"] = Value::Array(files.clone());
        if account.is_none_or(|a| text(a, "source") == "default") {
            account_home = Some(path_text(&default_account_folder(ctx, "claude")));
        }
        resources["reads"] = Value::Array(
            files
                .into_iter()
                .map(|path| json!({"path": path, "kind": "file"}))
                .collect(),
        );
    } else if usage == "quota" && id == "codex" {
        let home = if account.is_some_and(|a| text(a, "source") == "orca") {
            orca_account_home(ctx, "codex", text(account.unwrap(), "orcaAccount")).map(|p| path_text(&p))
        } else if let Some(h) = account.and_then(|a| a.get("home")).and_then(Value::as_str) {
            if h.is_empty() {
                None
            } else {
                Some(tilde(h, ctx))
            }
        } else {
            Some(path_text(&default_account_folder(ctx, "codex")))
        };
        let Some(home) = home else {
            return immediate(Some("Orca account folder not found".to_string()), None);
        };
        let home = resolve(&home, ctx);
        account_home = Some(home.clone());
        let root = format!("{home}/sessions");
        input_resources["codexSessions"] = Value::from(root.as_str());
        resources["reads"] = json!([{"path": root, "kind": "codex-logs"}]);
        resources["stores"] = json!([{
            "id": "codex-cursors",
            "path": path_text(&ctx.pacer_home.join("state/codex-cursors.json")),
            "kind": "cursors",
            "version": 4,
            "root": root,
        }]);
        if refresh {
            let env: serde_json::Map<String, Value> = ["HOME", "PATH", "TMPDIR", "LANG", "XDG_CONFIG_HOME"]
                .iter()
                .chain(NETWORK_ENV.iter())
                .filter_map(|key| ctx.env.get(*key).map(|v| (key.to_string(), Value::from(v.as_str()))))
                .chain(std::iter::once(("CODEX_HOME".to_string(), Value::from(home.as_str()))))
                .collect();
            resources["commands"] = json!([{
                "argv": ["codex", "-s", "read-only", "-a", "never", "app-server"],
                "timeoutMs": 10_000,
                "mode": "codex-live",
                "env": Value::Object(env),
            }]);
        }
    } else if usage == "quota" && quota_source == "arkcli" {
        resources["commands"] = json!([{
            "argv": ["arkcli", "usage", "plan", "--product", "coding-plan"],
            "timeoutMs": 8000,
        }]);
        resources["stores"] = json!([{
            "id": "arkcli-usage-plan",
            "path": path_text(&ctx.pacer_home.join("cache/arkcli-usage-plan.json")),
            "kind": "cache",
        }]);
    } else if usage == "metered" && cfg.get("model").is_some_and(|m| !m.is_null()) {
        resources["commands"] = json!([{
            "argv": ["opencode", "stats", "--standalone", "--models", "--cost", "--json", "--days", "7"],
            "timeoutMs": 15000,
        }]);
        resources["stores"] = json!([{
            "id": "opencode-stats-7d-cost",
            "path": path_text(&ctx.pacer_home.join("cache/opencode-stats-7d-cost.json")),
            "kind": "cache",
        }]);
    }
    let account_identity = account.map(|a| {
        json!({
            "name": a.get("name").cloned().unwrap_or(Value::Null),
            "kind": a.get("kind").cloned().unwrap_or(Value::Null),
            "source": a.get("source").cloned().unwrap_or(Value::Null),
        })
    });
    let params = json!({
        "provider": provider,
        "usage": cfg.get("usage").cloned().unwrap_or(Value::Null),
        "account": account_identity.unwrap_or(Value::Null),
        "accountHome": account_home.as_ref().map(|h| Value::from(h.as_str())).unwrap_or(Value::Null),
        "model": cfg.get("model").cloned().unwrap_or(Value::Null),
        "weeklyTokens": cfg.get("weeklyTokens").cloned().unwrap_or(Value::Null),
        "weeklyUsd": cfg.get("weeklyUsd").cloned().unwrap_or(Value::Null),
        "quotaSource": cfg.get("quotaSource").cloned().unwrap_or(Value::Null),
        "now": number(ctx.now),
        "readOnly": read_only,
        "refresh": refresh,
        "resources": input_resources,
    });
    UsageCall::Plugin { plugin, params, resources, account_home }
}
