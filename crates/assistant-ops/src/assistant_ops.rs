//! Native assistant settings and history ops (`src/api/ops-assistant.ts`) over the
//! assistant tables in `state/tasks.db`. `assistant.ask` and `assistant.cancel`
//! stay in TypeScript: they drive the assistant plugin and the in-process turn
//! stream. Inputs only TypeScript reproduces stay forwarded: work grants, Orca
//! worktree callers, stored settings that fail the Zod schemas, strategies the
//! Rust loader cannot read, and a configured `assistant.status` whose admission
//! needs the cached usage status.
#![allow(clippy::result_large_err)]
use chrono::{Duration, LocalResult, TimeZone};
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_messaging_ops::msg_ops::{current_dir, orca_worktree, own_worktree};
use pacer_read_model::js::{stringify, truth};
use pacer_store::{
    StoreError, TaskStore,
    assistant::{self, CardUpdate, Connection, Settings, SettingsWrite},
};
use serde_json::{Map, Value, json};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const EXECUTOR: &str =
    "PACER_ROLE=executor: executors cannot use the assistant or read its history.";
const NOT_SET_UP: (&str, &str) = (
    "The assistant is not set up.",
    "Choose an account in Settings › Assistant.",
);
/// `READS_SUMMARY`.
const READS: [&str; 4] = [
    "Counts, attention items, the pacing mode and whether delegation is paused.",
    "Titles, states, executors and times of tasks, with their decisions, attempts and review state.",
    "Cached usage, pace and reset times for your accounts. It never refreshes a reading.",
    "Reviewed outcomes with sample sizes, recent activity entries, and strategy names and summaries.",
];
fn env<'a>(ctx: &'a Ctx, name: &str) -> Option<&'a str> {
    ctx.env
        .get(name)
        .map(String::as_str)
        .filter(|v| !v.is_empty())
}

fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

/// `authorizeWorkOperation` and `isExecutorSession`, ahead of the params.
fn refuse(ctx: &Ctx) -> Result<(), CoreError> {
    if env(ctx, "PACER_ENFORCEMENT_TOKEN").is_some() {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    if env(ctx, "PACER_WORK_GRANT").is_some() {
        return Err(unavailable("work grants require the TypeScript core"));
    }
    let cwd = current_dir();
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor")
        || cwd.as_deref().is_some_and(|cwd| own_worktree(ctx, cwd))
    {
        return Err(CoreError::new(Code::NotAllowed, EXECUTOR));
    }
    if cwd.as_deref().is_some_and(orca_worktree) {
        return Err(unavailable(
            "Orca worktree callers require the TypeScript core",
        ));
    }
    Ok(())
}

pub fn assistant_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if !op.starts_with("assistant.") || matches!(op, "assistant.ask" | "assistant.cancel") {
        return false;
    }
    match refuse(ctx) {
        Ok(()) => {}
        Err(error) => return error.code == Code::Unavailable,
    }
    // Param issues come first in TypeScript too, before any store or strategy read.
    if parse(op, params.clone()).is_err() {
        return false;
    }
    let usable = || with_db(ctx, |db| Ok(assistant::read_settings(db)?.is_some())) == Ok(true);
    match op {
        "assistant.settings.get" | "assistant.conversations" => !usable(),
        "assistant.settings.set" => {
            let account = params
                .get("account")
                .and_then(Value::as_str)
                .is_some_and(|a| !a.is_empty());
            !usable() || (account && strategy(ctx).is_none())
        }
        "assistant.candidates" => strategy(ctx).is_none(),
        "assistant.status" => !matches!(status(ctx), Ok(Some(_))),
        "assistant.card.refresh" => {
            refresh_task(ctx, params).is_ok_and(|task| task.is_some_and(|t| !titled(&t)))
        }
        _ => false,
    }
}

/// `taskTitle` (run by the card lookup) throws unless the record has a title or a goal.
fn titled(task: &Value) -> bool {
    match task.get("title") {
        Some(Value::String(title)) if !pacer_read_model::js::trim(title).is_empty() => true,
        None | Some(Value::Null | Value::String(_)) => task["brief"]["goal"].is_string(),
        Some(_) => false,
    }
}

/// The task an action card's `params.id` names, as `refreshCard` reads it.
fn refresh_task(ctx: &Ctx, params: &Value) -> Result<Option<Value>, CoreError> {
    let (Some(turn_id), Some(card_id)) = (
        params.get("turnId").and_then(Value::as_str),
        params.get("cardId").and_then(Value::as_str),
    ) else {
        return Ok(None);
    };
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(store_error)?;
    let db = assistant::database(&mut store).map_err(store_error)?;
    let id = assistant::turn(db, turn_id)
        .map_err(store_error)?
        .and_then(|turn| {
            let cards = turn["cards"].as_array()?;
            let card = cards.iter().find(|c| c["id"] == card_id)?;
            card["params"]["id"].as_str().map(str::to_owned)
        });
    match id {
        Some(id) => store.read(&id).map_err(store_error),
        None => Ok(None),
    }
}

