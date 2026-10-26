//! Conservative normalized read model for basic current and legacy strategies.
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

fn simple_hosts(root: &Mapping) -> Option<JsonMap<String, Json>> {
    let Some(raw) = get(root, "hosts") else {
        return Some(JsonMap::new());
    };
    let mut hosts = JsonMap::new();
    for (alias, value) in map(raw)? {
        let alias = alias.as_str()?;
        if alias == "local" || !account_name(alias) {
            return None;
        }
        let config = map(value)?;
        if !only(config, &["ssh"]) {
            return None;
        }
        let ssh = get(config, "ssh")?.as_str()?;
        if ssh.is_empty()
            || !ssh.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'@')
            })
        {
            return None;
        }
        hosts.insert(
            alias.to_owned(),
            json!({
                "alias":alias,"ssh":ssh,"repos":{},"maxTasks":2,"accounts":{},"paused":false
            }),
        );
    }
    Some(hosts)
}

/// Normalize the narrow account/provider subset covered by the TypeScript oracle.
/// `None` means the core still owns validation and any public response.
#[must_use]
pub fn normalize_basic(text: &str, name: &str) -> Option<Json> {
    if text.len() > MAX_BYTES || text.contains(['&', '*', '!']) || text.contains("<<") {
        return None;
    }
    let yaml: Yaml = serde_yaml::from_str(text).ok()?;
    let root = map(&yaml)?;
    if !only(
        root,
        &[
            "planner",
            "accounts",
            "providers",
            "pacing",
            "routing",
            "hosts",
        ],
    ) {
        return None;
    }
    let hosts = simple_hosts(root)?;
    let planner = get(root, "planner")?.as_str()?;
    let legacy = get(root, "providers").is_some();
    if !["codex", "claude-code", "opencode"].contains(&planner)
        || (legacy && get(root, "accounts").is_some())
    {
        return None;
    }
    let mut account_rows = JsonMap::new();
    let mut runner_rows = JsonMap::new();
    let mut aliases = JsonMap::new();
    let mut provider_rows = JsonMap::new();
    let mut default_order = Vec::new();
    let mut planner_account = None;
    if legacy {
        let providers = map(get(root, "providers")?)?;
        if providers.is_empty() {
            return None;
        }
        let mut has_opencode = false;
        for (raw_name, raw_config) in providers {
            let account = raw_name.as_str()?;
            if !account_name(account) {
                return None;
            }
            let config = map(raw_config)?;
            let (agent, kind, source, usage, usage_source, model, via, id) = match account {
                "codex" | "cursor" => {
                    if !only(config, &["usage"]) {
                        return None;
                    }
                    let usage = get(config, "usage")?.as_str()?;
                    if usage
                        != if account == "cursor" {
                            "reactive"
                        } else {
                            "quota"
                        }
                    {
                        return None;
                    }
                    (
                        account,
                        account,
                        "default",
                        usage,
                        if account == "cursor" {
                            "reactive"
                        } else {
                            "native"
                        },
                        None,
                        None,
                        account.to_owned(),
                    )
                }
                "local" => {
                    if !only(config, &["via", "model", "usage"])
                        || get(config, "via")?.as_str()? != "opencode"
                        || get(config, "usage")?.as_str()? != "unmetered"
                    {
                        return None;
                    }
                    let model = get(config, "model")?.as_str()?;
                    if !model.contains('/') {
                        return None;
                    }
                    has_opencode = true;
                    (
                        "opencode",
                        "endpoint",
                        "endpoint",
                        "unmetered",
                        "unmetered",
                        Some(model),
                        Some("opencode"),
                        "opencode#local".to_owned(),
                    )
                }
                _ => return None,
            };
            if agent == planner {
                planner_account = Some(if planner == "opencode" {
                    "opencode".to_owned()
                } else {
                    account.to_owned()
                });
            }
            account_rows.insert(account.to_owned(), json!({
                "name":account,"model":model,"kind":kind,"source":source,"home":null,
                "orcaAccount":null,"usage":usage,"usageSource":usage_source,"quotaSource":null,
                "provider":null,"weeklyUsd":null,"weeklyTokens":null,"cooldownS":21600,"allowPaid":false
            }));
            runner_rows.insert(
                id.clone(),
                json!({
                    "id":id,"name":id,"host":null,"agent":agent,"account":account,"model":model
                }),
            );
            aliases.insert(account.to_owned(), Json::String(id.clone()));
            provider_rows.insert(
                id.clone(),
                json!({
                    "id":id,"via":via,"model":model,"usage":usage,"allowPaid":false,
                    "cooldownS":21600,"quotaSource":null,"weeklyTokens":null,"weeklyUsd":null
                }),
            );
        }
        for preferred in ["codex", "cursor"] {
            if runner_rows.contains_key(preferred) {
                default_order.push(preferred.to_owned());
            }
        }
        if has_opencode {
            default_order.push("opencode".to_owned());
        }
    } else {
        let accounts = map(get(root, "accounts")?)?;
        if accounts.is_empty() || planner == "opencode" {
            return None;
        }
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

    let executors = if let Some(routing) = get(root, "routing") {
        let routing = routing.as_sequence()?;
        if routing.len() != 1 {
            return None;
        }
        let rule = map(&routing[0])?;
        if !only(rule, &["default"]) {
            return None;
        }
        refs(get(rule, "default")?)?
    } else if legacy {
        provider_rows.keys().cloned().collect()
    } else {
        return None;
    };
    if executors.is_empty()
        || executors
            .iter()
            .any(|runner| !runner_rows.contains_key(runner))
    {
        return None;
    }
    Some(json!({
        "name":name,"planner":{"agent":planner,"account":planner_account},
        "accounts":account_rows,"hosts":hosts,"runners":runner_rows,"legacy":legacy,
        "runnerAliases":aliases,"providers":provider_rows,
        "pacing":{"policy":policy,"order":order,"plannerReserve":planner_reserve,
            "aheadThreshold":10,"behindThreshold":-10,"accounts":"spread","fillThreshold":fill_threshold},
        "routing":[{"kinds":null,"executors":executors}],"taskRetentionDays":14,
        "plugins":{"disabled":[],"installed":{},"config":{}},"execution":{},"classifier":{}
    }))
}
