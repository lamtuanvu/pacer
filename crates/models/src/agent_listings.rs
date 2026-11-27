//! Native agents' own model lists for the pick list (`src/models/agent-listings.ts`):
//! Codex's `models_cache.json`, `cursor-agent models` and `agy models`. Only
//! `executor.models.available` lists them; the model checks keep no listing
//! for these agents because the lists leave out ids the agents still accept.
use crate::{
    AvailableModel, AvailableModels, ModelSource,
    available::{js_number, js_string, text},
    discover::{CoreProcess, STDOUT_CAP, run_program, write_cache},
};
use pacer_js_json::{js_semantics::trim, quoted};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    time::Duration,
};

/// `AGENT_LIST_TIMEOUT_MS`: a hung CLI must not hold the request.
pub const AGENT_LIST_TIMEOUT: Duration = Duration::from_secs(30);

const CODEX_MISSING: &str =
    "Codex has not saved a model list yet; start Codex once with this account";
const CODEX_UNREADABLE: &str = "Codex's saved model list could not be read";
const CODEX_EMPTY: &str = "Codex's saved model list has no models; start Codex once to refresh it";
const CODEX_NO_FOLDER: &str = "Codex's folder for this account was not found";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliAgent {
    Cursor,
    Agy,
}

impl CliAgent {
    fn argv(self) -> [&'static str; 2] {
        match self {
            Self::Cursor => ["cursor-agent", "models"],
            Self::Agy => ["agy", "models"],
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Cursor => "Cursor",
            Self::Agy => "Antigravity",
        }
    }
    fn parse(self, stdout: &str) -> Vec<AvailableModel> {
        match self {
            Self::Cursor => parse_cursor_models(stdout),
            Self::Agy => parse_agy_models(stdout),
        }
    }
}

/// A runner the pick list lists from the agent itself.
#[derive(Debug)]
pub(crate) enum AgentListing {
    Known(AvailableModels),
    /// `cursor-agent models` or `agy models` must run; `base` is the unknown listing.
    Cli(AvailableModels, CliAgent),
    /// A folder only TypeScript resolves (Orca accounts, relative homes) or a file it parses differently.
    Unsupported,
}

/// Ids are printable ASCII without spaces, as both CLIs and the Codex cache write them.
fn plain_id(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| (0x21..=0x7e).contains(&b))
}

/// Each id once, in listing order.
fn once(models: Vec<AvailableModel>) -> Vec<AvailableModel> {
    let mut seen = HashSet::new();
    models
        .into_iter()
        .filter(|m| seen.insert(m.id.clone()))
        .collect()
}

fn entry(id: &str, name: &str) -> AvailableModel {
    AvailableModel {
        id: id.to_owned(),
        name: (!name.is_empty()).then(|| text(name)),
        ..AvailableModel::default()
    }
}

/// "Auto (current, default)" -> "Auto".
fn without_marker(name: &str) -> &str {
    let Some(open) = name.rfind('(') else {
        return name;
    };
    if !name.ends_with(')') {
        return name;
    }
    let inner = &name[open + 1..name.len() - 1];
    if inner
        .split(',')
        .map(trim)
        .all(|word| word == "current" || word == "default")
    {
        trim(&name[..open])
    } else {
        name
    }
}

/// `parseCursorModels`: `id - Name` lines.
pub fn parse_cursor_models(stdout: &str) -> Vec<AvailableModel> {
    let mut models = Vec::new();
    for raw in stdout.split('\n') {
        let line = trim(raw);
        let Some(at) = line.find(" - ") else {
            continue;
        };
        let id = &line[..at];
        if !plain_id(id) {
            continue;
        }
        models.push(entry(id, without_marker(trim(&line[at + 3..]))));
    }
    once(models)
}

/// `parseAgyModels`: `id<TAB>Name` lines.
pub fn parse_agy_models(stdout: &str) -> Vec<AvailableModel> {
    let mut models = Vec::new();
    for raw in stdout.split('\n') {
        let Some(tab) = raw.find('\t') else {
            continue;
        };
        let id = trim(&raw[..tab]);
        if !plain_id(id) {
            continue;
        }
        models.push(entry(id, trim(&raw[tab + 1..])));
    }
    once(models)
}

/// `parseCodexCache` on the parsed file: entries Codex lists itself
/// (`visibility: "list"` or no visibility). `None` is not a model cache.
pub fn parse_codex_cache(value: &Value) -> Option<Vec<AvailableModel>> {
    let items = value.as_object()?.get("models")?.as_array()?;
    let mut models = Vec::new();
    for item in items {
        let Some(e) = item.as_object() else {
            continue;
        };
        let Some(slug) = e
            .get("slug")
            .filter(|s| js_string(s))
            .and_then(Value::as_str)
            .filter(|s| plain_id(s))
        else {
            continue;
        };
        if e.get("visibility")
            .is_some_and(|v| v.as_str() != Some("list"))
        {
            continue;
        }
        let mut model = AvailableModel::new(slug);
        model.name = e
            .get("display_name")
            .filter(|n| js_string(n) && n.as_str() != Some(""))
            .cloned();
        model.context = e
            .get("context_window")
            .filter(|c| c.is_number())
            .and_then(Value::as_f64)
            .filter(|c| c.is_finite() && *c > 0.0)
            .map(js_number);
        models.push(model);
    }
    Some(once(models))
}

