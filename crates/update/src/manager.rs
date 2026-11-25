//! Who owns updates of this installation, ported from `src/update/update.ts`
//! (`installManager`) and `src/install/owner.ts` (`ownerRefusal`, ADR 0021).
use pacer_foundation::Ctx;
use serde_json::Value;
use std::{collections::HashMap, path::Path};

/// An installer that owns this pacer, so `pacer update` must not replace it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedBy {
    Desktop,
    Homebrew,
    Npm,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateManager {
    pub by: ManagedBy,
    pub message: String,
}

/// `src/install/owner.ts:85-89`, verbatim.
pub const MANAGED_BY_DESKTOP_MESSAGE: &str = "pacer is managed by the pacer app; update or change the service from the app (Settings), or run with --release-ownership to hand it back to this CLI";

const HOMEBREW_MESSAGE: &str = "pacer was installed with Homebrew; update with: brew upgrade pacer";

fn canonical(path: &Path) -> std::path::PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `installManager`: npm first, then Homebrew, then the desktop app bundle.
pub fn install_manager(
    env: &HashMap<String, String>,
    exec_path: &Path,
    nightly: bool,
) -> Option<UpdateManager> {
    if env.get("PACER_INSTALL_METHOD").is_some_and(|v| v == "npm") {
        let channel = if nightly { "nightly" } else { "latest" };
        return Some(UpdateManager {
            by: ManagedBy::Npm,
            message: format!(
                "pacer was installed with npm; update with: npm install -g @lamtuanvu/pacer@{channel}"
            ),
        });
    }
    let real = canonical(exec_path);
    let shown = real.to_string_lossy();
    let prefixes: Vec<_> = ["HOMEBREW_PREFIX", "HOMEBREW_CELLAR"]
        .iter()
        .filter_map(|key| env.get(*key))
        .collect();
    let homebrew = shown.contains("/Cellar/pacer/")
        || prefixes.iter().any(|prefix| {
            let root = canonical(Path::new(prefix));
            let root = root.to_string_lossy();
            let root = root.trim_end_matches('/');
            shown.starts_with(&format!("{root}/"))
        });
    if homebrew {
        return Some(UpdateManager {
            by: ManagedBy::Homebrew,
            message: HOMEBREW_MESSAGE.into(),
        });
    }
    let lower = shown.to_lowercase();
    if lower.contains(".app/contents/resources/") || lower.contains(".app/contents/macos/") {
        return Some(UpdateManager {
            by: ManagedBy::Desktop,
            message: "this executable belongs to the desktop app; use Settings → Updates in the desktop to update the complete app".into(),
        });
    }
    None
}

/// A missing or malformed `owner.json` means "no recorded owner", like `readOwner`.
fn desktop_owner(ctx: &Ctx) -> Option<std::path::PathBuf> {
    let path = ctx.pacer_home.join("owner.json");
    let text = std::fs::read_to_string(path).ok()?;
    let data: Value = serde_json::from_str(&text).ok()?;
    if !data.is_object()
        || data.get("schema").and_then(Value::as_i64) != Some(1)
        || data.get("owner").and_then(Value::as_str) != Some("desktop")
    {
        return None;
    }
    let executable = data.get("executable").and_then(Value::as_str)?;
    if !Path::new(executable).is_absolute() {
        return None;
    }
    if !data
        .get("at")
        .and_then(Value::as_f64)
        .is_some_and(f64::is_finite)
    {
        return None;
    }
    Some(canonical(Path::new(executable)))
}

/// `ownerRefusal`: a desktop-owned installation refuses a foreign CLI front door.
pub fn owner_refusal(ctx: &Ctx, exec_dir: &Path) -> bool {
    let Some(recorded) = desktop_owner(ctx) else {
        return false;
    };
    let pacer_bin = ctx.env.get("PACER_BIN").map(Path::new);
    let same_binary = pacer_bin.is_some_and(|bin| canonical(bin) == recorded);
    let same_dir = canonical(exec_dir) == recorded.parent().unwrap_or(Path::new("/"));
    !(same_binary || same_dir)
}

/// `updateManager`: the desktop owner outranks the install method.
pub fn update_manager(
    ctx: &Ctx,
    exec_path: &Path,
    exec_dir: &Path,
    nightly: bool,
) -> Option<UpdateManager> {
    if owner_refusal(ctx, exec_dir) {
        return Some(UpdateManager {
            by: ManagedBy::Desktop,
            message: MANAGED_BY_DESKTOP_MESSAGE.into(),
        });
    }
    install_manager(&ctx.env, exec_path, nightly)
}
