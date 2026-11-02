use serde_json::{Map, Value, json};

fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}
fn check_keys(value: &Value, allowed: &[&str]) -> bool {
    object(value).is_some_and(|map| map.keys().all(|k| allowed.contains(&k.as_str())))
}
fn merge(defaults: &Value, input: &Value) -> Value {
    if let (Some(base), Some(extra)) = (defaults.as_object(), input.as_object()) {
        let mut output = base.clone();
        for (k, v) in extra {
            let old = output.get(k).cloned().unwrap_or(Value::Null);
            output.insert(k.clone(), merge(&old, v));
        }
        Value::Object(output)
    } else {
        input.clone()
    }
}
fn positive_int(v: &Value, max: usize) -> bool {
    v.as_u64().is_some_and(|n| n > 0 && n <= max as u64)
}

pub(crate) fn dispatch(raw: &Value) -> Option<Value> {
    if !check_keys(
        raw,
        &[
            "engine",
            "engineFallback",
            "timeoutMs",
            "learning",
            "discovery",
            "reservePct",
            "comfortablePct",
            "steps",
            "onNoMatch",
        ],
    ) {
        return None;
    }
    let default_step = |id: &str, capacity: &str| json!({"id":id,"match":{},"require":{},"prefer":{"models":[],"strengths":[]},"candidates":{},"capacity":capacity,"rank":["task-fit","spare-capacity"]});
    let defaults = json!({"engine":"ladder","engineFallback":"queue","timeoutMs":1000,"learning":{"enabled":false,"minSamples":20,"maxAgeDays":90},"discovery":{"enabled":false,"runners":[],"models":[]},"reservePct":0,"comfortablePct":20,"steps":[default_step("capable-with-headroom","comfortable"),default_step("usable-fallback","usable")],"onNoMatch":"queue"});
    let mut result = merge(&defaults, raw);
    let engine = result["engine"].as_str()?;
    if engine != "ladder"
        && !(engine.starts_with("plugin:")
            && engine[7..].len() >= 2
            && engine[7..].len() <= 64
            && (engine.as_bytes()[7].is_ascii_lowercase() || engine.as_bytes()[7].is_ascii_digit())
            && engine[7..]
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
    {
        return None;
    }
    if !["queue", "ladder"].contains(&result["engineFallback"].as_str()?)
        || !["queue", "fail"].contains(&result["onNoMatch"].as_str()?)
    {
        return None;
    }
    if !positive_int(&result["timeoutMs"], 10000) {
        return None;
    }
    for key in ["reservePct", "comfortablePct"] {
        if result[key]
            .as_f64()
            .is_none_or(|v| !(0. ..=100.).contains(&v))
        {
            return None;
        }
    }
    let learning = &result["learning"];
    if !check_keys(learning, &["enabled", "minSamples", "maxAgeDays"])
        || !learning["enabled"].is_boolean()
        || !learning["minSamples"]
            .as_u64()
            .is_some_and(|n| (20..=1000).contains(&n))
        || !learning["maxAgeDays"]
            .as_u64()
            .is_some_and(|n| (1..=365).contains(&n))
    {
        return None;
    }
    let discovery = &result["discovery"];
    if !check_keys(discovery, &["enabled", "runners", "models"])
        || !discovery["enabled"].is_boolean()
        || discovery["runners"]
            .as_array()
            .is_none_or(|a| a.len() > 128 || a.iter().any(|v| v.as_str().is_none_or(str::is_empty)))
        || discovery["models"]
            .as_array()
            .is_none_or(|a| a.len() > 512 || a.iter().any(|v| v.as_str().is_none_or(str::is_empty)))
    {
        return None;
    }
    let steps = result["steps"].as_array_mut()?;
    if steps.is_empty() || steps.len() > 64 {
        return None;
    }
    let mut ids = std::collections::HashSet::new();
    for step in steps {
        if !check_keys(
            step,
            &[
                "id",
                "match",
                "require",
                "prefer",
                "candidates",
                "capacity",
                "rank",
            ],
        ) {
            return None;
        }
        let merged = merge(&default_step("", "comfortable"), step);
        let id = merged["id"].as_str()?;
        if id.is_empty() || id.len() > 256 || !ids.insert(id.to_owned()) {
            return None;
        }
        if !check_keys(&merged["match"], &["kind"])
            || !check_keys(&merged["require"], &["minTier", "tools", "context"])
            || !check_keys(&merged["prefer"], &["models", "strengths"])
            || !check_keys(&merged["candidates"], &["models", "executors"])
        {
            return None;
        }
        if merged["match"]
            .get("kind")
            .is_some_and(|v| v.as_str().is_none_or(str::is_empty))
            || merged["require"]
                .get("minTier")
                .is_some_and(|v| !matches!(v.as_str(), Some("small" | "medium" | "frontier")))
            || merged["require"]
                .get("tools")
                .is_some_and(|v| !v.is_boolean())
            || merged["require"]
                .get("context")
                .is_some_and(|v| !positive_int(v, usize::MAX))
        {
            return None;
        }
        for (section, key, max) in [
            ("prefer", "models", 256),
            ("prefer", "strengths", 64),
            ("candidates", "models", 256),
            ("candidates", "executors", 256),
        ] {
            if merged[section].get(key).is_some_and(|v| {
                v.as_array().is_none_or(|a| {
                    a.len() > max
                        || a.iter()
                            .any(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 256))
                })
            }) {
                return None;
            }
        }
        if !["comfortable", "usable", "unknown"].contains(&merged["capacity"].as_str()?) {
            return None;
        }
        let rank = merged["rank"].as_array()?;
        if rank.is_empty()
            || rank.len() > 5
            || rank.iter().any(|v| {
                !matches!(
                    v.as_str(),
                    Some(
                        "task-fit"
                            | "spare-capacity"
                            | "burn-before-reset"
                            | "cheapest-first"
                            | "preference"
                    )
                )
            })
        {
            return None;
        }
        *step = merged;
    }
    Some(result)
}

