//! Account folder resolution and Claude cache paths, ported from
//! `src/orca/accounts.ts` (`orcaAccountHome`), `src/exec/account-folder.ts`
//! (`defaultAccountFolder`) and `src/usage/claude.ts` (claudeCachePaths) (B12-2).

use pacer_foundation::Ctx;
use pacer_foundation::fsutil::read_json;
use serde_json::Value;
use std::path::PathBuf;

/// The Orca-managed user data directory (`orcaUserDataDir`); the darwin
/// default is the Electron userData layout.
fn orca_user_data_dir(ctx: &Ctx) -> PathBuf {
    if let Some(dir) = ctx.env.get("PACER_ORCA_USER_DATA") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "macos")]
    {
        ctx.home
            .join("Library")
            .join("Application Support")
            .join("orca")
    }
    #[cfg(not(target_os = "macos"))]
    {
        ctx.env
            .get("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| ctx.home.join("AppData").join("Roaming"))
            .join("orca")
    }
}

/// `safeId` (orca/accounts.ts:27): account ids cannot escape the layout.
fn safe_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// `orcaAccountHome`: an existing Orca-managed home for an account, or `None`
/// when the account has no usable folder there.
pub fn orca_account_home(ctx: &Ctx, kind: &str, id: &str) -> Option<PathBuf> {
    if !safe_id(id) {
        return None;
    }
    let root = ctx
        .env
        .get("ORCA_USER_DATA_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| orca_user_data_dir(ctx));
    let sub = if kind == "claude" {
        "claude-profiles"
    } else {
        "codex-accounts"
    };
    let path = root.join(sub).join(id).join("home");
    if path.is_dir() { Some(path) } else { None }
}

/// `defaultAccountFolder` (account-folder.ts:38-40): the folder the login
/// profile set for `kind`, else the home default.
pub fn default_account_folder(ctx: &Ctx, kind: &str) -> PathBuf {
    let recorded: Option<Value> = read_json(
        &ctx.pacer_home
            .join("state")
            .join("default-account-folders.json"),
    );
    let value = recorded
        .as_ref()
        .and_then(|m| m.get(kind))
        .and_then(Value::as_str)
        .filter(|v| v.starts_with('/'));
    value.map(PathBuf::from).unwrap_or_else(|| {
        ctx.home
            .join(if kind == "codex" { ".codex" } else { ".claude" })
    })
}

/// `claudeCacheFile` (claude.ts:74-77).
pub fn claude_cache_file(ctx: &Ctx, account: Option<&Value>) -> PathBuf {
    let named = account.is_some_and(|a| &a["source"] != "default");
    let name = if named {
        format!(
            "claude-rate-limits.{}.json",
            encode_uri_component(
                account
                    .and_then(|a| a.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
            )
        )
    } else {
        "claude-rate-limits.json".to_string()
    };
    ctx.pacer_home.join("cache").join(name)
}

/// `claudeCachePaths` (claude.ts:79-85).
pub fn claude_cache_paths(ctx: &Ctx, account: Option<&Value>) -> Vec<PathBuf> {
    let def = default_account_folder(ctx, "claude");
    if account.is_some_and(|a| &a["source"] != "default") {
        vec![claude_cache_file(ctx, account)]
    } else {
        vec![
            claude_cache_file(ctx, account),
            def.join("state").join("budget").join("claude.json"),
        ]
    }
}

/// Percent-encoding matching JavaScript `encodeURIComponent` for the cache
/// file name (ASCII passthrough, everything else %XX-encoded).
fn encode_uri_component(text: &str) -> String {
    let mut out = String::new();
    for b in text.bytes() {
        let unescaped = matches!(b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9'
            | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')');
        if unescaped {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
