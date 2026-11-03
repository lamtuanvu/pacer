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

/// Ask the already-running core for its negotiated v3 hello and return its
/// `coreBuild` descriptor (the real paired-core identity). The id uses the
/// same sync-name prefix as config sync so `forward_output` routes the reply
/// into `replies`; a per-call nonce keeps repeated hellos from mistaking a
/// stale reply for their own. Unmatched replies are consumed, never leaked.
///
/// Returns `Ok(None)` only for a valid child hello whose result object omits
/// `coreBuild` (allowed: serve the native inventory without the descriptor).
/// All other outcomes are surfaced as errors rather than silently serving a
/// "successful" hello missing `coreBuild`: write/flush failure (`BrokenPipe`),
/// timeout (`TimedOut`), channel close (`UnexpectedEof`), an upstream core
/// error (`Other`), or a malformed result (`InvalidData`).
async fn core_build_descriptor<W: AsyncWrite + Unpin>(
    core: &mut W,
    sync_id: &str,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> io::Result<Option<Value>> {
    let id = format!(
        "{}:hello:{}",
        sync_id,
        hex::encode(rand::random::<[u8; 16]>())
    );
    let request = json!({"jsonrpc":"2.0","id":id,"method":"hello","params":{"protocol":3}});
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "hello request encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes).await.map_err(|error| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            format!("core write failed: {error}"),
        )
    })?;
    core.flush().await.map_err(|error| {
        io::Error::new(
            io::ErrorKind::BrokenPipe,
            format!("core flush failed: {error}"),
        )
    })?;
    let reply = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while let Some(value) = replies.recv().await {
            if value.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                return Some(value);
            }
        }
        None
    })
    .await;
    let value = match reply {
        Ok(Some(value)) => value,
        Ok(None) => {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "core hello reply channel closed",
            ));
        }
        Err(_) => {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "core hello reply timed out",
            ));
        }
    };
    if let Some(error) = value.get("error") {
        return Err(io::Error::other(format!(
            "core hello upstream error: {error}"
        )));
    }
    match value.get("result") {
        // A valid child hello may legitimately omit coreBuild; serve the native
        // inventory without it. That is the only allowed missing-descriptor case.
        Some(Value::Object(result)) => Ok(result.get("coreBuild").cloned()),
        Some(_) => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "core hello reply result is malformed",
        )),
        None => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "core hello reply lacks a result",
        )),
    }
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
    forward_hello: bool,
    sync: (&str, &str, &mut tokio::sync::mpsc::UnboundedReceiver<Value>),
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
            if forward_hello {
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
                    // the accepted negotiation. For v3, also ask the running
                    // core (through the internal response channel) for its real
                    // build descriptor so the native inventory reports the actual
                    // paired-core identity instead of a hardcoded value. A
                    // write/flush/timeout/closed-channel/upstream/malformed
                    // failure is propagated, never silently served as a
                    // successful hello missing coreBuild.
                    let response = if version == 3 {
                        let mut body = hello_body(3)?;
                        if let Some(map) = body.as_object_mut()
                            && let Some(core_build) =
                                core_build_descriptor(&mut core, sync.0, sync.2).await?
                        {
                            map.insert("coreBuild".to_string(), core_build);
                        }
                        body
                    } else {
                        let notification = json!({"jsonrpc":"2.0", "method":"hello", "params":request.get("params").cloned().unwrap_or(Value::Null)});
                        let mut bytes = serde_json::to_vec(&notification)?;
                        bytes.push(b'\n');
                        core.write_all(&bytes).await?;
                        core.flush().await?;
                        hello_body(2)?
                    };
                    protocol = version;
                    if let Some(id) = request.get("id") {
                        if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
                            eprintln!("native hello {id}");
                        }
                        let mut bytes = serde_json::to_vec(
                            &json!({"jsonrpc":"2.0", "id":id, "result":response}),
                        )?;
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
            let request_ctx = ctx.at_now();
            let result = call_native(
                &request_ctx,
                op,
                request.get("params").cloned().unwrap_or_else(|| json!({})),
                request.get("id"),
                Some(Box::pin(crate::native::config_sync::stdio(
                    &mut core, sync.0, sync.1, op.name, sync.2,
                ))),
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
    let mut child = Command::new(program)
        .args(prefix)
        .args(["api", "--stdio"])
        .envs(env)
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
        forward_hello,
        (&sync_id, &sync_key, &mut sync_rx),
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

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used, // Test helpers and assertions are test-only (see v2_compat.rs).
        clippy::expect_used, // expect/expect_err in tests are test-only.
    )]

    use super::*;
    use pacer_foundation::Ctx;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::mpsc;

    /// In-memory core writer that records everything the front door writes to the
    /// child, so tests can (a) inspect the recorded bytes and (b) derive the
    /// exact internal request id before replying through the sync channel.
    #[derive(Clone)]
    struct SharedWriter(Arc<StdMutex<Vec<u8>>>);

    impl tokio::io::AsyncWrite for SharedWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            self.0.lock().unwrap().extend_from_slice(buf);
            std::task::Poll::Ready(Ok(buf.len()))
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    /// Core writer whose every write fails, proving write errors are surfaced
    /// rather than silently serving a hello missing coreBuild.
    struct BrokenWriter;

    impl tokio::io::AsyncWrite for BrokenWriter {
        fn poll_write(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
            _buf: &[u8],
        ) -> std::task::Poll<io::Result<usize>> {
            std::task::Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed")))
        }
        fn poll_flush(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed")))
        }
        fn poll_shutdown(
            self: std::pin::Pin<&mut Self>,
            _cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<io::Result<()>> {
            std::task::Poll::Ready(Ok(()))
        }
    }

    fn ctx() -> Ctx {
        Ctx::with(
            PathBuf::from("."),
            PathBuf::from("."),
            Default::default(),
            0.0,
        )
    }

    /// Extract the internal hello request id from bytes written to the core.
    fn internal_hello_id(written: &[u8]) -> Option<String> {
        for line in String::from_utf8_lossy(written).lines() {
            if let Ok(value) = serde_json::from_str::<Value>(line)
                && value.get("method") == Some(&Value::String("hello".into()))
                && let Some(id) = value.get("id").and_then(Value::as_str)
                && id.contains(":hello:")
            {
                return Some(id.to_string());
            }
        }
        None
    }

    fn written_lines(child: &Arc<StdMutex<Vec<u8>>>) -> Vec<String> {
        String::from_utf8_lossy(&child.lock().unwrap())
            .lines()
            .map(str::to_string)
            .collect()
    }

    /// Wait for the front door to have written its internal hello request to the
    /// child (the spawned `forward_input` sits awaiting the sync channel once it
    /// has), and return that request's unique id.
    async fn wait_for_id(
        child: &Arc<StdMutex<Vec<u8>>>,
        _handle: &tokio::task::JoinHandle<io::Result<()>>,
    ) -> String {
        for _ in 0..500 {
            if let Some(id) = internal_hello_id(&child.lock().unwrap()) {
                return id;
            }
            tokio::task::yield_now().await;
        }
        panic!("front door did not request the core hello descriptor");
    }

    async fn collected(out: &tokio::sync::Mutex<Vec<u8>>) -> Vec<Value> {
        let guard = out.lock().await;
        String::from_utf8_lossy(&guard)
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    fn core_build(build_id: &str, target_os: &str, target_arch: &str) -> Value {
        json!({"schemaVersion":1,"releaseVersion":"0.14.0","buildId":build_id,"role":"core","targetOs":target_os,"targetArch":target_arch})
    }

    type Out = Arc<tokio::sync::Mutex<Vec<u8>>>;

    /// Spawn `forward_input` and return it plus an `Arc` to the captured
    /// stdout plus the sync-channel sender, mirroring the production harness
    /// (stdin client, child core, sync channel). The caller feeds the sync
    /// replies the child would have produced through `tx`.
    async fn run_fixture(
        core: SharedWriter,
        input: Vec<u8>,
        forward_hello: bool,
    ) -> (
        tokio::task::JoinHandle<io::Result<()>>,
        Out,
        mpsc::UnboundedSender<Value>,
    ) {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let out: Out = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let registry = crate::native::registry("");
        let handle = tokio::spawn({
            let out = out.clone();
            let ctx = ctx();
            async move {
                forward_input(
                    BufReader::new(&input[..]),
                    core,
                    &*out,
                    &ctx,
                    &registry,
                    forward_hello,
                    ("sync01", "key01", &mut rx),
                )
                .await
            }
        });
        (handle, out, tx)
    }

    #[tokio::test]
    async fn v3_hello_splices_real_nondefault_core_build() {
        let child = Arc::new(StdMutex::new(Vec::new()));
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
"#
        .to_vec();
        let (handle, out, tx) = run_fixture(SharedWriter(child.clone()), input, false).await;
        let id = wait_for_id(&child, &handle).await;
        tx.send(json!({"jsonrpc":"2.0","id":id,"result":{"coreBuild":core_build("f1f0-4c8e", "linux", "arm64")}}))
            .unwrap();
        let result = handle.await.unwrap();
        assert!(result.is_ok(), "hello should succeed: {result:?}");
        let responses = collected(&out).await;
        let hello = responses
            .iter()
            .find(|r| r["id"] == json!(1))
            .expect("native hello reply");
        assert_eq!(hello["result"]["coreBuild"]["buildId"], "f1f0-4c8e");
        assert_eq!(hello["result"]["coreBuild"]["targetOs"], "linux");
        assert_eq!(hello["result"]["coreBuild"]["targetArch"], "arm64");
    }

    #[tokio::test]
    async fn valid_hello_omitting_core_build_serves_inventory_without_it() {
        let child = Arc::new(StdMutex::new(Vec::new()));
        let core = SharedWriter(child.clone());
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
"#
        .to_vec();
        let (handle, out, tx) = run_fixture(core, input, false).await;
        let id = wait_for_id(&child, &handle).await;
        // Valid child hello whose result simply omits coreBuild.
        tx.send(json!({"jsonrpc":"2.0","id":id,"result":{}}))
            .unwrap();
        assert!(handle.await.unwrap().is_ok());
        let responses = collected(&out).await;
        let hello = responses
            .iter()
            .find(|r| r["id"] == json!(1))
            .expect("native hello reply");
        assert!(
            hello["result"].get("coreBuild").is_none(),
            "coreBuild must be absent when the valid core omits it"
        );
    }

    #[tokio::test]
    async fn stale_reply_for_earlier_hello_is_not_mistaken_for_current() {
        let child = Arc::new(StdMutex::new(Vec::new()));
        let core = SharedWriter(child.clone());
        // Repeated hello: two hello requests with distinct client ids.
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
{"jsonrpc":"2.0","id":2,"method":"hello","params":{"protocol":3}}
"#
        .to_vec();
        let (handle, out, tx) = run_fixture(core, input, false).await;
        // A stale reply from an earlier (already-served) hello must be skipped;
        // only the reply matching the current request's unique id is accepted.
        let first_id = wait_for_id(&child, &handle).await;
        tx.send(json!({"jsonrpc":"2.0","id":first_id,"result":{"coreBuild":core_build("stale", "x", "y")}}))
            .unwrap();
        let _ = tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        // Second hello needs its own unique reply, not the stale value.
        let second_batch = written_lines(&child)
            .iter()
            .filter(|l| l.contains(":hello:"))
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .collect::<Vec<_>>();
        let ids = second_batch
            .iter()
            .filter_map(|v| v.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(ids.len() >= 2, "expected 2 internal hello ids, got {ids:?}");
        let second_id = ids.last().unwrap().to_string();
        assert_ne!(
            second_id, first_id,
            "repeated hello must use a fresh unique id"
        );
        tx.send(json!({"jsonrpc":"2.0","id":second_id,"result":{"coreBuild":core_build("real", "darwin", "arm64")}}))
            .unwrap();
        let result = handle.await.unwrap();
        assert!(result.is_ok());
        let responses = collected(&out).await;
        let second = responses
            .iter()
            .find(|r| r["id"] == json!(2))
            .expect("second hello reply");
        assert_eq!(second["result"]["coreBuild"]["buildId"], "real");
        assert_ne!(second["result"]["coreBuild"]["buildId"], "stale");
    }

    #[tokio::test]
    async fn upstream_core_error_propagates_not_silent_hello() {
        let child = Arc::new(StdMutex::new(Vec::new()));
        let core = SharedWriter(child.clone());
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
"#
        .to_vec();
        let (handle, out, tx) = run_fixture(core, input, false).await;
        let id = wait_for_id(&child, &handle).await;
        tx.send(
            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"method not found"}}),
        )
        .unwrap();
        let result = handle.await.unwrap();
        let err = result.expect_err("upstream core error must propagate, not serve a silent hello");
        assert!(
            err.to_string().contains("upstream error"),
            "unexpected error: {err}"
        );
        let responses = collected(&out).await;
        assert!(
            responses.is_empty(),
            "no native hello may be served on upstream error"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_is_surfaced_not_served_as_missing_core_build() {
        let child = Arc::new(StdMutex::new(Vec::new()));
        let core = SharedWriter(child.clone());
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
"#
        .to_vec();
        let (handle, out, tx) = run_fixture(core, input, false).await;
        // Never answer the internal hello; let the 10s timeout elapse.
        let _ = tx;
        let result = tokio::time::timeout(std::time::Duration::from_secs(12), handle)
            .await
            .expect("forward_input should not hang")
            .expect("spawned task should not panic");
        let err = result.expect_err("timeout must be surfaced");
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        let responses = collected(&out).await;
        assert!(
            responses.is_empty(),
            "no native hello may be served on timeout"
        );
    }

    #[tokio::test]
    async fn write_failure_to_core_is_surfaced() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let out = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
"#
        .to_vec();
        let registry = crate::native::registry("*");
        let ctx = ctx();
        let result = forward_input(
            BufReader::new(&input[..]),
            BrokenWriter,
            &*out,
            &ctx,
            &registry,
            false,
            ("sync01", "key01", &mut rx),
        )
        .await;
        let err = result.expect_err("write failure must be surfaced");
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
        let responses = collected(&out).await;
        assert!(
            responses.is_empty(),
            "no native hello may be served on write failure"
        );
    }

    #[tokio::test]
    async fn closed_reply_channel_is_surfaced() {
        let child = Arc::new(StdMutex::new(Vec::new()));
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
"#
        .to_vec();
        let (handle, _out, tx) = run_fixture(SharedWriter(child.clone()), input, false).await;
        let _ = wait_for_id(&child, &handle).await;
        drop(tx); // child side went away
        let result = handle.await.unwrap();
        let err = result.expect_err("closed channel must be surfaced");
        assert_eq!(err.kind(), io::ErrorKind::UnexpectedEof);
    }

    #[tokio::test]
    async fn v2_hello_unchanged_no_core_build() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let child = Arc::new(StdMutex::new(Vec::new()));
        let core = SharedWriter(child.clone());
        let out = tokio::sync::Mutex::new(Vec::new());
        let input = br#"{"jsonrpc":"2.0","id":"v2n","method":"hello","params":{"protocol":2}}
"#
        .to_vec();
        let registry = crate::native::registry("*");
        let ctx = ctx();
        let result = forward_input(
            BufReader::new(&input[..]),
            core,
            &out,
            &ctx,
            &registry,
            false,
            ("sync01", "key01", &mut rx),
        )
        .await;
        assert!(result.is_ok());
        let responses = collected(&out).await;
        let hello = responses
            .iter()
            .find(|r| r["id"] == json!("v2n"))
            .expect("v2 reply");
        assert_eq!(hello["result"]["protocol"], "2.8.0");
        assert!(
            hello["result"].get("coreBuild").is_none(),
            "v2 must stay coreBuild-free"
        );
        // The child still owes forwarded operations: the negotiation is mirrored.
        let sent = String::from_utf8_lossy(&child.lock().unwrap()).to_string();
        assert!(
            sent.contains(r#""method":"hello""#),
            "v2 hello must still reach the child"
        );
    }

    #[tokio::test]
    async fn forwarded_hello_remains_forwarded_byte_for_byte() {
        let (_tx, mut rx) = mpsc::unbounded_channel();
        let child = Arc::new(StdMutex::new(Vec::new()));
        let core = SharedWriter(child.clone());
        let out = tokio::sync::Mutex::new(Vec::new());
        let line = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}"#;
        let mut input = line.to_vec();
        input.push(b'\n');
        let registry = crate::native::registry("*");
        let ctx = ctx();
        let result = forward_input(
            BufReader::new(&input[..]),
            core,
            &out,
            &ctx,
            &registry,
            true, // forward_hello
            ("sync01", "key01", &mut rx),
        )
        .await;
        assert!(result.is_ok());
        let responses = collected(&out).await;
        assert!(
            responses.is_empty(),
            "forwarded hello must not produce a native reply"
        );
        let sent = String::from_utf8_lossy(&child.lock().unwrap()).to_string();
        let expected = format!("{}\n", String::from_utf8_lossy(line));
        assert_eq!(
            sent, expected,
            "forwarded hello must pass through byte-for-byte (incl. newline)"
        );
    }

    #[cfg(feature = "test-ops")]
    #[tokio::test]
    async fn native_echo_remains_native() {
        let child = Arc::new(StdMutex::new(Vec::new()));
        let core = SharedWriter(child.clone());
        let input = br#"{"jsonrpc":"2.0","id":1,"method":"hello","params":{"protocol":3}}
{"jsonrpc":"2.0","id":2,"method":"test.echo","params":{"a":1}}
"#
        .to_vec();
        let (handle, out, tx) = run_fixture(core, input, false).await;
        let id = wait_for_id(&child, &handle).await;
        tx.send(json!({"jsonrpc":"2.0","id":id,"result":{"coreBuild":core_build("dev", "darwin", "arm64")}}))
            .unwrap();
        let result = handle.await.unwrap();
        assert!(
            result.is_ok(),
            "echo must still be served natively: {result:?}"
        );
        let responses = collected(&out).await;
        let echo = responses
            .iter()
            .find(|r| r["id"] == json!(2))
            .expect("native echo reply");
        assert_eq!(
            echo["result"],
            json!({"a": 1}),
            "native echo must remain native"
        );
        let hello = responses
            .iter()
            .find(|r| r["id"] == json!(1))
            .expect("native hello reply");
        assert_eq!(hello["result"]["coreBuild"]["buildId"], "dev");
    }
}
