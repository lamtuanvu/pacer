//! Fixed public-v3 routes for the bundled app. No caller-supplied URL crosses this boundary.
use crate::{client::Session, logic, Shell};
use futures_util::{SinkExt, StreamExt};
use reqwest::{
    header::{HeaderMap, HeaderValue},
    Method,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{ipc::Channel, AppHandle, Manager, WebviewWindow};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

#[derive(Default)]
pub struct Bridge {
    pages: Mutex<HashMap<String, (String, Channel<Value>)>>,
    status: Mutex<Value>,
    pub cursor: Mutex<EventCursor>,
    terminals: Mutex<HashMap<String, Terminal>>,
    streams: Mutex<HashMap<String, (String, tokio::task::JoinHandle<()>)>>,
    stream_pending: Mutex<HashMap<String, Arc<Mutex<usize>>>>,
}
struct Terminal {
    owner: String,
    tx: mpsc::Sender<Message>,
    pending: Arc<Mutex<usize>>,
    room: Arc<tokio::sync::Notify>,
    _cancel: tokio::sync::oneshot::Sender<()>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    status: u16,
    body: Vec<u8>,
    content_type: String,
}
impl Bridge {
    pub fn has_page(&self, label: &str) -> bool {
        self.pages.lock().unwrap().contains_key(label)
    }
    pub fn status(&self, mut value: Value) {
        if matches!(value["status"].as_str(),Some("connected" | "reconnecting")) && value.get("warning").is_none() {
            value["warning"]=self.status.lock().unwrap()["warning"].clone();
        }
        if value["status"] == "reconnecting" {
            let old = self.status.lock().unwrap().clone();
            let attempt = old["attempt"].as_u64().unwrap_or(0) + 1;
            value["attempt"] = json!(attempt);
            value["nextRetry"] = json!(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis()
                    + 2000
            );
        }
        *self.status.lock().unwrap() = value.clone();
        self.broadcast(value);
    }
    pub fn broadcast(&self, value: Value) {
        self.pages
            .lock()
            .unwrap()
            .retain(|_, (_, channel)| channel.send(value.clone()).is_ok());
    }
    pub fn instance(&self) -> Option<String> {
        self.pages
            .lock()
            .unwrap()
            .get("main")
            .map(|(id, _)| id.clone())
    }
    pub fn reconcile_cursor(&self, identity: String, snapshot: u64) -> u64 {
        let (seq, reset) = self.cursor.lock().unwrap().reconcile(identity, snapshot);
        if reset {
            self.broadcast(json!({"type":"resync","id":seq,"data":"{}"}));
        }
        seq
    }
}
pub fn event_message(event: &logic::Event) -> Value {
    if event.kind == "reset" {
        json!({"type":"resync","id":event.id,"data":event.data})
    } else {
        json!({"type":"event","event":event.kind,"id":event.id,"data":event.data})
    }
}
pub fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}
pub fn task_id(id: &str) -> bool {
    // Task IDs are t-YYYYMMDD-HHMMSS-<four lowercase hex digits>.
    id.is_ascii()
        && id.len() == 22
        && id.starts_with("t-")
        && id.as_bytes()[10] == b'-'
        && id.as_bytes()[17] == b'-'
        && id[2..10].bytes().all(|c| c.is_ascii_digit())
        && id[11..17].bytes().all(|c| c.is_ascii_digit())
        && id[18..]
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
pub fn turn_id(id: &str) -> bool {
    id.len() == 17
        && id.starts_with("turn-")
        && id.bytes().enumerate().skip(5).all(|(i, c)| {
            if i == 13 {
                c == b'-'
            } else {
                c.is_ascii_hexdigit() && !c.is_ascii_uppercase()
            }
        })
}
fn require_id(valid: bool) -> Result<(), String> {
    if valid {
        Ok(())
    } else {
        Err("Invalid identifier".into())
    }
}
pub fn validate_op(ops: &[String], op: &str, params: &Value) -> Result<(), String> {
    if !op
        .as_bytes()
        .first()
        .is_some_and(|c| c.is_ascii_lowercase())
        || !op
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'.')
        || op == "ui.open"
        || !ops.iter().any(|name| name == op)
    {
        return Err("Operation is not allowed".into());
    }
    if serde_json::to_vec(params)
        .map_err(|_| "Invalid params")?
        .len()
        > 256 * 1024
    {
        return Err("Params exceed 256 KiB".into());
    }
    Ok(())
}
pub fn app_headers(origin: &str, instance: &str) -> Result<HeaderMap, String> {
    let url = reqwest::Url::parse(origin).map_err(|_| "Invalid public service origin")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Invalid public service origin".into());
    }
    if instance.is_empty()
        || instance.len() > 64
        || !instance
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(&c))
    {
        return Err("Invalid client instance".into());
    }
    let mut headers = HeaderMap::new();
    headers.insert(
        "origin",
        HeaderValue::from_str(origin).map_err(|_| "Invalid origin")?,
    );
    headers.insert("x-pacer-client", HeaderValue::from_static("app"));
    headers.insert(
        "x-pacer-client-instance",
        HeaderValue::from_str(instance).map_err(|_| "Invalid client instance")?,
    );
    Ok(headers)
}
pub fn valid_caller(label: &str, url: &url::Url, main_only: bool) -> bool {
    (label == "main" || (!main_only && label == "tray"))
        && logic::bundled_document(url, label == "tray")
}
fn caller(window: &WebviewWindow, main_only: bool) -> Result<(), String> {
    let url = window.url().map_err(|_| "Unknown caller")?;
    if valid_caller(window.label(), &url, main_only) {
        Ok(())
    } else {
        Err("IPC requires the bundled window".into())
    }
}
#[derive(Default)]
pub struct EventCursor {
    pub seq: Option<u64>,
    identity: Option<String>,
}
impl EventCursor {
    fn reconcile(&mut self, identity: String, snapshot: u64) -> (u64, bool) {
        let reset = self.identity.as_ref().is_some_and(|old| old != &identity)
            || self.seq.is_some_and(|seq| snapshot < seq);
        if reset || self.seq.is_none() {
            self.seq = Some(snapshot);
        }
        self.identity = Some(identity);
        (self.seq.unwrap(), reset)
    }
}
fn reserve(pending: &mut usize, size: usize) -> bool {
    if size > 1024 * 1024 || *pending > 1024 * 1024 - size {
        return false;
    }
    *pending += size;
    true
}
/// Admission of a terminal frame into the renderer's queue. The page drains
/// with terminal_ack; while its 1 MiB budget is full the attachment stops
/// reading the socket so the server buffers (a replay of an ended session
/// would otherwise overflow every attach and loop on resync). Returns false
/// when the frame can never fit, the attachment is cancelled, or the page
/// sends no ack for 30 seconds. A false return always ends the attachment, so
/// the cancel receiver is never polled again after it resolves.
async fn admit(
    pending: &Arc<Mutex<usize>>,
    room: &Arc<tokio::sync::Notify>,
    cancelled: &mut tokio::sync::oneshot::Receiver<()>,
    size: usize,
) -> bool {
    if size > 1024 * 1024 {
        return false;
    }
    loop {
        // Register the wakeup before checking, or an ack landing between
        // the check and the await would never wake the wait.
        let notified = room.notified();
        tokio::pin!(notified);
        if reserve(&mut pending.lock().unwrap(), size) {
            return true;
        }
        tokio::select! {
            _ = &mut notified => {}
            _ = &mut *cancelled => return false,
            _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => return false,
        }
    }
}
fn cancel_stream(
    streams: &mut HashMap<String, (String, tokio::task::JoinHandle<()>)>,
    owner: &str,
    id: &str,
) {
    if streams.get(id).is_some_and(|(label, _)| label == owner) {
        if let Some((_, handle)) = streams.remove(id) {
            handle.abort();
        }
    }
}

