//! Strict fixture-proven runner shape; unsupported strategies remain core-owned.
use crate::strategy_list::{active_name, read_regular};
use pacer_foundation::Ctx;
use rustix::fs::{CWD, Mode, OFlags, openat};
use serde_yaml::{Mapping, Value as Yaml};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};

#[derive(Clone, PartialEq, Eq)]
pub(super) struct RunnerDoc {
    pub active: String,
    pub path: PathBuf,
    pub yaml: String,
    pub planner: String,
    pub executors: Vec<String>,
    pub order: Vec<String>,
    pub route: Vec<String>,
    pub enabled: BTreeMap<String, bool>,
    pub declared: BTreeSet<String>,
}

fn get<'a>(map: &'a Mapping, name: &str) -> Option<&'a Yaml> {
    map.get(Yaml::String(name.to_owned()))
}
fn only(map: &Mapping, names: &[&str]) -> bool {
    map.keys()
        .all(|key| key.as_str().is_some_and(|key| names.contains(&key)))
}
fn strings(value: &Yaml) -> Option<Vec<String>> {
    value
        .as_sequence()?
        .iter()
        .map(|value| value.as_str().map(str::to_owned))
        .collect()
}
fn simple_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && bytes.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

pub(super) fn parse(ctx: &Ctx) -> Option<RunnerDoc> {
    let home = openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    let active = active_name(&home)?;
    let (yaml, path) = if active == "default" {
        (
            read_regular(&home, "strategy.yaml", 256 * 1024)?,
            ctx.pacer_home.join("strategy.yaml"),
        )
    } else {
        let dir = openat(
            &home,
            "strategies",
            OFlags::RDONLY
                | OFlags::DIRECTORY
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK
                | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .ok()?;
        (
            read_regular(&dir, &format!("{active}.yaml"), 256 * 1024)?,
            ctx.pacer_home
                .join("strategies")
                .join(format!("{active}.yaml")),
        )
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::symlink_metadata(&path).ok()?.permissions().mode() & 0o777 != 0o600 {
            return None;
        }
    }
    if yaml.contains(['&', '*', '!']) || yaml.contains("<<") {
        return None;
    }
    let root: Yaml = serde_yaml::from_str(&yaml).ok()?;
    let root = root.as_mapping()?;
    if !only(
        root,
        &["planner", "accounts", "runners", "routing", "pacing"],
    ) {
        return None;
    }
    let accounts = get(root, "accounts")?.as_mapping()?;
    if accounts.len() < 2 || accounts.len() > 4 {
        return None;
    }
    let mut ids = BTreeSet::new();
    for (name, config) in accounts {
        if !simple_name(name.as_str()?) {
            return None;
        }
        let config = config.as_mapping()?;
        if !only(config, &["kind"]) {
            return None;
        }
        let id = match get(config, "kind")?.as_str()? {
            "claude" => "claude-code",
            "codex" => "codex",
            "cursor" => "cursor",
            _ => return None,
        };
        if !ids.insert(id.to_owned()) {
            return None;
        }
    }
    let planner = get(root, "planner")?.as_str()?.to_owned();
    if !ids.contains(&planner) {
        return None;
    }
    let executors: Vec<String> = ids.iter().filter(|id| **id != planner).cloned().collect();
    if executors.is_empty() {
        return None;
    }
    let mut enabled = ids
        .iter()
        .map(|id| (id.clone(), true))
        .collect::<BTreeMap<_, _>>();
    let mut declared = BTreeSet::new();
    if let Some(raw) = get(root, "runners") {
        for (id, value) in raw.as_mapping()? {
            let id = id.as_str()?;
            if !ids.contains(id) || id == planner {
                return None;
            }
            let value = value.as_mapping()?;
            if !only(value, &["enabled", "model", "max_tasks", "test"]) {
                return None;
            }
            if let Some(value) = get(value, "enabled") {
                enabled.insert(id.to_owned(), value.as_bool()?);
            }
            if let Some(value) = get(value, "model")
                && !value.is_null()
                && value.as_str()?.is_empty()
            {
                return None;
            }
            if let Some(value) = get(value, "max_tasks")
                && !(1..=16).contains(&value.as_i64()?)
            {
                return None;
            }
            if let Some(value) = get(value, "test") {
                value.as_bool()?;
            }
            declared.insert(id.to_owned());
        }
    }
    let routing = get(root, "routing")?.as_sequence()?;
    if routing.len() != 1 {
        return None;
    }
    let rule = routing[0].as_mapping()?;
    if !only(rule, &["default"]) {
        return None;
    }
    let route = strings(get(rule, "default")?)?;
    if route.is_empty() || route.iter().any(|id| !ids.contains(id)) {
        return None;
    }
    let pacing = get(root, "pacing")?.as_mapping()?;
    if !only(pacing, &["order", "policy"]) {
        return None;
    }
    if let Some(policy) = get(pacing, "policy")
        && policy.as_str()? != "priority"
    {
        return None;
    }
    let order = strings(get(pacing, "order")?)?;
    if order.len() != executors.len()
        || order.iter().collect::<BTreeSet<_>>().len() != executors.len()
        || order.iter().any(|id| !executors.contains(id))
    {
        return None;
    }
    Some(RunnerDoc {
        active,
        path,
        yaml,
        planner,
        executors,
        order,
        route,
        enabled,
        declared,
    })
}
