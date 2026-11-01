use crate::native::{call_native, registry};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, Registry},
};
use serde_json::{Value, json};
use std::{collections::HashMap, io, process::Stdio};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};

/// Generated from the TypeScript hello bodies; the parity test catches drift.
fn hello_body(version: u8) -> io::Result<Value> {
    let bodies: Value = serde_json::from_str(include_str!("stdio_hello.json"))?;
    Ok(bodies[if version == 3 { "v3" } else { "v2" }].clone())
}

fn hello_version(params: Option<&Value>) -> Result<u8, &'static str> {
    let params = params.filter(|value| !value.is_null());
    let protocol = match params {
        None => None,
        Some(Value::Object(map)) => map.get("protocol").filter(|value| !value.is_null()),
        _ => return Err("hello params must be an object"),
    };
    match protocol {
        None => Ok(2),
        Some(Value::Number(number)) if number.as_f64() == Some(2.0) => Ok(2),
        Some(Value::Number(number)) if number.as_f64() == Some(3.0) => Ok(3),
        _ => Err("protocol must be 2 or 3"),
    }
}

async fn write_line<W: AsyncWrite + Unpin>(out: &Mutex<W>, line: &[u8]) -> io::Result<()> {
    let mut out = out.lock().await;
    out.write_all(line).await?;
    out.flush().await
}

async fn forward_input<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin, O: AsyncWrite + Unpin>(
    mut input: R,
    mut core: W,
    out: &Mutex<O>,
    ctx: &Ctx,
    registry: &Registry<'_>,
) -> io::Result<()> {
    let mut line = Vec::new();
    let mut protocol = 2;
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line).await? == 0 {
            return core.shutdown().await;
        }
        let request = serde_json::from_slice::<Value>(&line).ok();
        let method = request
            .as_ref()
            .and_then(|r| r.get("method"))
            .and_then(Value::as_str);
        let valid = request.as_ref().is_some_and(|r| {
            r["jsonrpc"] == "2.0"
                && r.get("id")
                    .is_none_or(|id| id.is_null() || id.is_string() || id.is_number())
        });
        if method == Some("hello")
            && valid
            && let Some(request) = request.as_ref()
        {
            match hello_version(request.get("params")) {
                Ok(version) => {
                    // The child still owns forwarded operations, so mirror only
                    // the accepted negotiation as a notification before the next line.
                    let notification = json!({"jsonrpc":"2.0", "method":"hello", "params":request.get("params").cloned().unwrap_or(Value::Null)});
                    let mut bytes = serde_json::to_vec(&notification)?;
                    bytes.push(b'\n');
                    core.write_all(&bytes).await?;
                    core.flush().await?;
                    protocol = version;
                    if let Some(id) = request.get("id") {
                        if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
                            eprintln!("native hello {id}");
                        }
                        let response =
                            json!({"jsonrpc":"2.0", "id":id, "result":hello_body(version)?});
                        let mut bytes = serde_json::to_vec(&response)?;
                        bytes.push(b'\n');
                        write_line(out, &bytes).await?;
                    }
                }
                Err(message) => {
                    if let Some(id) = request.get("id") {
                        let response = json!({"jsonrpc":"2.0", "id":id, "error":CoreError::new(Code::InvalidInput, message).rpc()});
                        let mut bytes = serde_json::to_vec(&response)?;
                        bytes.push(b'\n');
                        write_line(out, &bytes).await?;
                    }
                }
            }
            continue;
        }
        if protocol == 3
            && valid
            && let Some(op) = method.and_then(|name| registry.get(name))
            && let Some(request) = request.as_ref()
        {
            let result = call_native(
                ctx,
                op,
                request.get("params").cloned().unwrap_or_else(|| json!({})),
                request.get("id"),
            )
            .await;
            if let Some(id) = request.get("id") {
                let response = match result {
                    Ok(value) => json!({"jsonrpc":"2.0", "id":id, "result":value}),
                    Err(error) => json!({"jsonrpc":"2.0", "id":id, "error":error.rpc()}),
                };
                let mut bytes = serde_json::to_vec(&response)?;
                bytes.push(b'\n');
                write_line(out, &bytes).await?;
            }
            continue;
        }
        core.write_all(&line).await?;
        core.flush().await?;
    }
}

async fn forward_output<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    mut core: R,
    out: &Mutex<W>,
) -> io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if core.read_until(b'\n', &mut line).await? == 0 {
            return Ok(());
        }
        write_line(out, &line).await?;
    }
}

/// Build the runtime only when the CLI selects the stdio transport.
pub fn run_stdio_blocking(core: Vec<String>, env: HashMap<String, String>) -> i32 {
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let code = runtime.block_on(run_stdio(core, env));
            // A blocking stdin read can remain pending after an early core exit.
            runtime.shutdown_background();
            code
        }
        Err(error) => {
            eprintln!("pacer: could not start runtime: {error}");
            1
        }
    }
}

/// One core child per connection; forwarded lines retain their original bytes.
pub async fn run_stdio(core: Vec<String>, env: HashMap<String, String>) -> i32 {
    match proxy(core, env).await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("pacer: stdio proxy: {error}");
            1
        }
    }
}

async fn proxy(core: Vec<String>, env: HashMap<String, String>) -> io::Result<i32> {
    let scoped_work = env.contains_key("PACER_WORK_GRANT");
    let forward = env
        .get("PACER_FORWARD_OPS")
        .map(String::as_str)
        .unwrap_or("");
    if !forward.is_empty() {
        eprintln!("pacer: PACER_FORWARD_OPS={forward}");
    }
    let registry = registry(if scoped_work { "*" } else { forward });
    let (program, prefix) = core
        .split_first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty core argv"))?;
    let mut child = Command::new(program)
        .args(prefix)
        .args(["api", "--stdio"])
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let input = child
        .stdin
        .take()
        .ok_or_else(|| io::Error::other("missing core stdin"))?;
    let output = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("missing core stdout"))?;
    let out = Mutex::new(tokio::io::stdout());
    let ctx = Ctx::from_env();
    let incoming = forward_input(
        BufReader::new(tokio::io::stdin()),
        input,
        &out,
        &ctx,
        &registry,
    );
    let outgoing = forward_output(BufReader::new(output), &out);
    tokio::pin!(incoming, outgoing);
    let mut input_done = false;
    let mut output_done = false;
    loop {
        tokio::select! {
            result = &mut incoming, if !input_done => {
                result?;
                input_done = true;
            }
            result = &mut outgoing, if !output_done => {
                result?;
                output_done = true;
            }
            status = child.wait() => {
                if !output_done {
                    outgoing.await?;
                }
                return Ok(status?.code().unwrap_or(1));
            }
        }
    }
}
