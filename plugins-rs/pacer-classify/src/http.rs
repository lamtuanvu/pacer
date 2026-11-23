//! Classifier adapter vocabulary, a port of `plugins/pacer-classify/http.ts`.
//!
//! Defines the question/answer shapes every adapter shares, the narrowed
//! `ClassifierHost` client surface adapters use, and the shared helpers
//! (`join_url`, `is_local_url`, `post_json`) including the `HttpError`
//! translation for non-2xx responses. The `Answer` is exposed as raw JSON so
//! handlers return it verbatim.

use pacer_plugin::{HttpResponse, PluginError};
use serde_json::{Map, Value, json};

/// An ECMAScript `URL`-based check for `is_local_url` (http.ts:49-53).
pub fn is_local_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let host = parsed.host_str().unwrap_or_default();
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost")
}

/// `joinUrl` (http.ts:46-48): join with exactly one slash between.
pub fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}/{}",
        base.trim_end_matches('/'),
        path.trim_start_matches('/')
    )
}

/// An error raised by `postJson` for a non-2xx response (http.ts:21-28). The
/// body is kept (and may be echoed) only for anonymous requests, so an
/// authenticated body that echoes a credential is never surfaced.
#[derive(Debug)]
pub struct HttpError {
    pub status: u16,
    pub body: String,
    pub authenticated: bool,
}

impl HttpError {
    /// The `PluginError` the host sees: `HTTP <status>` for authenticated
    /// failures, else `HTTP <status>: <body.slice(0, 200)>` (http.ts:24).
    pub fn into_plugin(self) -> PluginError {
        let message = if self.authenticated {
            format!("HTTP {}", self.status)
        } else {
            format!("HTTP {}: {}", self.status, slice(&self.body, 200))
        };
        PluginError::new("invalid_input", message)
    }
}

/// Errors `postJson` can return. A transport failure propagates unchanged; an
/// HTTP status or a non-JSON body take the TS `HttpError` / plain-`Error`
/// shape respectively.
#[derive(Debug)]
pub enum PostJsonError {
    Transport(PluginError),
    Http(HttpError),
    NotJson,
}

impl PostJsonError {
    /// The `PluginError` surface: `invalid_input` for an HTTP status,
    /// `internal` for a parse failure (a plain `Error` in TS).
    pub fn into_plugin(self) -> PluginError {
        match self {
            PostJsonError::Transport(e) => e,
            PostJsonError::Http(e) => e.into_plugin(),
            PostJsonError::NotJson => PluginError::new("internal", "invalid JSON response body"),
        }
    }

    /// True when this came from a non-2xx status (so `jev` can wrap it).
    pub fn status(&self) -> Option<u16> {
        match self {
            PostJsonError::Http(e) => Some(e.status),
            _ => None,
        }
    }
}

/// The narrowed client surface adapters use (`http | secrets`, http.ts:19).
pub trait ClassifierHost {
    fn http(&self, request: Value) -> impl std::future::Future<Output = Result<HttpResponse, PluginError>> + Send;
    fn present(&self, reference: &str) -> impl std::future::Future<Output = Result<bool, PluginError>> + Send;
}

/// The real host satisfies the adapter surface, so handlers pass `&ctx.host`.
impl ClassifierHost for pacer_plugin::Host {
    fn http(
        &self,
        request: Value,
    ) -> impl std::future::Future<Output = Result<HttpResponse, PluginError>> + Send {
        pacer_plugin::Host::http(self, request)
    }

    fn present(
        &self,
        reference: &str,
    ) -> impl std::future::Future<Output = Result<bool, PluginError>> + Send {
        pacer_plugin::Host::secrets_present(self, reference)
    }
}