fn store_error(error: StoreError) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

fn with_db<T>(
    ctx: &Ctx,
    read: impl FnOnce(&Connection) -> Result<T, StoreError>,
) -> Result<T, CoreError> {
    let mut store = TaskStore::open(&ctx.pacer_home).map_err(store_error)?;
    read(assistant::database(&mut store).map_err(store_error)?).map_err(store_error)
}

fn settings(db: &Connection) -> Result<Settings, CoreError> {
    assistant::read_settings(db)
        .map_err(store_error)?
        .ok_or_else(|| unavailable("stored assistant settings require the TypeScript schema"))
}

fn array_index(key: &str) -> bool {
    key.parse::<u32>()
        .is_ok_and(|n| n < u32::MAX && n.to_string() == key)
}

/// `loadStrategy`, when the Rust loader reads it with TypeScript key order.
fn strategy(ctx: &Ctx) -> Option<Value> {
    let strategy = load_strategy(&ctx.pacer_home).ok()?;
    let ordered = ["accounts", "runners"].iter().all(|key| {
        strategy
            .get(*key)
            .and_then(Value::as_object)
            .is_none_or(|map| !map.keys().any(|k| array_index(k)))
    });
    ordered.then_some(strategy)
}

fn nullish(value: Option<&Value>) -> bool {
    value.is_none_or(Value::is_null)
}

/// `endpointFor(...) !== null`.
fn endpoint_ok(strategy: &Value, account: &str, runner: Option<&str>) -> bool {
    let Some(entry) = strategy["accounts"].get(account) else {
        return false;
    };
    if entry.get("kind").and_then(Value::as_str) != Some("endpoint")
        || !entry.get("connection").is_some_and(truth)
    {
        return false;
    }
    let runner = runner
        .filter(|r| !r.is_empty())
        .and_then(|r| strategy["runners"].get(r));
    let model = [
        runner.and_then(|r| r.get("model")),
        entry.get("model"),
        entry["connection"]["models"]
            .get(0)
            .and_then(|m| m.get("id")),
    ]
    .into_iter()
    .find(|v| !nullish(*v))
    .flatten();
    model.is_some_and(truth)
}

/// Inserts like a JavaScript object literal: an `undefined` value is dropped.
fn put(out: &mut Map<String, Value>, key: &str, value: Option<&Value>) {
    if let Some(value) = value {
        out.insert(key.into(), value.clone());
    }
}

/// `candidates`: endpoint accounts with their models and runners.
fn candidates(strategy: &Value) -> Vec<Value> {
    let empty = Map::new();
    let accounts = strategy["accounts"].as_object().unwrap_or(&empty);
    let runners = strategy["runners"].as_object().unwrap_or(&empty);
    accounts
        .iter()
        .filter(|(_, a)| {
            a.get("kind").and_then(Value::as_str) == Some("endpoint")
                && a.get("connection").is_some_and(truth)
        })
        .map(|(name, a)| {
            let models: Vec<Value> = a["connection"]["models"]
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(|m| {
                    let mut out = Map::new();
                    put(&mut out, "id", m.get("id"));
                    let name = m.get("name").filter(|n| !n.is_null()).or(m.get("id"));
                    put(&mut out, "name", name);
                    Value::Object(out)
                })
                .collect();
            let runners: Vec<Value> = runners
                .values()
                .filter(|r| r.get("account").and_then(Value::as_str) == Some(name))
                .map(|r| {
                    let mut out = Map::new();
                    put(&mut out, "id", r.get("id"));
                    put(&mut out, "model", r.get("model"));
                    Value::Object(out)
                })
                .collect();
            let planner = strategy.pointer("/planner/account").and_then(Value::as_str);
            json!({"account":name,"models":models,"runners":runners,"isPlanner":planner == Some(name)})
        })
        .collect()
}

/// The process time zone: `TZ`, else the `/etc/localtime` zone name.
fn local_zone(ctx: &Ctx) -> Option<chrono_tz::Tz> {
    if let Some(name) = ctx.env.get("TZ") {
        return name.parse().ok();
    }
    if let Ok(name) = std::env::var("TZ") {
        return name.parse().ok();
    }
    let target = std::fs::read_link("/etc/localtime").ok()?;
    let target = target.to_str()?;
    let at = target.find("zoneinfo/")?;
    target[at + "zoneinfo/".len()..].parse().ok()
}

