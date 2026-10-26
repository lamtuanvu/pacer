use crate::native::Dispatcher;
use futures_util::{StreamExt, stream::FuturesUnordered};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, io, process::Stdio};
use std::{future::Future, pin::Pin};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};

#[derive(Default)]
struct Negotiation {
    native: bool,
    previous: bool,
    pending: Option<Value>,
    settled: Option<tokio::sync::oneshot::Sender<()>>,
}
impl Negotiation {
    fn request(&mut self, request: &Value) -> Option<tokio::sync::oneshot::Receiver<()>> {
        // A hello notification changes the core protocol without an observable
        // acknowledgement. Disable native dispatch until an acknowledged hello.
        if request.get("method").and_then(Value::as_str) == Some("hello") {
            self.previous = self.native;
            self.native = false;
            self.pending = request.get("id").cloned();
            if self.pending.is_some() {
                let (sender, receiver) = tokio::sync::oneshot::channel();
                self.settled = Some(sender);
                return Some(receiver);
            }
        }
        None
    }
    fn response(&mut self, response: &Value) {
        if self
            .pending
            .as_ref()
            .is_some_and(|id| response.get("id") == Some(id))
        {
            self.native = if response.get("error").is_some() {
                self.previous
            } else {
                response.pointer("/result/protocol").and_then(Value::as_str) == Some("3.0.0")
            };
            self.pending = None;
            if let Some(sender) = self.settled.take() {
                let _ = sender.send(());
            }
        }
    }
    fn eof(&mut self) {
        self.native = false;
        self.pending = None;
        self.settled.take();
    }
}
const MAX_NATIVE_FRAME: usize = 1024 * 1024;

async fn write_line<W: AsyncWrite + Unpin>(out: &Mutex<W>, line: &[u8]) -> io::Result<()> {
    let mut out = out.lock().await;
    out.write_all(line).await?;
    out.flush().await
}

async fn forward_input<
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
    O: AsyncWrite + Unpin + Send,
>(
    mut input: R,
    mut core: W,
    out: &Mutex<O>,
    ctx: &Ctx,
    dispatcher: &Dispatcher,
    negotiation: &Mutex<Negotiation>,
) -> io::Result<()> {
    let mut line = Vec::new();
    let mut pending: FuturesUnordered<Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>>> =
        FuturesUnordered::new();
    let mut streaming = false;
    loop {
        let buffer = tokio::select! {
            buffer = input.fill_buf() => buffer?,
            Some(result) = pending.next(), if !pending.is_empty() => { result?; continue; }
        };
        let eof = buffer.is_empty();
        if eof && line.is_empty() {
            while let Some(result) = pending.next().await {
                result?;
            }
            return core.shutdown().await;
        }
        let end = if eof {
            Some(0)
        } else {
            buffer.iter().position(|byte| *byte == b'\n').map(|i| i + 1)
        };
        let count = end.unwrap_or(buffer.len());
        if streaming || line.len() + count > MAX_NATIVE_FRAME {
            // Oversized frames stay byte-transparent and never allocate unbounded
            // memory or execute natively. Invalidate any unobservable hello state.
            negotiation.lock().await.native = false;
            core.write_all(&line).await?;
            line.clear();
            core.write_all(&buffer[..count]).await?;
            streaming = end.is_none();
            core.flush().await?;
            input.consume(count);
            continue;
        }
        line.extend_from_slice(&buffer[..count]);
        input.consume(count);
        if end.is_none() {
            continue;
        }
        let request = serde_json::from_slice::<Value>(&line).ok();
        let mut selected = false;
        let mut acknowledgement = None;
        if let Some(request) = request.as_ref().filter(|r| valid_request(r)) {
            let mut state = negotiation.lock().await;
            acknowledgement = state.request(request);
            selected = state.native;
        }
        if selected
            && let Some(request) = request
            && let Some(method) = request.get("method").and_then(Value::as_str)
            && dispatcher.names().contains(&method)
        {
            let method = method.to_owned();
            let ctx = ctx.at_now();
            pending.push(Box::pin(async move {
                let params = request
                    .get("params")
                    .filter(|v| !v.is_null())
                    .cloned()
                    .unwrap_or(json!({}));
                let result = dispatcher.call(&ctx, &method, params).await;
                if let Some(id) = request.get("id")
                    && let Some(result) = result
                {
                    let mut response = json!({"jsonrpc":"2.0", "id":id});
                    match result {
                        Ok(value) => response["result"] = value,
                        Err(error) => response["error"] = error.rpc(),
                    }
                    let mut bytes = serde_json::to_vec(&response)?;
                    bytes.push(b'\n');
                    write_line(out, &bytes).await?;
                }
                Ok(())
            }));
        } else {
            core.write_all(&line).await?;
            core.flush().await?;
            // Bound buffering to the reader's buffer and preserve pipelined native
            // calls until the actual core acknowledgement selects the protocol.
            if let Some(mut receiver) = acknowledgement {
                loop {
                    tokio::select! {
                        _ = &mut receiver => break,
                        Some(result) = pending.next(), if !pending.is_empty() => { result?; }
                    }
                }
            }
        }
        line.clear();
        if eof {
            while let Some(result) = pending.next().await {
                result?;
            }
            return core.shutdown().await;
        }
    }
}
fn valid_request(request: &Value) -> bool {
    request.is_object()
        && request["jsonrpc"] == "2.0"
        && request.get("method").is_some_and(Value::is_string)
        && request
            .get("id")
            .is_none_or(|id| id.is_null() || id.is_string() || id.is_number())
}
async fn forward_output<R: AsyncBufRead + Unpin, W: AsyncWrite + Unpin>(
    mut core: R,
    out: &Mutex<W>,
    negotiation: &Mutex<Negotiation>,
    dispatcher: &Dispatcher,
) -> io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if core.read_until(b'\n', &mut line).await? == 0 {
            negotiation.lock().await.eof();
            return Ok(());
        }
        if let Ok(mut response) = serde_json::from_slice::<Value>(&line) {
            let mut state = negotiation.lock().await;
            let hello = state
                .pending
                .as_ref()
                .is_some_and(|id| response.get("id") == Some(id));
            state.response(&response);
            let native_protocol = state.native;
            drop(state);
            if native_protocol && !dispatcher.names().is_empty() {
                if hello && let Some(result) = response.get_mut("result") {
                    dispatcher.decorate_hello(result);
                }
                if let Some(hint) = response.pointer_mut("/error/data/hint") {
                    dispatcher.decorate_hint(hint);
                }
                line = serde_json::to_vec(&response)?;
                line.push(b'\n');
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
    let dispatcher = stdio_dispatcher(&env);
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
    let negotiation = Mutex::new(Negotiation::default());
    let incoming = forward_input(
        BufReader::new(tokio::io::stdin()),
        input,
        &out,
        &ctx,
        &dispatcher,
        &negotiation,
    );
    let outgoing = forward_output(BufReader::new(output), &out, &negotiation, &dispatcher);
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

fn stdio_dispatcher(env: &HashMap<String, String>) -> Dispatcher {
    if env.contains_key("PACER_WORK_GRANT") {
        // A scoped worker may only use the core's task/attempt grant checks.
        Dispatcher::new("*")
    } else {
        Dispatcher::startup()
    }
}

#[cfg(test)]
#[path = "stdio_proxy/tests.rs"]
mod tests;
