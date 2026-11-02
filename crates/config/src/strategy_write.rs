//! Named strategy activation and removal. Publication belongs to the caller.

use crate::strategy::{StrategyError, list_strategies, load_strategy, show_strategy, summary_yaml};
use pacer_foundation::js_semantics::JsTrim;
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

pub(crate) fn check_name(name: &str, writable: bool) -> Result<(), StrategyError> {
    let valid = !name.is_empty()
        && name.len() <= 40
        && (name.as_bytes()[0].is_ascii_lowercase() || name.as_bytes()[0].is_ascii_digit())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid || (writable && name == "default") {
        return Err(StrategyError::Other(format!(
            "invalid strategy name \"{name}\"{}",
            if writable {
                "; default is protected"
            } else {
                ""
            }
        )));
    }
    Ok(())
}

fn path_for(home: &Path, name: &str) -> Result<PathBuf, StrategyError> {
    if !list_strategies(home)?.iter().any(|known| known == name) {
        return Err(StrategyError::Other(format!("unknown strategy \"{name}\"")));
    }
    Ok(if name == "default" {
        home.join("strategy.yaml")
    } else {
        home.join("strategies").join(format!("{name}.yaml"))
    })
}

fn write_active(home: &Path, name: &str) -> io::Result<()> {
    fs::create_dir_all(home)?;
    #[cfg(unix)]
    fs::set_permissions(home, fs::Permissions::from_mode(0o700))?;
    let active = home.join("active");
    for _ in 0..16 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let temp = home.join(format!(
            "active.{}.{nanos}.{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = match options.open(&temp) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        use std::io::Write;
        let result = (|| {
            file.write_all(format!("{name}\n").as_bytes())?;
            file.sync_all()?;
            fs::rename(&temp, &active)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        return result;
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a unique strategy temp file",
    ))
}

/// Apply the service-level `strategy.use` file effect. The P3-B caller must
/// publish the strategy-switch alert after this succeeds.
pub fn use_strategy(home: &Path, name: &str) -> Result<Value, StrategyError> {
    show_strategy(home, name)?;
    let path = if name == "default" {
        let active = home.join("active");
        match fs::remove_file(active) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        home.join("strategy.yaml")
    } else {
        let path = home.join("strategies").join(format!("{name}.yaml"));
        write_active(home, name)?;
        path
    };
    Ok(json!({"name":name,"path":path}))
}

/// Apply the service-level `strategy.remove` file effect. The API caller
/// guards default and active names with its `not_allowed` error first.
pub fn remove_strategy(home: &Path, name: &str) -> Result<Value, StrategyError> {
    check_name(name, true)?;
    if load_strategy(home)?["name"] == name {
        return Err(StrategyError::Other(
            "cannot delete the active strategy".into(),
        ));
    }
    let path = path_for(home, name)?;
    fs::remove_file(path)?;
    Ok(json!({"name":name,"deleted":true}))
}

fn change_path(
    node: &mut crate::yaml_value::Value,
    keys: &[&str],
    value: Option<crate::yaml_value::Value>,
    path: &str,
) -> Result<(), StrategyError> {
    let map = node.as_object_mut().ok_or_else(|| {
        StrategyError::Other(format!(
            "cannot traverse \"{path}\"; arrays and scalars replace wholesale"
        ))
    })?;
    if keys.len() == 1 {
        if let Some(value) = value {
            map.insert(keys[0].into(), value);
        } else {
            map.shift_remove(keys[0]);
        }
        return Ok(());
    }
    if !map.contains_key(keys[0]) {
        if value.is_none() {
            return Ok(());
        }
        map.insert(
            keys[0].into(),
            crate::yaml_value::Value::Object(Default::default()),
        );
    }
    let child = map
        .get_mut(keys[0])
        .ok_or_else(|| StrategyError::Other("missing draft key".into()))?;
    change_path(child, &keys[1..], value, path)
}

fn schema_keys(prefix: &[&str]) -> Option<&'static [&'static str]> {
    match prefix {
        [] => Some(&[
            "planner",
            "providers",
            "dispatch",
            "pacing",
            "routing",
            "execution",
            "classifier",
        ]),
        ["providers"] => Some(&["*"]),
        ["providers", _] => Some(&[
            "via",
            "model",
            "usage",
            "allow_paid",
            "cooldown",
            "quota_source",
            "budget",
        ]),
        ["providers", _, "budget"] => Some(&["weekly_tokens"]),
        ["pacing"] => Some(&[
            "policy",
            "order",
            "planner_reserve",
            "planner_reserve_headroom",
            "planner_probe",
            "ahead_threshold",
            "behind_threshold",
        ]),
        ["execution"] => Some(&["backend", "worktree", "base_branch"]),
        ["classifier"] => Some(&[
            "default",
            "shadow",
            "shadow_external",
            "timeout_ms",
            "log_state",
            "decisions",
            "tiers",
            "adapters",
            "bench",
        ]),
        ["classifier", "decisions"] => Some(&["task_kind", "difficulty", "guard", "result_check"]),
        ["classifier", "decisions", _] => {
            Some(&["use", "min_confidence", "verify_kind", "max_for_cheap"])
        }
        ["classifier", "tiers"] => Some(&["*"]),
        ["classifier", "adapters"] => Some(&["ollama", "jev"]),
        ["classifier", "adapters", "ollama"] => {
            Some(&["base_url", "model", "max_tokens", "key_env"])
        }
        ["classifier", "adapters", "jev"] => Some(&[
            "base_url",
            "model",
            "key_env",
            "usd_per_mtok_in",
            "usd_per_mtok_out",
        ]),
        ["classifier", "bench"] => Some(&["redact", "timeout_ms"]),
        _ => None,
    }
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<u16> = b.encode_utf16().collect();
    let mut row = (0..=b.len()).collect::<Vec<_>>();
    for (i, a) in a.encode_utf16().enumerate() {
        let mut next = vec![i + 1];
        for (j, &b) in b.iter().enumerate() {
            next.push(
                (next[j] + 1)
                    .min(row[j + 1] + 1)
                    .min(row[j] + usize::from(a != b)),
            );
        }
        row = next;
    }
    row[b.len()]
}

fn check_draft_path(keys: &[&str], path: &str) -> Result<(), StrategyError> {
    for index in 0..keys.len() {
        let prefix = &keys[..index];
        let Some(allowed) = schema_keys(prefix) else {
            return Err(StrategyError::Other(format!(
                "cannot traverse \"{path}\"; arrays and scalars replace wholesale; closest known key: \"{}\"",
                prefix.join(".")
            )));
        };
        if !allowed.contains(&keys[index]) && !allowed.contains(&"*") {
            let closest = allowed
                .iter()
                .min_by_key(|known| distance(keys[index], known))
                .copied()
                .unwrap_or("");
            let mut suggestion = prefix.to_vec();
            suggestion.push(closest);
            return Err(StrategyError::Other(format!(
                "unknown strategy key \"{path}\"; closest known key: \"{}\"",
                suggestion.join(".")
            )));
        }
    }
    Ok(())
}

fn apply_draft(
    mut raw: crate::yaml_value::Value,
    draft: &Value,
) -> Result<crate::yaml_value::Value, StrategyError> {
    let mut draft = draft.clone();
    crate::normalize_json(&mut draft);
    if !raw.is_object() {
        return Err(StrategyError::Other(
            "base strategy must be a mapping".into(),
        ));
    }
    let mut changes = Vec::new();
    if let Some(set) = draft.get("set").and_then(Value::as_object) {
        changes.extend(
            set.iter()
                .map(|(key, value)| (key.clone(), Some(value.clone()))),
        );
    }
    if let Some(unset) = draft.get("unset").and_then(Value::as_array) {
        changes.extend(
            unset
                .iter()
                .filter_map(Value::as_str)
                .map(|key| (key.to_owned(), None)),
        );
    }
    for (path, value) in changes {
        let keys = path.split('.').collect::<Vec<_>>();
        if keys
            .iter()
            .any(|key| key.is_empty() || matches!(*key, "__proto__" | "prototype" | "constructor"))
        {
            return Err(StrategyError::Other(format!(
                "invalid dotted path \"{path}\""
            )));
        }
        check_draft_path(&keys, &path)?;
        change_path(
            &mut raw,
            &keys,
            value.as_ref().map(crate::yaml_value::Value::from),
            &path,
        )?;
    }
    Ok(raw)
}

fn one_line(text: &str) -> String {
    text.chars()
        .map(|ch| if ch <= '\u{001f}' { ' ' } else { ch })
        .collect()
}

/// Save a named draft with the TypeScript header and atomic create/replace
/// semantics. `now_iso` is the caller's rendering of `ctx.now` in UTC.
pub struct SaveOptions<'a> {
    pub who: &'a str,
    pub now_iso: &'a str,
    pub overwrite: bool,
    pub active_ok: bool,
}

