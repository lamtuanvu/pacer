//! Job transitions. Persistence, cancellation signals and restart handover remain
//! effects owned by the caller; every transition consumes its latest snapshot.
use crate::{Error, a, js, n, s, truth};
use serde_json::{Value, json};

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
}
fn settle(job: &mut Value) {
    let failed = job["state"] == "failed";
    if let Some(steps) = job["steps"].as_array_mut() {
        for step in steps {
            if step["state"] == "running" {
                step["state"] = if failed { "failed" } else { "skipped" }.into();
            }
            if step["state"] == "pending" {
                step["state"] = "skipped".into();
            }
        }
    }
}
pub fn cancel(job: &Value, time: f64) -> Result<Value, Error> {
    if !truth(&job["cancellable"]) {
        return Err(Error::new("not_allowed", "job is not cancellable"));
    }
    let mut out = job.clone();
    if out["state"] == "running" {
        out["state"] = "cancelled".into();
        out["endedAt"] = json!(time);
        settle(&mut out);
    }
    Ok(out)
}
/// Whether a stored PID can even be queried by the effectful liveness adapter.
pub fn query_pid(pid: f64) -> bool {
    pid.is_finite() && pid.fract() == 0.0 && pid > 0.0
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recovery {
    Unchanged,
    Save,
    Handover,
}
pub fn recover(
    job: &Value,
    time: f64,
    version: &str,
    pid_alive: bool,
    after_restart: bool,
) -> (Value, Recovery) {
    let mut out = job.clone();
    if job["state"] != "running" {
        return (out, Recovery::Unchanged);
    }
    let restart = if job["kind"] == "update.apply" {
        a(&job["steps"])
            .iter()
            .position(|step| step["name"] == "Restart" && step["state"] == "running")
    } else {
        None
    };
    if let Some(index) = restart
        && job["steps"][index]["detail"] == version
    {
        if after_restart {
            return (out, Recovery::Handover);
        }
        out["steps"][index]["state"] = "passed".into();
        out["state"] = "passed".into();
        out["endedAt"] = json!(time);
        return (out, Recovery::Save);
    }
    if query_pid(n(&job["pid"])) && pid_alive {
        return (out, Recovery::Unchanged);
    }
    out["state"] = "failed".into();
    out["endedAt"] = json!(time);
    out["error"] = json!({"code":"interrupted","message":"pacer restarted while this was running"});
    settle(&mut out);
    (out, Recovery::Save)
}
/// Complete an asynchronous afterRestart using the latest stored row. Cancelled
/// or already settled jobs win; unlike normal completion this leaves other steps.
pub fn finish_restart(latest: &Value, time: f64, detail: &str, error: bool) -> Value {
    let mut out = latest.clone();
    if out["state"] != "running" {
        return out;
    }
    if let Some(steps) = out["steps"].as_array_mut()
        && let Some(step) = steps.iter_mut().find(|step| step["name"] == "Restart")
    {
        step["state"] = if error { "failed" } else { "passed" }.into();
        step["detail"] = detail.into();
    }
    out["state"] = if error { "failed" } else { "passed" }.into();
    out["endedAt"] = json!(time);
    if error {
        out["error"] = json!({"code":"interrupted","message":detail});
    }
    out
}
pub fn retained(job: &Value, time: f64) -> bool {
    job["state"] == "running"
        || time
            - n(job
                .get("endedAt")
                .filter(|v| !v.is_null())
                .unwrap_or(&job["startedAt"]))
            <= 86400.0
}
pub fn list(jobs: &[Value], time: f64, target: Option<&str>) -> Vec<Value> {
    let mut out: Vec<_> = jobs
        .iter()
        .filter(|j| retained(j, time) && target.is_none_or(|t| s(&j["target"]) == t))
        .cloned()
        .collect();
    out.sort_by(|a, b| {
        n(&b["startedAt"])
            .partial_cmp(&n(&a["startedAt"]))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| js::compare(s(&a["id"]), s(&b["id"])))
    });
    out
}
pub fn create(
    id: &str,
    kind: &str,
    target: &str,
    steps: &[Value],
    time: f64,
    pid: f64,
    cancellable: bool,
) -> Value {
    json!({"id":id,"kind":kind,"target":target,"state":"running","steps":steps.iter().map(|name|json!({"name":name,"state":"pending"})).collect::<Vec<_>>(),"startedAt":time,"pid":pid,"cancellable":cancellable})
}
pub fn existing(jobs: &[Value], kind: &str, target: &str, time: f64) -> Option<Value> {
    list(jobs, time, Some(target))
        .into_iter()
        .find(|j| s(&j["kind"]) == kind && j["state"] == "running")
}
pub fn update(
    job: &mut Value,
    latest: &Value,
    name: &str,
    state: &str,
    detail: Option<&str>,
) -> Result<(), Error> {
    if latest["state"] != "running" {
        return Ok(());
    }
    let step = job["steps"]
        .as_array_mut()
        .and_then(|steps| steps.iter_mut().find(|s| s["name"] == name))
        .ok_or_else(|| Error::new("invalid_input", format!("unknown job step {name}")))?;
    step["state"] = state.into();
    if let Some(detail) = detail {
        step["detail"] = detail.into();
    }
    Ok(())
}
pub fn finish(
    job: &Value,
    latest: &Value,
    time: f64,
    await_restart: bool,
    error: Option<&Error>,
) -> Value {
    if latest["state"] != "running" {
        return latest.clone();
    }
    let mut out = job.clone();
    let failed = a(&job["steps"]).iter().find(|s| s["state"] == "failed");
    let err = error.cloned().or_else(|| {
        failed.map(|step| {
            Error::new(
                "failed",
                step["detail"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("step failed: {}", s(&step["name"]))),
            )
        })
    });
    if let Some(err) = err {
        out["state"] = "failed".into();
        out["error"] = json!({"code":err.code,"message":err.message});
    } else {
        out["state"] = if await_restart
            && a(&job["steps"])
                .iter()
                .any(|s| s["name"] == "Restart" && s["state"] == "running")
        {
            "running"
        } else {
            "passed"
        }
        .into();
    }
    if out["state"] == "running" {
        return out;
    }
    out["endedAt"] = json!(time);
    settle(&mut out);
    out
}
