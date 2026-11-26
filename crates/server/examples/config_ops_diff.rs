//! Native-registry parity driver on caller-created disposable homes. Endpoint
//! bridge integration is exercised separately by the fixed live fixture.
use pacer_foundation::{Ctx, api::OpFuture};
use pacer_install::install_ops::ServiceEffects;
use pacer_update::apply::UpdateEffects;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

/// Records the Core effects a native op requests and answers each with `effectResult`.
struct Effects {
    reply: Value,
    requests: Vec<Value>,
}

impl Effects {
    fn record(&mut self, request: Value) -> OpFuture<'_> {
        self.requests.push(request);
        let reply = self.reply.clone();
        Box::pin(async move { Ok(reply) })
    }
}

impl ServiceEffects for Effects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.record(request)
    }
}

impl UpdateEffects for Effects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.record(request)
    }
}

impl pacer_update::handover::HandoverBridge for Effects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.record(request)
    }
}

impl pacer_update::onboarding::OnboardingBridge for Effects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.record(request)
    }
}

/// Answers `terminal.*` bridge requests by kind from `terminalParts` and records them.
struct Terminal {
    replies: Value,
    requests: Vec<Value>,
}

impl pacer_task_ops::terminal_ops::TerminalBridge for Terminal {
    fn parts(&mut self, request: Value) -> OpFuture<'_> {
        let reply = self.replies[request["kind"].as_str().unwrap_or("")].clone();
        self.requests.push(request);
        Box::pin(async move { Ok(reply) })
    }
}

impl pacer_install::agent_ops::AgentEffects for Effects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.record(request)
    }
}

/// A check job decided from the case snapshot the parity test supplies.
struct CaseStarter {
    case: Value,
}

impl pacer_config_ops::runner_check_ops::JobStarter for CaseStarter {
    fn start<'a>(&'a self, ctx: &'a Ctx, _: &'a Value) -> OpFuture<'a> {
        let case = self.case.clone();
        Box::pin(async move { pacer_delegation::runner_check::run_case(ctx, &case) })
    }
}

/// Records the argv an interactive `runner.add` would open.
struct RecordingTerminal;

impl pacer_config_ops::runner_ops::TerminalOpener for RecordingTerminal {
    fn open<'a>(
        &'a self,
        ctx: &'a Ctx,
        argv: &[String],
        title: &str,
        _worktree: Option<&str>,
    ) -> OpFuture<'a> {
        let line = serde_json::to_string(argv).unwrap_or_default();
        let argv = argv.to_vec();
        let title = title.to_string();
        Box::pin(async move {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(ctx.pacer_home.join("terminal-open.log"))
                .map_err(|error| {
                    pacer_foundation::api::CoreError::new(
                        pacer_foundation::api::Code::Internal,
                        error.to_string(),
                    )
                })?;
            writeln!(file, "{line}").map_err(|error| {
                pacer_foundation::api::CoreError::new(
                    pacer_foundation::api::Code::Internal,
                    error.to_string(),
                )
            })?;
            Ok(json!({"opened": true, "argv": argv, "title": title}))
        })
    }
}

/// Answers `dispatch.preview`/`dispatch.explain` bridge requests from the parts TypeScript
/// computed for every runner (`dispatchParts`), keeping the runners asked for, and records them.
struct Preview {
    status: Value,
    parts: Value,
    requests: Vec<Value>,
}

impl pacer_dispatch_ops::preview_ops::Bridge for Preview {
    fn status(&mut self, params: Value) -> OpFuture<'_> {
        let parts = match params.get("draft") {
            Some(_) => json!({"current": self.status, "draft": self.status}),
            None => self.status.clone(),
        };
        self.requests.push(params);
        Box::pin(async move { Ok(parts) })
    }
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        let rows = |all: &Value| -> Vec<Value> {
            let asked = params["runners"].as_array().cloned().unwrap_or_default();
            asked
                .iter()
                .filter_map(|r| {
                    all.as_array()?
                        .iter()
                        .find(|row| row["runner"] == *r)
                        .cloned()
                })
                .collect()
        };
        let reply = if params["kind"] == "dispatch.executor-guards" {
            let guards = &self.parts["guards"];
            json!({"guards": rows(&guards["guards"]), "admissionHooks": guards["admissionHooks"]})
        } else {
            json!(rows(&self.parts["enforcement"]))
        };
        self.requests.push(params);
        Box::pin(async move { Ok(reply) })
    }
}