/// `postJson` (http.ts:37-44): POST JSON and parse the JSON body, translating
/// a non-2xx status into `HttpError` and a non-JSON body into `NotJson`.
/// `key_ref` adds `authorization: { secretRef }` when present and marks the
/// request authenticated, so an echoed credential is never surfaced.
pub async fn post_json<T: ClassifierHost>(
    host: &T,
    url: &str,
    body: &Value,
    timeout_ms: f64,
    key_ref: Option<&str>,
) -> Result<Value, PostJsonError> {
    let mut request = serde_json::Map::new();
    request.insert("url".into(), json!(url));
    request.insert("method".into(), json!("POST"));
    request.insert(
        "headers".into(),
        json!({ "content-type": "application/json" }),
    );
    request.insert("body".into(), Value::String(stable_json(body)));
    request.insert("timeoutMs".into(), js_number(timeout_ms));
    if let Some(reference) = key_ref {
        request.insert(
            "authorization".into(),
            json!({ "secretRef": reference }),
        );
    }
    let response = host
        .http(Value::Object(request))
        .await
        .map_err(PostJsonError::Transport)?;
    if !(200..300).contains(&response.status) {
        return Err(PostJsonError::Http(HttpError {
            status: response.status,
            body: response.body,
            authenticated: key_ref.is_some(),
        }));
    }
    serde_json::from_str(&response.body).map_err(|_| PostJsonError::NotJson)
}

/// The schema field an adapter writes for a question kind (ollama.ts:4-6).
pub fn field_for(kind: &str) -> &'static str {
    match kind {
        "choice" => "choice",
        "score" => "score",
        _ => "answer",
    }
}

/// A classified question (`Question` in http.ts), validated from a snapshot.
#[derive(Debug, Clone)]
pub enum Question {
    Choice {
        id: String,
        instructions: String,
        criteria: Map<String, Value>,
    },
    Score {
        id: String,
        instructions: String,
        min: f64,
        max: f64,
    },
    YesNo {
        id: String,
        instructions: String,
    },
}

impl Question {
    pub fn id(&self) -> &str {
        match self {
            Question::Choice { id, .. } => id,
            Question::Score { id, .. } => id,
            Question::YesNo { id, .. } => id,
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Question::Choice { .. } => "choice",
            Question::Score { .. } => "score",
            Question::YesNo { .. } => "yesno",
        }
    }

    pub fn instructions(&self) -> &str {
        match self {
            Question::Choice { instructions, .. } => instructions,
            Question::Score { instructions, .. } => instructions,
            Question::YesNo { instructions, .. } => instructions,
        }
    }
}

/// Build the `Answer` JSON object an adapter returns (`answer` in
/// rules.ts:37-39 and the shared shape in http.ts): `value`, `confidence`,
/// `latencyMs`, and `costUsd` (only when present — the Jev adapter computes it
/// conditionally). `probabilities` is included only when present.
pub fn answer_body(
    value: Value,
    confidence: f64,
    latency_ms: f64,
    cost_usd: Option<Value>,
    probabilities: Option<Map<String, Value>>,
) -> Value {
    let mut object = Map::new();
    object.insert("value".into(), value);
    if let Some(probabilities) = probabilities {
        object.insert("probabilities".into(), Value::Object(probabilities));
    }
    object.insert("confidence".into(), json!(confidence));
    object.insert("latencyMs".into(), js_number(latency_ms));
    if let Some(cost_usd) = cost_usd {
        object.insert("costUsd".into(), cost_usd);
    }
    Value::Object(object)
}

/// Compact JSON, as `JSON.stringify` would emit for the plain request
/// objects these adapters build.
fn stable_json(v: &Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

/// A JSON number for an f64, keeping integral values in their integer form
/// (JS numbers — `0.5` stays a fraction, `120001` stays an integer).
pub fn js_number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n.is_sign_positive() && n <= 9.007e15 {
        Value::Number((n as i64).into())
    } else {
        serde_json::Number::from_f64(n)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// `String.prototype.slice` shortening for error bodies (slices at 200).
pub fn slice(s: &str, len: usize) -> String {
    pacer_plugin::js::slice_utf16(s, 0, Some(len as i64))
}