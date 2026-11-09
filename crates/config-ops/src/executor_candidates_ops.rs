//! Native `executor.setup.candidates` (`detectCandidates` in
//! `src/endpoints/detect.ts`). Rust reads OpenCode sign-ins (`opencode auth
//! list`), the OpenCode config providers and the cached catalog, and assembles
//! the candidates. The endpoint plugin probes the fixed local model servers
//! through Core. A stale, missing or malformed catalog (models.dev fetch) and a
//! strategy Rust cannot read forward.
#![allow(clippy::result_large_err)]
use crate::executor_setup_ops::{
    CATALOG_MAX_AGE_S, catalog_model, classify, enforcement, params_map,
};
use crate::setup_effects::{SetupEffects, run, unavailable, which};
use pacer_config::strategy::load_strategy;
use pacer_foundation::{Ctx, api::CoreError};
use serde_json::{Map, Value, json};
use std::time::Duration;

const LOCAL_SERVERS: &[(&str, &str, &str)] = &[
    ("ollama", "Ollama", "http://127.0.0.1:11434/v1"),
    ("lmstudio", "LM Studio", "http://127.0.0.1:1234/v1"),
];

fn catalog_provider(provider: &Value) -> bool {
    provider["id"].is_string()
        && provider["name"].is_string()
        && provider["models"]
            .as_array()
            .is_some_and(|models| models.iter().all(catalog_model))
}

/// The cached catalog providers while the cache is fresh and well formed.
fn fresh_catalog(ctx: &Ctx) -> Option<Map<String, Value>> {
    let cache: Value =
        pacer_foundation::fsutil::read_json(&ctx.pacer_home.join("cache").join("models.json"))?;
    let fetched = cache["fetchedAt"].as_f64()?;
    let providers = cache["providers"].as_object()?;
    (ctx.now - fetched < CATALOG_MAX_AGE_S && providers.values().all(catalog_provider))
        .then(|| providers.clone())
}

pub(crate) fn stays_forwarded(ctx: &Ctx) -> bool {
    fresh_catalog(ctx).is_none() || load_strategy(&ctx.pacer_home).is_err()
}

fn models(catalog: &Map<String, Value>, id: &str) -> Vec<Value> {
    catalog
        .get(id)
        .and_then(|p| p["models"].as_array())
        .cloned()
        .unwrap_or_default()
}

/// Provider ids and names only; connection ids and methods are ignored.
async fn signed_in(ctx: &Ctx) -> Option<Vec<(String, String)>> {
    let argv = ["opencode", "auth", "list", "--format", "json"];
    let (code, stdout) = run(ctx, &argv, Duration::from_secs(15)).await?;
    if code != 0 {
        return None;
    }
    let list: Value = serde_json::from_str(&stdout).ok()?;
    Some(
        list.as_array()?
            .iter()
            .filter_map(|p| {
                let id = p.get("id")?.as_str()?;
                Some((id.into(), p["name"].as_str().unwrap_or(id).into()))
            })
            .collect(),
    )
}

/// Provider keys and display names only; options (which may hold keys) are never read.
fn config_providers(ctx: &Ctx) -> Vec<(String, String)> {
    let dir = ctx
        .env
        .get("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map_or_else(|| ctx.home.join(".config"), Into::into)
        .join("opencode");
    let jsonc = dir.join("opencode.jsonc");
    let path = if jsonc.exists() {
        jsonc
    } else {
        dir.join("opencode.json")
    };
    let Some(config) = std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
    else {
        return vec![];
    };
    config["provider"]
        .as_object()
        .map(|providers| {
            providers
                .iter()
                .map(|(id, p)| (id.clone(), p["name"].as_str().unwrap_or(id).into()))
                .collect()
        })
        .unwrap_or_default()
}

/// The OpenCode runner using an account, as `addedBy` in detect.ts.
fn account_runner<'a>(runners: &'a Value, account: &Value) -> Option<&'a Value> {
    runners
        .as_object()?
        .values()
        .find(|r| r["agent"] == "opencode" && r["account"] == *account)
}

/// `added` and `model` for a candidate. An account counts only while an
/// OpenCode executor still uses it, so a left-behind account does not lock its
/// provider out of setup; `model` drops the provider prefix.
fn added_by(
    accounts: &Value,
    runners: &Value,
    provider: &str,
    base_url: Option<&str>,
) -> Map<String, Value> {
    let account = accounts
        .as_object()
        .into_iter()
        .flat_map(|all| all.values())
        .find(|a| {
            ((a["source"] == "opencode" && a["provider"] == provider)
                || base_url.is_some_and(|url| a["connection"]["base_url"] == url))
                && account_runner(runners, &a["name"]).is_some()
        });
    let mut out = Map::new();
    let Some(account) = account else {
        out.insert("added".into(), Value::Null);
        return out;
    };
    out.insert("added".into(), account["name"].clone());
    let model = account_runner(runners, &account["name"]).and_then(|r| r["model"].as_str());
    let prefix = format!("{provider}/");
    out.insert(
        "model".into(),
        model.map_or(Value::Null, |m| m.strip_prefix(&prefix).unwrap_or(m).into()),
    );
    out
}

