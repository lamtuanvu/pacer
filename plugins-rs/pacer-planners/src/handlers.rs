//! The six planner handlers (`plugins/pacer-planners/index.ts:39-208`).

use crate::claude;
use crate::codex;
use crate::cursor;
use crate::opencode;
use crate::types::{ListFn, PlannerBuilder, PlannerContext, join};
use pacer_plugin::install::{
    FileChange, PlanEnv, PlannerCommandIntent, PlannerRecord, PriorReference,
    create_planner_io, host_call, pieces_present, prepare_planner_install,
    prepare_planner_uninstall_files, read_planner_prior, sha256,
};
use pacer_plugin::{Ctx, PluginError};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::{Arc, OnceLock};

const UNDO_FAILED: &str = "recorded command undo failed; install record retained. Restore the agent CLI and retry uninstall";

fn internal(message: impl Into<String>) -> PluginError {
    PluginError::new("internal", message)
}

fn version_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\d+\.\d+(?:\.\d+)?")
            .unwrap_or_else(|error| panic!("invalid version regex: {error}"))
    })
}

fn parse<T: serde::de::DeserializeOwned>(value: Option<Value>, what: &str) -> Result<T, PluginError> {
    serde_json::from_value(value.unwrap_or(Value::Null))
        .map_err(|error| internal(format!("invalid planner {what}: {error}")))
}

async fn record_from(
    params: Value,
    host: pacer_plugin::install::HostCall,
) -> Result<Option<PlannerRecord>, PluginError> {
    if let Some(reference) = params.get("priorRange") {
        let reference: PriorReference = parse(Some(reference.clone()), "prior reference")?;
        let value = read_planner_prior(host, reference)
            .await
            .map_err(internal)?;
        Ok(Some(parse(Some(value), "prior record")?))
    } else {
        match params.get("prior") {
            Some(Value::Null) | None => Ok(None),
            Some(value) => Ok(Some(parse(Some(value.clone()), "prior record")?)),
        }
    }
}

