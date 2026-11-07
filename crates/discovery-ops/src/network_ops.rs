//! Native `discovery.list`, `discovery.network.get` and `discovery.network.set`
//! (`src/api/ops-discovery.ts`) over the Rust current-network probe.
//!
//! A state file whose network or found-machine entries the TypeScript handlers
//! would trip over (a non-object entry, non-list aliases, a found machine
//! without a numeric `lastSeen` or string `discoveryId`) stays forwarded, as do
//! the files `discovery_ops` already forwards.
#![allow(clippy::result_large_err)]
use crate::discovery_ops::{
    State, authorize, done, expect_rev, object, read_state, type_name, unusable, update_state,
};
use crate::network::{NetworkInfo, current_network, radio_available};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    ctx::unix_now,
};
use serde_json::{Map, Value, json};

/// discovery.list returns at most this many found machines, most recently seen first.
const FOUND_MAX: usize = 100;
const WARNING: &str = "The discovery state file could not be read, so discovery is off. Turn it on again to start over.";
const ALPHABET: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

pub(crate) fn reads_native(state: &State) -> bool {
    let networks = state.object("networks").is_none_or(|networks| {
        networks.values().all(|entry| {
            entry.as_object().is_some_and(|entry| {
                entry
                    .get("aliases")
                    .is_none_or(|a| a.is_null() || a.is_array())
            })
        })
    });
    let seen = state.object("seen").is_none_or(|seen| {
        seen.values().all(|x| {
            x.get("lastSeen").is_some_and(Value::is_number)
                && x.get("discoveryId").is_some_and(Value::is_string)
        })
    });
    networks && seen
}

fn aliases(entry: &Value) -> impl Iterator<Item = &Value> {
    entry["aliases"].as_array().into_iter().flatten()
}

/// `findNetwork`: the entry key and whether the entry should record the key.
fn find_network(networks: &Map<String, Value>, net: &NetworkInfo) -> Option<(String, bool)> {
    if let Some(own) = networks.get(&net.key) {
        let adopt = net.group.is_some() && own["group"].as_str() != net.group.as_deref();
        return Some((net.key.clone(), adopt));
    }
    let key = json!(net.key);
    if let Some((alias, _)) = networks.iter().find(|(_, n)| aliases(n).any(|a| *a == key)) {
        return Some((alias.clone(), false));
    }
    let group = json!(net.group.as_deref()?);
    networks
        .iter()
        .find(|(k, n)| {
            n.get("group") == Some(&group)
                && (net.continues.contains(k)
                    || aliases(n).any(|a| {
                        a.as_str()
                            .is_some_and(|a| net.continues.iter().any(|c| c == a))
                    }))
        })
        .map(|(k, _)| (k.clone(), true))
}

fn network_key(networks: &Map<String, Value>, net: &NetworkInfo) -> String {
    find_network(networks, net).map_or_else(|| net.key.clone(), |(key, _)| key)
}

fn networks_of(state: &State) -> Map<String, Value> {
    state.object("networks").cloned().unwrap_or_default()
}

/// Copies the present fields, as `JSON.stringify` drops undefined ones.
fn pick(target: &mut Map<String, Value>, source: &Value, fields: &[&str]) {
    for field in fields {
        if let Some(value) = source.get(field) {
            target.insert((*field).into(), value.clone());
        }
    }
}

fn readable(ctx: &Ctx) -> Result<State, CoreError> {
    read_state(ctx).filter(reads_native).ok_or_else(unusable)
}

async fn networks(ctx: &Ctx) -> Result<Value, CoreError> {
    let state = readable(ctx)?;
    let net = current_network().await;
    let networks = networks_of(&state);
    let rows: Vec<Value> = networks
        .iter()
        .map(|(key, n)| {
            let mut row = Map::new();
            row.insert("key".into(), json!(key));
            pick(&mut row, n, &["label", "advertise", "muted"]);
            Value::Object(row)
        })
        .collect();
    Ok(json!({
        "rev": state.doc["rev"],
        "networksRev": state.doc["networksRev"],
        "current": net.map(|net| network_key(&networks, &net)),
        "networks": rows,
    }))
}