pub(crate) fn messaging(raw: &Value) -> Option<Value> {
    let empty = json!({});
    let raw = if raw.is_null() { &empty } else { raw };
    if !check_keys(
        raw,
        &[
            "defaults",
            "rules",
            "message",
            "tree",
            "liveness",
            "hooks",
            "grants",
            "keep_worktree_days",
        ],
    ) {
        return None;
    }
    let defaults = json!({"defaults":true,"rules":[],"message":{"max_bytes":65536},"tree":{"max_turns":50},"liveness":{"interval_s":60,"backoff_max_s":900,"max_nudges":3,"nudge_in_modes":["relaxed","normal"],"escalate_after_s":900,"retry_delivery":true},"hooks":{"stop":"block","stop_release_after":2},"grants":{"user_started_tasks":"on"},"keep_worktree_days":7});
    let result = merge(&defaults, raw);
    if !result["defaults"].is_boolean()
        || !result["keep_worktree_days"]
            .as_u64()
            .is_some_and(|v| v <= 3650)
    {
        return None;
    }
    if !check_keys(&result["message"], &["max_bytes"])
        || !positive_int(&result["message"]["max_bytes"], 1 << 20)
        || !check_keys(&result["tree"], &["max_turns"])
        || !positive_int(&result["tree"]["max_turns"], 10000)
    {
        return None;
    }
    let live = &result["liveness"];
    if !check_keys(
        live,
        &[
            "interval_s",
            "backoff_max_s",
            "max_nudges",
            "nudge_in_modes",
            "escalate_after_s",
            "retry_delivery",
        ],
    ) || ["interval_s", "backoff_max_s", "escalate_after_s"]
        .iter()
        .any(|k| live[*k].as_u64().is_none_or(|n| n < 10))
        || !live["max_nudges"].is_u64()
        || !live["retry_delivery"].is_boolean()
    {
        return None;
    }
    if live["nudge_in_modes"].as_array().is_none_or(|a| {
        a.iter().any(|v| {
            !matches!(
                v.as_str(),
                Some("relaxed" | "normal" | "strict" | "emergency")
            )
        })
    }) {
        return None;
    }
    if !check_keys(&result["hooks"], &["stop", "stop_release_after"])
        || !matches!(
            result["hooks"]["stop"].as_str(),
            Some("block" | "inject_only" | "off")
        )
        || !positive_int(&result["hooks"]["stop_release_after"], usize::MAX)
    {
        return None;
    }
    if !check_keys(&result["grants"], &["user_started_tasks"])
        || !matches!(
            result["grants"]["user_started_tasks"].as_str(),
            Some("on" | "off")
        )
    {
        return None;
    }
    let rules = result["rules"].as_array()?;
    if rules.len() > 200 {
        return None;
    }
    for rule in rules {
        if !check_keys(
            rule,
            &[
                "effect",
                "from_kind",
                "to_kind",
                "from_position",
                "relation",
                "kinds",
                "repo",
                "executor",
                "grant",
                "limits",
            ],
        ) || !matches!(rule["effect"].as_str(), Some("allow" | "deny"))
        {
            return None;
        }
        for key in ["from_kind", "to_kind"] {
            if let Some(v) = rule.get(key)
                && !matches!(
                    v.as_str(),
                    Some("human" | "external" | "launched" | "broker" | "any")
                )
            {
                return None;
            }
        }
        if let Some(v) = rule.get("from_position")
            && !matches!(v.as_str(), Some("top" | "child" | "any"))
        {
            return None;
        }
        if let Some(v) = rule.get("grant")
            && !matches!(v.as_str(), Some("required" | "not_required"))
        {
            return None;
        }
        if let Some(v) = rule.get("relation")
            && v != "any"
            && v.as_array().is_none_or(|a| {
                a.is_empty()
                    || a.iter().any(|v| {
                        !matches!(
                            v.as_str(),
                            Some(
                                "self"
                                    | "parent"
                                    | "child"
                                    | "sibling"
                                    | "descendant"
                                    | "ancestor"
                                    | "top_peer"
                                    | "same_tree"
                                    | "none"
                            )
                        )
                    })
            })
        {
            return None;
        }
        if let Some(v) = rule.get("kinds")
            && v.as_array().is_none_or(|a| {
                a.is_empty()
                    || a.iter().any(|v| {
                        !matches!(
                            v.as_str(),
                            Some("message" | "question" | "answer" | "report" | "nudge" | "close")
                        )
                    })
            })
        {
            return None;
        }
        for key in ["repo", "executor"] {
            if rule
                .get(key)
                .is_some_and(|v| v.as_str().is_none_or(str::is_empty))
            {
                return None;
            }
        }
        if let Some(limits) = rule.get("limits")
            && (!check_keys(limits, &["per_minute", "max_bytes", "confirm"])
                || limits
                    .get("per_minute")
                    .is_some_and(|v| !positive_int(v, usize::MAX))
                || limits
                    .get("max_bytes")
                    .is_some_and(|v| !positive_int(v, 1 << 20))
                || limits.get("confirm").is_some_and(|v| !v.is_boolean()))
        {
            return None;
        }
    }
    Some(result)
}