fn session(
    window: &WebviewWindow,
    app: &AppHandle,
    instance: &str,
    main_only: bool,
) -> Result<Session, String> {
    caller(window, main_only)?;
    let session = app
        .state::<Shell>()
        .session
        .lock()
        .unwrap()
        .clone()
        .ok_or("Service is connecting")?;
    app_headers(&session.origin, instance)?;
    Ok(session)
}
fn request(
    session: &Session,
    method: Method,
    path: &str,
    instance: &str,
) -> Result<reqwest::RequestBuilder, String> {
    Ok(session
        .client
        .request(method, format!("{}{path}", session.origin))
        .headers(app_headers(&session.origin, instance)?))
}
async fn reply(response: reqwest::RequestBuilder, limit: usize) -> Result<Reply, String> {
    let response = response
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .await
        .map_err(|_| "Service request failed")?;
    let status = response.status().as_u16();
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/json")
        .to_owned();
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "Service response interrupted")?;
        if body.len() + chunk.len() > limit {
            return Err("Service response exceeds limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Reply {
        status,
        body,
        content_type,
    })
}
#[tauri::command]
pub async fn service_call(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    op: String,
    params: Value,
) -> Result<Reply, String> {
    let session = session(&window, &app, &instance, false)?;
    validate_op(&session.ops.lock().unwrap(), &op, &params)?;
    reply(
        request(&session, Method::POST, &format!("/v3/ops/{op}"), &instance)?.json(&params),
        64 * 1024 * 1024,
    )
    .await
}
// A comparison of claims only: it cannot establish bundle signature or peer identity.
fn build_diagnostic(hello: &Value, manifest: Option<&Value>) -> Value {
    fn descriptor(value: &Value) -> Option<[&str; 5]> {
        let o = value.as_object()?;
        if o.len() != 6 || value["schemaVersion"] != 1 || value["role"] != "core" { return None; }
        let fields = ["releaseVersion", "buildId", "role", "targetOs", "targetArch"];
        let mut out = [""; 5];
        for (i, key) in fields.iter().enumerate() {
            let v = value[*key].as_str()?;
            if v.is_empty() || v.len() > 128 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || b"._+-".contains(&b)) { return None; }
            out[i] = v;
        }
        if out[1] == "development-uncompiled" { return None; }
        Some(out)
    }
    let Some(m) = manifest else { return json!({"status":"unknown","reason":"manifest-unavailable","proof":"unverified"}); };
    if m["schemaVersion"] != 1 { return json!({"status":"unknown","reason":"unsupported-manifest","proof":"unverified"}); }
    let valid_entry = |entry: &Value, role: &str| {
        let mut d = entry["descriptor"].clone();
        if d["role"] != role { return false; }
        d["role"] = json!("core");
        entry.as_object().is_some_and(|o| o.len() == 2)
            && descriptor(&d).is_some()
            && entry["sha256"].as_str().is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    };
    if !m.as_object().is_some_and(|o| o.len() == 3) || !valid_entry(&m["frontDoor"], "front-door") || !valid_entry(&m["core"], "core") || m["frontDoor"]["descriptor"]["targetOs"] != m["core"]["descriptor"]["targetOs"] || m["frontDoor"]["descriptor"]["targetArch"] != m["core"]["descriptor"]["targetArch"] {
        return json!({"status":"unknown","reason":"invalid-manifest","proof":"unverified"});
    }
    match (descriptor(&hello["coreBuild"]), descriptor(&m["core"]["descriptor"])) {
        (Some(a), Some(b)) if a != b => json!({"status":"mismatch","reason":"core-descriptor-differs","proof":"unverified"}),
        (Some(_), Some(_)) => json!({"status":"unverified","reason":"native-proof-unavailable","proof":"unverified"}),
        _ => json!({"status":"unknown","reason":"descriptor-unavailable","proof":"unverified"}),
    }
}
fn bundled_pair_manifest() -> Option<Value> {
    let exe = std::env::current_exe().ok()?;
    let path = exe.parent()?.parent()?.join("Resources/pacer-pair-manifest.json");
    let file = std::fs::File::open(path).ok()?;
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(8193).read_to_end(&mut bytes).ok()?;
    if bytes.len() > 8192 { return None; }
    serde_json::from_slice(&bytes).ok()
}

