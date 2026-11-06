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
/// The v3 body's `coreBuild` describes the running core, so it is never in the
/// generated file: it comes from the core itself, once per connection.
fn hello_body(version: u8, core_build: Option<&Value>) -> io::Result<Value> {
    let bodies: Value = serde_json::from_str(include_str!("stdio_hello.json"))?;
    let mut body = bodies[if version == 3 { "v3" } else { "v2" }].clone();
    if version == 3
        && let (Some(build), Value::Object(fields)) = (core_build, &mut body)
    {
        let mut ordered = serde_json::Map::new();
        ordered.insert("coreBuild".into(), build.clone());
        ordered.extend(std::mem::take(fields));
        *fields = ordered;
    }
    Ok(body)
}

/// The core's build descriptor, read with `--pacer-component-descriptor` on first use.
struct CoreBuild<'a> {
    /// The core answers hello itself (scoped work or a forwarding override).
    forward_hello: bool,
    program: &'a str,
    prefix: &'a [String],
    env: &'a HashMap<String, String>,
    value: tokio::sync::OnceCell<Option<Value>>,
}
impl CoreBuild<'_> {
    async fn get(&self) -> Option<&Value> {
        self.value
            .get_or_init(|| async {
                // A hung core must not hold hello and every request behind it.
                let output = tokio::time::timeout(
                    std::time::Duration::from_secs(2),
                    Command::new(self.program)
                        .args(self.prefix)
                        .arg("--pacer-component-descriptor")
                        .envs(self.env)
                        .stdin(Stdio::null())
                        .stderr(Stdio::inherit())
                        .kill_on_drop(true)
                        .output(),
                )
                .await;
                match output {
                    Ok(Ok(output)) if output.status.success() => {
                        serde_json::from_slice::<Value>(&output.stdout).ok()
                    }
                    _ => {
                        eprintln!("pacer: core build descriptor unavailable");
                        None
                    }
                }
            })
            .await
            .as_ref()
    }
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

async fn forward_input<
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin + Send,
    O: AsyncWrite + Unpin,