pub(crate) fn hosts(raw: Option<&Value>, problems: &mut Vec<String>) -> Value {
    let mut out = Map::new();
    let Some(raw) = raw else {
        return Value::Object(out);
    };
    let Some(entries) = raw.as_object() else {
        problems.push("hosts must be a mapping".into());
        return Value::Object(out);
    };
    for (alias, value) in entries {
        let at = format!("hosts.{alias}");
        if alias == "local" {
            problems.push("hosts: \"local\" is reserved".into());
        }
        if !alias_ok(alias) {
            problems.push(format!("{at}: invalid host alias"));
        }
        let Some(host) = value.as_object() else {
            problems.push(format!("{at} must be a mapping"));
            continue;
        };
        for key in host.keys() {
            if !["ssh", "repos", "max_tasks", "accounts", "paused", "session"]
                .contains(&key.as_str())
            {
                problems.push(format!("{at}: unknown key {key}"));
            }
        }
        let ssh = host.get("ssh").and_then(Value::as_str).unwrap_or("");
        if ssh.is_empty()
            || ssh.starts_with('-')
            || !ssh
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._@-".contains(&c))
        {
            problems.push(format!("{at}.ssh must be an ssh alias"));
        }
        if host.get("paused").is_some_and(|v| !v.is_boolean()) {
            problems.push(format!("{at}.paused must be a boolean"));
        }
        if let Some(session) = host.get("session")
            && !matches!(session.as_str(), Some("recording" | "full"))
        {
            problems.push(format!("{at}.session must be recording or full"));
        }
        let max = host.get("max_tasks").cloned().unwrap_or(json!(2));
        if max.as_u64().is_none_or(|n| !(1..=16).contains(&n)) {
            problems.push(format!("{at}.max_tasks must be 1..16"));
        }
        let mut repos = Map::new();
        if let Some(value) = host.get("repos") {
            if let Some(m) = value.as_object() {
                for (key, path) in m {
                    let parts = key.split('/').collect::<Vec<_>>();
                    let host_ok = |s: &str| {
                        s.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                            || s.as_bytes().first().is_some_and(u8::is_ascii_digit)
                    };
                    let host_tail = |s: &str| {
                        s.bytes().all(|c| {
                            c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c)
                        })
                    };
                    let segment_ok = |s: &str| {
                        !s.is_empty()
                            && s.bytes().all(|c| {
                                c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c)
                            })
                    };
                    if parts.len() != 3
                        || !host_ok(parts[0])
                        || !host_tail(parts[0])
                        || !segment_ok(parts[1])
                        || !segment_ok(parts[2])
                        || key.ends_with(".git")
                    {
                        problems.push(format!(
                            "{at}.repos: {key} is not a canonical repo key (host/owner/repo)"
                        ));
                    }
                    if path
                        .as_str()
                        .is_none_or(|s| pacer_foundation::js_semantics::js_trim(s).is_empty())
                    {
                        problems.push(format!("{at}.repos.{key} must be a non-empty path"));
                    } else {
                        repos.insert(key.clone(), path.clone());
                    }
                }
            } else {
                problems.push(format!("{at}.repos must be a mapping"));
            }
        }
        let mut accounts = Map::new();
        if let Some(value) = host.get("accounts") {
            if let Some(m) = value.as_object() {
                for (id, cfg) in m {
                    let loc = format!("{at}.accounts.{id}");
                    if !alias_ok(id) {
                        problems.push(format!("{loc}: invalid account name"));
                    }
                    if let Some(c) = cfg.as_object() {
                        for key in c.keys() {
                            if key != "home" {
                                problems.push(format!("{loc}: unknown key {key}"));
                            }
                        }
                        if c.get("home")
                            .and_then(Value::as_str)
                            .is_none_or(|s| pacer_foundation::js_semantics::js_trim(s).is_empty())
                        {
                            problems.push(format!("{loc}.home must be a non-empty folder"));
                        } else {
                            accounts.insert(id.clone(), json!({"home":c["home"]}));
                        }
                    } else {
                        problems.push(format!("{loc} must be a mapping"));
                    }
                }
            } else {
                problems.push(format!("{at}.accounts must be a mapping"));
            }
        }
        let mut normalized = json!({"alias":alias,"ssh":ssh,"repos":repos,"maxTasks":max,"accounts":accounts,"paused":host.get("paused")==Some(&Value::Bool(true))});
        if let Some(v) = host
            .get("session")
            .filter(|v| matches!(v.as_str(), Some("recording" | "full")))
        {
            normalized["session"] = v.clone();
        }
        out.insert(alias.clone(), normalized);
    }
    Value::Object(out)
}
fn alias_ok(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