#[tauri::command]
pub async fn service_hello(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
) -> Result<Reply, String> {
    let session = session(&window, &app, &instance, false)?;
    let mut response = reply(
        request(&session, Method::GET, "/v3/hello", &instance)?,
        2 * 1024 * 1024,
    ).await?;
    if response.status == 200 {
        if let Ok(mut hello) = serde_json::from_slice::<Value>(&response.body) {
            if hello.is_object() {
                hello["desktopBuildDiagnostic"] = build_diagnostic(&hello, bundled_pair_manifest().as_ref());
                if let Ok(body) = serde_json::to_vec(&hello) { response.body = body; }
            }
        }
    }
    Ok(response)
}
#[tauri::command]
pub async fn service_snapshot(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
) -> Result<Reply, String> {
    let session = session(&window, &app, &instance, false)?;
    reply(
        request(&session, Method::GET, "/v3/snapshot", &instance)?,
        64 * 1024 * 1024,
    )
    .await
}
#[tauri::command]
pub fn service_events(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    channel: Channel<Value>,
) -> Result<(), String> {
    caller(&window, false)?;
    // Validate the supplied identity even before the service is available.
    app_headers("http://127.0.0.1:1", &instance)?;
    let bridge = app.state::<Bridge>();
    let status = bridge.status.lock().unwrap().clone();
    channel
        .send(if status.is_null() {
            json!({"type":"status","status":"connecting"})
        } else {
            status
        })
        .map_err(|_| "Page disconnected")?;
    let previous = bridge
        .pages
        .lock()
        .unwrap()
        .insert(window.label().into(), (instance.clone(), channel));
    if previous.is_some_and(|(old, _)| old != instance) {
        bridge
            .terminals
            .lock()
            .unwrap()
            .retain(|_, terminal| terminal.owner != window.label());
        let mut streams = bridge.streams.lock().unwrap();
        streams.retain(|_, (owner, handle)| {
            if owner == window.label() {
                handle.abort();
                false
            } else {
                true
            }
        });
        bridge
            .stream_pending
            .lock()
            .unwrap()
            .retain(|id, _| streams.contains_key(id));
    }
    Ok(())
}
#[tauri::command]
pub fn stream_cancel(
    window: WebviewWindow,
    app: AppHandle,
    stream_id: String,
) -> Result<(), String> {
    caller(&window, true)?;
    let bridge = app.state::<Bridge>();
    let mut streams = bridge.streams.lock().unwrap();
    cancel_stream(&mut streams, window.label(), &stream_id);
    if !streams.contains_key(&stream_id) {
        bridge.stream_pending.lock().unwrap().remove(&stream_id);
    }
    Ok(())
}
#[tauri::command]
pub fn stream_ack(
    window: WebviewWindow,
    app: AppHandle,
    stream_id: String,
    size: usize,
) -> Result<(), String> {
    caller(&window, true)?;
    let bridge = app.state::<Bridge>();
    let streams = bridge.streams.lock().unwrap();
    if !streams
        .get(&stream_id)
        .is_some_and(|(owner, _)| owner == window.label())
    {
        return Err("Unknown stream".into());
    }
    if let Some(pending) = bridge.stream_pending.lock().unwrap().get(&stream_id) {
        let mut count = pending.lock().unwrap();
        *count = count.saturating_sub(size);
    }
    Ok(())
}
// `from` counts UTF-8 output bytes in log-frame display order (stdout, stderr).
// The public route sends the initial log; skip the already received prefix here.
fn resume_log(event: &mut logic::Event, remaining: &mut u64) -> Result<(), &'static str> {
    if *remaining == 0 || event.kind != "log" {
        return Ok(());
    }
    let mut value: Value = serde_json::from_str(&event.data).map_err(|_| "Invalid log frame")?;
    for field in ["stdout", "stderr"] {
        if let Some(text) = value[field].as_str() {
            let skip = (*remaining).min(text.len() as u64) as usize;
            if !text.is_char_boundary(skip) {
                return Err("Invalid log offset");
            }
            let rest = text[skip..].to_owned();
            *remaining -= skip as u64;
            value[field] = json!(rest);
        }
    }
    event.data = value.to_string();
    Ok(())
}
async fn start_stream(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    stream_id: String,
    channel: Channel<Value>,
    path: String,
    parsed: bool,
    mut from: u64,
) -> Result<(), String> {
    let session = session(&window, &app, &instance, true)?;
    require_id(uuid(&stream_id))?;
    let request =
        request(&session, Method::GET, &path, &instance)?.header("accept", "text/event-stream");
    let bridge = app.state::<Bridge>();
    let mut streams = bridge.streams.lock().unwrap();
    if streams.len() >= 32 || streams.contains_key(&stream_id) {
        return Err("Too many streams".into());
    }
    let pending = Arc::new(Mutex::new(0usize));
    bridge
        .stream_pending
        .lock()
        .unwrap()
        .insert(stream_id.clone(), pending.clone());
    let handle = app.clone();
    let key = stream_id.clone();
    // Register cancellation before opening the HTTP stream. A quick unmount can
    // cancel a pending handshake as well as an established stream.
    let task = tokio::spawn(async move {
        let result = async {
            let response = request
                .send()
                .await
                .map_err(|_| "Stream connection failed")?;
            if !response.status().is_success() {
                return Err("Stream request rejected");
            }
            if !response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with("text/event-stream"))
            {
                return Err("Invalid stream response");
            }
            let mut stream = response.bytes_stream();
            let mut parser = logic::Sse::default();
            channel
                .send(json!({"type":"open"}))
                .map_err(|_| "Page disconnected")?;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| "Stream interrupted")?;
                if parsed {
                    for mut event in parser.push(&chunk)? {
                        resume_log(&mut event, &mut from)?;
                        let mut message = event_message(&event);
                        let size = message.to_string().len();
                        if !reserve(&mut pending.lock().unwrap(), size) {
                            let _ = channel.send(json!({"type":"resync","data":"{}"}));
                            return Err("Stream output queue is full");
                        }
                        message["size"] = json!(size);
                        channel.send(message).map_err(|_| "Page disconnected")?;
                    }
                } else {
                    if !reserve(&mut pending.lock().unwrap(), chunk.len()) {
                        let _ = channel.send(json!({"type":"resync","data":"{}"}));
                        return Err("Stream output queue is full");
                    }
                    channel
                        .send(json!({"type":"chunk","bytes":chunk.to_vec(),"size":chunk.len()}))
                        .map_err(|_| "Page disconnected")?;
                }
            }
            Ok::<(), &str>(())
        }
        .await;
        if let Err(reason) = result {
            let _ = channel.send(json!({"type":"error","reason":reason}));
        } else {
            let _ = channel.send(json!({"type":"end"}));
        }
        handle
            .state::<Bridge>()
            .stream_pending
            .lock()
            .unwrap()
            .remove(&key);
        handle
            .state::<Bridge>()
            .streams
            .lock()
            .unwrap()
            .remove(&key);
    });
    streams.insert(stream_id, (window.label().into(), task));
    Ok(())
}
#[tauri::command]
pub async fn assistant_turn_stream(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    id: String,
    stream_id: String,
    channel: Channel<Value>,
) -> Result<(), String> {
    require_id(turn_id(&id))?;
    start_stream(
        window,
        app,
        instance,
        stream_id,
        channel,
        format!("/v3/assistant/turns/{id}/stream"),
        false,
        0,
    )
    .await
}
#[tauri::command]
pub async fn task_log_follow(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    id: String,
    from: u64,
    stream_id: String,
    channel: Channel<Value>,
) -> Result<(), String> {
    require_id(task_id(&id))?;
    start_stream(
        window,
        app,
        instance,
        stream_id,
        channel,
        format!("/v3/tasks/{id}/log?follow=1"),
        true,
        from,
    )
    .await
}
#[tauri::command]
pub async fn attachment_upload(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    draft: String,
    batch: String,
    name: String,
    mime: String,
    bytes: Vec<u8>,
) -> Result<Reply, String> {
    let session = session(&window, &app, &instance, true)?;
    require_id(uuid(&draft) && uuid(&batch))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Attachment exceeds 25 MiB".into());
    }
    let name: String = url::form_urlencoded::byte_serialize(name.as_bytes()).collect();
    reply(
        request(
            &session,
            Method::POST,
            &format!("/v3/attachments?draft={draft}&batch={batch}"),
            &instance,
        )?
        .header("x-pacer-filename", name)
        .header("content-type", mime)
        .body(bytes),
        1024 * 1024,
    )
    .await
}
#[tauri::command]
pub async fn attachment_list(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    draft: String,
) -> Result<Reply, String> {
    let session = session(&window, &app, &instance, true)?;
    require_id(uuid(&draft))?;
    reply(
        request(
            &session,
            Method::GET,
            &format!("/v3/attachments?draft={draft}"),
            &instance,
        )?,
        1024 * 1024,
    )
    .await
}
#[tauri::command]
pub async fn attachment_read(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    draft: String,
    id: String,
) -> Result<Reply, String> {
    let session = session(&window, &app, &instance, true)?;
    require_id(uuid(&draft) && uuid(&id))?;
    reply(
        request(
            &session,
            Method::GET,
            &format!("/v3/attachments/{id}?draft={draft}"),
            &instance,
        )?,
        25 * 1024 * 1024,
    )
    .await
}
#[tauri::command]
pub async fn attachment_delete(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    draft: String,
    id: String,
) -> Result<Reply, String> {
    let session = session(&window, &app, &instance, true)?;
    require_id(uuid(&draft) && uuid(&id))?;
    reply(
        request(
            &session,
            Method::DELETE,
            &format!("/v3/attachments/{id}?draft={draft}"),
            &instance,
        )?,
        1024 * 1024,
    )
    .await
}
#[derive(Deserialize, Debug)]
pub struct Target {
    kind: String,
    id: String,
    attempt: Option<u64>,
}
/// The service session URL a renderer target may attach to. Only a task target may address a recorded
/// attempt, and only with a positive integer value; everything else is rejected before connecting.
fn terminal_url(origin: &str, target: &Target) -> Result<String, String> {
    let family = match target.kind.as_str() {
        "task" if task_id(&target.id) => "tasks",
        "terminal" if uuid(&target.id) => "terminals",
        _ => return Err("Invalid terminal target".into()),
    };
    match target.attempt {
        Some(attempt) if attempt >= 1 && family == "tasks" => {
            Ok(format!("{origin}/v3/{family}/{}/session?attempt={attempt}", target.id))
        }
        Some(_) => Err("Invalid terminal attempt".into()),
        None => Ok(format!("{origin}/v3/{family}/{}/session", target.id)),
    }
}
#[tauri::command]
pub async fn terminal_attach(
    window: WebviewWindow,
    app: AppHandle,
    instance: String,
    attachment: String,
    target: Target,
    from: Option<u64>,
    hello: Value,
    channel: Channel<Value>,
) -> Result<(), String> {
    use reqwest::cookie::CookieStore;
    let session = session(&window, &app, &instance, true)?;
    require_id(uuid(&attachment))?;
    let url = terminal_url(&session.origin, &target)?;
    let mut upgrade = url
        .replacen("http:", "ws:", 1)
        .into_client_request()
        .map_err(|_| "Invalid socket")?;
    for (key, value) in app_headers(&session.origin, &instance)?.iter() {
        upgrade.headers_mut().insert(key.clone(), value.clone());
    }
    let cookie = session
        .cookies
        .cookies(&url::Url::parse(&url).unwrap())
        .ok_or("Missing app cookie")?;
    upgrade.headers_mut().insert("cookie", cookie);
    let (mut socket, _) = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio_tungstenite::connect_async(upgrade),
    )
    .await
    .map_err(|_| "Terminal connection timed out")?
    .map_err(|_| "Terminal connection failed")?;
    let frame = desktop_hello(&hello, from)?;
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .map_err(|_| "Terminal hello failed")?;
    let (tx, mut rx) = mpsc::channel(64);
    let (cancel, mut cancelled) = tokio::sync::oneshot::channel();
    let pending = Arc::new(Mutex::new(0usize));
    let room = Arc::new(tokio::sync::Notify::new());
    {
        let bridge = app.state::<Bridge>();
        let mut terminals = bridge.terminals.lock().unwrap();
        if terminals.len() >= 16 || terminals.contains_key(&attachment) {
            return Err("Too many terminal attachments".into());
        }
        terminals.insert(
            attachment.clone(),
            Terminal {
                owner: window.label().into(),
                tx,
                pending: pending.clone(),
                room: room.clone(),
                _cancel: cancel,
            },
        );
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _=&mut cancelled=>break,
                frame=rx.recv()=> match frame {Some(frame)=>if socket.send(frame).await.is_err(){break;},None=>break},
                frame=socket.next()=> {
                    let Some(Ok(frame))=frame else {break;};
                    let value=match frame {Message::Text(text)=>json!({"type":"text","data":text.as_str()}),Message::Binary(bytes)=>json!({"type":"binary","bytes":bytes.to_vec()}),Message::Close(_)=>break,_=>continue};
                    let size=value.to_string().len();
                    // Backpressure, not dropping: wait for the page's acks so
                    // the server buffers a long replay instead of the bridge.
                    if !admit(&pending,&room,&mut cancelled,size).await {
                        // A single frame larger than the whole budget, or no
                        // ack progress for 30s. Resync clears the page's offset
                        // so the shared session client requests a fresh snapshot
                        // on reconnect.
                        let _=channel.send(json!({"type":"text","data":"{\"type\":\"resync\"}"}));
                        break;
                    }
                    if channel.send(json!({"type":"terminal","frame":value,"size":size})).is_err(){break;}
                }
            }
        }
        let _ = socket.close(None).await;
        let _ = channel.send(json!({"type":"end"}));
        app.state::<Bridge>()
            .terminals
            .lock()
            .unwrap()
            .remove(&attachment);
    });
    Ok(())
}
/// The renderer's hello, rebuilt from validated fields. Its session-protocol range is forwarded:
/// pinning it to 1.1 made a 1.2 host treat the desktop as a viewer that must take control, while
/// the shared client read the host's 1.2 range and never took, leaving every pane read-only.
fn desktop_hello(hello: &Value, from: Option<u64>) -> Result<Value, String> {
    let cols = hello["cols"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 1000)
        .ok_or("Invalid columns")?;
    let rows = hello["rows"]
        .as_u64()
        .filter(|v| *v > 0 && *v <= 1000)
        .ok_or("Invalid rows")?;
    let versions = match &hello["versions"] {
        Value::Null => [1, 1],
        Value::Array(range) => match range.as_slice() {
            [low, high] => match (low.as_u64(), high.as_u64()) {
                (Some(low), Some(high)) if (1..=high).contains(&low) && high <= 99 => [low, high],
                _ => return Err("Invalid session versions".into()),
            },
            _ => return Err("Invalid session versions".into()),
        },
        _ => return Err("Invalid session versions".into()),
    };
    let mut frame = json!({"type":"hello","v":1,"versions":versions,"client":"app","label":"Pacer desktop","cols":cols,"rows":rows});
    if let Some(from) = from {
        frame["from"] = json!(from);
    }
    Ok(frame)
}
fn terminal(
    window: &WebviewWindow,
    app: &AppHandle,
    attachment: &str,
    frame: Message,
) -> Result<(), String> {
    caller(window, true)?;
    let bridge = app.state::<Bridge>();
    let result = queue_terminal(
        &mut bridge.terminals.lock().unwrap(),
        window.label(),
        attachment,
        frame,
    );
    result
}
fn queue_terminal(
    terminals: &mut HashMap<String, Terminal>,
    owner: &str,
    attachment: &str,
    frame: Message,
) -> Result<(), String> {
    let terminal = terminals
        .get(attachment)
        .filter(|t| t.owner == owner)
        .ok_or("Unknown terminal attachment")?;
    if terminal.tx.try_send(frame).is_err() {
        terminals.remove(attachment);
        return Err("Terminal input queue is full".into());
    }
    Ok(())
}
#[tauri::command]
pub fn terminal_ack(
    window: WebviewWindow,
    app: AppHandle,
    attachment: String,
    size: usize,
) -> Result<(), String> {
    caller(&window, true)?;
    let bridge = app.state::<Bridge>();
    let terminals = bridge.terminals.lock().unwrap();
    let terminal = terminals
        .get(&attachment)
        .filter(|terminal| terminal.owner == window.label())
        .ok_or("Unknown terminal attachment")?;
    let mut count = terminal.pending.lock().unwrap();
    *count = count.saturating_sub(size);
    // Free room wakes an attachment waiting to admit its next frame.
    terminal.room.notify_one();
    Ok(())
}
#[tauri::command]
pub fn terminal_send(
    window: WebviewWindow,
    app: AppHandle,
    attachment: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    if bytes.len() < 5
        || bytes.len() > 256 * 1024
        || bytes[0] != 10
        || u32::from_be_bytes(bytes[1..5].try_into().unwrap()) as usize != bytes.len() - 5
    {
        return Err("Invalid terminal input frame".into());
    }
    terminal(&window, &app, &attachment, Message::Binary(bytes.into()))
}
#[tauri::command]
pub fn terminal_resize(
    window: WebviewWindow,
    app: AppHandle,
    attachment: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if cols == 0 || cols > 1000 || rows == 0 || rows > 1000 {
        return Err("Invalid terminal size".into());
    }
    terminal(
        &window,
        &app,
        &attachment,
        Message::Text(
            json!({"type":"size","cols":cols,"rows":rows})
                .to_string()
                .into(),
        ),
    )
}
#[tauri::command]
pub fn terminal_take(
    window: WebviewWindow,
    app: AppHandle,
    attachment: String,
    force: bool,
) -> Result<(), String> {
    terminal(
        &window,
        &app,
        &attachment,
        Message::Text(json!({"type":"take","force":force}).to_string().into()),
    )
}
/// Session protocol 1.2: this pane gained focus, so the PTY follows its size.
#[tauri::command]
pub fn terminal_focus(
    window: WebviewWindow,
    app: AppHandle,
    attachment: String,
) -> Result<(), String> {
    terminal(
        &window,
        &app,
        &attachment,
        Message::Text(json!({"type":"focus"}).to_string().into()),
    )
}
#[tauri::command]
pub fn terminal_release(
    window: WebviewWindow,
    app: AppHandle,
    attachment: String,
) -> Result<(), String> {
    terminal(
        &window,
        &app,
        &attachment,
        Message::Text(json!({"type":"release"}).to_string().into()),
    )
}
#[tauri::command]
pub fn terminal_detach(
    window: WebviewWindow,
    app: AppHandle,
    attachment: String,
) -> Result<(), String> {
    caller(&window, true)?;
    let bridge = app.state::<Bridge>();
    let mut terminals = bridge.terminals.lock().unwrap();
    if terminals
        .get(&attachment)
        .is_some_and(|terminal| terminal.owner == window.label())
    {
        terminals.remove(&attachment);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn desktop_hello_forwards_the_session_protocol_range() {
        // A 1.2 pane must reach the host as 1.2, or the host makes it read-only until it takes control.
        let hello = desktop_hello(&json!({"cols":80,"rows":24,"versions":[1,2]}), Some(7)).unwrap();
        assert_eq!(hello["versions"], json!([1, 2]));
        assert_eq!(hello["from"], json!(7));
        assert_eq!(hello["client"], json!("app"));
        assert_eq!(hello["label"], json!("Pacer desktop"));
        let legacy = desktop_hello(&json!({"cols":80,"rows":24}), None).unwrap();
        assert_eq!(legacy["versions"], json!([1, 1]));
        assert!(legacy.get("from").is_none());
        for versions in [json!([2, 1]), json!([0, 2]), json!([1]), json!([1, 100]), json!(["1", "2"]), json!("1.2")] {
            assert!(desktop_hello(&json!({"cols":80,"rows":24,"versions":versions}), None).is_err());
        }
        // Unvalidated renderer fields never pass through.
        let extra = desktop_hello(&json!({"cols":80,"rows":24,"readOnly":false,"label":"x"}), None).unwrap();
        assert!(extra.get("readOnly").is_none());
        assert_eq!(extra["label"], json!("Pacer desktop"));
    }
    #[test]
    fn operation_policy_is_exact_and_replaced_on_reconnect() {
        let ops = vec![
            "task.get".to_owned(),
            "ui.open".to_owned(),
            "task/get".into(),
            "Task.get".into(),
        ];
        assert!(validate_op(&ops, "task.get", &json!({})).is_ok());
        for name in [
            "task.send",
            "ui.open",
            "Task.get",
            "task/get",
            "task.get?x",
            "1task",
            "",
        ] {
            assert!(validate_op(&ops, name, &json!({})).is_err(), "{name}");
        }
        assert!(validate_op(&[], "task.get", &json!({})).is_err());
        assert!(validate_op(&ops, "task.get", &json!({"value":"a".repeat(256*1024)})).is_err());
    }
    #[test]
    fn headers_use_app_cookie_identity_never_bearer() {
        let headers = app_headers("http://127.0.0.1:1234", "window-1").unwrap();
        assert_eq!(headers["origin"], "http://127.0.0.1:1234");
        assert_eq!(headers["x-pacer-client"], "app");
        assert_eq!(headers["x-pacer-client-instance"], "window-1");
        assert!(!headers.contains_key("authorization"));
        assert!(app_headers("http://example.com:1234", "window-1").is_err());
        assert!(app_headers("http://127.0.0.1:1234", "a\r\nb").is_err());
    }
    #[test]
    fn reset_is_one_resync_message() {
        let event = crate::logic::Event {
            id: Some(42),
            kind: "reset".into(),
            data: "{}".into(),
        };
        assert_eq!(
            event_message(&event),
            json!({"type":"resync","id":42,"data":"{}"})
        );
    }
    #[test]
    fn log_resume_skips_received_bytes_without_changing_the_service_route() {
        let mut remaining = 3;
        let mut event = logic::Event {
            id: None,
            kind: "log".into(),
            data: r#"{"stdout":"abcd","stderr":"err"}"#.into(),
        };
        resume_log(&mut event, &mut remaining).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&event.data).unwrap(),
            json!({"stdout":"d","stderr":"err"})
        );
        assert_eq!(remaining, 0);
    }
    fn target(kind: &str, id: &str, attempt: Option<u64>) -> Target {
        Target { kind: kind.into(), id: id.into(), attempt }
    }
    #[test]
    fn terminal_targets_address_recorded_task_attempts() {
        let origin = "http://127.0.0.1:1234";
        let id = "t-20261102-090145-e376";
        assert_eq!(
            terminal_url(origin, &target("task", id, None)).unwrap(),
            format!("{origin}/v3/tasks/{id}/session")
        );
        // A recorded attempt stays a positive integer query on the fixed task session route.
        assert_eq!(
            terminal_url(origin, &target("task", id, Some(2))).unwrap(),
            format!("{origin}/v3/tasks/{id}/session?attempt=2")
        );
        assert_eq!(
            terminal_url(origin, &target("terminal", "12345678-1234-1234-1234-123456789abc", None)).unwrap(),
            format!("{origin}/v3/terminals/12345678-1234-1234-1234-123456789abc/session")
        );
        for bad in [
            target("task", id, Some(0)),
            target("terminal", "12345678-1234-1234-1234-123456789abc", Some(1)),
            target("task", "../hello", None),
            target("task", "t-20261102-090145-e376/x", None),
            target("terminal", "not-a-uuid", None),
            target("other", id, None),
        ] {
            assert!(terminal_url(origin, &bad).is_err(), "{bad:?}");
        }
    }
    #[test]
    fn identifiers_cannot_escape_fixed_routes() {        assert!(uuid("12345678-1234-1234-1234-123456789abc"));
        assert!(task_id("t-20261102-090145-e376"));
        assert!(turn_id("turn-12345678-abc"));
        assert!(!turn_id("../turn-1234"));
        for id in ["../hello", "a/b", "a?b", "", "t-foo", "a%2fb"] {
            assert!(!task_id(id));
            assert!(!uuid(id));
        }
    }
    #[test]
    fn static_capabilities_are_local_and_separate() {
        let main: Value = serde_json::from_str(include_str!("../capabilities/main.json")).unwrap();
        let tray: Value = serde_json::from_str(include_str!("../capabilities/tray.json")).unwrap();
        assert_eq!(main["windows"], json!(["main"]));
        assert_eq!(tray["windows"], json!(["tray"]));
        for capability in [&main, &tray] {
            assert_eq!(capability["local"], true);
            assert!(capability.get("remote").is_none());
        }
        let expected_main = [
            "allow-service-call",
            "allow-service-hello",
            "allow-service-snapshot",
            "allow-service-events",
            "allow-stream-cancel",
            "allow-stream-ack",
            "allow-assistant-turn-stream",
            "allow-task-log-follow",
            "allow-attachment-upload",
            "allow-attachment-list",
            "allow-attachment-read",
            "allow-attachment-delete",
            "allow-terminal-attach",
            "allow-terminal-send",
            "allow-terminal-resize",
            "allow-terminal-take",
            "allow-terminal-release",
            "allow-terminal-focus",
            "allow-terminal-detach",
            "allow-terminal-ack",
            "allow-client-control",
            "allow-session-expired",
            "allow-session-ready",
            "allow-desktop-version",
            "allow-rounded-window-supported",
            "allow-native-titlebar-supported",
            "allow-desktop-update-connection",
            "allow-takeover-open",
            "allow-native-validation-setup",
            "allow-windowMinimize",
            "allow-windowToggleMaximize",
            "allow-windowClose",
            "core:window:allow-start-dragging",
            "core:window:allow-internal-toggle-maximize",
            "allow-menu-set-enabled",
            "core:event:allow-listen",
            "core:event:allow-unlisten",
        ];
        let expected_tray = [
            "allow-service-call",
            "allow-service-hello",
            "allow-service-snapshot",
            "allow-service-events",
            "allow-client-control",
            "allow-tray-resize",
            "allow-tray-open",
            "allow-tray-hide",
            "allow-tray-login-item",
            "allow-app-quit",
            "allow-session-expired",
        ];
        assert_eq!(main["permissions"], json!(&expected_main[..]));
        assert_eq!(tray["permissions"], json!(expected_tray));
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[test]
    fn cursor_carries_for_same_service_and_resets_for_identity_or_rewind() {
        let mut state = EventCursor::default();
        assert_eq!(state.reconcile("service-a".into(), 10), (10, false));
        state.seq = Some(15);
        assert_eq!(state.reconcile("service-a".into(), 20), (15, false));
        assert_eq!(state.reconcile("service-b".into(), 2), (2, true));
        assert_eq!(state.reconcile("service-b".into(), 1), (1, true));
        assert_eq!(state.reconcile("service-b".into(), 1), (1, false));
    }
    #[test]
    fn caller_labels_and_documents_are_checked() {
        for (label, path, only, ok) in [
            ("main", "/", true, true),
            ("tray", "/tray.html", false, true),
            ("tray", "/", false, false),
            ("main", "/other", true, false),
            ("other", "/", false, false),
            ("tray", "/tray.html", true, false),
        ] {
            assert_eq!(
                valid_caller(
                    label,
                    &url::Url::parse(&format!("tauri://localhost{path}")).unwrap(),
                    only
                ),
                ok
            );
        }
        assert!(!valid_caller(
            "main",
            &url::Url::parse("https://example.com/").unwrap(),
            false
        ));
    }
    #[tokio::test]
    async fn overflowing_input_drops_attachment_and_owner_checks_prevent_cancellation() {
        let (tx, _rx) = mpsc::channel(1);
        let mut terminals = HashMap::new();
        terminals.insert(
            "one".into(),
            Terminal {
                owner: "main".into(),
                tx,
                pending: Default::default(),
                room: Default::default(),
                _cancel: tokio::sync::oneshot::channel().0,
            },
        );
        assert!(queue_terminal(&mut terminals, "tray", "one", Message::Text("x".into())).is_err());
        assert_eq!(terminals.len(), 1);
        assert!(queue_terminal(&mut terminals, "main", "one", Message::Text("x".into())).is_ok());
        assert!(queue_terminal(&mut terminals, "main", "one", Message::Text("x".into())).is_err());
        assert!(terminals.is_empty());
        let mut streams = HashMap::new();
        let task = tokio::spawn(std::future::pending());
        let abort = task.abort_handle();
        streams.insert("one".into(), ("main".into(), task));
        cancel_stream(&mut streams, "tray", "one");
        assert!(!abort.is_finished());
        assert_eq!(streams.len(), 1);
        cancel_stream(&mut streams, "main", "one");
        assert!(streams.is_empty());
        tokio::task::yield_now().await;
        assert!(abort.is_finished());
    }
    #[test]
    fn channel_budget_requires_acknowledgement_and_recovers_capacity() {
        let mut pending = 0;
        assert!(reserve(&mut pending, 1024 * 1024));
        assert!(!reserve(&mut pending, 1));
        pending = pending.saturating_sub(1024 * 1024);
        assert!(reserve(&mut pending, 1));
    }
    #[tokio::test]
    async fn a_frame_that_does_not_fit_waits_and_is_admitted_after_an_ack() {
        let pending = Arc::new(Mutex::new(0usize));
        let room = Arc::new(tokio::sync::Notify::new());
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        reserve(&mut pending.lock().unwrap(), 1024 * 1024);
        let waiter = {
            let pending = pending.clone();
            let room = room.clone();
            tokio::spawn(async move {
                let mut cancelled = cancelled;
                admit(&pending, &room, &mut cancelled, 512).await
            })
        };
        // The budget is full: the wait holds instead of dropping the frame.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(!waiter.is_finished());
        assert_eq!(*pending.lock().unwrap(), 1024 * 1024);
        // An ack frees room and the frame is admitted.
        *pending.lock().unwrap() -= 512;
        room.notify_one();
        assert!(waiter.await.unwrap());
        assert_eq!(*pending.lock().unwrap(), 1024 * 1024);
        drop(cancel);
    }
    #[tokio::test]
    async fn a_frame_larger_than_the_budget_is_rejected() {
        let pending = Arc::new(Mutex::new(0usize));
        let room = Arc::new(tokio::sync::Notify::new());
        let (_, mut cancelled) = tokio::sync::oneshot::channel();
        assert!(!admit(&pending, &room, &mut cancelled, 1024 * 1024 + 1).await);
        assert_eq!(*pending.lock().unwrap(), 0);
    }
    #[tokio::test]
    async fn cancellation_ends_the_wait() {
        let pending = Arc::new(Mutex::new(0usize));
        let room = Arc::new(tokio::sync::Notify::new());
        let (cancel, cancelled) = tokio::sync::oneshot::channel();
        reserve(&mut pending.lock().unwrap(), 1024 * 1024);
        let waiter = {
            let pending = pending.clone();
            let room = room.clone();
            tokio::spawn(async move {
                let mut cancelled = cancelled;
                admit(&pending, &room, &mut cancelled, 512).await
            })
        };
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        assert!(!waiter.is_finished());
        // Detaching the terminal drops the cancel sender and ends the wait.
        drop(cancel);
        assert!(!waiter.await.unwrap());
        assert_eq!(*pending.lock().unwrap(), 1024 * 1024);
    }
}

