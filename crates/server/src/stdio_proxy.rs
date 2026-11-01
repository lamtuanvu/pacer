use crate::native::{call_native, registry};
use pacer_foundation::{Ctx, api::Registry};
use serde_json::{Value, json};
use std::{collections::HashMap, io, process::Stdio, sync::Arc};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex, oneshot},
};

type PendingHello = Arc<Mutex<Option<(Value, oneshot::Sender<Value>)>>>;

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
    pending_hello: &PendingHello,
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
        if protocol == 3
            && valid
            && let Some(op) = method.and_then(|name| registry.get(name))
            && let Some(request) = request.as_ref()
        {
            let result = call_native(
                ctx,
                op,
                request.get("params").cloned().unwrap_or_else(|| json!({})),
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
        // Register the pending hello before writing, so a fast core reply cannot
        // escape the handoff. Only this one reply is retained by the proxy.
        let hello_reply = if method == Some("hello") && valid {
            request.as_ref().and_then(|r| r.get("id")).map(|id| {
                let (tx, rx) = oneshot::channel();
                (id.clone(), tx, rx)
            })
        } else {
            None
        };
        let hello_reply = if let Some((id, tx, rx)) = hello_reply {
            *pending_hello.lock().await = Some((id, tx));
            Some(rx)
        } else {
            None
        };
        core.write_all(&line).await?;
        core.flush().await?;
        if method == Some("hello") && valid && hello_reply.is_none() {
            protocol = 2;
        }
        if let Some(rx) = hello_reply
            && let Ok(response) = rx.await
            && response.get("error").is_none()
        {
            protocol = if response["result"]["protocol"] == "3.0.0" {
                3
            } else {
                2
            };
        }
    }
}

async fn forward_output<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    mut core: R,
    out: &Mutex<W>,
    pending_hello: &PendingHello,
) -> io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if core.read_until(b'\n', &mut line).await? == 0 {
            return Ok(());
        }
        if let Ok(response) = serde_json::from_slice::<Value>(&line) {
            let mut pending = pending_hello.lock().await;
            if pending
                .as_ref()
                .is_some_and(|(id, _)| response.get("id") == Some(id))
                && let Some((_, sender)) = pending.take()
            {
                let _ = sender.send(response);
            }
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
    let pending_hello = Arc::new(Mutex::new(None));
    let incoming = forward_input(
        BufReader::new(tokio::io::stdin()),
        input,
        &out,
        &ctx,
        &registry,
        &pending_hello,
    );
    let outgoing = forward_output(BufReader::new(output), &out, &pending_hello);
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