/// `name` is the machine name this machine advertises, read only when a network is found.
pub async fn discovery_list(
    ctx: &Ctx,
    params: Value,
    name: impl FnOnce() -> Result<Value, CoreError>,
) -> Result<Value, CoreError> {
    authorize(ctx)?;
    object(&params)?;
    let state = readable(ctx)?;
    let now = unix_now().floor();
    let net = current_network().await;
    let networks = networks_of(&state);
    let network = match net {
        Some(net) => {
            let key = network_key(&networks, &net);
            let entry = networks.get(&key).unwrap_or(&Value::Null);
            let muted = entry.get("muted").filter(|m| !m.is_null());
            json!({
                "key": key,
                "label": net.label,
                "advertise": entry.get("advertise").cloned().unwrap_or(Value::Null),
                "muted": muted.cloned().unwrap_or(json!(false)),
                "name": name()?,
            })
        }
        None => Value::Null,
    };
    let silenced = state.object("silenced").cloned().unwrap_or_default();
    let mut seen: Vec<Value> = state
        .object("seen")
        .map(|seen| seen.values().cloned().collect())
        .unwrap_or_default();
    let last = |x: &Value| x["lastSeen"].as_f64().unwrap_or(0.0);
    seen.sort_by(|a, b| last(b).total_cmp(&last(a)));
    let found: Vec<Value> = seen
        .iter()
        .take(FOUND_MAX)
        .map(|x| {
            let id = x["discoveryId"].as_str().unwrap_or_default();
            let quiet = match silenced.get(id) {
                Some(Value::String(v)) => v == "forever",
                Some(Value::Number(v)) => v.as_f64().is_some_and(|v| v > now),
                _ => false,
            };
            let mut row = Map::new();
            pick(&mut row, x, &["discoveryId", "name", "version", "lastSeen"]);
            row.insert("silenced".into(), json!(quiet));
            Value::Object(row)
        })
        .collect();
    let mut out = Map::new();
    out.insert("available".into(), json!(radio_available()));
    out.insert("enabled".into(), state.doc["enabled"].clone());
    out.insert("network".into(), network);
    if state.corrupt {
        out.insert("warning".into(), json!(WARNING));
    }
    out.insert("found".into(), json!(found));
    out.insert("rev".into(), state.doc["rev"].clone());
    out.insert("networksRev".into(), state.doc["networksRev"].clone());
    Ok(Value::Object(out))
}

pub async fn discovery_network_get(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    authorize(ctx)?;
    object(&params)?;
    networks(ctx).await
}

fn new_id() -> String {
    let bytes: [u8; 17] = rand::random();
    let (mut out, mut bits, mut value) = (String::new(), 0u32, 0u32);
    for byte in bytes {
        value = (value << 8) | u32::from(byte);
        bits += 8;
        while bits >= 5 {
            out.push(ALPHABET[((value >> (bits - 5)) & 31) as usize] as char);
            bits -= 5;
        }
        value &= (1 << bits) - 1;
    }
    out.truncate(26);
    out
}

fn optional_bool(p: &Map<String, Value>, key: &str, issues: &mut Vec<String>) -> Option<bool> {
    match p.get(key) {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(other) => {
            issues.push(format!(
                "{key}: Invalid input: expected boolean, received {}",
                type_name(other)
            ));
            None
        }
    }
}

pub async fn discovery_network_set(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    authorize(ctx)?;
    let p = object(&params)?;
    let mut issues = Vec::new();
    let network = match p.get("network") {
        Some(Value::String(n))
            if n.len() == 32 && n.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
        {
            Some(n.clone())
        }
        Some(Value::String(_)) => {
            issues.push("network: Invalid string: must match pattern /^[0-9a-f]{32}$/".into());
            None
        }
        other => {
            issues.push(format!(
                "network: Invalid input: expected string, received {}",
                other.map_or("undefined", type_name)
            ));
            None
        }
    };
    let advertise = optional_bool(&p, "advertise", &mut issues);
    let muted = optional_bool(&p, "muted", &mut issues);
    let reset = optional_bool(&p, "resetId", &mut issues);
    let expect = match p.get("expect_rev") {
        Some(value) => expect_rev(value, &mut issues),
        None => {
            issues.push("expect_rev: Invalid input: expected number, received undefined".into());
            None
        }
    };
    done(issues)?;
    let network = network.unwrap_or_default();
    update_state(ctx, expect, false, |s| {
        let entry = s
            .doc
            .get_mut("networks")
            .and_then(Value::as_object_mut)
            .and_then(|networks| networks.get_mut(&network));
        let entry = match entry {
            Some(Value::Object(entry)) => entry,
            None => return Err(CoreError::new(Code::NotFound, "Unknown network.")),
            Some(_) => return Err(unusable()),
        };
        if let Some(advertise) = advertise {
            entry.insert("advertise".into(), json!(advertise));
            entry.insert("askedAt".into(), json!(unix_now().floor() as i64));
        }
        if let Some(muted) = muted {
            entry.insert("muted".into(), json!(muted));
        }
        if reset == Some(true) {
            entry.insert("discoveryId".into(), json!(new_id()));
        }
        Ok(())
    })?;
    networks(ctx).await
}

#[cfg(test)]
mod tests;
