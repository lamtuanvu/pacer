//! Opt-in parity driver. Domain calls go to an isolated test backend over a Unix
//! socket; this example is neither installed nor selected by `pacer mcp`.
use pacer_server::mcp::{
    Backend, BackendFuture, McpServer, Mode, parse_json, run_stdio, stringify_backend_json,
};
use serde_json::{Value, json};
use std::{io, path::PathBuf};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
};

struct DomainSocket(PathBuf);
impl Backend for DomainSocket {
    fn call(&self, name: &str, arguments: Value) -> BackendFuture<'_> {
        let request = json!({"name":name,"arguments":arguments});
        Box::pin(async move {
            async {
                let mut stream = UnixStream::connect(&self.0).await?;
                stream
                    .write_all(format!("{}\n", stringify_backend_json(&request)).as_bytes())
                    .await?;
                let mut line = String::new();
                BufReader::new(stream).read_line(&mut line).await?;
                let response: Value = parse_json(&line).map_err(io::Error::other)?;
                Ok::<_, io::Error>(response)
            }
            .await
            .map_err(|error| error.to_string())
            .and_then(|response| {
                if let Some(error) = response["error"].as_str() {
                    Err(error.to_owned())
                } else {
                    Ok(response["value"].clone())
                }
            })
        })
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let mode = match args.next().as_deref() {
        Some("planner") => Mode::Planner,
        Some("grant") => Mode::Grant,
        _ => return Err("expected planner or grant".into()),
    };
    let version = args.next().ok_or("expected version")?;
    let socket = args.next().ok_or("expected isolated backend socket")?;
    let server = McpServer::new(mode, version, DomainSocket(socket.into()))?;
    run_stdio(
        server,
        BufReader::new(tokio::io::stdin()),
        tokio::io::stdout(),
    )
    .await?;
    Ok(())
}
