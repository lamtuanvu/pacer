use serde_json::{Map, Value, json};

pub type Id = Value;

#[derive(Debug, Clone)]
pub struct WireError {
    pub message: String,
    pub data: Value,
}
impl WireError {
    pub fn code(&self) -> &str {
        self.data
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("internal")
    }
    pub fn hint(&self) -> Option<&str> {
        self.data.get("hint").and_then(Value::as_str)
    }
    pub fn reason(&self) -> Option<&str> {
        self.data.get("reason").and_then(Value::as_str)
    }
}

#[derive(Debug)]
pub enum Incoming {
    Request {
        id: Id,
        method: String,
        params: Value,
        /// Host → plugin `_meta` (for example `{ "capabilityCall": "…" }`).
        meta: Option<Value>,
    },
    Notification {
        method: String,
        params: Value,
    },
    Response {
        id: String,
        result: Result<Value, WireError>,
    },
}

/// One JSON-RPC 2.0 message, or None for anything the SDK ignores (as the TypeScript SDK does).
pub fn parse(line: &str) -> Option<Incoming> {
    let v: Value = serde_json::from_str(line).ok()?;
    let o = v.as_object()?;
    if o.get("jsonrpc")?.as_str()? != "2.0" {
        return None;
    }
    let params = o
        .get("params")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let meta = o.get("_meta").cloned().filter(|m| m.is_object());
    if let Some(method) = o.get("method").and_then(Value::as_str) {
        return match o.get("id") {
            Some(id @ (Value::String(_) | Value::Number(_))) => Some(Incoming::Request {
                id: id.clone(),
                method: method.to_owned(),
                params,
                meta,
            }),
            None | Some(Value::Null) => Some(Incoming::Notification {
                method: method.to_owned(),
                params,
            }),
            _ => None,
        };
    }
    let id = match o.get("id") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => return None,
    };
    if let Some(err) = o.get("error") {
        let message = err
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("host error")
            .to_owned();
        let data = err.get("data").cloned().unwrap_or(Value::Null);
        return Some(Incoming::Response {
            id,
            result: Err(WireError { message, data }),
        });
    }
    Some(Incoming::Response {
        id,
        result: Ok(o.get("result").cloned().unwrap_or(Value::Null)),
    })
}

fn line(v: Value) -> String {
    let mut s = v.to_string();
    s.push('\n');
    s
}
pub fn result(id: &Id, value: Value) -> String {
    line(json!({"jsonrpc":"2.0","id":id,"result":value}))
}
pub fn error(id: &Id, code: i64, message: &str, data: Value) -> String {
    line(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message,"data":data}}))
}
pub fn request(id: &str, method: &str, params: Value) -> String {
    request_with_meta(id, method, params, None)
}
pub fn request_with_meta(id: &str, method: &str, params: Value, meta: Option<&Value>) -> String {
    let mut body = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    if let Some(meta) = meta
        && let Some(obj) = body.as_object_mut()
    {
        obj.insert("_meta".into(), meta.clone());
    }
    line(body)
}

/// A request carrying an arbitrary JSON id (string or number), as the real host
/// sends numeric ids to plugins.
pub fn request_value_with_meta(
    id: &Value,
    method: &str,
    params: Value,
    meta: Option<&Value>,
) -> String {
    let mut body = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
    if let Some(meta) = meta
        && let Some(obj) = body.as_object_mut()
    {
        obj.insert("_meta".into(), meta.clone());
    }
    line(body)
}
pub fn notification(method: &str, params: Value) -> String {
    line(json!({"jsonrpc":"2.0","method":method,"params":params}))
}

/// Extract the host's `capabilityCall` token from request `_meta`, if present.
pub fn capability_call_token(meta: Option<&Value>) -> Option<String> {
    meta.and_then(|m| m.get("capabilityCall"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)] // unit tests may use unwrap
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_requests_notifications_and_responses() {
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","id":1,"method":"diagnostic.ping","params":{}}"#),
            Some(Incoming::Request { meta: None, .. })
        ));
        match parse(
            r#"{"jsonrpc":"2.0","id":1,"method":"assistant.reply","params":{},"_meta":{"capabilityCall":"tok"}}"#,
        ) {
            Some(Incoming::Request { meta: Some(m), .. }) => {
                assert_eq!(m["capabilityCall"], "tok");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            parse(r#"{"jsonrpc":"2.0","method":"$/cancel","params":{"id":1}}"#),
            Some(Incoming::Notification { .. })
        ));
        match parse(r#"{"jsonrpc":"2.0","id":"p1","result":{"config":{}}}"#) {
            Some(Incoming::Response { id, result: Ok(v) }) => {
                assert_eq!(id, "p1");
                assert_eq!(v, json!({"config":{}}));
            }
            other => panic!("{other:?}"),
        }
        match parse(
            r#"{"jsonrpc":"2.0","id":"p2","error":{"code":-32000,"message":"no","data":{"code":"capability_denied"}}}"#,
        ) {
            Some(Incoming::Response { result: Err(e), .. }) => {
                assert_eq!(e.code(), "capability_denied")
            }
            other => panic!("{other:?}"),
        }
        assert!(parse("{not json").is_none());
        assert!(parse(r#"{"jsonrpc":"1.0","id":1,"method":"x"}"#).is_none());
    }

    #[test]
    fn encodes_one_line_each() {
        let l = error(
            &json!(4),
            -32000,
            "no account",
            json!({"code":"invalid_input"}),
        );
        assert!(l.ends_with('\n') && !l[..l.len() - 1].contains('\n'));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&l).unwrap()["error"]["data"]["code"],
            "invalid_input"
        );
        let with_meta = request_with_meta(
            "p1",
            "capability.assistant.tool",
            json!({}),
            Some(&json!({"capabilityCall":"t"})),
        );
        let v: Value = serde_json::from_str(with_meta.trim_end()).unwrap();
        assert_eq!(v["_meta"]["capabilityCall"], "t");
    }
}
