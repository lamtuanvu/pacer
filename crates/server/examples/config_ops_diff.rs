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
        let ctx = Ctx::with(
            home.into(),
            home.into(),
            env,
            input["now"].as_f64().unwrap_or(1_700_000_000.0),
        );
        let registry = pacer_server::native::registry("");
        let name = input["op"].as_str().unwrap_or("");
        let op = registry
            .get(name)
            .ok_or_else(|| io::Error::other("missing native op"))?;
        let result = pacer_server::native::call_native(
            &ctx,
            op,
            input["params"].clone(),
            None,
            Some(Box::pin(async { Ok(Value::Null) })),
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
