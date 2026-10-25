use crate::native::{ApiError, NATIVE_OPS, call_native};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::{collections::HashMap, io, process::Stdio};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::Mutex,
};

type NativeCall = fn(&Ctx, &str, &Value) -> Option<Result<Value, ApiError>>;

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
    native_ops: &[&str],
    native: NativeCall,
) -> io::Result<()> {
    let mut line = Vec::new();
    loop {
        line.clear();
        if input.read_until(b'\n', &mut line).await? == 0 {
            return core.shutdown().await;
        }
        if let Ok(request) = serde_json::from_slice::<Value>(&line)
            && let Some(method) = request.get("method").and_then(Value::as_str)
            && native_ops.contains(&method)
            && request["jsonrpc"] == "2.0"
            && request
                .get("id")
                .is_none_or(|id| id.is_null() || id.is_string() || id.is_number())
            && let Some(result) = native(ctx, method, request.get("params").unwrap_or(&json!({})))
        {
            if let Some(id) = request.get("id") {
                let mut response = json!({"jsonrpc":"2.0", "id":id});
                match result {
                    Ok(value) => response["result"] = value,
                    Err(error) => response["error"] = error.to_rpc(),
                }
                let mut bytes = serde_json::to_vec(&response)?;
                bytes.push(b'\n');
                write_line(out, &bytes).await?;
            }
        } else {
            core.write_all(&line).await?;
            core.flush().await?;
        }
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
        if scoped_work { &[] } else { NATIVE_OPS },
        call_native,
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

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[tokio::test]
    async fn native_ops_are_answered_locally() {
        fn echo(_: &Ctx, _: &str, params: &Value) -> Option<Result<Value, ApiError>> {
            Some(Ok(params.clone()))
        }
        let ctx = Ctx::from_env();
        let mut core = Vec::new();
        let out = Mutex::new(Vec::new());
        let input = b"{\"jsonrpc\":\"2.0\",\"method\":\"test.echo\",\"id\":7,\"params\":{\"ok\":true}}\n{\"jsonrpc\":\"2.0\",\"method\":\"test.echo\"}\n";
        forward_input(&input[..], &mut core, &out, &ctx, &["test.echo"], echo)
            .await
            .unwrap();
        assert!(core.is_empty());
        let response: Value = serde_json::from_slice(&out.into_inner()).unwrap();
        assert_eq!(
            response,
            json!({"jsonrpc":"2.0","id":7,"result":{"ok":true}})
        );
        assert!(NATIVE_OPS.is_empty());
        assert!(call_native(&ctx, "test.echo", &Value::Null).is_none());
    }

    #[test]
    fn rpc_errors_match_typescript() {
        for (code, number) in [
            ("unknown_op", -32601),
            ("invalid_input", -32602),
            ("conflict", -32000),
        ] {
            for hint in [None, Some(""), Some("retry")] {
                let error = ApiError {
                    code: code.into(),
                    message: "message".into(),
                    hint: hint.map(String::from),
                    data: Some(json!({"private":true})),
                };
                let mut expected = json!({"code":number,"message":"message","data":{"code":code}});
                if hint == Some("retry") {
                    expected["data"]["hint"] = json!("retry");
                }
                assert_eq!(error.to_rpc(), expected);
            }
        }
    }
}
