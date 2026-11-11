//! TypeScript-compatible plugin settings, revision CAS and visibility.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
pub use pacer_js_json::js_semantics::trim as js_trim;
pub use pacer_js_json::number_string as js_number;
use pacer_js_json::quoted;
pub use pacer_js_json::quoted::{stringify as js_json, stringify_ipc as ipc_json};
use serde_json::{Value, json};
use std::fs;
use unicode_normalization::UnicodeNormalization;

pub fn clean_text(s: &str) -> String {
    s.nfc().filter(|c| !matches!(*c as u32, 0..=8 | 11..=12 | 14..=31 | 127..=159 | 0x200b..=0x200f | 0x202a..=0x202e | 0x2060..=0x2064 | 0x2066..=0x2069 | 0xfeff)).collect()
}
pub fn js_length(s: &str) -> usize {
    quoted::utf16(s).len()
}
fn empty() -> Value {
    json!({"rev":0,"values":{},"hidden":[]})
}
fn store(ctx: &Ctx) -> Result<Value, CoreError> {
    let path = ctx.pacer_home.join("plugin-settings.json");
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = match fs::read(&path).map(|bytes| quoted::parse_file(&bytes)) {
        Ok(Err(error)) if error == quoted::NESTING_FALLBACK => {
            // Unsupported native decoding is not evidence of corrupt state.
            // Leave the source intact and let the read dispatcher use TS.
            return Err(CoreError::new(Code::Unavailable, error));
        }
        Ok(Ok(value)) => Some(value),
        _ => None,
    };
    let Some(Value::Object(raw)) = raw else {
        let _ = fs::rename(
            &path,
            path.with_file_name(format!(
                "plugin-settings.json.corrupt-{}",
                (pacer_foundation::ctx::unix_now() * 1000.0) as u64
            )),
        );
        return Ok(json!({}));
    };
    let mut out = json!({});
    for (id, r) in raw {
        if quoted::number(&r["rev"]).is_some() && r["values"].is_object() {
            out[&id] = json!({"rev":r["rev"],"values":r["values"],"hidden":r["hidden"].as_array().map(|a| a.iter().filter(|v| v.is_string() && !quoted::nonfinite(v)).cloned().collect::<Vec<_>>()).unwrap_or_default()});
        }
    }
    Ok(out)
}
pub fn read(ctx: &Ctx, id: &str) -> Result<Value, CoreError> {
    Ok(store(ctx)?.get(id).cloned().unwrap_or_else(empty))
}
pub fn validate(schema: &Value, values: &Value) -> Vec<Value> {
    let mut errors = vec![];
    let ordered = quoted::parse(js_json(values).as_bytes()).unwrap_or(Value::Null);
    let Some(values) = ordered.as_object() else {
        return errors;
    };
    for (name, v) in values {
        let f = &schema["fields"][name];
        let max = |key: &str, default: u64| f[key].as_f64().unwrap_or(default as f64) as usize;
        let msg = match f["type"].as_str() {
            Some("boolean") => (!v.is_boolean()).then(|| "must be on or off".into()),
            Some("string") => match v.as_str() {
                None => Some("must be text".into()),
                Some(s) if js_length(s) > max("maxLength", 2000) => Some(format!(
                    "must be at most {} characters",
                    max("maxLength", 2000)
                )),
                Some(_) if f["enum"].as_array().is_some_and(|a| !a.contains(v)) => {
                    Some("must be one of the listed options".into())
                }
                Some(s) if clean_text(s) != s => {
                    Some("contains characters that are not allowed".into())
                }
                _ => None,
            },
            Some("secretRef") => (!v.as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.as_bytes()[0].is_ascii_alphanumeric()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
            }))
            .then(|| "must be the name of a secret reference".into()),
            Some("integer") => match v.as_f64() {
                Some(n) if n.is_finite() && n.fract() == 0.0 => {
                    if n < f["minimum"].as_f64().unwrap_or(0.0)
                        || n > f["maximum"].as_f64().unwrap_or(0.0)
                    {
                        Some(format!(
                            "must be between {} and {}",
                            js_number(f["minimum"].as_f64().unwrap_or(0.0)),
                            js_number(f["maximum"].as_f64().unwrap_or(0.0))
                        ))
                    } else {
                        None
                    }
                }
                _ => Some("must be a whole number".into()),
            },
            Some(kind @ ("array" | "repos")) => {
                if !v.as_array().is_some_and(|a| {
                    a.iter().all(|v| {
                        v.as_str().is_some_and(|s| {
                            js_length(s) <= if kind == "repos" { 4096 } else { 2000 }
                                && (kind == "repos" || clean_text(s) == s)
                        })
                    })
                }) {
                    Some(
                        if kind == "repos" {
                            "must be a list of repositories"
                        } else {
                            "must be a list of text"
                        }
                        .into(),
                    )
                } else if v.as_array().is_some_and(|a| a.len() > max("maxItems", 100)) {
                    Some(format!("must have at most {} items", max("maxItems", 100)))
                } else {
                    None
                }
            }
            _ => Some("is not a setting of this plugin".into()),
        };
        if let Some(message) = msg {
            errors.push(json!({"path":name,"message":message}));
        }
        if errors.len() == 50 {
            break;
        }
    }
    errors
}
fn mutate(
    ctx: &Ctx,
    id: &str,
    rev: f64,
    visibility: Option<(&str, bool)>,
    values: Option<Value>,
) -> Result<Value, CoreError> {
    crate::private::locked(ctx, "plugin-settings", |ctx| {
        let mut all = store(ctx)?;
        let mut cur = all.get(id).cloned().unwrap_or_else(empty);
        let actual = quoted::number(&cur["rev"]).unwrap_or(0.0);
        if actual != rev {
            return Err(CoreError::new(
                Code::Conflict,
                format!(
                    "plugin {id} {}at revision {}, not {}",
                    if visibility.is_some() {
                        "is "
                    } else {
                        "settings are "
                    },
                    js_number(actual),
                    js_number(rev)
                ),
            )
            .hint(if visibility.is_some() {
                "Reload and try again."
            } else {
                "Reload the page and try again."
            }));
        }
        cur["rev"] = js_value(actual + 1.0);
        if let Some((key, visible)) = visibility {
            let mut hidden = cur["hidden"].as_array().cloned().unwrap_or_default();
            if visible {
                hidden.retain(|v| v != key);
            } else {
                hidden.push(json!(key));
                let mut seen = std::collections::HashSet::new();
                hidden.retain(|v| seen.insert(v.as_str().unwrap_or("").to_owned()));
            }
            cur["hidden"] = json!(hidden);
        }
        if let Some(values) = values {
            cur["values"] = values;
        }
        all[id] = cur.clone();
        crate::private::write_shared(
            &ctx.pacer_home.join("plugin-settings.json"),
            js_json(&all).as_bytes(),
        )?;
        Ok(cur)
    })
}
pub fn save(ctx: &Ctx, id: &str, values: Value, rev: f64) -> Result<Value, CoreError> {
    mutate(ctx, id, rev, None, Some(values))
}
pub fn visibility(
    ctx: &Ctx,
    id: &str,
    key: &str,
    visible: bool,
    rev: f64,
) -> Result<Value, CoreError> {
    mutate(ctx, id, rev, Some((key, visible)), None)
}
pub fn forget(ctx: &Ctx, id: &str) -> Result<(), CoreError> {
    crate::private::locked(ctx, "plugin-settings", |ctx| {
        let mut all = store(ctx)?;
        if all
            .as_object_mut()
            .is_some_and(|o| o.shift_remove(id).is_some())
        {
            crate::private::write_shared(
                &ctx.pacer_home.join("plugin-settings.json"),
                js_json(&all).as_bytes(),
            )?;
        }
        Ok(())
    })
}

/// Strategy config remains the fallback; saved values overlay it without defaults.
pub fn effective_config(ctx: &Ctx, id: &str) -> Result<Value, CoreError> {
    let cfg = crate::config::read_config(ctx)?;
    let mut values = cfg["config"][id].as_object().cloned().unwrap_or_default();
    if let Some(saved) = read(ctx, id)?["values"].as_object() {
        values.extend(saved.clone());
    }
    Ok(Value::Object(values))
}

fn js_value(n: f64) -> Value {
    serde_json::from_str(&js_number(n)).unwrap_or(Value::Null)
}
