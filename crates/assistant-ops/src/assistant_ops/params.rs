//! The `ops-assistant.ts` param schemas, with Zod issue text and order. Unknown
//! keys are stripped, as `z.object` does.
use super::MAX_SAFE;
use pacer_foundation::api::{Code, CoreError};
use pacer_store::assistant::{Field, LIMITS, RETENTION};
use serde_json::{Map, Value};

const STATES: [&str; 4] = ["done", "failed", "dismissed", "stale"];

pub(crate) struct SettingsParams {
    pub runner: Option<String>,
    pub account: Option<String>,
    pub limits: Option<Vec<i64>>,
    pub retention: Option<Vec<i64>>,
    pub expect_rev: i64,
}

pub(crate) enum Params {
    Empty,
    Settings(SettingsParams),
    Page {
        before: Option<f64>,
        limit: Option<i64>,
    },
    Id(Option<String>),
    Card {
        turn_id: String,
        card_id: String,
        state: String,
        result: Option<String>,
    },
}

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

struct Issues(Vec<String>);
impl Issues {
    fn push(&mut self, path: &str, message: impl std::fmt::Display) {
        self.0.push(format!("{path}: {message}"));
    }

    /// `z.string().min(min).max(max)`, counting code points.
    fn string(
        &mut self,
        path: &str,
        value: Option<&Value>,
        min: usize,
        max: usize,
    ) -> Option<String> {
        let Some(Value::String(text)) = value else {
            self.push(
                path,
                format_args!(
                    "Invalid input: expected string, received {}",
                    received(value)
                ),
            );
            return None;
        };
        let length = text.chars().count();
        if length < min {
            self.push(
                path,
                format_args!("Too small: expected string to have >={min} characters"),
            );
        } else if length > max {
            self.push(
                path,
                format_args!("Too big: expected string to have <={max} characters"),
            );
        }
        Some(text.clone())
    }

    /// `z.number().int()` with an inclusive (or, for `positive()`, exclusive) minimum.
    fn int(
        &mut self,
        path: &str,
        value: Option<&Value>,
        min: i64,
        exclusive: bool,
        max: Option<i64>,
    ) -> Option<i64> {
        let Some(n) = value.and_then(Value::as_f64) else {
            self.push(
                path,
                format_args!(
                    "Invalid input: expected number, received {}",
                    received(value)
                ),
            );
            return None;
        };
        if n.fract() != 0.0 {
            self.push(path, "Invalid input: expected int, received number");
            return None;
        }
        if n > MAX_SAFE {
            self.push(path, "Too big: expected int to be <=9007199254740991");
        } else if n < -MAX_SAFE {
            self.push(path, "Too small: expected int to be >=-9007199254740991");
        }
        if exclusive && n <= min as f64 {
            self.push(
                path,
                format_args!("Too small: expected number to be >{min}"),
            );
        } else if !exclusive && n < min as f64 {
            self.push(
                path,
                format_args!("Too small: expected number to be >={min}"),
            );
        } else if let Some(max) = max.filter(|max| n > *max as f64) {
            self.push(path, format_args!("Too big: expected number to be <={max}"));
        }
        Some(n as i64)
    }

    /// `schema.partial().optional()`: absent fields take their defaults.
    fn fields(&mut self, path: &str, value: Option<&Value>, fields: &[Field]) -> Option<Vec<i64>> {
        let value = value?;
        let Some(map) = value.as_object() else {
            self.push(
                path,
                format_args!(
                    "Invalid input: expected object, received {}",
                    received(Some(value))
                ),
            );
            return None;
        };
        let parsed: Vec<Option<i64>> = fields
            .iter()
            .map(|f| match map.get(f.name) {
                None => Some(f.default),
                v => self.int(&format!("{path}.{}", f.name), v, f.min, false, Some(f.max)),
            })
            .collect();
        parsed.into_iter().collect()
    }

    fn nullable_string(&mut self, path: &str, value: Option<&Value>, max: usize) -> Option<String> {
        match value {
            Some(Value::Null) => None,
            v => self.string(path, v, 1, max),
        }
    }

    fn finish<T>(self, value: T) -> Result<T, CoreError> {
        if self.0.is_empty() {
            Ok(value)
        } else {
            Err(CoreError::new(Code::InvalidInput, self.0.join("; ")))
        }
    }
}

/// `params ?? {}` must be an object.
fn object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                received(Some(other))
            ),
        )),
    }
}

pub(crate) fn parse(op: &str, params: Value) -> Result<Params, CoreError> {
    let p = object(&params)?;
    let mut issues = Issues(Vec::new());
    let parsed = match op {
        "assistant.settings.set" => {
            let runner = issues.nullable_string("runner", p.get("runner"), 128);
            let account = issues.nullable_string("account", p.get("account"), 64);
            let limits = issues.fields("limits", p.get("limits"), &LIMITS);
            let retention = issues.fields("retention", p.get("retention"), &RETENTION);
            let expect_rev = issues.int("expect_rev", p.get("expect_rev"), 0, true, None);
            Params::Settings(SettingsParams {
                runner,
                account,
                limits,
                retention,
                expect_rev: expect_rev.unwrap_or(0),
            })
        }
        "assistant.conversations" => {
            let before = match p.get("before") {
                None => None,
                Some(v) => {
                    let n = v.as_f64();
                    if n.is_none() {
                        issues.push(
                            "before",
                            format_args!(
                                "Invalid input: expected number, received {}",
                                received(Some(v))
                            ),
                        );
                    }
                    n
                }
            };
            let limit = match p.get("limit") {
                None => None,
                v => issues.int("limit", v, 1, false, Some(100)),
            };
            Params::Page { before, limit }
        }
        "assistant.conversation" => Params::Id(issues.string("id", p.get("id"), 1, 128)),
        "assistant.turn" => Params::Id(issues.string("turnId", p.get("turnId"), 1, 128)),
        "assistant.delete" => Params::Id(match p.get("id") {
            None => None,
            v => issues.string("id", v, 1, 128),
        }),
        "assistant.card.record" | "assistant.card.refresh" => {
            let turn_id = issues.string("turnId", p.get("turnId"), 1, 128);
            let card_id = issues.string("cardId", p.get("cardId"), 1, 128);
            let (mut state, mut result) = (None, None);
            if op == "assistant.card.record" {
                state = p
                    .get("state")
                    .and_then(Value::as_str)
                    .filter(|s| STATES.contains(s))
                    .map(str::to_owned);
                if state.is_none() {
                    issues.push("state", "Invalid option: expected one of \"done\"|\"failed\"|\"dismissed\"|\"stale\"");
                }
                if let Some(v) = p.get("result") {
                    result = issues.string("result", Some(v), 0, 500);
                }
            }
            Params::Card {
                turn_id: turn_id.unwrap_or_default(),
                card_id: card_id.unwrap_or_default(),
                state: state.unwrap_or_default(),
                result,
            }
        }
        _ => Params::Empty,
    };
    issues.finish(parsed)
}
