//! Native-registry parity driver on caller-created disposable homes. Endpoint
//! bridge integration is exercised separately by the fixed live fixture.
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};
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
        if pacer_server::native::assistant_stays_forwarded(&ctx, name, &input["params"])
            || pacer_server::native::repo_registry_stays_forwarded(&ctx, name, &input["params"])
            || pacer_server::native::runner_attention_stays_forwarded(&ctx, name, &input["params"])
            || pacer_server::native::service_agent_stays_forwarded(&ctx, name, &input["params"])
        {
            serde_json::to_writer(&mut stdout, &json!({"forwarded":true}))?;
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
        let core_bridge_sync = if name == "setup.check" {
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
