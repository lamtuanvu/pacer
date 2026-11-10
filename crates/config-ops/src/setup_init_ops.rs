//! Native `setup.init` (`src/core/setup.ts` `init`). An existing strategy only
//! gets its planner set, without agent integrations. Otherwise Rust detects the
//! installed CLIs and running local model servers (the Ollama tags endpoint,
//! fetched by Core through the setup effects bridge, and `lms ls` on an
//! explicit port, so neither starts an application), writes the starter
//! strategy and migrates it.
#![allow(clippy::result_large_err)]
use crate::executor_setup_ops::{invalid, params_map, type_name};
use crate::setup_effects::{SetupEffects, run, unavailable, which};
use pacer_config::{settings, strategy};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Value, json};
use std::{collections::HashMap, path::Path, time::Duration};

const BINS: &[&str] = &[
    "claude",
    "codex",
    "cursor-agent",
    "cursor",
    "agy",
    "opencode",
    "arkcli",
    "ollama",
    "lms",
    "orca",
];
const AGENTS: &[&str] = &["claude-code", "codex", "cursor", "agy", "opencode"];
const PLANNERS: &[&str] = &["claude-code", "codex", "cursor", "opencode"];

fn planner_param(params: &Value) -> Result<String, CoreError> {
    let map = params_map(params)?;
    let value = map.get("planner");
    let Some(planner) = value.and_then(Value::as_str) else {
        return Err(invalid(format!(
            "planner: Invalid input: expected string, received {}",
            type_name(value)
        )));
    };
    match planner.chars().count() {
        0 => Err(invalid(
            "planner: Too small: expected string to have >=1 characters",
        )),
        n if n > 128 => Err(invalid(
            "planner: Too big: expected string to have <=128 characters",
        )),
        _ => Ok(planner.to_owned()),
    }
}