#[cfg(test)]
mod broadcast_tests {
    use super::*;
    #[test]
    fn identity_and_cursor_rewind_each_emit_exactly_one_resync() {
        let bridge = Bridge::default();
        let messages = Arc::new(Mutex::new(Vec::new()));
        let seen = messages.clone();
        let channel = Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                seen.lock()
                    .unwrap()
                    .push(serde_json::from_str::<Value>(&text).unwrap());
            }
            Ok(())
        });
        bridge
            .pages
            .lock()
            .unwrap()
            .insert("main".into(), ("page".into(), channel));
        assert_eq!(bridge.reconcile_cursor("a".into(), 100), 100);
        assert_eq!(bridge.reconcile_cursor("a".into(), 110), 100);
        assert!(messages.lock().unwrap().is_empty());
        assert_eq!(bridge.reconcile_cursor("b".into(), 3), 3);
        assert_eq!(bridge.reconcile_cursor("b".into(), 3), 3);
        assert_eq!(
            messages.lock().unwrap().as_slice(),
            &[json!({"type":"resync","id":3,"data":"{}"})]
        );
        assert_eq!(bridge.reconcile_cursor("b".into(), 2), 2);
        assert_eq!(bridge.reconcile_cursor("b".into(), 2), 2);
        assert_eq!(messages.lock().unwrap().len(), 2);
        assert_eq!(
            messages.lock().unwrap()[1],
            json!({"type":"resync","id":2,"data":"{}"})
        );
    }
}