/// The Codex folder as `codexHome` resolves it; `Err` is a folder only TypeScript resolves.
fn codex_home(user_home: &Path, account: &Value) -> Result<Option<PathBuf>, ()> {
    match account["source"].as_str() {
        Some("default") => return Ok(Some(user_home.join(".codex"))),
        Some("orca") => return Err(()),
        _ => {}
    }
    let Some(home) = account["home"].as_str().filter(|h| !h.is_empty()) else {
        return Ok(None);
    };
    let expanded = match home.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            format!("{}{rest}", user_home.display())
        }
        _ => home.to_owned(),
    };
    let path = PathBuf::from(expanded);
    // `resolve` would normalize these against Core's working directory.
    let plain = path.is_absolute()
        && path
            .components()
            .all(|c| matches!(c, Component::RootDir | Component::Normal(_)));
    if plain { Ok(Some(path)) } else { Err(()) }
}

fn codex_listing(user_home: &Path, account: &Value, mut base: AvailableModels) -> AgentListing {
    let Ok(home) = codex_home(user_home, account) else {
        return AgentListing::Unsupported;
    };
    let Some(home) = home else {
        base.note = Some(CODEX_NO_FOLDER.into());
        return AgentListing::Known(base);
    };
    let path = home.join("models_cache.json");
    if let Ok(meta) = fs::metadata(&path)
        && !meta.is_file()
        && !meta.is_dir()
    {
        return AgentListing::Unsupported;
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) => {
            base.note = Some(
                if error.kind() == ErrorKind::NotFound {
                    CODEX_MISSING
                } else {
                    CODEX_UNREADABLE
                }
                .into(),
            );
            return AgentListing::Known(base);
        }
    };
    let models = match quoted::parse_file(&bytes) {
        Ok(value) => parse_codex_cache(&value),
        Err(error) if error == quoted::NESTING_FALLBACK => return AgentListing::Unsupported,
        Err(_) => None,
    };
    match models {
        None => base.note = Some(CODEX_UNREADABLE.into()),
        Some(models) if models.is_empty() => base.note = Some(CODEX_EMPTY.into()),
        Some(models) => base.models = Some(models),
    }
    AgentListing::Known(base)
}

/// The pick-list listing for a local Codex, Cursor or Antigravity runner;
/// `None` is any other runner, which `compose` lists.
pub(crate) fn agent_listing(
    user_home: &Path,
    strategy: &Value,
    runner_id: &str,
    base: &AvailableModels,
) -> Option<AgentListing> {
    let runner = strategy["runners"].get(runner_id)?;
    if !runner["host"].is_null() {
        return None;
    }
    let name = runner["account"].as_str()?;
    let account = strategy["accounts"].get(name)?;
    let agent = runner["agent"].as_str()?;
    if account["kind"].as_str() != Some(agent) {
        return None;
    }
    let mut base = base.clone();
    base.provider = Some(name.to_owned());
    match agent {
        "codex" => {
            base.source = ModelSource::Codex;
            Some(codex_listing(user_home, account, base))
        }
        "cursor" => {
            base.source = ModelSource::Cursor;
            Some(AgentListing::Cli(base, CliAgent::Cursor))
        }
        "agy" => {
            base.source = ModelSource::Agy;
            Some(AgentListing::Cli(base, CliAgent::Agy))
        }
        _ => None,
    }
}

/// `cliModels`: run the agent's `models` command as Core runs it, parse it and
/// cache a non-empty listing.
pub(crate) async fn list_cli(
    home: &Path,
    mut base: AvailableModels,
    agent: CliAgent,
    process: &CoreProcess,
) -> AvailableModels {
    let label = agent.label();
    let Some(stdout) = run_program(process, &agent.argv(), AGENT_LIST_TIMEOUT, STDOUT_CAP).await
    else {
        base.note = Some(format!("{label} could not list its models"));
        return base;
    };
    let models = agent.parse(&String::from_utf8_lossy(&stdout));
    if models.is_empty() {
        base.note = Some(format!(
            "{label} lists no models; check that it is signed in"
        ));
        return base;
    }
    base.models = Some(models);
    write_cache(
        &crate::available::cache_file(home, &base.runner),
        &quoted::stringify(&base.to_json()),
    );
    base
}