/// `planner.install` and `planner.plan` (`index.ts:39-69`).
pub async fn prepare(params: Value, ctx: &Ctx) -> Result<Value, PluginError> {
    let host = ctx.host.clone();
    let call = host_call(move |method, params| {
        let host = host.clone();
        async move { host.call(&method, params).await.map_err(|error| error.to_string()) }
    });

    let env: PlanEnv = parse(params.get("env").cloned(), "env")?;
    let prior = record_from(params.clone(), call.clone()).await?;

    let io = create_planner_io(call.clone(), Some(ctx.cancel.clone()));
    let list: ListFn = {
        let call = call.clone();
        Arc::new(move |dir, glob| {
            let call = call.clone();
            Box::pin(async move {
                let value = call(
                    "capability.fs.list".to_string(),
                    json!({ "dir": dir, "glob": glob }),
                )
                .await?;
                let files = value
                    .get("files")
                    .and_then(Value::as_array)
                    .ok_or("invalid fs.list result")?;
                Ok(files
                    .iter()
                    .filter_map(|file| {
                        file.get("path")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .collect())
            })
        })
    };
    let config_env = params
        .get("env")
        .and_then(|env| env.get("configEnv"))
        .cloned()
        .and_then(|value| serde_json::from_value::<BTreeMap<String, String>>(value).ok())
        .unwrap_or_default();
    let context = PlannerContext {
        home: params
            .get("home")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        env: config_env,
        binary: params
            .get("binary")
            .and_then(Value::as_str)
            .map(str::to_string),
        list,
    };
    let agent = params
        .get("agent")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let plan = prepare_planner_install(io, env, prior.as_ref(), |builder| {
        Box::pin(async move {
            let mut tx = PlannerBuilder { tx: builder, context };
            match agent.as_str() {
                "claude-code" => claude::install_claude(&mut tx).await,
                "codex" => codex::install_codex(&mut tx).await,
                "cursor" => cursor::install_cursor(&mut tx).await,
                "opencode" => opencode::install_opencode_files(&mut tx).await,
                _ => Err("unsupported planner".to_string()),
            }
        })
    })
    .await
    .map_err(internal)?;
    serde_json::to_value(plan).map_err(|error| internal(error.to_string()))
}

/// `planner.detect` (`index.ts:73-103`).
pub async fn detect(params: Value, ctx: &Ctx) -> Result<Value, PluginError> {
    let hints: BTreeMap<&str, &str> = BTreeMap::from([
        ("claude-code", "npm install -g @anthropic-ai/claude-code"),
        ("codex", "npm install -g @openai/codex"),
        ("cursor", "Install Cursor CLI from https://cursor.com/docs/cli/installation"),
        ("opencode", "brew install opencode"),
    ]);
    let agent = params.get("agent").and_then(Value::as_str).unwrap_or_default();
    let path = params
        .get("binary")
        .and_then(|binary| binary.get("path"))
        .and_then(Value::as_str);
    let name = params
        .get("binary")
        .and_then(|binary| binary.get("name"))
        .and_then(Value::as_str);
    let version = if path.is_some() && name != Some("cursor") && params.get("probe").is_some() {
        let probe = params.get("probe").cloned().unwrap_or(Value::Null);
        match ctx.host.call("capability.process.spawn", probe).await {
            Ok(result) if result.get("code").and_then(Value::as_i64) == Some(0) => {
                let stdout = result.get("stdout").and_then(Value::as_str).unwrap_or_default();
                let stderr = result.get("stderr").and_then(Value::as_str).unwrap_or_default();
                version_re()
                    .find(&format!("{stdout}\n{stderr}"))
                    .map(|m| m.as_str().to_string())
            }
            _ => None,
        }
    } else {
        None
    };
    let mut out = json!({
        "agent": agent,
        "found": path.is_some(),
        "version": version,
        "path": path,
    });
    if let Some(hint) = hints.get(agent) {
        out["install_hint"] = json!(hint);
    }
    Ok(out)
}

/// `planner.check` (`index.ts:104-124`).
pub async fn check(params: Value, ctx: &Ctx) -> Result<Value, PluginError> {
    let host = ctx.host.clone();
    let call = host_call(move |method, params| {
        let host = host.clone();
        async move { host.call(&method, params).await.map_err(|error| error.to_string()) }
    });
    let io = create_planner_io(call, Some(ctx.cancel.clone()));
    let files: Vec<FileChange> = parse(params.get("files").cloned(), "files")?;
    let mut results = Vec::new();
    let mut intact = true;
    for file in &files {
        let image = io.base.read(&file.path).await.map_err(internal)?;
        let file_intact = if file.action == "moved" {
            match &file.backup {
                Some(backup) => {
                    image.is_none() && io.base.read(backup).await.map_err(internal)?.is_some()
                }
                None => false,
            }
        } else {
            image.as_ref().is_some_and(|image| {
                file.after_hash
                    .as_ref()
                    .is_some_and(|hash| sha256(&image.text) == *hash)
                    || (!file.undo.is_empty() && pieces_present(&image.text, &file.undo))
            })
        };
        intact &= file_intact;
        results.push(json!({ "path": file.path, "intact": file_intact }));
    }
    Ok(json!({ "intact": intact, "files": results }))
}

/// `planner.preview` (`index.ts:125-171`).
pub async fn preview(params: Value, ctx: &Ctx) -> Result<Value, PluginError> {
    let env: PlanEnv = parse(params.get("env").cloned(), "env")?;
    let root = env.folder.clone().unwrap_or_default();
    let skill = env.skill_folder.clone().unwrap_or_else(|| root.clone());
    let agent = params.get("agent").and_then(Value::as_str).unwrap_or_default();
    let mut files = vec![join(&skill, "skills/pacer/SKILL.md")];
    match agent {
        "claude-code" => {
            files.push(join(&root, "rules/pacer.md"));
            files.push(join(&root, "settings.json"));
        }
        "codex" => {
            files.push(join(&root, "AGENTS.md"));
            files.push(join(&root, "hooks.json"));
        }
        "cursor" => files.push(join(&root, "hooks.json")),
        "opencode" => files.push(join(&root, "AGENTS.md")),
        _ => {}
    }
    let kept: Vec<String> = if agent == "claude-code" {
        vec![join(&root, "CLAUDE.md")]
    } else {
        vec![]
    };
    let prior: Option<PlannerRecord> = parse(params.get("prior").cloned(), "prior record")?;
    let prior_files: BTreeMap<String, FileChange> = prior
        .map(|record| {
            record
                .files
                .into_iter()
                .map(|file| (file.path.clone(), file))
                .collect()
        })
        .unwrap_or_default();

    let host = ctx.host.clone();
    let call = host_call(move |method, params| {
        let host = host.clone();
        async move { host.call(&method, params).await.map_err(|error| error.to_string()) }
    });
    let io = create_planner_io(call, Some(ctx.cancel.clone()));

    let mut changes: Vec<Value> = Vec::new();
    for path in &files {
        let old = prior_files.get(path);
        let text = io
            .base
            .read(path)
            .await
            .map_err(internal)?
            .map(|image| image.text);
        let change = if old
            .and_then(|file| file.after_hash.as_ref())
            .is_some_and(|hash| text.as_ref().is_some_and(|text| sha256(text) == *hash))
        {
            "unchanged"
        } else if old.is_some() {
            "restore"
        } else if text.is_none() {
            "create"
        } else {
            "update"
        };
        changes.push(json!({ "path": path, "change": change }));
    }
    for path in &kept {
        changes.push(json!({ "path": path, "change": "kept" }));
    }
    let mut out = json!({
        "files": files,
        "changes": changes,
        "undo": format!("pacer uninstall {}", env.planner_key.unwrap_or_default()),
    });
    if agent == "claude-code" {
        let home = params.get("home").and_then(Value::as_str).unwrap_or_default();
        let detail = claude::claude_preview(&io.base, home, &root)
            .await
            .map_err(internal)?;
        out["detail"] = json!(detail);
    }
    Ok(out)
}

/// `planner.uninstall` (`index.ts:172-208`).
pub async fn uninstall(params: Value, ctx: &Ctx) -> Result<Value, PluginError> {
    let host = ctx.host.clone();
    let call = host_call(move |method, params| {
        let host = host.clone();
        async move { host.call(&method, params).await.map_err(|error| error.to_string()) }
    });
    let prior = record_from(params.clone(), call.clone())
        .await?
        .ok_or_else(|| internal("planner install record missing"))?;
    let io = create_planner_io(call, Some(ctx.cancel.clone()));
    let mut plan = prepare_planner_uninstall_files(&io.base, &prior, None)
        .await
        .map_err(internal)?;
    let agent = params.get("agent").and_then(Value::as_str).unwrap_or_default();
    for undo in prior.commands.iter().rev() {
        let argv = &undo.undo;
        if agent == "claude-code"
            && argv.get(1).map(String::as_str) == Some("mcp")
            && argv.get(2).map(String::as_str) == Some("remove")
        {
            let mut run = |args: Vec<String>| {
                let io = io.clone();
                async move {
                    io.run(PlannerCommandIntent {
                        argv: args,
                        undo: None,
                        timeout_ms: 30000,
                    })
                    .await
                }
            };
            let removed = claude::remove_claude_mcp(&mut run, &mut plan.notes, argv)
                .await
                .map_err(internal)?;
            if !removed {
                return Err(internal(UNDO_FAILED));
            }
        } else {
            let result = io
                .run(PlannerCommandIntent {
                    argv: argv.clone(),
                    undo: None,
                    timeout_ms: 30000,
                })
                .await
                .map_err(internal)?;
            if result.code != 0 {
                return Err(internal(UNDO_FAILED));
            }
        }
    }
    plan.uninstall_report.notes = plan.notes.clone();
    serde_json::to_value(plan).map_err(|error| internal(error.to_string()))
}