/// `[a-z0-9][a-z0-9-]*`
fn segment(text: &str) -> bool {
    text.bytes()
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `parseRunnerId` accepting only a local planner agent.
fn local_planner(id: &str) -> bool {
    let (rest, host) = id.split_once('@').map_or((id, None), |(r, h)| (r, Some(h)));
    let (agent, account) = rest
        .split_once('#')
        .map_or((rest, None), |(a, b)| (a, Some(b)));
    segment(agent)
        && AGENTS.contains(&agent)
        && account.is_none_or(segment)
        && host.is_none_or(|h| segment(h) && h == "local")
        && PLANNERS.contains(&agent)
}

/// The first model the Ollama server at `OLLAMA_HOST` lists, from Core's
/// `fetch` so every `OLLAMA_HOST` form resolves and frames as in `pacer init`.
async fn ollama_model(effects: &mut dyn SetupEffects) -> Result<Option<String>, CoreError> {
    let reply = effects.call(json!({"kind": "ollama_model"})).await?;
    match &reply["model"] {
        Value::Null => Ok(None),
        Value::String(model) => Ok(Some(model.clone())),
        _ => Err(unavailable("invalid setup effects response")),
    }
}

/// The LM Studio model to start with, from a server already listening.
async fn lmstudio_model(ctx: &Ctx) -> Option<String> {
    let legacy = ctx.home.join(".cache").join("lm-studio");
    let pointer = std::fs::read_to_string(ctx.home.join(".lmstudio-home-pointer"))
        .ok()
        .map(|t| t.trim().to_owned())
        .filter(|t| !t.is_empty());
    let home = pointer.map(Into::into).unwrap_or_else(|| {
        if legacy.exists() {
            legacy
        } else {
            ctx.home.join(".lmstudio")
        }
    });
    let info_path = ctx
        .env
        .get("LMS_API_SERVER_INFO_PATH")
        .filter(|p| !p.is_empty())
        .map_or_else(
            || home.join(".internal").join("http-server.json"),
            Into::into,
        );
    let info: Option<Value> = pacer_foundation::fsutil::read_json(&info_path);
    let port = info
        .as_ref()
        .and_then(|i| i["port"].as_f64())
        .filter(|p| p.fract() == 0.0 && *p > 0.0 && *p <= 65535.0)
        .map_or(41343, |p| p as u32)
        .to_string();
    let argv = ["lms", "ls", "--json", "--port", port.as_str()];
    let (code, stdout) = run(ctx, &argv, Duration::from_secs(5)).await?;
    if code != 0 {
        return None;
    }
    let models: Value = serde_json::from_str(&stdout).ok()?;
    let llms: Vec<&Value> = models
        .as_array()?
        .iter()
        .filter(|m| m["type"] == "llm" && m["modelKey"].as_str().is_some_and(|k| !k.is_empty()))
        .collect();
    let model = llms
        .iter()
        .find(|m| m["trainedForToolUse"] == true)
        .or(llms.first())?;
    model["modelKey"].as_str().map(str::to_owned)
}

struct Detection {
    clis: HashMap<&'static str, bool>,
    ollama: Option<String>,
    lmstudio: Option<String>,
}

async fn detect(ctx: &Ctx, effects: &mut dyn SetupEffects) -> Result<Detection, CoreError> {
    let mut clis: HashMap<&'static str, bool> =
        BINS.iter().map(|b| (*b, which(ctx, b).is_some())).collect();
    if clis["cursor"] {
        clis.insert("cursor-agent", true);
    }
    let ollama = if clis["ollama"] {
        ollama_model(effects).await?
    } else {
        None
    };
    let lmstudio = if clis["lms"] {
        lmstudio_model(ctx).await
    } else {
        None
    };
    Ok(Detection {
        clis,
        ollama,
        lmstudio,
    })
}

/// `starterStrategy(detect(ctx), planner)` for a planner agent.
fn starter(d: &Detection, selected: &str) -> String {
    let has = |bin: &str| d.clis.get(bin).copied().unwrap_or(false);
    let mut providers: Vec<(String, String)> = Vec::new();
    let mut add = |id: &str, cfg: String| providers.push((id.into(), cfg));
    if has("claude") {
        add("claude-code", "{usage: quota}".into());
    }
    if has("codex") {
        add("codex", "{usage: quota, allow_paid: false}".into());
    }
    if has("cursor-agent") {
        add("cursor", "{usage: reactive, cooldown: 6h}".into());
    }
    if has("agy") {
        add("agy", "{usage: reactive, cooldown: 6h}".into());
    }
    if has("opencode") {
        if has("arkcli") {
            add("byteplus", "{via: opencode, model: \"coding-plan/dola-seed-2.0-code\", usage: quota, quota_source: arkcli}".into());
        }
        let local = |prefix: &str, model: &str| {
            format!(
                "{{via: opencode, model: {}, usage: unmetered}}",
                json!(format!("{prefix}/{model}"))
            )
        };
        if let (true, Some(model)) = (has("ollama"), &d.ollama) {
            add("ollama", local("ollama", model));
        }
        if let (true, Some(model)) = (has("lms"), &d.lmstudio) {
            add("lmstudio", local("lmstudio", model));
        }
    }
    // A missing planner can still be configured for installation later.
    if selected != "opencode" && !providers.iter().any(|(id, _)| id == selected) {
        let cfg = if selected == "cursor" {
            "{usage: reactive}"
        } else {
            "{usage: quota}"
        };
        providers.push((selected.into(), cfg.into()));
    }
    let executors: Vec<&str> = [
        "codex",
        "cursor",
        "agy",
        "byteplus",
        "ollama",
        "lmstudio",
        "claude-code",
    ]
    .into_iter()
    .filter(|p| *p != selected && providers.iter().any(|(id, _)| id == p))
    .collect();
    let mut lines = vec![
        format!("planner: {selected}"),
        if providers.is_empty() {
            "providers: {}".into()
        } else {
            "providers:".into()
        },
    ];
    lines.extend(providers.iter().map(|(id, cfg)| format!("  {id}: {cfg}")));
    lines.push("# To add opencode-go: use via: opencode, model: opencode-go/<model>,".into());
    lines.push(
        "# usage: metered, and budget.weekly_tokens (e.g. budget: {weekly_tokens: 20M}).".into(),
    );
    lines.push("pacing: {policy: priority, planner_reserve: 15}".into());
    if executors.is_empty() {
        lines.push("routing: []".into());
    } else {
        lines.push("routing:".into());
        lines.push(format!("  - default: [{}]", executors.join(", ")));
    }
    lines.push(String::new());
    lines.join("\n")
}

fn failed(error: impl std::fmt::Display) -> CoreError {
    invalid(error.to_string())
}

fn settings_error(error: settings::SettingsError) -> CoreError {
    let code = match error.code {
        "conflict" => Code::Conflict,
        "unavailable" => Code::Unavailable,
        _ => Code::InvalidInput,
    };
    let mut out = CoreError::new(code, error.message);
    if let Some(hint) = error.hint {
        out = out.hint(hint);
    }
    out
}

fn publish(ctx: &Ctx, area: &str) -> Result<(), CoreError> {
    let report = pacer_store::publish_config_change(ctx, area)
        .map_err(|e| CoreError::new(Code::Internal, format!("{area} publication failed: {e}")))?;
    for error in report.errors {
        eprintln!("pacer: config publication failed: {error}");
    }
    Ok(())
}

async fn create(
    ctx: &Ctx,
    path: &Path,
    planner: &str,
    effects: &mut dyn SetupEffects,
) -> Result<(), CoreError> {
    if !PLANNERS.contains(&planner) {
        return Err(failed(format!(
            "planner {planner} is unknown or its CLI is missing"
        )));
    }
    let text = starter(&detect(ctx, effects).await?, planner);
    strategy::validate_strategy_text(&text, path).map_err(failed)?;
    std::fs::create_dir_all(&ctx.pacer_home).map_err(failed)?;
    std::fs::write(path, &text).map_err(failed)?;
    strategy::migrate_strategy(path, None).map_err(failed)?;
    Ok(())
}

pub(crate) async fn setup_init(
    ctx: &Ctx,
    params: Value,
    effects: &mut dyn SetupEffects,
) -> Result<Value, CoreError> {
    crate::executor_setup_ops::enforcement(ctx)?;
    let planner = planner_param(&params)?;
    if !local_planner(&planner) {
        return Err(invalid("unknown planner").hint(format!("choose {}", PLANNERS.join(", "))));
    }
    let path = ctx.pacer_home.join("strategy.yaml");
    if path.exists() {
        let (active, name) = strategy::strategy_path(&ctx.pacer_home).map_err(failed)?;
        settings::set_planner_without_integrations(&active, &name, &json!(planner))
            .map_err(settings_error)?;
        publish(ctx, "config")?;
    } else {
        create(ctx, &path, &planner, effects).await?;
    }
    publish(ctx, "setup")?;
    Ok(json!({"strategy": path.display().to_string()}))
}

#[cfg(test)]
mod tests;
