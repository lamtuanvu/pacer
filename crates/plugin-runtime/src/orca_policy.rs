//! Host composition of the TS Orca preparation and launch policy. Never plugin input.
use super::orca_attempt::{client::OrcaClient, journal::Journal, real};
use crate::{BrokerError, OrcaAttemptSpec, OrcaPlacement, WireReply, native_command::denied};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Instant,
};

#[derive(Clone, Default)]
pub struct LoginEnvironment {
    pub env: HashMap<String, String>,
    pub profile_keys: Vec<String>,
    pub login_shell: bool,
}
#[derive(Clone)]
pub struct OrcaPolicy {
    pub provider: Value,
    pub execution: Value,
    pub strategy: Value,
    pub user_home: PathBuf,
    pub login: LoginEnvironment,
}
pub fn resolve_placement(task: &Value, strategy: &str, busy: bool, dirty: bool) -> Value {
    let requested = task["placement"]["requested"].as_str().unwrap_or("");
    let (mode, why) = if ["current", "new"].contains(&requested) {
        (
            requested,
            format!(
                "agent: {}",
                task["placement"]["reason"]
                    .as_str()
                    .map(crate::js_semantics::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("no reason given")
            ),
        )
    } else if busy {
        ("new", "another task is writing there".into())
    } else if task["kind"] == "research" {
        ("current", "read-only kind".into())
    } else if dirty
        && regex::Regex::new("(?i:uncommitted|in[ -]progress|working[ -]tree|unstaged)").is_ok_and(
            |r| {
                r.is_match(
                    &["goal", "context", "scope"]
                        .map(|k| task["brief"][k].as_str().unwrap_or(""))
                        .join("\n"),
                )
            },
        )
    {
        ("current", "builds on uncommitted work".into())
    } else {
        (
            if strategy == "current" {
                "current"
            } else {
                "new"
            },
            "strategy default".into(),
        )
    };
    json!({"mode":mode,"why":why})
}
// The scalar resolver selects policy; stored text is derived from this same
// exact decision snapshot, never from a later CAS revision's preview.
fn resolve_placement_wire(
    task: &WireReply,
    strategy: &str,
    busy: bool,
    dirty: bool,
) -> Result<WireReply, pacer_store::StoreError> {
    let preview = task.preview();
    let mut resolved = WireReply::new(resolve_placement(preview, strategy, busy, dirty));
    if ["current", "new"].contains(&preview["placement"]["requested"].as_str().unwrap_or("")) {
        let reason = if preview["placement"]["reason"].is_string() {
            task.string_at("/placement/reason")?
        } else {
            crate::Utf16String::from_units(Vec::new())
        };
        let units = reason.units();
        let space = |u: &u16| matches!(*u, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff);
        let start = units.iter().position(|u| !space(u)).unwrap_or(units.len());
        let end = units
            .iter()
            .rposition(|u| !space(u))
            .map_or(start, |n| n + 1);
        let mut why: Vec<u16> = "agent: ".encode_utf16().collect();
        if start == end {
            why.extend("no reason given".encode_utf16());
        } else {
            why.extend_from_slice(&units[start..end]);
        }
        resolved.set_string("/why", crate::Utf16String::from_units(why))?;
    }
    Ok(resolved)
}
pub fn account_environment(
    account: &Value,
    agent: &str,
    home: &Path,
    orca_root: Option<&str>,
    login: &LoginEnvironment,
) -> Result<HashMap<String, String>, BrokerError> {
    if account.get("connection").is_some_and(|v| !v.is_null()) {
        return Err(BrokerError::Effect("account environment contains values that cannot be placed in a visible Orca terminal command".into()));
    }
    let var = if agent == "claude" {
        "CLAUDE_CONFIG_DIR"
    } else {
        "CODEX_HOME"
    };
    let source = account["source"].as_str().unwrap_or("default");
    let folder = if ["default", "endpoint", "opencode"].contains(&source) {
        login
            .profile_keys
            .iter()
            .any(|k| k == var && login.login_shell)
            .then(|| login.env.get(var))
            .flatten()
            .filter(|s| s.starts_with('/'))
            .cloned()
    } else if !["claude", "codex"].contains(&account["kind"].as_str().unwrap_or("")) {
        None
    } else if source == "orca" {
        let id = account["orcaAccount"].as_str().ok_or_else(denied)?;
        if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*$").is_ok_and(|r| r.is_match(id)) {
            return Err(denied());
        }
        let root = orca_root.map(PathBuf::from).unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                home.join("Library/Application Support/orca")
            } else {
                home.join(".config/orca")
            }
        });
        let path = root
            .join(if account["kind"] == "claude" {
                "claude-profiles"
            } else {
                "codex-accounts"
            })
            .join(id)
            .join("home");
        if !path.is_dir() {
            return Err(BrokerError::Effect("account folder not found".into()));
        }
        Some(path.to_string_lossy().into_owned())
    } else {
        let value = account["home"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(denied)?;
        Some(if value == "~" {
            home.to_string_lossy().into_owned()
        } else if let Some(tail) = value.strip_prefix("~/") {
            home.join(tail).to_string_lossy().into_owned()
        } else {
            value.into()
        })
    };
    Ok(folder
        .map(|s| HashMap::from([(var.into(), s)]))
        .unwrap_or_default())
}
pub fn launch_argv(
    agent: &str,
    model: Option<&str>,
    worktree: &str,
    tasks: &str,
    top: &str,
) -> Result<Vec<String>, BrokerError> {
    let mut argv = match agent {
        "codex" => {
            let mut roots = vec![worktree];
            if top != worktree {
                roots.push(top);
            }
            let trust = format!(
                "projects={{{}}}",
                roots
                    .iter()
                    .map(|s| format!("{}={{trust_level=\"trusted\"}}", json!(s)))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            vec![
                "codex".into(),
                "--no-daemon".into(),
                "-c".into(),
                trust,
                "-C".into(),
                worktree.into(),
                "--dangerously-bypass-approvals-and-sandbox".into(),
                "--add-dir".into(),
                tasks.into(),
            ]
        }
        "claude" => vec!["claude".into(), "--dangerously-skip-permissions".into()],
        _ => return Err(denied()),
    };
    if let Some(model) = model.filter(|s| !s.is_empty()) {
        argv.extend([
            if agent == "codex" { "-m" } else { "--model" }.into(),
            model.into(),
        ]);
    }
    Ok(argv)
}
pub(super) fn name(s: &str) -> String {
    let s = regex::Regex::new(r"[^\p{L}\p{N}._-]+")
        .map(|r| r.replace_all(s, "-").into_owned())
        .unwrap_or_default();
    let s = regex::Regex::new("-+")
        .map(|r| r.replace_all(&s, "-").into_owned())
        .unwrap_or_default();
    let s = regex::Regex::new(r"\.{2,}")
        .map(|r| r.replace_all(&s, ".").into_owned())
        .unwrap_or_default();
    s.trim_matches(['.', '-']).into()
}
pub(super) async fn coordinator(
    client: &OrcaClient,
    journal: &mut Journal,
    top: &str,
) -> Result<(String, String), BrokerError> {
    // Hold the same cross-runtime coordinator lock across discovery and creation.
    let lock = journal.lock().await?;
    let (mut edit, mut state) = journal.edit(&lock, "coordinator")?;
    let mut handle = state["coordinator"].as_str().unwrap_or("").to_owned();
    let mut run = state["run"].as_str().unwrap_or("").to_owned();
    if !handle.is_empty() {
        let t = client
            .call(&["terminal", "show", "--terminal", &handle], 30000)
            .await?;
        if t["ok"] != true && t["error"]["code"] != "terminal_handle_stale" {
            return Err(reply_error("orca terminal show failed", &t));
        }
        if t["ok"] != true
            || t["result"]["terminal"]["connected"] != true
            || t["result"]["terminal"]["writable"] != true
        {
            handle.clear();
        }
    }
    if handle.is_empty() {
        handle = create_coordinator(client, top).await?;
        run.clear();
    }
    if !run.is_empty() {
        let r = client
            .call(&["orchestration", "run-show", "--id", &run], 30000)
            .await?;
        if r["ok"] != true || r["result"]["run"]["coordinator_handle"] != handle {
            run.clear();
        }
    }
    if run.is_empty() {
        let mut r = create_run(client, &handle).await?;
        if r["ok"] != true
            && (r["error"]["code"] == "consumer_fenced"
                || regex::Regex::new(
                    "consumer_fenced|This terminal is attested as .* cannot act as",
                )
                .is_ok_and(|p| p.is_match(r["error"]["message"].as_str().unwrap_or(""))))
        {
            state["coordinator"] = Value::Null;
            state["run"] = Value::Null;
            edit.write(&state)?;
            let old = handle;
            handle = create_coordinator(client, top).await?;
            if old != handle {
                let _ = client.close(&old).await;
            }
            r = create_run(client, &handle).await?;
        }
        if r["ok"] != true {
            state["coordinator"] = json!(handle);
            state["run"] = Value::Null;
            edit.write(&state)?;
            return Err(reply_error("orca run-create failed", &r));
        }
        run = r["result"]["run"]["id"].as_str().ok_or_else(denied)?.into();
    }
    state["coordinator"] = json!(handle);
    state["run"] = json!(run);
    edit.write(&state)?;
    drop(lock);
    Ok((handle, run))
}
async fn create_coordinator(c: &OrcaClient, top: &str) -> Result<String, BrokerError> {
    let r = c
        .call(
            &[
                "terminal",
                "create",
                "--worktree",
                &format!("path:{top}"),
                "--title",
                "pacer coordinator",
            ],
            30000,
        )
        .await?;
    if r["ok"] != true {
        return Err(reply_error("orca terminal create failed", &r));
    }
    r["result"]["terminal"]["handle"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(denied)
}
async fn create_run(c: &OrcaClient, handle: &str) -> Result<Value, BrokerError> {
    c.call(
        &[
            "orchestration",
            "run-create",
            "--objective",
            "pacer executors",
            "--from",
            handle,
        ],
        30000,
    )
    .await
}
fn reply_error(prefix: &str, r: &Value) -> BrokerError {
    BrokerError::Effect(format!(
        "{prefix}: {} {}",
        r["error"]["code"].as_str().unwrap_or("error"),
        r["error"]["message"].as_str().unwrap_or("")
    ))
}

pub(super) fn selected_agent(provider: &Value) -> Option<&'static str> {
    if provider["via"] == "opencode" {
        return None;
    }
    let id = provider["id"].as_str()?;
    match super::orca_attempt::runner::parse_runner_id(id)?.agent {
        "codex" => Some("codex"),
        "claude-code" => Some("claude"),
        _ => None,
    }
}
pub(super) async fn compose(
    attempt: &mut crate::OrcaAttempt,
    policy: &OrcaPolicy,
) -> Result<Value, BrokerError> {
    let task_wire = attempt.task_wire()?;
    let task = task_wire.preview();
    let id = policy.provider["id"].as_str().ok_or_else(denied)?;
    let agent = selected_agent(&policy.provider).ok_or_else(denied)?;
    let repo = task["brief"]["repo"].as_str().ok_or_else(denied)?;
    let git = attempt.git.as_ref().ok_or_else(denied)?;
    let info = git
        .text(
            repo,
            &[
                "rev-parse",
                "--path-format=absolute",
                "--show-toplevel",
                "--abbrev-ref",
                "HEAD",
                "--git-common-dir",
            ],
            &[],
            attempt.deadline,
        )
        .await?;
    let lines = info
        .split('\n')
        .map(crate::js_semantics::trim)
        .collect::<Vec<_>>();
    let top = *lines.first().filter(|s| !s.is_empty()).ok_or_else(denied)?;
    let branch = *lines.get(1).filter(|s| !s.is_empty()).ok_or_else(denied)?;
    let common = lines.get(2).copied().unwrap_or("");
    let common = if common.is_empty() {
        PathBuf::from(top).join(".git")
    } else {
        PathBuf::from(repo).join(common)
    };
    let main = real(
        common
            .parent()
            .ok_or_else(denied)?
            .to_str()
            .ok_or_else(denied)?,
    );
    let dirty = !git
        .text(top, &["status", "--porcelain"], &[], attempt.deadline)
        .await?
        .is_empty();
    let active = attempt
        .store
        .list(&pacer_store::TaskFilter {
            states: Some(&["running"]),
            ..Default::default()
        })?
        .iter()
        .any(|t| {
            active_task_at(t, &task["id"], top, |p| {
                nix::sys::signal::kill(nix::unistd::Pid::from_raw(p), None).is_ok()
            })
        });
    if active && task["placement"]["requested"] == "current" {
        return Ok(
            json!({"ok":false,"reason":"another pacer task is running in the current worktree; requested current placement refused","refuse":true}),
        );
    }
    let strategy = policy.execution["worktree"].as_str().unwrap_or("new-child");
    let resolved_wire = resolve_placement_wire(&task_wire, strategy, active, dirty)?;
    let resolved = resolved_wire.preview();
    if resolved["mode"] == "current" && resolved["why"] == "strategy default" && dirty {
        return Ok(
            json!({"ok":false,"reason":"current worktree has uncommitted changes","refuse":true}),
        );
    }
    let retry = task["retryOf"].as_str().is_some_and(|s| !s.is_empty())
        && task["worktree"].as_str().is_some_and(|s| !s.is_empty());
    let current = resolved["mode"] == "current" || retry;
    let (base, sha) = if current {
        (
            task["baseBranch"].as_str().unwrap_or(branch).to_owned(),
            task["baseSha"].as_str().map(str::to_owned),
        )
    } else {
        match resolve_base(
            git,
            top,
            &task["brief"],
            &policy.execution,
            strategy == "child-of-current" && task["placement"]["requested"] != "new",
            attempt.deadline,
        )
        .await
        {
            Ok(v) => (v.0, Some(v.1)),
            Err(e) => return Ok(json!({"ok":false,"reason":e.to_string(),"refuse":true})),
        }
    };
    let repos = attempt.client.call(&["repo", "list"], 30000).await?;
    if repos["ok"] != true {
        return Err(reply_error("orca repo list failed", &repos));
    }
    let mut repo_id = repos["result"]["repos"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|r| r["path"].as_str().is_some_and(|p| real(p) == main))
        })
        .and_then(|r| r["id"].as_str())
        .map(str::to_owned);
    if repo_id.is_none() {
        let r = attempt
            .client
            .call(
                &["worktree", "show", "--worktree", &format!("path:{top}")],
                30000,
            )
            .await?;
        if r["ok"] == true {
            repo_id = r["result"]["repo"]["id"]
                .as_str()
                .or(r["result"]["worktree"]["repoId"].as_str())
                .or(r["result"]["worktree"]["repo_id"].as_str())
                .or(r["result"]["worktree"]["repo"]["id"].as_str())
                .map(str::to_owned);
        }
    }
    if repo_id.is_none() {
        if policy.execution["registerRepos"] != true || real(top) != main {
            return Ok(
                json!({"ok":false,"reason":"repository is not an Orca project","refuse":false}),
            );
        }
        let r = attempt
            .client
            .call(
                &["repo", "add", "--path", main.to_str().ok_or_else(denied)?],
                30000,
            )
            .await?;
        if r["ok"] != true {
            return Err(reply_error("orca repo add failed", &r));
        }
        repo_id = r["result"]["repo"]["id"].as_str().map(str::to_owned);
    }
    let repo_id = repo_id.ok_or_else(denied)?;
    let (coordinator, run) = coordinator(&attempt.client, &mut attempt.journal, top).await?;
    let parent = if !current {
        if let Some(group) = task["group"].as_str().filter(|s| !s.is_empty()) {
            Some(
                ensure_group(
                    &attempt.client,
                    &mut attempt.journal,
                    &repo_id,
                    group,
                    sha.as_deref().unwrap_or(&base),
                )
                .await?,
            )
        } else {
            None
        }
    } else {
        None
    };
    let sub = real(repo)
        .strip_prefix(top)
        .ok()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let placement = if current {
        OrcaPlacement::Existing {
            path: if retry {
                task["worktree"].as_str().ok_or_else(denied)?.into()
            } else {
                top.into()
            },
        }
    } else {
        OrcaPlacement::NewChild {
            repo_id,
            name: name(&format!("pacer-{}-{id}", attempt.task_id)),
            base_sha: sha.clone().unwrap_or_else(|| base.clone()),
            parent,
        }
    };
    let mut notes = vec![];
    if !current && dirty {
        notes.push(format!("note: {top} has uncommitted changes; the worker's new worktree starts from {base} without them"));
    }
    let where_ = if current {
        if retry {
            task["worktree"].as_str().unwrap_or(repo).to_owned()
        } else {
            repo.into()
        }
    } else {
        format!(
            "The current working directory: a new Orca worktree of {top} branched from {base}{}{}. Do not edit {top} itself.",
            if task["group"].as_str().is_some_and(|s| !s.is_empty()) {
                format!(", grouped under {}", task["group"].as_str().unwrap_or(""))
            } else {
                String::new()
            },
            if sub.is_empty() {
                String::new()
            } else {
                format!(". Work in its {sub}/ subdirectory")
            }
        )
    };
    let prompt = crate::orca_prompt::build(&task["brief"], &where_, &attempt.task_id);
    attempt.spec = OrcaAttemptSpec {
        executor: id.into(),
        agent: agent.into(),
        model: policy.provider["model"].as_str().map(str::to_owned),
        coordinator,
        run,
        top: top.into(),
        base: base.clone(),
        sub,
        placement,
        notes,
        prompt,
        launch: vec![agent.into()],
        account_env: HashMap::new(),
    };
    attempt.edit(|t| {
        if let Some(sha) = sha {
            t.put("/baseSha", WireReply::new(json!(sha)))?;
        }
        let mut placement = if t.preview()["placement"].is_object() {
            t.subtree("/placement")?
        } else {
            WireReply::new(json!({}))
        };
        if placement.preview().get("requested").is_none() {
            placement.put("/requested", WireReply::new(json!("auto")))?;
        }
        for k in resolved.as_object().into_iter().flatten().map(|(k, _)| k) {
            let path = format!("/{k}");
            placement.put(&path, resolved_wire.subtree(&path)?)?;
        }
        t.put("/placement", placement)?;
        if !retry && t.preview().get("worktree").is_some() {
            t.remove("/worktree")?;
        }
        Ok(())
    })?;
    Ok(json!({"ok":true}))
}
async fn resolve_base(
    git: &crate::NativeGit,
    top: &str,
    brief: &Value,
    ex: &Value,
    allow: bool,
    deadline: Instant,
) -> Result<(String, String), BrokerError> {
    let mut base = brief["base"].as_str().map(str::to_owned).or_else(|| {
        if brief["worktreeBase"] == "head" {
            Some("HEAD".into())
        } else {
            ex["baseBranch"].as_str().map(str::to_owned)
        }
    });
    if base.as_ref().is_none_or(|s| s.is_empty()) && allow && brief.get("worktreeBase").is_none() {
        let remotes = git.text(top, &["remote"], &[], deadline).await?;
        if !remotes.split_whitespace().any(|s| s == "origin") {
            base = Some("HEAD".into());
        }
    }
    if base.as_ref().is_none_or(|s| s.is_empty()) {
        git.text(top,&["fetch","--prune","origin","+refs/heads/*:refs/remotes/origin/*"],&[],deadline).await.map_err(|_|BrokerError::Effect("cannot fetch origin for worktree base; use --worktree-base head to opt in to the current HEAD".into()))?;
        let remote = git
            .text(
                top,
                &["ls-remote", "--symref", "origin", "HEAD"],
                &[],
                deadline,
            )
            .await?;
        let branch=remote.lines().find_map(|s|s.strip_prefix("ref: refs/heads/").and_then(|s|s.strip_suffix("\tHEAD"))).ok_or_else(||BrokerError::Effect("cannot determine origin's default branch; use --worktree-base head or an explicit base".into()))?;
        base = Some(format!("origin/{branch}"));
    }
    let base = base.ok_or_else(denied)?;
    let sha = git
        .text(
            top,
            &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
            &[],
            deadline,
        )
        .await?;
    if !(40..=64).contains(&sha.len())
        || !sha
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(denied());
    }
    Ok((base, sha))
}
async fn ensure_group(
    c: &OrcaClient,
    j: &mut Journal,
    repo: &str,
    group: &str,
    base: &str,
) -> Result<String, BrokerError> {
    if !regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$").is_ok_and(|r| r.is_match(group)) {
        return Err(BrokerError::Effect(
            "group must be 1–40 characters, starting alphanumeric, of letters, digits, - and _"
                .into(),
        ));
    }
    let lock = j.lock_named("orca-group").await?;
    let (mut edit, mut s) = j.edit(&lock, "orca-group")?;
    let key = format!("{repo}:{group}");
    if let Some(selector) = s["groups"][&key]["selector"].as_str() {
        let r = c
            .call(&["worktree", "show", "--worktree", selector], 30000)
            .await?;
        if r["ok"] == true && r["result"]["worktree"].is_object() {
            return Ok(selector.into());
        }
        if r["ok"] != true
            && !regex::Regex::new("(?i:not[_ ]found)")
                .is_ok_and(|p| p.is_match(r["error"]["code"].as_str().unwrap_or("")))
        {
            return Err(reply_error("orca worktree show failed for group", &r));
        }
        s["groups"].as_object_mut().map(|o| o.remove(&key));
        edit.write(&s)?;
    }
    let r = c
        .call(
            &[
                "worktree",
                "create",
                "--name",
                &format!("pacer-group-{group}"),
                "--repo",
                &format!("id:{repo}"),
                "--base-branch",
                base,
                "--setup",
                "skip",
                "--no-parent",
            ],
            30000,
        )
        .await?;
    if r["ok"] != true {
        return Err(reply_error("orca worktree create failed for group", &r));
    }
    let path = r["result"]["worktree"]["path"]
        .as_str()
        .ok_or_else(denied)?;
    let selector = format!("path:{path}");
    s["groups"][key] = json!({"selector":selector});
    edit.write(&s)?;
    drop(lock);
    Ok(selector)
}

fn active_task_at(
    task: &Value,
    current_id: &Value,
    top: &str,
    probe: impl FnOnce(i32) -> bool,
) -> bool {
    if task["id"] == *current_id {
        return false;
    }
    let alive = runner_pid(&task["runnerPid"]).is_some_and(probe);
    let path = task["worktree"]
        .as_str()
        .or(task["result"]["worktree"].as_str())
        .or(task["brief"]["repo"].as_str())
        .map(real);
    alive && path.is_some_and(|p| p.starts_with(real(top)))
}
fn runner_pid(value: &Value) -> Option<i32> {
    crate::js_semantics::safe_i64(value).and_then(|p| i32::try_from(p).ok().filter(|p| *p > 0))
}
#[cfg(test)]
#[path = "orca_policy/tests.rs"]
mod tests;