/// Answers `dispatch.enforcement` and `dispatch.enforcement.denied` bridge requests from the parts
/// TypeScript computed (`dispatchParts`), keeping the runners asked for, and records them. The
/// `dispatch.enforcement-diagnostics` reply keeps its top-level `scheduled`.
struct Enforcement {
    parts: Value,
    requests: Vec<Value>,
}

impl pacer_dispatch_ops::enforcement_ops::Bridge for Enforcement {
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        let rows = |all: &Value| -> Vec<Value> {
            let asked = params["runners"].as_array().cloned().unwrap_or_default();
            asked
                .iter()
                .filter_map(|r| {
                    all.as_array()?
                        .iter()
                        .find(|row| row["runner"] == *r)
                        .cloned()
                })
                .collect()
        };
        let reply = if params["kind"] == "dispatch.enforcement-diagnostics" {
            let diag = &self.parts["enforcementDiagnostics"];
            let mut reply = diag.clone();
            reply["runners"] = json!(rows(&diag["runners"]));
            reply
        } else {
            json!(rows(&self.parts["enforcement"]))
        };
        self.requests.push(params);
        Box::pin(async move { Ok(reply) })
    }
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line?).map_err(io::Error::other)?;
        if let Some(ms) = input["sleepMs"].as_u64() {
            tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
        }
        let home = input["home"]
            .as_str()
            .ok_or_else(|| io::Error::other("missing fixture home"))?;
        let mut env = std::collections::HashMap::new();
        env.insert(
            "PACER_ORCA_USER_DATA".into(),
            format!("{home}/orca-user-data"),
        );
        if let Some(agent) = input["agent"].as_str() {
            env.insert("PACER_AGENT".into(), agent.into());
        }
        for (key, value) in input["env"].as_object().into_iter().flatten() {
            env.insert(key.clone(), value.as_str().unwrap_or_default().into());
        }
        let ctx = Ctx::with(
            home.into(),
            home.into(),
            env,
            input["now"].as_f64().unwrap_or(1_700_000_000.0),
        );
        pacer_server::native::set_identity_platform_for_tests(input["identityPlatform"].as_str());
        if let Some(outputs) = input["probeOutputs"].as_object() {
            pacer_server::native::set_probe_outputs_for_tests(Some(
                outputs
                    .iter()
                    .map(|(argv, out)| (argv.clone(), out.as_str().unwrap_or_default().into()))
                    .collect(),
            ));
        }
        let registry = pacer_server::native::registry("");
        let name = input["op"].as_str().unwrap_or("");
        if pacer_server::native::discovery_stays_forwarded(&ctx, name, &input["params"])
            || pacer_server::native::desktop_reconcile_stays_forwarded(name)
        {
            serde_json::to_writer(&mut stdout, &json!({"forwarded": true}))?;
            stdout.write_all(b"\n")?;
            continue;
        }
        let op = registry
            .get(name)
            .ok_or_else(|| io::Error::other("missing native op"))?;
        if name == "runner.check" || name == "runner.add" {
            let starter = CaseStarter {
                case: input["runnerCheckCase"].clone(),
            };
            let result = if name == "runner.check" {
                pacer_config_ops::runner_check_ops::runner_check_native(
                    &ctx,
                    input["params"].clone(),
                    &starter,
                )
                .await
            } else {
                pacer_config_ops::runner_ops::runner_add_native(
                    &ctx,
                    input["params"].clone(),
                    &starter,
                    &RecordingTerminal,
                )
                .await
            };
            let output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if pacer_server::native::assistant_stays_forwarded(&ctx, name, &input["params"])
            || pacer_server::native::repo_registry_stays_forwarded(&ctx, name, &input["params"])
            || pacer_server::native::service_agent_stays_forwarded(&ctx, name, &input["params"])
            || pacer_server::native::status_residue_stays_forwarded(&ctx, name, &input["params"])
            || (name == "config.set"
                && pacer_server::native::config_set_stays_forwarded(&ctx, &input["params"]))
        {
            serde_json::to_writer(&mut stdout, &json!({"forwarded":true}))?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if pacer_task_ops::terminal_ops::uses_bridge(name) {
            if pacer_server::native::terminal_stays_forwarded(&ctx, name, &input["params"]) {
                serde_json::to_writer(&mut stdout, &json!({"forwarded":true}))?;
                stdout.write_all(b"\n")?;
                continue;
            }
            let mut bridge = Terminal {
                replies: input["terminalParts"].clone(),
                requests: Vec::new(),
            };
            let params = input["params"].clone();
            let result = pacer_task_ops::terminal_ops::call(&ctx, name, params, &mut bridge).await;
            let mut output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            output["bridge"] = json!(bridge.requests);
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if pacer_dispatch_ops::preview_ops::needs_dispatch_parts(name) {
            if pacer_server::native::dispatch_preview_stays_forwarded(&ctx, name, &input["params"])
            {
                serde_json::to_writer(&mut stdout, &json!({"forwarded":true}))?;
                stdout.write_all(b"\n")?;
                continue;
            }
            let mut bridge = Preview {
                status: input["statusParts"].clone(),
                parts: input["dispatchParts"].clone(),
                requests: Vec::new(),
            };
            let result = pacer_dispatch_ops::preview_ops::dispatch_preview(
                &ctx,
                name,
                input["params"].clone(),
                &mut bridge,
            )
            .await;
            let mut output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            output["bridge"] = json!(bridge.requests);
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if pacer_dispatch_ops::enforcement_ops::needs_dispatch_parts(name)
            || name == "dispatch.enforcement.probe"
        {
            if pacer_server::native::dispatch_enforcement_stays_forwarded(
                &ctx,
                name,
                &input["params"],
            ) {
                serde_json::to_writer(&mut stdout, &json!({"forwarded":true}))?;
                stdout.write_all(b"\n")?;
                continue;
            }
            if name == "dispatch.enforcement.probe" {
                let result = pacer_dispatch_ops::enforcement_ops::dispatch_enforcement_probe(
                    &ctx,
                    input["params"].clone(),
                )
                .await;
                let output = match result {
                    Ok(value) => json!({"result":value}),
                    Err(error) => error.body(),
                };
                serde_json::to_writer(&mut stdout, &output)?;
                stdout.write_all(b"\n")?;
                continue;
            }
            let mut bridge = Enforcement {
                parts: input["dispatchParts"].clone(),
                requests: Vec::new(),
            };
            let result = if name == "dispatch.enforcement" {
                pacer_dispatch_ops::enforcement_ops::dispatch_enforcement(
                    &ctx,
                    input["params"].clone(),
                    &mut bridge,
                )
                .await
            } else {
                pacer_dispatch_ops::enforcement_ops::dispatch_enforcement_denied(
                    &ctx,
                    input["params"].clone(),
                    &mut bridge,
                )
                .await
            };
            let mut output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            output["bridge"] = json!(bridge.requests);
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if name == "service.install" || name == "update.apply" {
            let mut effects = Effects {
                reply: input.get("effectResult").cloned().unwrap_or(Value::Null),
                requests: Vec::new(),
            };
            let params = input["params"].clone();
            let result = if name == "service.install" {
                pacer_install::install_ops::service_install(&ctx, params, &mut effects).await
            } else {
                pacer_update::apply::update_apply(&ctx, params, &mut effects).await
            };
            let mut output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            output["effects"] = json!(effects.requests);
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if pacer_update::handover::uses_effects(name) {
            let mut effects = Effects {
                reply: input.get("effectResult").cloned().unwrap_or(Value::Null),
                requests: Vec::new(),
            };
            let params = input["params"].clone();
            let result =
                pacer_update::handover::call(&ctx, name, params, false, &mut effects).await;
            let mut output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            output["effects"] = json!(effects.requests);
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if pacer_update::onboarding::uses_effects(name) {
            let mut effects = Effects {
                reply: input.get("effectResult").cloned().unwrap_or(Value::Null),
                requests: Vec::new(),
            };
            let params = input["params"].clone();
            let result =
                pacer_update::onboarding::call(&ctx, name, params, false, &mut effects).await;
            let mut output = match result {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            output["effects"] = json!(effects.requests);
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        if pacer_install::agent_ops::uses_effects(name) {
            let mut effects = Effects {
                reply: input.get("effectResult").cloned().unwrap_or(Value::Null),
                requests: Vec::new(),
            };
            let result = pacer_install::agent_ops::agent_call(
                &ctx,
                name,
                input["params"].clone(),
                &mut effects,
            )
            .await;
            let mut output = match result {
                Ok(value) => json!({"result": value}),
                Err(error) => error.body(),
            };
            output["effects"] = json!(effects.requests);
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        let host_sync = if name == "config.get" {
            let host_parts = input.get("hostParts").cloned().unwrap_or(Value::Null);
            Some(Box::pin(async move { Ok(host_parts) }) as pacer_foundation::api::OpFuture<'_>)
        } else {
            None
        };
        let host_read_sync = if name == "host.list" || name == "host.get" {
            let host_parts = input.get("hostParts").cloned().unwrap_or(Value::Null);
            Some(Box::pin(async move { Ok(host_parts) }) as pacer_foundation::api::OpFuture<'_>)
        } else {
            None
        };
        if input["bridgeEcho"] == json!(true) {
            // The request Core would receive, without answering it.
            let output = match pacer_server::native::core_bridge_params(name, &input["params"]) {
                Ok(value) => json!({"result":value}),
                Err(error) => error.body(),
            };
            serde_json::to_writer(&mut stdout, &output)?;
            stdout.write_all(b"\n")?;
            continue;
        }
        let core_bridge_sync = if matches!(
            name,
            "setup.check"
                | "setup.health"
                | "doctor.run"
                | "desktop.capture.register"
                | "desktop.capture.targets"
                | "desktop.capture.request"
                | "desktop.capture.claim"
                | "desktop.capture.complete"
                | "desktop.capture.result"
                | "desktop.update.status"
                | "desktop.update.check"
                | "desktop.update.download"
                | "desktop.update.restart"
                | "desktop.update.cancel"
                | "desktop.update.adopt"
                | "desktop.update.adoptCancel"
                | "desktop.update.configure"
        ) {
            let bridge_result = input.get("bridgeResult").cloned().unwrap_or(Value::Null);
            Some(Box::pin(async move { Ok(bridge_result) }) as pacer_foundation::api::OpFuture<'_>)
        } else {
            None
        };
        let broker_parts = input.get("brokerParts").cloned();
        let broker_sync = broker_parts
            .map(|parts| Box::pin(async move { Ok(parts) }) as pacer_foundation::api::OpFuture<'_>);
        let snapshot_parts = input.get("snapshotParts").cloned();
        let snapshot_sync = snapshot_parts
            .map(|parts| Box::pin(async move { Ok(parts) }) as pacer_foundation::api::OpFuture<'_>);
        let result = pacer_server::native::call_native(
            &ctx,
            op,
            input["params"].clone(),
            None,
            Some(Box::pin(async { Ok(Value::Null) })),
            broker_sync,
            None,
            None,
            host_sync,
            snapshot_sync,
            None,
            host_read_sync,
            core_bridge_sync,
            None,
            None,
            None,
            None,
            None,
        None,
        )
        .await;
        let output = match result {
            Ok(value) => json!({"result":value}),
            Err(error) => error.body(),
        };
        serde_json::to_writer(&mut stdout, &output)?;
        stdout.write_all(b"\n")?;
    }
    stdout.flush()
}
