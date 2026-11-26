//! Server effects for native `dispatch.enforcement.probe` (B2-12): the
//! agent-session control call and the B1 job runtime that owns the canary.
#![allow(clippy::result_large_err)]
use crate::native::plugins::Service;
use pacer_delegation::{
    enforcement_probe::{JobStarter, probe},
    runtime::PluginCalls,
};
use pacer_dispatch::VersionCache;
use pacer_dispatch_ops::enforcement_ops::ProbeEffects;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use pacer_plugin_ops::ipc::CoreIpc;
use serde_json::{Value, json};
use std::{fs, path::PathBuf, sync::Arc, time::Duration};

/// The server's plugin-call implementation for delegation effects.
pub(crate) struct CorePluginCalls<'a> {
    service: &'a Service,
    core: (Arc<dyn CoreIpc>, String),
}

impl<'a> CorePluginCalls<'a> {
    pub(crate) fn new(service: &'a Service, core: (Arc<dyn CoreIpc>, String)) -> Self {
        Self { service, core }
    }
}

impl PluginCalls for CorePluginCalls<'_> {
    fn providers(&self, _ctx: &Ctx, _method: &str) -> Vec<String> {
        // The probe calls the host-owned `pacer-agent-session` adapter by id.
        Vec::new()
    }

    fn call<'a>(
        &'a self,
        _ctx: &'a Ctx,
        plugin: &'a str,
        method: &'a str,
        params: Value,
        deadline: Duration,
    ) -> OpFuture<'a> {
        let service = self.service;
        let core = self.core.clone();
        Box::pin(async move {
            let call = service.call_method(async move { Some(core) }, plugin, method, params);
            tokio::time::timeout(deadline, call)
                .await
                .map_err(|_| CoreError::new(Code::Unavailable, "plugin call timed out"))?
        })
    }
}

fn job_path(ctx: &Ctx, id: &str) -> PathBuf {
    ctx.pacer_home.join("state").join("jobs").join(format!("{id}.json"))
}

fn save(ctx: &Ctx, id: &str, job: &Value) -> Result<(), CoreError> {
    write_private(&job_path(ctx, id), job.to_string().as_bytes())
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))
}

fn uuid() -> String {
    let bytes: [u8; 16] = rand::random();
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

/// The B1 job runtime: a `jobs`-locked file in `state/jobs`, settled in process
/// once the canary completes. `job.get` reads the same file across both doors.
pub(crate) struct NativeJobs;

impl JobStarter for NativeJobs {
    fn start<'a>(
        &'a self,
        ctx: &'a Ctx,
        kind: &'a str,
        target: &'a str,
        steps: &'a [String],
        work: OpFuture<'a>,
    ) -> OpFuture<'a> {
        Box::pin(async move {
            let dir = ctx.pacer_home.join("state").join("jobs");
            fs::create_dir_all(&dir)
                .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?;
            let (id, mut job) = with_lock(ctx, "jobs", LockOptions::default(), || {
                let id = uuid();
                let job = json!({
                    "id": id, "kind": kind, "target": target, "state": "running",
                    "steps": steps.iter().map(|name| json!({"name": name, "state": "pending"})).collect::<Vec<_>>(),
                    "startedAt": ctx.now, "pid": std::process::id(), "cancellable": false,
                });
                save(ctx, &id, &job)?;
                Ok::<_, CoreError>((id, job))
            })
            .map_err(|e| CoreError::new(Code::Internal, e.to_string()))??;
            job["steps"][0]["state"] = json!("running");
            save(ctx, &id, &job)?;
            match work.await {
                Ok(_) => {
                    job["steps"][0]["state"] = json!("passed");
                    job["steps"][0]["detail"] = json!("Native child blocking verified");
                    job["state"] = json!("passed");
                }
                Err(error) => {
                    job["steps"][0]["state"] = json!("failed");
                    job["state"] = json!("failed");
                    job["error"] = json!({"code": error.code, "message": error.message});
                }
            }
            job["endedAt"] = json!(ctx.now);
            save(ctx, &id, &job)?;
            Ok(job)
        })
    }
}

/// Binds the native probe to the door's plugin channel and version cache.
pub(crate) struct NativeProbeEffects<'a> {
    plugins: CorePluginCalls<'a>,
    jobs: NativeJobs,
    cache: &'a VersionCache,
}

impl<'a> NativeProbeEffects<'a> {
    pub(crate) fn new(
        service: &'a Service,
        core: (Arc<dyn CoreIpc>, String),
        cache: &'a VersionCache,
    ) -> Self {
        Self {
            plugins: CorePluginCalls::new(service, core),
            jobs: NativeJobs,
            cache,
        }
    }
}

impl ProbeEffects for NativeProbeEffects<'_> {
    fn run<'a>(
        &'a mut self,
        ctx: &'a Ctx,
        strategy: Value,
        runner: &'a str,
        repo: &'a str,
    ) -> OpFuture<'a> {
        Box::pin(probe(
            ctx,
            &strategy,
            runner,
            repo,
            &self.plugins,
            &self.jobs,
            self.cache,
        ))
    }
}
