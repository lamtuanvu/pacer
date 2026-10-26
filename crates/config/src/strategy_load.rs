//! Conservative normalized read model for basic current-account strategies.
//!
//! This module is not selected by a public operation. Unsupported shapes and
//! errors remain with TypeScript until validation and message parity is complete.

use serde_json::{Map as JsonMap, Value as Json, json};
use serde_yaml::{Mapping, Value as Yaml};

const MAX_BYTES: usize = 256 * 1024;

fn map(value: &Yaml) -> Option<&Mapping> {
    value.as_mapping()
}

fn get<'a>(value: &'a Mapping, key: &str) -> Option<&'a Yaml> {
    value.get(Yaml::String(key.to_owned()))
}

fn only(value: &Mapping, allowed: &[&str]) -> bool {
    value
        .keys()
        .all(|key| key.as_str().is_some_and(|key| allowed.contains(&key)))
}

fn refs(value: &Yaml) -> Option<Vec<String>> {
    value
        .as_sequence()?
        .iter()
        .map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn account_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes.next().is_some_and(|first| first.is_ascii_lowercase())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// Normalize the narrow current-account subset covered by the TypeScript oracle.
/// `None` means the core still owns validation and any public response.
#[must_use]
pub fn normalize_basic(text: &str, name: &str) -> Option<Json> {
    if text.len() > MAX_BYTES || text.contains(['&', '*', '!']) || text.contains("<<") {
        return None;
    }
    let yaml: Yaml = serde_yaml::from_str(text).ok()?;
    let root = map(&yaml)?;
    if !only(root, &["planner", "accounts", "pacing", "routing"]) {
        return None;
    }
    let planner = get(root, "planner")?.as_str()?;
    if !["codex", "claude-code"].contains(&planner) {
        return None;
    }
    let accounts = map(get(root, "accounts")?)?;
    if accounts.is_empty() {
        return None;
    }
    let mut account_rows = JsonMap::new();
    let mut runner_rows = JsonMap::new();
    let mut aliases = JsonMap::new();
    let mut provider_rows = JsonMap::new();
    let mut default_order = Vec::new();
    let mut planner_account = None;
    for (raw_name, raw_config) in accounts {
        let account = raw_name.as_str()?;
        if !account_name(account) {
            return None;
        }
        let config = map(raw_config)?;
        if !only(config, &["kind"]) {
            return None;
        }
        let kind = get(config, "kind")?.as_str()?;
        let agent = match kind {
            "claude" => "claude-code",
            "codex" => "codex",
            _ => return None,
        };
        if runner_rows.contains_key(agent) {
            return None;
        }
        if agent == planner {
            planner_account = Some(account.to_owned());
        }
        account_rows.insert(account.to_owned(), json!({
            "name":account,"model":null,"kind":kind,"source":"default","home":null,
            "orcaAccount":null,"usage":"quota","usageSource":"native","quotaSource":null,
            "provider":null,"weeklyUsd":null,"weeklyTokens":null,"cooldownS":21600,"allowPaid":false
        }));
        runner_rows.insert(
            agent.to_owned(),
            json!({
                "id":agent,"name":agent,"host":null,"agent":agent,"account":account,"model":null
            }),
        );
        aliases.insert(agent.to_owned(), Json::String(agent.to_owned()));
        provider_rows.insert(
            agent.to_owned(),
            json!({
                "id":agent,"via":null,"model":null,"usage":"quota","allowPaid":false,
                "cooldownS":21600,"quotaSource":null,"weeklyTokens":null,"weeklyUsd":null
            }),
        );
        default_order.push(agent.to_owned());
    }
    let planner_account = planner_account?;

    let mut policy = "priority";
    let mut order = default_order.clone();
    let mut planner_reserve = 15;
    let mut fill_threshold = 90;
    if let Some(raw) = get(root, "pacing") {
        let pacing = map(raw)?;
        if !only(
            pacing,
            &["policy", "order", "planner_reserve", "fill_threshold"],
        ) {
            return None;
        }
        if let Some(value) = get(pacing, "policy") {
            policy = value.as_str()?;
            if !["priority", "even", "burn-before-reset", "cheapest-first"].contains(&policy) {
                return None;
            }
        }
        if let Some(value) = get(pacing, "order") {
            order = refs(value)?;
            if order.iter().any(|runner| !runner_rows.contains_key(runner)) {
                return None;
            }
        }
        if let Some(value) = get(pacing, "planner_reserve") {
            planner_reserve = value.as_i64()?;
            if !(0..100).contains(&planner_reserve) {
                return None;
            }
        }
        if let Some(value) = get(pacing, "fill_threshold") {
            fill_threshold = value.as_i64()?;
            if !(50..=100).contains(&fill_threshold) {
                return None;
            }
        }
    }

    let routing = get(root, "routing")?.as_sequence()?;
    if routing.len() != 1 {
        return None;
    }
    let rule = map(&routing[0])?;
    if !only(rule, &["default"]) {
        return None;
    }
    let executors = refs(get(rule, "default")?)?;
    if executors.is_empty()
        || executors
            .iter()
            .any(|runner| !runner_rows.contains_key(runner))
    {
        return None;
    }
    Some(json!({
        "name":name,"planner":{"agent":planner,"account":planner_account},
        "accounts":account_rows,"hosts":{},"runners":runner_rows,"legacy":false,
        "runnerAliases":aliases,"providers":provider_rows,
        "pacing":{"policy":policy,"order":order,"plannerReserve":planner_reserve,
            "aheadThreshold":10,"behindThreshold":-10,"accounts":"spread","fillThreshold":fill_threshold},
        "routing":[{"kinds":null,"executors":executors}],"taskRetentionDays":14,
        "plugins":{"disabled":[],"installed":{},"config":{}},"execution":{},"classifier":{}
    }))
}