pub fn save_strategy(
    home: &Path,
    name: &str,
    draft: &Value,
    reason: &str,
    options: SaveOptions<'_>,
) -> Result<Value, StrategyError> {
    check_name(name, true)?;
    if reason.js_trim().is_empty() {
        return Err(StrategyError::Other("a save reason is required".into()));
    }
    let source = draft["from"].as_str().unwrap_or("default");
    let source_path = path_for(home, source)?;
    let before = fs::read_to_string(source_path)?;
    let raw =
        crate::doc::parse_yaml_value(&before).map_err(|e| StrategyError::Other(e.to_string()))?;
    let raw = apply_draft(raw, draft)?;
    let strategy = crate::strategy_validation::validate_strategy(&raw, Path::new("draft"), source)?;
    let path = home.join("strategies").join(format!("{name}.yaml"));
    if path.exists() && !options.overwrite {
        return Err(StrategyError::Other(format!(
            "strategy \"{name}\" already exists; use overwrite:true to replace it"
        )));
    }
    if path.exists() && load_strategy(home)?["name"] == name && !options.active_ok {
        return Err(StrategyError::Other(format!(
            "strategy \"{name}\" is active; overwriting changes live routing; use activeOk:true to approve"
        )));
    }
    fs::create_dir_all(home.join("strategies"))?;
    #[cfg(unix)]
    fs::set_permissions(home.join("strategies"), fs::Permissions::from_mode(0o700))?;
    let description = draft["description"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| summary_yaml(&strategy));
    let content = format!(
        "# {}\n# created by {} on {}: {}\n{}",
        one_line(&description),
        one_line(options.who),
        options.now_iso,
        one_line(reason),
        crate::doc::stringify_yaml_bun(&raw)
    );
    let (temp, mut file) = crate::temp_file::create(&path)?;
    let write = (|| -> io::Result<()> {
        use std::io::Write;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        if path.exists() && !options.overwrite {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("strategy \"{name}\" already exists"),
            ));
        }
        if options.overwrite {
            fs::rename(&temp, &path)
        } else {
            fs::hard_link(&temp, &path)
        }
    })();
    let _ = fs::remove_file(temp);
    write?;
    Ok(
        json!({"name":name,"path":path,"summary":summary_yaml(&strategy),"active":load_strategy(home)?["name"] == name}),
    )
}
