use super::*;
use crate::NativeGit;
use std::time::Duration;

async fn remove_owned(
    c: &OrcaClient,
    j: &mut Journal,
    w: &Value,
    force: bool,
) -> Result<bool, BrokerError> {
    let id = string(w, "id")?;
    let path = string(w, "path")?;
    let shown = c
        .call(
            &["worktree", "show", "--worktree", &format!("id:{id}")],
            30000,
        )
        .await?;
    if shown["ok"] != true {
        return Ok(shown["error"]["code"] == "selector_not_found");
    }
    let actual = &shown["result"]["worktree"];
    if actual["id"] != id
        || actual["displayName"] != w["name"]
        || actual["isMainWorktree"] == true
        || actual["path"]
            .as_str()
            .is_none_or(|p| real(p) != real(path))
    {
        return Ok(false);
    }
    let selector = format!("id:{id}");
    let mut args = vec!["worktree", "rm", "--worktree", &selector];
    if force {
        args.push("--force");
    }
    let removed = c.call(&args, 60000).await?;
    if removed["ok"] != true {
        return Ok(false);
    }
    j.mutate(|s| {
        s["removed"][id] = json!({"id":id,"path":path,"at":now()});
        Ok(())
    })
    .await?;
    for _ in 0..20 {
        if !Path::new(path).exists() {
            return Ok(true);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Ok(!Path::new(path).exists())
}
pub(super) async fn empty_group(
    c: &OrcaClient,
    j: &mut Journal,
    git: &NativeGit,
    repo: &str,
    group: &str,
    deadline: Instant,
) -> Result<(), BrokerError> {
    let lock = j.lock_named("orca-group").await?;
    let key = format!("{repo}:{group}");
    let state = j.read()?;
    let Some(selector) = state["groups"][&key]["selector"].as_str() else {
        return Ok(());
    };
    let shown = c
        .call(&["worktree", "show", "--worktree", selector], 30000)
        .await?;
    if shown["ok"] != true {
        if shown["error"]["code"] == "selector_not_found" {
            j.mutate(|s| {
                s["groups"].as_object_mut().map(|o| o.remove(&key));
                Ok(())
            })
            .await?;
        }
        return Ok(());
    }
    let w = &shown["result"]["worktree"];
    if w["childWorktreeIds"]
        .as_array()
        .is_none_or(|a| !a.is_empty())
    {
        return Ok(());
    }
    let path = selector.strip_prefix("path:").ok_or_else(denied)?;
    if !git
        .text(path, &["status", "--porcelain"], &[], deadline)
        .await?
        .is_empty()
    {
        return Ok(());
    }
    let owned = json!({"id":w["id"],"path":path,"name":format!("pacer-group-{group}")});
    if remove_owned(c, j, &owned, false).await? {
        j.mutate(|s| {
            s["groups"].as_object_mut().map(|o| o.remove(&key));
            Ok(())
        })
        .await?;
    }
    drop(lock);
    Ok(())
}
pub(super) async fn live_lane(
    c: &OrcaClient,
    j: &Journal,
    git: &NativeGit,
    task: &Value,
    live: &Value,
    deadline: Instant,
) -> Result<Option<Value>, BrokerError> {
    let state = j.read()?;
    let path = state["workers"][string(live, "worker")?]["worktree"]
        .as_str()
        .or(task["worktree"].as_str());
    let Some(path) = path else {
        return Ok(None);
    };
    if task["brief"]["repo"]
        .as_str()
        .is_some_and(|p| real(p) == real(path))
    {
        return Ok(None);
    }
    let top = git
        .text(path, &["rev-parse", "--show-toplevel"], &[], deadline)
        .await?;
    let name = Path::new(&top)
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(denied)?;
    if !regex::Regex::new(r"^pacer-t-\d{8}-\d{6}-[0-9a-f]{4}-").is_ok_and(|r| r.is_match(name))
        || !name.ends_with(&format!(
            "-{}",
            crate::orca_policy::name(string(live, "executor")?)
        ))
    {
        return Ok(None);
    }
    let shown = c
        .call(
            &["worktree", "show", "--worktree", &format!("path:{top}")],
            30000,
        )
        .await?;
    if shown["ok"] != true || shown["result"]["worktree"]["id"].as_str().is_none() {
        return Ok(None);
    }
    Ok(Some(
        json!({"id":shown["result"]["worktree"]["id"],"path":top,"name":name}),
    ))
}
#[allow(clippy::too_many_arguments)]
pub(super) async fn release_lane(
    home: &Path,
    task: &Value,
    w: Option<&Value>,
    c: &OrcaClient,
    j: &mut Journal,
    git: Option<&NativeGit>,
    deadline: Instant,
    settled: bool,
) -> Result<bool, BrokerError> {
    let Some(w) = w else {
        return Ok(false);
    };
    let id = string(task, "id")?;
    let mut store = TaskStore::open(home)?;
    let current = store.read(id)?.ok_or_else(denied)?;
    if current["interactionMode"] != "conversation" || (current["state"] != "stopped" && !settled) {
        return Ok(false);
    }
    let Some(git) = git else {
        return Ok(false);
    };
    let path = string(w, "path")?;
    if !git
        .text(path, &["status", "--porcelain"], &[], deadline)
        .await?
        .is_empty()
    {
        return Ok(false);
    }
    let Some(base) = current["baseSha"]
        .as_str()
        .or(current["baseBranch"].as_str())
        .filter(|s| !s.is_empty())
    else {
        return Ok(false);
    };
    let count = git
        .text(
            path,
            &["rev-list", "--count", &format!("{base}..HEAD")],
            &[],
            deadline,
        )
        .await?;
    if !count.is_empty() && crate::js_semantics::number_text(&count) != Some(0.0) {
        return Ok(false);
    }
    if !remove_owned(c, j, w, true).await? {
        j.mutate(|s| {
            s["stranded"][id] = w.clone();
            s["stranded"][id]["taskId"] = json!(id);
            s["stranded"][id]["at"] = json!(now());
            Ok(())
        })
        .await?;
        return Ok(false);
    }
    if let (Some((repo, _)), Some(group)) =
        (string(w, "id")?.split_once("::"), current["group"].as_str())
    {
        // A parent cleanup failure must not hide successful lane removal.
        let _ = empty_group(c, j, git, repo, group, deadline).await;
    }
    let gone = |p: &Value| {
        p.as_str()
            .is_some_and(|p| p == path || p.starts_with(&format!("{path}/")))
    };
    store.update(id, crate::native_run::rev(&current)?, now(), |t| {
        if gone(&t["worktree"]) {
            t.as_object_mut().map(|o| o.remove("worktree"));
        }
        if gone(&t["result"]["worktree"]) {
            t["result"].as_object_mut().map(|o| o.remove("worktree"));
        }
        t["worktreeReleased"] = json!({"at":now(),"path":path});
    })?;
    Ok(true)
}
