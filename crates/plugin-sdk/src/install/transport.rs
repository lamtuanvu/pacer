//! Host-backed transport for planner file images, command output and prior
//! records. Every image must carry descriptor-observed mode and identity.

use crate::install::{
    BoxFuture, FileImage, PlannerCommandIntent, PlannerCommandResult, PreparedPlannerIo,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const CHUNK: usize = 262144;
const MAX_OUTPUT: usize = 1048576;

pub type HostCall =
    Arc<dyn Fn(String, Value) -> BoxFuture<'static, Result<Value, String>> + Send + Sync>;

pub fn host_call<F, Fut>(call: F) -> HostCall
where
    F: Fn(String, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    Arc::new(move |method, params| Box::pin(call(method, params)))
}

async fn call(host: &HostCall, method: &str, params: Value) -> Result<Value, String> {
    host(method.to_string(), params).await
}

fn base64(bytes: &[u8]) -> Result<Vec<u8>, String> {
    fn digit(b: u8) -> Option<u8> {
        match b {
            b'A'..=b'Z' => Some(b - b'A'),
            b'a'..=b'z' => Some(b - b'a' + 26),
            b'0'..=b'9' => Some(b - b'0' + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    if !bytes.len().is_multiple_of(4) {
        return Err("invalid base64".into());
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for block in bytes.chunks(4) {
        let padding = block.iter().rev().take_while(|b| **b == b'=').count();
        if padding > 2 {
            return Err("invalid base64".into());
        }
        let mut value: u32 = 0;
        for (i, b) in block.iter().enumerate() {
            if i >= 4 - padding {
                continue;
            }
            value = (value << 6) | digit(*b).ok_or("invalid base64")? as u32;
        }
        let body = (4 - padding) as u32;
        value <<= 6 * (4 - body);
        out.push((value >> 16) as u8);
        if padding < 2 {
            out.push((value >> 8) as u8);
        }
        if padding < 1 {
            out.push(value as u8);
        }
    }
    Ok(out)
}

fn decode_text(bytes: &[u8]) -> Result<String, String> {
    let text = String::from_utf8(bytes.to_vec()).map_err(|_| "invalid UTF-8")?;
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

fn safe(value: &Value) -> Option<i64> {
    let n = value.as_i64()?;
    (n >= 0).then_some(n)
}

fn observed_mode(value: &Value) -> Option<u32> {
    safe(value).and_then(|n| u32::try_from(n).ok())
}

fn identity(value: &Value) -> bool {
    let Some(map) = value.as_object() else {
        return false;
    };
    map.get("path").is_some_and(Value::is_string)
        && ["size", "inode", "device"]
            .iter()
            .all(|key| map.get(*key).is_some_and(|v| safe(v).is_some()))
        && map
            .get("mtimeMs")
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
        && map.get("mode").is_some_and(observed_mode_check)
}

fn observed_mode_check(value: &Value) -> bool {
    observed_mode(value).is_some()
}

fn same(a: &Value, b: &Value) -> bool {
    let Some(map) = b.as_object() else {
        return false;
    };
    let Some(left) = a.as_object() else {
        return false;
    };
    identity(b)
        && left.get("path") == map.get("path")
        && left.get("size") == map.get("size")
        && left.get("inode") == map.get("inode")
        && left.get("device") == map.get("device")
        && left.get("mtimeMs") == map.get("mtimeMs")
        && left.get("mode") == map.get("mode")
}

async fn output(host: &HostCall, handle: &str) -> Result<String, String> {
    let mut parts: Vec<u8> = Vec::new();
    let mut offset = 0usize;
    loop {
        let value = call(
            host,
            "capability.process.outputChunk",
            serde_json::json!({"handle": handle, "offset": offset, "length": CHUNK}),
        )
        .await?;
        let encoded = value
            .get("base64")
            .and_then(Value::as_str)
            .ok_or("invalid planner command output")?;
        let bytes = base64(encoded.as_bytes())?;
        if bytes.len() > CHUNK || offset + bytes.len() > MAX_OUTPUT {
            return Err("invalid planner command output".into());
        }
        offset += bytes.len();
        let done = bytes.len() < CHUNK;
        parts.extend(bytes);
        if done {
            return decode_text(&parts);
        }
    }
}

async fn planner_read(host: &HostCall, path: &str) -> Result<Option<FileImage>, String> {
    let image = call(
        host,
        "capability.fs.read",
        serde_json::json!({"path": path}),
    )
    .await?;
    if image.get("missing") == Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let Some(ranged) = image.get("ranged") else {
        let mode = image
            .get("mode")
            .and_then(observed_mode)
            .ok_or("planner file image requires observed mode")?;
        let text = image
            .get("text")
            .and_then(Value::as_str)
            .ok_or("invalid planner file image")?;
        return Ok(Some(FileImage {
            text: text.to_string(),
            mode,
        }));
    };
    if !identity(ranged) || ranged.get("path").and_then(Value::as_str) != Some(path) {
        return Err("planner file range requires observed mode and identity".into());
    }
    let size = ranged
        .get("size")
        .and_then(safe)
        .ok_or("planner file range requires observed mode and identity")? as usize;
    let mode = ranged
        .get("mode")
        .and_then(observed_mode)
        .ok_or("planner file range requires observed mode and identity")?;
    let mut parts: Vec<u8> = Vec::with_capacity(size);
    let mut offset = 0usize;
    while offset < size {
        let length = CHUNK.min(size - offset);
        let value = call(
            host,
            "capability.fs.readRange",
            serde_json::json!({"path": path, "offset": offset, "length": length, "expected": ranged}),
        )
        .await?;
        let encoded = value
            .get("base64")
            .and_then(Value::as_str)
            .ok_or("planner file changed during range assembly")?;
        let missing = Value::Null;
        if !same(ranged, value.get("info").unwrap_or(&missing)) {
            return Err("planner file changed during range assembly".into());
        }
        let bytes = base64(encoded.as_bytes())?;
        if bytes.len() != length {
            return Err("incomplete planner file range".into());
        }
        parts.extend(bytes);
        offset += length;
    }
    Ok(Some(FileImage {
        text: decode_text(&parts)?,
        mode,
    }))
}

async fn planner_run(
    host: &HostCall,
    intent: PlannerCommandIntent,
) -> Result<PlannerCommandResult, String> {
    let params = serde_json::to_value(intent).map_err(|e| e.to_string())?;
    let value = call(host, "capability.planner.run", params).await?;
    let Some(streams) = value.get("output") else {
        return serde_json::from_value(value).map_err(|e| e.to_string());
    };
    let stdout_handle = streams
        .get("stdout")
        .and_then(Value::as_str)
        .ok_or("invalid planner command output")?;
    let stderr_handle = streams
        .get("stderr")
        .and_then(Value::as_str)
        .ok_or("invalid planner command output")?;
    Ok(PlannerCommandResult {
        code: value
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or_default() as i32,
        stdout: output(host, stdout_handle).await?,
        stderr: output(host, stderr_handle).await?,
    })
}

pub fn create_planner_io(host: HostCall, signal: Option<CancellationToken>) -> PreparedPlannerIo {
    let read_host = Arc::clone(&host);
    let run_host = Arc::clone(&host);
    let io = PreparedPlannerIo::new(
        move |path| {
            let host = Arc::clone(&read_host);
            async move { planner_read(&host, &path).await }
        },
        move |intent| {
            let host = Arc::clone(&run_host);
            async move { planner_run(&host, intent).await }
        },
    );
    match signal {
        Some(signal) => io.with_signal(signal),
        None => io,
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriorReference {
    pub handle: String,
    pub bytes: u64,
}

pub async fn read_planner_prior(
    host: HostCall,
    reference: PriorReference,
) -> Result<Value, String> {
    let PriorReference { handle, bytes } = reference;
    if handle.is_empty() || handle.len() > 256 {
        return Err("invalid planner prior reference".into());
    }
    let mut parts: Vec<u8> = Vec::with_capacity(bytes as usize);
    let mut offset = 0usize;
    while offset < bytes as usize {
        let length = CHUNK.min(bytes as usize - offset);
        let value = call(
            &host,
            "capability.planner.readPriorRange",
            serde_json::json!({"handle": handle, "offset": offset, "length": length}),
        )
        .await?;
        let encoded = value
            .get("base64")
            .and_then(Value::as_str)
            .ok_or("invalid planner prior range")?;
        let chunk = base64(encoded.as_bytes()).map_err(|_| "invalid planner prior range")?;
        if chunk.len() != length {
            return Err("incomplete planner prior range".into());
        }
        parts.extend(chunk);
        offset += length;
    }
    let text = decode_text(&parts)?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}
