//! Installation-manager detection, ported from `src/update/update.ts:installManager`
//! and `src/install/owner.ts` (`readOwner`, `isRecordedOwnerExecutable`, `ownerRefusal`).
//! An installation another installer updates must not have its binaries replaced here.
use pacer_foundation::Ctx;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

/// `src/install/owner.ts:85-86`, verbatim.
pub const MANAGED_BY_DESKTOP_MESSAGE: &str = "pacer is managed by the pacer app; update or change the service from the app (Settings), or run with --release-ownership to hand it back to this CLI";
const BREW_MESSAGE: &str = "pacer was installed with Homebrew; update with: brew upgrade pacer";
const APP_MESSAGE: &str =
    "this executable belongs to the desktop app; use Settings → Updates in the desktop to update the complete app";

/// Who updates this installation when it is not `pacer update`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManagedBy {
    Desktop,
    Homebrew,
    Npm,
}

pub struct UpdateManager {
    pub by: ManagedBy,
    pub message: String,
}

/// True when `path` resolves into some `*.app/Contents/(Resources|MacOS)` bundle.
fn is_bundled_executable(exe: &Path) -> bool {
    let resolved = fs::canonicalize(exe).unwrap_or_else(|_| exe.to_path_buf());
    let parts: Vec<_> = resolved
        .components()
        .map(|part| part.as_os_str().to_string_lossy().into_owned())
        .collect();
    parts.windows(4).any(|parts| {
        parts[0].to_ascii_lowercase().ends_with(".app")
            && parts[1].eq_ignore_ascii_case("Contents")
            && (parts[2].eq_ignore_ascii_case("Resources")
                || parts[2].eq_ignore_ascii_case("MacOS"))
    })
}

/// `installManager`: npm, then Homebrew, then the desktop app bundle.
pub fn install_manager(
    env: &HashMap<String, String>,
    exec_path: &Path,
    nightly: bool,
) -> Option<UpdateManager> {
    if env.get("PACER_INSTALL_METHOD").is_some_and(|v| v == "npm") {
        return Some(UpdateManager {
            by: ManagedBy::Npm,
            message: format!(
                "pacer was installed with npm; update with: npm install -g @lamtuanvu/pacer@{}",
                if nightly { "nightly" } else { "latest" }
            ),
        });
    }
    let real = fs::canonicalize(exec_path).ok()?;
    let shown = real.to_string_lossy();
    let prefixes = ["HOMEBREW_PREFIX", "HOMEBREW_CELLAR"]
        .into_iter()
        .filter_map(|key| env.get(key));
    let homebrew = shown.contains("/Cellar/pacer/") || prefixes.into_iter().any(|prefix| {
        let canonical = fs::canonicalize(prefix).unwrap_or_else(|_| PathBuf::from(prefix));
        let base = canonical.to_string_lossy();
        shown.starts_with(&format!("{}/", base.trim_end_matches('/')))
    });
    if homebrew {
        return Some(UpdateManager {
            by: ManagedBy::Homebrew,
            message: BREW_MESSAGE.into(),
        });
    }
    if is_bundled_executable(exec_path)
        || shown.contains(".app/Contents/Resources/pacer")
        || shown.contains(".app/Contents/MacOS/pacer")
    {
        return Some(UpdateManager {
            by: ManagedBy::Desktop,
            message: APP_MESSAGE.into(),
        });
    }
    None
}

/// A missing or malformed `owner.json` means "no recorded owner". Never panics.
fn read_owner(ctx: &Ctx) -> Option<(String, PathBuf)> {
    let text = fs::read_to_string(ctx.pacer_home.join("owner.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let object = value.as_object()?;
    if object.get("schema").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let owner = object.get("owner").and_then(Value::as_str)?;
    if owner != "cli" && owner != "desktop" {
        return None;
    }
    let executable = PathBuf::from(object.get("executable").and_then(Value::as_str)?);
    if !executable.is_absolute() {
        return None;
    }
    let at = object.get("at")?;
    if !at.as_f64().is_some_and(f64::is_finite) {
        return None;
    }
    Some((owner.to_owned(), executable))
}

/// `realpathSync` with a `resolve` fallback, as in `owner.ts:canonical`.
fn canonical(path: &Path) -> PathBuf {
    if let Ok(real) = fs::canonicalize(path) {
        return real;
    }
    if path.is_absolute() {
        return path.to_path_buf();
    }
    std::env::current_dir().unwrap_or_default().join(path)
}

/// The bundled-CLI exemption: `PACER_BIN` is the recorded executable, or the running
/// front door's directory is the recorded executable's directory.
fn is_recorded_owner_executable(
    env: &HashMap<String, String>,
    exec_dir: &Path,
    recorded: &Path,
) -> bool {
    let recorded = canonical(recorded);
    if let Some(bin) = env.get("PACER_BIN")
        && canonical(Path::new(bin)) == recorded
    {
        return true;
    }
    recorded.parent() == Some(canonical(exec_dir).as_path())
}

/// `ownerRefusal`: true when a desktop owner is recorded and this process is not its
/// own bundled CLI. `exec_dir` is the directory of the running front door.
pub fn owner_refusal(ctx: &Ctx, exec_dir: &Path) -> bool {
    let Some((owner, executable)) = read_owner(ctx) else {
        return false;
    };
    owner == "desktop" && !is_recorded_owner_executable(&ctx.env, exec_dir, &executable)
}

/// `updateManager`: a desktop owner refusal wins, then the install-method hints.
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