/// `new Date(now * 1000).setHours(0, 0, 0, 0) / 1000`.
fn local_midnight(now: f64, zone: chrono_tz::Tz) -> Option<f64> {
    let date = zone
        .timestamp_millis_opt((now * 1000.0).floor() as i64)
        .single()?
        .date_naive();
    let mut local = date.and_hms_opt(0, 0, 0)?;
    for _ in 0..24 * 60 {
        match zone.from_local_datetime(&local) {
            LocalResult::Single(at) | LocalResult::Ambiguous(at, _) => {
                return Some(at.timestamp() as f64);
            }
            LocalResult::None => local += Duration::minutes(1),
        }
    }
    None
}

/// `assistantStatus` where admission needs no cached usage status; `None` otherwise.
fn status(ctx: &Ctx) -> Result<Option<Value>, CoreError> {
    let Some(zone) = local_zone(ctx) else {
        return Ok(None);
    };
    let Some(midnight) = local_midnight(ctx.now, zone) else {
        return Ok(None);
    };
    let read = with_db(ctx, |db| {
        let Some(settings) = assistant::read_settings(db)? else {
            return Ok(None);
        };
        Ok(Some((settings, assistant::usage_since(db, midnight)?)))
    })?;
    let Some((settings, today)) = read else {
        return Ok(None);
    };
    let account = settings.account.as_deref().filter(|a| !a.is_empty());
    let turns_per_day = settings.limit("turnsPerDay");
    let refusal = match account {
        None => (NOT_SET_UP.0.to_owned(), NOT_SET_UP.1),
        Some(account) => {
            let Some(strategy) = strategy(ctx) else {
                return Ok(None);
            };
            if !endpoint_ok(&strategy, account, settings.runner.as_deref()) {
                (
                    "The account chosen for the assistant is no longer available.".to_owned(),
                    "Choose another account in Settings › Assistant.",
                )
            } else if today[0].as_f64().unwrap_or(0.0) >= turns_per_day as f64 {
                (
                    format!("The assistant reached its limit of {turns_per_day} turns today."),
                    "The limit resets at midnight, or raise it in Settings.",
                )
            } else {
                return Ok(None);
            }
        }
    };
    let mut out = Map::new();
    out.insert("available".into(), json!(false));
    out.insert("configured".into(), json!(account.is_some()));
    put(
        &mut out,
        "account",
        settings.account.as_ref().map(|a| json!(a)).as_ref(),
    );
    put(
        &mut out,
        "runner",
        settings.runner.as_ref().map(|r| json!(r)).as_ref(),
    );
    out.insert("reason".into(), json!(refusal.0));
    out.insert("hint".into(), json!(refusal.1));
    out.insert("limits".into(), settings.limits_json());
    out.insert("retention".into(), settings.retention_json());
    out.insert("rev".into(), json!(settings.rev));
    let [turns, input, output] = today;
    out.insert(
        "today".into(),
        json!({"turns":turns,"input":input,"output":output}),
    );
    Ok(Some(Value::Object(out)))
}

mod params;
use params::{Params, parse};

fn not_found(message: &str) -> CoreError {
    CoreError::new(Code::NotFound, message)
}

pub fn assistant_status(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        parse("assistant.status", params)?;
        status(ctx)?.ok_or_else(|| unavailable("assistant admission requires the cached status"))
    })
}

pub fn assistant_settings_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        parse("assistant.settings.get", params)?;
        let settings = with_db(ctx, |db| Ok(settings(db)))??;
        Ok(settings.to_json())
    })
}

pub fn assistant_settings_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        let Params::Settings(p) = parse("assistant.settings.set", params)? else {
            unreachable!("settings params")
        };
        if let Some(account) = p.account.as_deref() {
            let strategy = strategy(ctx)
                .ok_or_else(|| unavailable("the strategy requires the TypeScript loader"))?;
            with_db(ctx, |db| Ok(settings(db)))??;
            if !endpoint_ok(&strategy, account, p.runner.as_deref()) {
                return Err(CoreError::new(
                    Code::InvalidInput,
                    "Choose an endpoint account with a model.",
                )
                .hint("Add one in Settings › Accounts."));
            }
        }
        let write = with_db(ctx, |db| {
            assistant::write_settings(db, p.runner, p.account, p.limits, p.retention, p.expect_rev)
        })?;
        match write {
            SettingsWrite::Saved(settings) => Ok(settings.to_json()),
            SettingsWrite::Conflict(rev) => {
                let mut data = Map::new();
                data.insert("rev".into(), json!(rev));
                Err(CoreError::new(
                    Code::Conflict,
                    "Assistant settings changed since you loaded them.",
                )
                .hint("Reload the settings and try again.")
                .data(data))
            }
            SettingsWrite::Unusable => Err(unavailable(
                "stored assistant settings require the TypeScript schema",
            )),
        }
    })
}

