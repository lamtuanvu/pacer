//! Host decisions over supplied probe/task/config snapshots. No grants, shell
//! recipes or native operations are issued here; an outcome is not authorization.
use crate::{Error, a, event, js, n, s, truth};
use regex::Regex;
use serde_json::{Value, json};
fn regex(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}
pub fn repo_key(origin: &str) -> Option<String> {
    let non_space = js::NON_WHITESPACE;
    let user = non_space.replacen("[^", "[^@/:", 1);
    let scp = regex(&format!(r"^{user}+@([A-Za-z0-9.-]+):({non_space}+)$"))?;
    let (host, path) = if let Some(m) = scp.captures(origin) {
        (m[1].to_owned(), m[2].to_owned())
    } else {
        let parsed = url::Url::parse(origin).ok()?;
        if !["https", "ssh"].contains(&parsed.scheme())
            || parsed.query().is_some_and(|v| !v.is_empty())
            || parsed.fragment().is_some_and(|v| !v.is_empty())
            || parsed.password().is_some_and(|p| !p.is_empty())
        {
            return None;
        }
        (
            parsed.host_str()?.to_owned(),
            parsed
                .path()
                .strip_prefix('/')
                .unwrap_or(parsed.path())
                .to_owned(),
        )
    };
    let key = format!("{host}/{path}").to_lowercase();
    let key = key.strip_suffix(".git").unwrap_or(&key);
    canonical(key).then(|| key.to_owned())
}
pub fn canonical(key: &str) -> bool {
    regex(r"^[a-z0-9][a-z0-9.-]*/[a-z0-9._-]+/[a-z0-9._-]+$").is_some_and(|r| r.is_match(key))
        && !key.ends_with(".git")
}
fn local(c: &Value, key: &str) -> String {
    js::trim(c["local"][key].as_str().unwrap_or(match key {
        "origin" => "https://github.com/acme/api.git",
        "name" => "Dev",
        _ => "dev@example.invalid",
    }))
    .into()
}
fn mapped(c: &Value) -> Option<String> {
    let key = repo_key(&local(c, "origin"))?;
    truth(&c["host"]["repos"][&key]).then_some(key)
}
/// Probe/check step order includes disabled configured runners, as in prepareCheck.
pub fn names(c: &Value) -> Vec<String> {
    let full = c["host"]["session"] == "full";
    let mut names = vec!["ssh".into()];
    if full {
        names.push("glibc".into());
    }
    names.extend(["git".into(), "setsid".into()]);
    if !full {
        names.extend(["script".into(), "tail".into()]);
    }
    for (agent, name) in [("codex", "codex"), ("claude-code", "claude")] {
        if a(&c["runners"])
            .iter()
            .any(|r| r["host"] == c["alias"] && r["agent"] == agent)
        {
            names.push(name.into());
        }
    }
    names.push("account homes".into());
    for key in repo_keys(c) {
        names.push(format!("checkout {key}"));
        names.push(format!("identity {key}"));
    }
    names
}
fn repo_keys(c: &Value) -> Vec<String> {
    if truth(&c["repo"]) {
        return mapped(c).into_iter().collect();
    }
    c["host"]["repos"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}
fn version(text: &str, pattern: &str, minor: f64) -> bool {
    regex(pattern)
        .and_then(|r| {
            r.captures(text).map(|m| {
                let major = m[1].parse::<f64>().unwrap_or(f64::NAN);
                let min = m[2].parse::<f64>().unwrap_or(f64::NAN);
                major > 2.0 || major == 2.0 && min >= minor
            })
        })
        .unwrap_or(false)
}
fn check_result(c: &Value, steps: &mut Vec<Value>) -> Result<Value, Error> {
    let alias = s(&c["alias"]);
    if truth(&c["repo"]) && mapped(c).is_none() {
        return Err(Error::new(
            "invalid_input",
            format!("repo not mapped on {alias}"),
        ));
    }
    let names = names(c);
    let mut checks = vec![];
    let mut facts = json!({"os":null,"arch":null,"glibc":null,"git":null,"setsid":null,"tools":{}});
    event(steps, "start", "ssh", None);
    let probe = &c["probe"];
    if truth(&c["unavailable"]) || !truth(&probe["ok"]) {
        for name in &names {
            let detail = if name == "ssh" {
                c["unavailable"].as_str().unwrap_or("unreachable")
            } else {
                "skipped"
            };
            checks.push(json!({"name":name,"ok":false,"detail":detail}));
            event(
                steps,
                if detail == "skipped" { "skip" } else { "fail" },
                name,
                Some(detail),
            );
        }
    } else {
        add(&mut checks, steps, "ssh", true, "");
        event(steps, "start", "git", None);
        let tools = &probe["facts"];
        for key in ["os", "glibc", "arch", "setsid"] {
            if truth(&tools[key]) {
                facts[key] = tools[key].clone();
            }
        }
        let git = s(&tools["git"]);
        let git_fact=regex(r"^git version[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]+").map(|r|r.replace(git,"").to_string()).unwrap_or_default();
        if !git_fact.is_empty() {
            facts["git"] = git_fact.into();
        }
        for key in ["codex", "claude"] {
            if truth(&tools[key]) {
                facts["tools"][key] = tools[key].clone();
            }
        }
        let full = c["host"]["session"] == "full";
        if full && tools["os"] == "Linux" {
            event(steps, "start", "glibc", None);
            let glibc = s(&tools["glibc"]);
            let ok = version(glibc, r"^([0-9]+)\.([0-9]+)(?:\.[0-9]+)?$", 17.0);
            add(
                &mut checks,
                steps,
                "glibc",
                ok,
                &if ok {
                    glibc.into()
                } else {
                    format!(
                        "{}; pacer Linux binary requires >= 2.17",
                        if glibc.is_empty() {
                            "glibc unknown"
                        } else {
                            glibc
                        }
                    )
                },
            );
        } else if full {
            event(steps, "skip", "glibc", Some("not a Linux host"));
        }
        let ok = version(git, r"git version ([0-9]+)\.([0-9]+)", 30.0);
        add(
            &mut checks,
            steps,
            "git",
            ok,
            &if ok {
                git.into()
            } else {
                format!(
                    "{} < 2.30",
                    if git.is_empty() { "git missing" } else { git }
                )
            },
        );
        event(steps, "start", "setsid", None);
        add(
            &mut checks,
            steps,
            "setsid",
            truth(&tools["setsid"]),
            if truth(&tools["setsid"]) {
                s(&tools["setsid"])
            } else {
                "missing"
            },
        );
        if !full {
            event(steps, "start", "script", None);
            let script = s(&tools["script"]);
            let ok = version(script, r"util-linux ([0-9]+)\.([0-9]+)", 35.0);
            add(
                &mut checks,
                steps,
                "script",
                ok,
                &if ok {
                    script.into()
                } else {
                    format!(
                        "{}; requires >= 2.35 (stdin EOF issue)",
                        if script.is_empty() {
                            "util-linux script missing"
                        } else {
                            script
                        }
                    )
                },
            );
            event(steps, "start", "tail", None);
            add(
                &mut checks,
                steps,
                "tail",
                truth(&tools["tail"]),
                if truth(&tools["tail"]) {
                    s(&tools["tail"])
                } else {
                    "tail missing"
                },
            );
        }
        for agent in ["codex", "claude"] {
            if names.iter().any(|name| name == agent) {
                event(steps, "start", agent, None);
                add(
                    &mut checks,
                    steps,
                    agent,
                    truth(&tools[agent]),
                    &if truth(&tools[agent]) {
                        s(&tools[agent]).into()
                    } else {
                        format!("{agent} not on login PATH")
                    },
                );
            }
        }
        event(steps, "start", "account homes", None);
        let missing: Vec<_> = c["host"]["accounts"]
            .as_object()
            .map(|m| {
                m.keys()
                    .filter(|k| c["accountHomes"][*k] == false)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        add(
            &mut checks,
            steps,
            "account homes",
            missing.is_empty(),
            &if missing.is_empty() {
                String::new()
            } else {
                format!("missing: {}", missing.join(", "))
            },
        );
        for key in repo_keys(c) {
            let path = s(&c["host"]["repos"][&key]);
            let probe = c["repoProbes"].get(path).unwrap_or(probe);
            let f = &probe["facts"];
            let checkout = format!("checkout {key}");
            event(steps, "start", &checkout, None);
            let ok = truth(&probe["ok"])
                && f["git"] == "1"
                && repo_key(s(&f["origin"])).as_deref() == Some(&key);
            let detail = if ok {
                ""
            } else if f["exists"] != "1" {
                "missing checkout"
            } else if f["git"] != "1" {
                "not a git checkout"
            } else {
                "origin mismatch"
            };
            add(&mut checks, steps, &checkout, ok, detail);
            let identity = format!("identity {key}");
            event(steps, "start", &identity, None);
            let name = local(c, "name");
            let email = local(c, "email");
            let ok = !name.is_empty()
                && !email.is_empty()
                && s(&f["name"]) == name
                && s(&f["email"]) == email;
            add(
                &mut checks,
                steps,
                &identity,
                ok,
                if ok {
                    ""
                } else {
                    "repo-local identity does not match local repo"
                },
            );
        }
    }
    Ok(
        json!({"alias":alias,"ok":checks.iter().all(|c|c["ok"]==true),"checks":checks,"facts":facts}),
    )
}
fn add(checks: &mut Vec<Value>, steps: &mut Vec<Value>, name: &str, ok: bool, detail: &str) {
    checks.push(json!({"name":name,"ok":ok,"detail":detail}));
    event(
        steps,
        if detail == "skipped" {
            "skip"
        } else if ok {
            "pass"
        } else {
            "fail"
        },
        name,
        Some(detail),
    );
}
pub fn check(c: &Value) -> Value {
    let mut steps = vec![];
    match check_result(c, &mut steps) {
        Ok(result) => json!({"result":result,"steps":steps}),
        Err(e) => {
            let mut v = e.value();
            v["steps"] = json!(steps);
            v
        }
    }
}
pub fn setup(c: &Value) -> Value {
    let mut steps = vec![];
    let result = (|| -> Result<Value, Error> {
        let alias = s(&c["alias"]);
        let options = &c["options"];
        if options["consent"] != true {
            return Err(Error::new(
                "invalid_input",
                "host repo setup requires consent: true",
            ));
        }
        let key = mapped(c)
            .ok_or_else(|| Error::new("invalid_input", format!("repo not mapped on {alias}")))?;
        let path = s(&c["host"]["repos"][&key]);
        if options["clone"] != false {
            if let Some(preview) = c.get("preview") {
                let snapshot = json!({"alias":alias,"key":key,"path":path,"origin":local(c,"origin"),"hostFingerprint":c["hostFingerprint"]});
                validate_clone_preview(&snapshot, preview)?;
            }
            event(&mut steps, "start", "Clone", None);
            let p = c["repoProbes"].get(path).unwrap_or(&c["probe"]);
            let exists = s(&p["facts"]["exists"]);
            if a(&p["checks"]).len() != 1
                || p["checks"][0]["name"] != "checkout"
                || !["0", "1"].contains(&exists)
            {
                return Err(Error::new(
                    "invalid_input",
                    format!("host {alias} unreachable"),
                ));
            }
            if exists == "1" {
                event(&mut steps, "skip", "Clone", Some("checkout already exists"));
            } else {
                if truth(&c["cloneCode"]) {
                    return Err(Error::new(
                        "invalid_input",
                        format!("clone failed on {alias}"),
                    ));
                }
                event(&mut steps, "pass", "Clone", None);
            }
        } else {
            event(&mut steps, "skip", "Clone", None);
        }
        if options["identity"] != false {
            event(&mut steps, "start", "Set identity", None);
            if local(c, "name").is_empty() || local(c, "email").is_empty() {
                return Err(Error::new(
                    "invalid_input",
                    "local repo needs user.name and user.email",
                ));
            }
            if c["caller"].as_str().unwrap_or("pacer-remote-caller") != "pacer-remote-caller" {
                return Err(Error::new(
                    "plugin_unavailable",
                    "bundled remote caller plugin is unavailable",
                ));
            }
            if truth(&c["identityCode"]) {
                return Err(Error::new(
                    "invalid_input",
                    format!("identity setup failed on {alias}"),
                ));
            }
            event(&mut steps, "pass", "Set identity", None);
        } else {
            event(&mut steps, "skip", "Set identity", None);
        }
        event(&mut steps, "start", "Check", None);
        let mut scoped = c.clone();
        scoped["repo"] = "repo".into();
        let result = check_result(&scoped, &mut vec![])?;
        if result["ok"] == true {
            event(&mut steps, "pass", "Check", None);
        } else {
            let detail = a(&result["checks"])
                .iter()
                .filter(|c| c["ok"] != true)
                .map(|c| format!("{}: {}", s(&c["name"]), s(&c["detail"])))
                .collect::<Vec<_>>()
                .join("; ");
            event(&mut steps, "fail", "Check", Some(&detail));
        }
        Ok(result)
    })();
    match result {
        Ok(result) => json!({"result":result,"steps":steps}),
        Err(e) => {
            let mut v = e.value();
            v["steps"] = json!(steps);
            v
        }
    }
}
fn terminal(state: &str) -> bool {
    [
        "done",
        "partial",
        "failed",
        "limit",
        "stopped",
        "needs_input",
    ]
    .contains(&state)
}
pub fn clean(c: &Value) -> Value {
    let mut worktrees = vec![];
    let mut removed = vec![];
    let mut kept = vec![];
    let dry = truth(&c["dryRun"]);
    for t in a(&c["tasks"]) {
        let run = &t["run"];
        if run["host"] != c["alias"] || run["mode"] != "new" {
            continue;
        }
        let eligible = terminal(s(&t["state"]))
            && (truth(&t["review"]) || truth(&t["dismissed"]) || truth(&t["resolved"]));
        let received = eligible && truth(&c["transferred"][s(&t["id"])]);
        let paths = truth(&run["remoteWorktree"]) && truth(&run["remoteDir"]);
        let mapped = mapped(c).is_some();
        let removable = received && paths && (!dry || mapped);
        worktrees.push(json!({"branch":run.get("remoteBranch").filter(|v|!v.is_null()).cloned().unwrap_or_else(||json!(format!("pacer/{}",s(&t["id"])))),"state":t["state"],"fate":if !terminal(s(&t["state"])){"in use"}else if removable{"will remove"}else{"kept"}}));
        if dry || !eligible {
            continue;
        }
        if !mapped || !paths {
            kept.push(json!({"id":t["id"],"reason":"remote cleanup needs a configured host, checkout and run"}));
        } else if !received || truth(&c["cleanCodes"][s(&t["id"])]) {
            kept.push(json!({"id":t["id"],"reason":"remote cleanup failed"}));
        } else {
            removed.push(t["id"].clone());
        }
    }
    if dry {
        json!({"worktrees":worktrees})
    } else {
        json!({"removed":removed,"kept":kept})
    }
}
/// Configured host summaries from strategy hosts plus injected runtime snapshots.
pub fn list(c: &Value) -> Value {
    let Some(hosts) = c["hosts"].as_object() else {
        return json!([]);
    };
    let mut rows = Vec::with_capacity(hosts.len());
    for (alias, host) in hosts {
        let reachability = c["reachabilityByAlias"]
            .get(alias)
            .or_else(|| c.get("reachability"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let stored = c["storedByAlias"]
            .get(alias)
            .or_else(|| c.get("stored"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        rows.push(summary(&json!({
            "alias": alias,
            "host": host,
            "reachability": reachability,
            "stored": stored,
            "jobs": c["jobs"],
            "runners": c["runners"],
            "repos": c["repos"],
            "tasks": c["tasks"],
        })));
    }
    json!(rows)
}

pub fn summary(c: &Value) -> Value {
    let host = &c["host"];
    let alias = &c["alias"];
    let runners = a(&c["runners"]);
    let repos = &host["repos"];
    let running = a(&c["tasks"])
        .iter()
        .filter(|t| t["state"] == "running" && t["run"]["host"] == *alias)
        .count();
    let state = if truth(&host["paused"]) {
        "paused"
    } else if n(&c["reachability"]["failures"]) >= 2.0 {
        "down"
    } else if a(&c["jobs"])
        .iter()
        .any(|j| j["target"] == *alias && j["kind"] == "host.check" && j["state"] == "running")
    {
        "checking"
    } else if a(&c["stored"]["checks"]).iter().any(|c| !truth(&c["ok"]))
        || a(&c["repos"]).iter().any(|r| {
            !s(&r["key"]).starts_with("local:")
                && !truth(&repos[s(&r["key"])])
                && runners
                    .iter()
                    .any(|r| r["host"] == *alias && r["enabled"] != false)
        })
    {
        "needs_setup"
    } else {
        "ready"
    };
    let max = host.get("maxTasks").cloned().unwrap_or(json!(2));
    json!({"alias":alias,"ssh":host.get("ssh").unwrap_or(alias),"maxTasks":max,"paused":host["paused"].as_bool().unwrap_or(false),"session":host["session"].as_str().unwrap_or("recording"),"state":state,"repos":repos.as_object().map(|m|m.keys().collect::<Vec<_>>()).unwrap_or_default(),"runners":runners.iter().filter(|r|r["host"]==*alias).map(|r|r["id"].clone()).collect::<Vec<_>>(),"running":running,"slots":{"used":running,"max":max}})
}

/// Compare the exact configured clone snapshot captured at consent time.
pub fn validate_clone_preview(snapshot: &Value, preview: &Value) -> Result<(), Error> {
    if ["alias", "key", "path", "origin", "hostFingerprint"]
        .iter()
        .any(|key| preview[key] != snapshot[key])
    {
        return Err(Error::new(
            "capability_denied",
            "configured clone changed after consent",
        ));
    }
    Ok(())
}

/// Choose the local checkout for host.repo.setup before creating the job. Candidate
/// order is cwd followed by persisted task repositories, deduplicated by path.
pub fn setup_plan(
    alias: &str,
    key: &str,
    consent: bool,
    repos: &Value,
    candidates: &[Value],
) -> Result<Value, Error> {
    if !consent {
        return Err(Error::new(
            "invalid_input",
            "host repo setup requires consent: true",
        ));
    }
    let key = key.to_lowercase();
    if !canonical(&key) || repos.get(&key).is_none() {
        let mut error = Error::new("invalid_input", format!("repo not mapped on {alias}"));
        error.hint = Some("Use a mapped canonical host/owner/repo key.".into());
        return Err(error);
    }
    let mut seen = std::collections::HashSet::new();
    for candidate in candidates {
        let path = s(&candidate["path"]);
        if !seen.insert(path) {
            continue;
        }
        if repo_key(js::trim(s(&candidate["origin"]))).as_deref() == Some(&key) {
            return Ok(
                json!({"kind":"host.repo.setup","target":format!("{alias}:{key}"),"names":["Clone","Set identity","Check"],"repo":path}),
            );
        }
    }
    let mut error = Error::new("invalid_input", "local repo checkout not found");
    error.hint = Some(
        "Run pacer host setup from the local checkout, or delegate a task for that repo first."
            .into(),
    );
    Err(error)
}
