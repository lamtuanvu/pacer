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
}

#[derive(Debug)]
pub enum Incoming {
    Request {
        id: Id,
        method: String,
        params: Value,
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
    if let Some(method) = o.get("method").and_then(Value::as_str) {
        return match o.get("id") {
            Some(id @ (Value::String(_) | Value::Number(_))) => Some(Incoming::Request {
                id: id.clone(),
                method: method.to_owned(),
                params,
            }),
            None | Some(Value::Null) => Some(Incoming::Notification {
                method: method.to_owned(),
                params,
            }),
            _ => None,
        };
    }
    let id = o.get("id")?.as_str()?.to_owned();
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
    line(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
}
pub fn notification(method: &str, params: Value) -> String {
    line(json!({"jsonrpc":"2.0","method":method,"params":params}))
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
            Some(Incoming::Request { .. })
        ));
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
    }
}
