//! Old-release console reads remain compatibility-only and never refresh Orca
//! membership or delete registrations from this read-model library.
use crate::{js::*, read};
use pacer_foundation::Ctx;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::PathBuf;
#[derive(Default)]
pub(crate) struct Consoles {
    registrations: HashMap<PathBuf, (f64, Vec<Value>)>,
}
impl Consoles {
    pub fn read(
        &mut self,
        ctx: &Ctx,
        current: &str,
        alive: &dyn Fn(i64) -> bool,
    ) -> (Value, Vec<Value>) {
        let raw = if let Some((_, rows)) = self
            .registrations
            .get(&ctx.pacer_home)
            .filter(|(at, _)| ctx.now >= *at && ctx.now - *at < 2.0)
        {
            rows.clone()
        } else {
            let mut rows = vec![read(ctx, "link/console.json")];
            if let Ok(entries) = std::fs::read_dir(ctx.pacer_home.join("link/consoles")) {
                let mut entries = entries.flatten().collect::<Vec<_>>();
                entries.sort_by_key(|e| e.file_name());
                for e in entries {
                    let name = e.file_name();
                    let name = name.to_string_lossy();
                    if name.strip_suffix(".json").is_some_and(|name| {
                        !name.is_empty()
                            && name
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    }) {
                        rows.push(
                            pacer_foundation::fsutil::read_json(&e.path()).unwrap_or(Value::Null),
                        );
                    }
                }
            }
            self.registrations
                .insert(ctx.pacer_home.clone(), (ctx.now, rows.clone()));
            rows
        };
        let mut found: Vec<Value> = Vec::new();
        for raw in raw {
            let c = parse(&raw);
            if c.is_null()
                || ctx.now - num(&c["heartbeatAt"]) > 600.0
                || !c["pid"].as_i64().is_some_and(alive)
                || !truth(&c["handle"])
            {
                continue;
            }
            if let Some(old) = found.iter_mut().find(|old| old["handle"] == c["handle"]) {
                if num(&old["heartbeatAt"]) < num(&c["heartbeatAt"]) {
                    *old = c;
                }
            } else {
                found.push(c);
            }
        }
        found.sort_by(|a, b| num(&b["heartbeatAt"]).total_cmp(&num(&a["heartbeatAt"])));
        found.truncate(32);
        found.retain(|c| current_version(c, current));
        let console = found.first().cloned().unwrap_or_else(|| {
            let c = parse(&read(ctx, "link/console.json"));
            if !c.is_null()
                && ctx.now - num(&c["heartbeatAt"]) <= 30.0
                && c["pid"].as_i64().is_some_and(alive)
                && current_version(&c, current)
            {
                c
            } else {
                Value::Null
            }
        });
        (console, found)
    }
}
fn parse(raw: &Value) -> Value {
    pacer_store::outbox::parse_snapshot(&json!({"v":1,"seq":0,"at":0,"console":raw}))
        .map_or(Value::Null, |s| s["console"].clone())
}
fn version(v: &str) -> Option<(Vec<f64>, Option<Vec<String>>)> {
    let re=regex::Regex::new(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$").ok()?;
    let parts = re.captures(v)?;
    let numbers = (1..=3)
        .map(|i| {
            parts
                .get(i)
                .and_then(|m| m.as_str().parse::<f64>().ok())
                .unwrap_or(0.0)
        })
        .collect();
    let pre = parts
        .get(4)
        .map(|m| m.as_str().split('.').map(String::from).collect());
    Some((numbers, pre))
}
fn current_version(c: &Value, current: &str) -> bool {
    let Some(v) = c["version"].as_str() else {
        return true;
    };
    let (Some((a, pa)), Some((b, pb))) = (version(v), version(current)) else {
        return false;
    };
    for (a, b) in a.iter().zip(b) {
        if *a != b {
            return *a > b;
        }
    }
    match (pa, pb) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(a), Some(b)) => {
            for i in 0..a.len().max(b.len()) {
                let (Some(x), Some(y)) = (a.get(i), b.get(i)) else {
                    return a.len() > b.len();
                };
                if x == y {
                    continue;
                }
                let nx = x.bytes().all(|b| b.is_ascii_digit());
                let ny = y.bytes().all(|b| b.is_ascii_digit());
                return if nx && ny {
                    x.parse::<f64>().unwrap_or(0.0) > y.parse::<f64>().unwrap_or(0.0)
                } else if nx {
                    false
                } else if ny {
                    true
                } else {
                    x > y
                };
            }
            true
        }
    }
}