#[cfg(test)]
mod warning_tests {
    use super::*;
    #[test]
    fn warning_survives_reconnect_and_clears_on_a_new_activation() {
        let bridge=Bridge::default();
        bridge.status(json!({"status":"connected","warning":"older service"}));
        bridge.status(json!({"status":"reconnecting"}));
        assert_eq!(bridge.status.lock().unwrap()["warning"],"older service");
        bridge.status(json!({"status":"connected"}));
        assert_eq!(bridge.status.lock().unwrap()["warning"],"older service");
        bridge.status(json!({"status":"connected","warning":null}));
        assert!(bridge.status.lock().unwrap()["warning"].is_null());
    }
}

#[cfg(test)]
mod build_diagnostic_tests {
    use super::*;
    #[test]
    fn compares_claims_without_granting_proof() {
        let core = json!({"schemaVersion":1,"releaseVersion":"1.2.3","buildId":"a","role":"core","targetOs":"darwin","targetArch":"arm64"});
        let hello = json!({"coreBuild":core});
        let mut front = hello["coreBuild"].clone();
        front["role"] = json!("front-door");
        let hash = "a".repeat(64);
        let mut pair = json!({"schemaVersion":1,"frontDoor":{"descriptor":front,"sha256":hash},"core":{"descriptor":hello["coreBuild"],"sha256":hash}});
        assert_eq!(build_diagnostic(&hello, Some(&pair))["status"], "unverified");
        // A matching core claim says nothing about the front door or measured bytes.
        pair["frontDoor"]["descriptor"]["buildId"] = json!("different-front-door");
        pair["frontDoor"]["sha256"] = json!("b".repeat(64));
        pair["core"]["sha256"] = json!("c".repeat(64));
        assert_eq!(build_diagnostic(&hello, Some(&pair))["status"], "unverified");
        pair["core"]["descriptor"]["buildId"] = json!("b");
        assert_eq!(build_diagnostic(&hello, Some(&pair))["status"], "mismatch");
        assert_eq!(build_diagnostic(&json!({}), Some(&pair))["status"], "unknown");
        assert_eq!(build_diagnostic(&hello, None)["status"], "unknown");
        pair["schemaVersion"] = json!(2);
        assert_eq!(build_diagnostic(&hello, Some(&pair))["status"], "unknown");
    }
}