pub fn assistant_candidates(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        parse("assistant.candidates", params)?;
        let strategy = strategy(ctx)
            .ok_or_else(|| unavailable("the strategy requires the TypeScript loader"))?;
        Ok(json!({"accounts":candidates(&strategy),"reads":READS}))
    })
}

pub fn assistant_conversations(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        let Params::Page { before, limit } = parse("assistant.conversations", params)? else {
            unreachable!("page params")
        };
        let now = (ctx.now * 1000.0).floor() / 1000.0;
        let page = with_db(ctx, |db| {
            let Some(settings) = assistant::read_settings(db)? else {
                return Ok(None);
            };
            let deleted = assistant::enforce_retention(
                db,
                now,
                settings.retention("days"),
                settings.retention("conversations"),
            )?;
            if deleted > 0 {
                assistant::checkpoint(db);
            }
            assistant::conversations(db, before.unwrap_or(MAX_SAFE), limit.unwrap_or(30).min(100))
                .map(Some)
        })?
        .ok_or_else(|| unavailable("stored assistant settings require the TypeScript schema"))?;
        Ok(json!({"conversations":page}))
    })
}

pub fn assistant_conversation(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        let Params::Id(id) = parse("assistant.conversation", params)? else {
            unreachable!("id params")
        };
        let id = id.unwrap_or_default();
        let turns = with_db(ctx, |db| assistant::conversation_turns(db, &id))?
            .ok_or_else(|| not_found("Unknown conversation."))?;
        Ok(json!({"id":id,"turns":turns}))
    })
}

pub fn assistant_turn(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        let Params::Id(id) = parse("assistant.turn", params)? else {
            unreachable!("id params")
        };
        with_db(ctx, |db| assistant::turn(db, &id.unwrap_or_default()))?
            .ok_or_else(|| not_found("Unknown turn."))
    })
}

pub fn assistant_delete(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        let Params::Id(id) = parse("assistant.delete", params)? else {
            unreachable!("id params")
        };
        let deleted = with_db(ctx, |db| {
            let deleted = assistant::delete_conversations(db, id.as_deref())?;
            if deleted.is_some() {
                assistant::checkpoint(db);
            }
            Ok(deleted)
        })?
        .ok_or_else(|| not_found("Unknown conversation."))?;
        Ok(json!({"deleted":deleted}))
    })
}

fn card_result(update: CardUpdate) -> Result<Value, CoreError> {
    match update {
        CardUpdate::Updated(card) => Ok(card),
        CardUpdate::UnknownTurn => Err(not_found("Unknown turn.")),
        CardUpdate::UnknownCard => Err(not_found("Unknown action card.")),
    }
}

pub fn assistant_card_record(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        let Params::Card {
            turn_id,
            card_id,
            state,
            result,
        } = parse("assistant.card.record", params)?
        else {
            unreachable!("card params")
        };
        let update = with_db(ctx, |db| {
            assistant::update_card(
                db,
                &turn_id,
                &card_id,
                |card| {
                    card.insert("state".into(), json!(state));
                    if let Some(result) = result {
                        card.insert("result".into(), json!(result));
                    }
                },
                stringify,
            )
        })?;
        card_result(update)
    })
}

pub fn assistant_card_refresh(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse(ctx)?;
        let Params::Card {
            turn_id, card_id, ..
        } = parse("assistant.card.refresh", params)?
        else {
            unreachable!("card params")
        };
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(store_error)?;
        let db = assistant::database(&mut store).map_err(store_error)?;
        let card = assistant::turn(db, &turn_id)
            .map_err(store_error)?
            .and_then(|turn| {
                turn["cards"]
                    .as_array()?
                    .iter()
                    .find(|c| c["id"] == card_id.as_str())
                    .cloned()
            })
            .ok_or_else(|| not_found("Unknown action card."))?;
        let task = match card["params"]["id"].as_str() {
            Some(id) => store.read(id).map_err(store_error)?,
            None => None,
        };
        let task = task.ok_or_else(|| not_found("That task no longer exists."))?;
        if !titled(&task) {
            return Err(unavailable(
                "the task record requires the TypeScript title reader",
            ));
        }
        let rev = task["rev"].clone();
        let mut next = card["params"].as_object().cloned().unwrap_or_default();
        next.insert("expect_rev".into(), rev);
        let db = assistant::database(&mut store).map_err(store_error)?;
        let update = assistant::update_card(
            db,
            &turn_id,
            &card_id,
            |card| {
                card.insert("state".into(), json!("pending"));
                card.shift_remove("result");
                card.insert("params".into(), Value::Object(next));
            },
            stringify,
        )
        .map_err(store_error)?;
        card_result(update)
    })
}

#[cfg(test)]
mod tests;