/// A candidate object in detect.ts key order: `added`/`model` before `usage`.
fn candidate(fields: Value, added: Map<String, Value>, usage: Value) -> Value {
    let mut out = fields.as_object().cloned().unwrap_or_default();
    out.extend(added);
    out.insert("usage".into(), usage);
    Value::Object(out)
}

/// Probe results in `LOCAL_SERVERS` order: `Ok(model count)` when listed.
async fn probe_local(
    effects: &mut dyn SetupEffects,
) -> Result<Vec<Result<Option<usize>, String>>, CoreError> {
    let urls: Vec<&str> = LOCAL_SERVERS.iter().map(|(_, _, url)| *url).collect();
    let reply = effects
        .call(json!({"kind": "discover", "baseUrls": urls}))
        .await?;
    let results = reply["results"]
        .as_array()
        .filter(|r| r.len() == LOCAL_SERVERS.len())
        .ok_or_else(|| unavailable("invalid setup effects response"))?;
    Ok(results
        .iter()
        .map(|r| match r["failure"].as_str() {
            Some(failure) => Err(failure.to_owned()),
            None => Ok((r["listed"] == true).then(|| r["models"].as_array().map_or(0, Vec::len))),
        })
        .collect())
}

pub(crate) async fn candidates(
    ctx: &Ctx,
    params: Value,
    effects: &mut dyn SetupEffects,
) -> Result<Value, CoreError> {
    enforcement(ctx)?;
    params_map(&params)?;
    let catalog = fresh_catalog(ctx).ok_or_else(|| {
        unavailable("executor.setup.candidates: a stale catalog needs the forwarded operation")
    })?;
    let strategy = load_strategy(&ctx.pacer_home).map_err(|_| {
        unavailable("executor.setup.candidates: the strategy needs the forwarded operation")
    })?;
    let accounts = &strategy["accounts"];
    let runners = &strategy["runners"];
    let opencode = which(ctx, "opencode").is_some();
    let mut notes = Vec::new();
    if !opencode {
        notes.push(
            "Install OpenCode to use providers you have signed in to or connect new ones."
                .to_owned(),
        );
    }
    let (probes, signed) = if opencode {
        let (probes, signed) = tokio::join!(probe_local(effects), signed_in(ctx));
        (probes?, signed)
    } else {
        (probe_local(effects).await?, Some(vec![]))
    };
    if signed.is_none() {
        notes.push("Could not read OpenCode sign-ins; showing other options.".into());
    }
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if opencode {
        for (id, name) in signed
            .unwrap_or_default()
            .into_iter()
            .chain(config_providers(ctx))
        {
            if !seen.insert(id.clone()) {
                continue;
            }
            let added = added_by(accounts, runners, &id, None);
            candidates.push(candidate(
                json!({"group":"signed_in","provider":id,"name":name}),
                added,
                classify(&id, &models(&catalog, &id)),
            ));
        }
    }
    let mut failures: Vec<String> = Vec::new();
    for probe in &probes {
        if let Err(failure) = probe
            && !failures.contains(failure)
        {
            failures.push(failure.clone());
        }
    }
    notes.extend(
        failures
            .into_iter()
            .map(|f| format!("Could not check local model servers: {f}")),
    );
    for ((provider, name, url), probe) in LOCAL_SERVERS.iter().zip(&probes) {
        if let Ok(Some(count)) = probe {
            let added = added_by(accounts, runners, provider, Some(url));
            candidates.push(candidate(json!({"group":"local","provider":provider,"name":name,"base_url":url,"models":count}), added, json!({"usage":"unmetered","known":true})));
        }
    }
    if opencode {
        for p in catalog.values() {
            let id = p["id"].as_str().unwrap_or_default();
            let models = p["models"].as_array().cloned().unwrap_or_default();
            if seen.contains(id) || id == "ollama" || id == "lmstudio" || models.is_empty() {
                continue;
            }
            let added = added_by(accounts, runners, id, None);
            candidates.push(candidate(
                json!({"group":"catalog","provider":id,"name":p["name"]}),
                added,
                classify(id, &models),
            ));
        }
    }
    Ok(json!({"candidates":candidates,"opencode":opencode,"catalog":"fresh","notes":notes}))
}

#[cfg(test)]
mod added_tests {
    use super::*;

    #[test]
    fn an_account_counts_as_added_only_while_an_opencode_runner_uses_it() {
        let accounts =
            json!({"go": {"name": "go", "source": "opencode", "provider": "opencode-go"}});
        let orphan = added_by(&accounts, &json!({}), "opencode-go", None);
        assert_eq!(Value::Object(orphan), json!({"added": null}));
        let runners = json!({"opencode#go": {"agent": "opencode", "account": "go", "model": "opencode-go/kimi-k3"}});
        let live = added_by(&accounts, &runners, "opencode-go", None);
        assert_eq!(
            Value::Object(live),
            json!({"added": "go", "model": "kimi-k3"})
        );
    }
}