>(
    mut input: R,
    mut core: W,
    out: &Mutex<O>,
    ctx: &Ctx,
    registry: &Registry<'_>,
    sync: (&str, &str, &mut tokio::sync::mpsc::UnboundedReceiver<Value>),
    core_build: &CoreBuild<'_>,
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
            if core_build.forward_hello {
                if let Ok(version) = hello_version(request.get("params")) {
                    protocol = version;
                }
                core.write_all(&line).await?;
                core.flush().await?;
                continue;
            }
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
                        let build = if version == 3 {
                            core_build.get().await
                        } else {
                            None
                        };
                        let response =
                            json!({"jsonrpc":"2.0", "id":id, "result":hello_body(version, build)?});
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
            let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
            // Planner install and backend readiness remain on the TypeScript path.
            if !(op.name == "config.set" && crate::native::config_set_stays_forwarded(&params))
                && !(op.name == "mode.hold" && crate::native::mode_hold_stays_forwarded(&params))
                && !(op.name == "routing.route"
                    && crate::native::routing_route_stays_forwarded(&params))
            {
                let request_ctx = ctx.at_now();
                let result = if crate::native::needs_usage_broker(op.name) {
                    call_native(
                        &request_ctx,
                        op,
                        params,
                        request.get("id"),
                        None,
                        Some(Box::pin(crate::native::status_sync::stdio(
                            &mut core, sync.0, sync.1, sync.2,
                        ))
                            as pacer_foundation::api::OpFuture<'_>),
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                    .await
                } else if crate::native::needs_task_read_bridge(op.name) {
                    let task_id = params
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned();
                    call_native(
                        &request_ctx,
                        op,
                        params,
                        request.get("id"),
                        None,
                        None,
                        None,
                        Some(Box::pin(crate::native::task_read_sync::stdio(
                            &mut core, sync.0, sync.1, &task_id, sync.2,
                        ))
                            as pacer_foundation::api::OpFuture<'_>),
                        None,
                        None,
                        None,
                    )
                    .await
                } else if crate::native::needs_task_clean_bridge(op.name) {
                    let ids = crate::native::task_dismiss_ops::ids_from_params(&params);
                    let result = match ids {
                        Ok(ids) => {
                            call_native(
                                &request_ctx,
                                op,
                                params,
                                request.get("id"),
                                None,
                                None,
                                None,
                                None,
                                None,
                                None,
                                Some(Box::pin(crate::native::task_clean_sync::stdio(
                                    &mut core, sync.0, sync.1, &ids, sync.2,
                                ))
                                    as pacer_foundation::api::OpFuture<'_>),
                            )
                            .await
                        }
                        Err(error) => Err(error),
                    };
                    result
                } else if crate::native::needs_snapshot_bridge(op.name) {
                    call_native(
                        &request_ctx,
                        op,
                        params,
                        request.get("id"),
                        None,
                        None,
                        None,
                        None,
                        None,
                        Some(Box::pin(crate::native::snapshot_sync::stdio(
                            &mut core, sync.0, sync.1, sync.2,
                        ))
                            as pacer_foundation::api::OpFuture<'_>),
                        None,
                    )
                    .await
                } else if crate::native::needs_session_probe(op.name) {
                    call_native(
                        &request_ctx,
                        op,
                        params,
                        request.get("id"),
                        None,
                        None,
                        Some(Box::pin(crate::native::session_sync::stdio(
                            &mut core, sync.0, sync.1, sync.2,
                        ))
                            as pacer_foundation::api::OpFuture<'_>),
                        None,
                        None,
                        None,
                        None,
                    )
                    .await
                } else if crate::native::needs_config_host_bridge(op.name) {
                    call_native(
                        &request_ctx,
                        op,
                        params,
                        request.get("id"),
                        None,
                        None,
                        None,
                        None,
                        Some(Box::pin(crate::native::config_host_sync::stdio(
                            &mut core, sync.0, sync.1, sync.2,
                        ))
                            as pacer_foundation::api::OpFuture<'_>),
                        None,
                        None,
                    )
                    .await
                } else {
                    call_native(
                        &request_ctx,
                        op,
                        params,
                        request.get("id"),
                        Some(Box::pin(crate::native::config_sync::stdio(
                            &mut core, sync.0, sync.1, op.name, sync.2,
                        ))
                            as pacer_foundation::api::OpFuture<'_>),
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                    )
                    .await
                };
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
        }
        core.write_all(&line).await?;
        core.flush().await?;
    }
}

async fn forward_output<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    mut core: R,
    out: &Mutex<W>,
    sync_id: &str,
    sync: tokio::sync::mpsc::UnboundedSender<Value>,
) -> io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if core.read_until(b'\n', &mut line).await? == 0 {
            return Ok(());
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&line)
            && value
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| id.starts_with(&format!("{sync_id}:")))
        {
            let _ = sync.send(value);
            continue;
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
    let forward_hello = scoped_work
        || forward
            .split(',')
            .map(str::trim)
            .any(|name| name == "*" || name == "hello");
    let (program, prefix) = core
        .split_first()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "empty core argv"))?;
    let sync_id = hex::encode(rand::random::<[u8; 32]>());
    let sync_key = hex::encode(rand::random::<[u8; 32]>());
    let (sync_tx, mut sync_rx) = tokio::sync::mpsc::unbounded_channel();
    let core_build = CoreBuild {
        forward_hello,
        program,
        prefix,
        env: &env,
        value: tokio::sync::OnceCell::new(),
    };
    let mut child = Command::new(program)
        .args(prefix)
        .args(["api", "--stdio"])
        .envs(&env)
        .env("PACER_NATIVE_CONFIG_SYNC_KEY", &sync_key)
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
        (&sync_id, &sync_key, &mut sync_rx),
        &core_build,
    );
    let outgoing = forward_output(BufReader::new(output), &out, &sync_id, sync_tx);
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
