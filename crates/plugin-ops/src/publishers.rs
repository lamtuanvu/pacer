//! Publisher trust with canonical Ed25519 keys and fingerprint compare-and-swap.
#![allow(clippy::result_large_err)]
use crate::private::{error, parents};
use base64::{Engine, engine::general_purpose::STANDARD};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
fn invalid(s: &str) -> CoreError {
    CoreError::new(Code::InvalidInput, s)
}
pub fn key_bytes(key: &str) -> Result<[u8; 32], CoreError> {
    let bytes = STANDARD
        .decode(key)
        .map_err(|_| invalid("publisher key must be canonical base64"))?;
    if bytes.len() != 32 || STANDARD.encode(&bytes) != key {
        return Err(invalid("publisher key must encode 32 bytes"));
    }
    let mut out = [0; 32];
    out.copy_from_slice(&bytes);
    let mut y = out;
    y[31] &= 127;
    let mut p = [255; 32];
    p[0] = 237;
    p[31] = 127;
    let weak = [
        "0100000000000000000000000000000000000000000000000000000000000000",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000080",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
        "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
        "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
        "0100000000000000000000000000000000000000000000000000000000000080",
        "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    ];
    if weak.contains(&hex::encode(out).as_str())
        || y.iter().rev().cmp(p.iter().rev()) != std::cmp::Ordering::Less
    {
        return Err(invalid(
            "publisher key is a weak or non-canonical Ed25519 point",
        ));
    }
    Ok(out)
}
pub fn fingerprint(key: &str) -> Result<String, CoreError> {
    Ok(hex::encode(Sha256::digest(key_bytes(key)?)))
}
fn name(s: &str) -> Result<(), CoreError> {
    if s.is_empty()
        || s.len() > 128
        || crate::settings::js_trim(s) != s
        || !s.as_bytes()[0].is_ascii_alphanumeric()
        || !s
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._ -".contains(&b))
    {
        Err(invalid("invalid publisher name"))
    } else {
        Ok(())
    }
}
fn encoding(value: &Value) -> Result<String, CoreError> {
    // JSON.stringify enumerates numeric names first and renders 1.0 as 1.
    let ordered: Value = serde_json::from_str(&crate::settings::js_json(value)).map_err(error)?;
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&ordered).map_err(error)?
    ))
}
pub struct PublisherTrust {
    shipped: BTreeMap<String, String>,
}
impl PublisherTrust {
    pub fn new(shipped: BTreeMap<String, String>) -> Result<Self, CoreError> {
        let mut folded = HashSet::new();
        for (n, k) in &shipped {
            name(n)?;
            key_bytes(k)?;
            if !folded.insert(n.to_lowercase()) {
                return Err(invalid(
                    "shipped publisher names collide case-insensitively",
                ));
            }
        }
        Ok(Self { shipped })
    }
    pub fn shipped() -> Result<Self, CoreError> {
        Self::new(
            serde_json::from_str(include_str!("../../../plugins/publishers.json"))
                .map_err(error)?,
        )
    }
    fn load(&self, ctx: &Ctx) -> Result<Value, CoreError> {
        let root = ctx.pacer_home.join("plugins");
        if !crate::private::root(&root, false)? {
            return Ok(json!({"version":1,"publishers":{}}));
        }
        let Some(bytes) = crate::private::read(&root.join("publishers.json"), 64 * 1024, true)?
        else {
            return Ok(json!({"version":1,"publishers":{}}));
        };
        let value =
            crate::json::parse_file(&bytes).map_err(|_| error("invalid publisher store JSON"))?;
        if value.as_object().is_none_or(|o| {
            o.len() != 2 || !o.contains_key("version") || !o.contains_key("publishers")
        }) || value["version"].as_f64() != Some(1.0)
            || !value["publishers"].is_object()
        {
            return Err(error("invalid publisher store shape"));
        }
        let mut seen = HashSet::new();
        if let Some(pubs) = value["publishers"].as_object() {
            for (n, k) in pubs {
                name(n)?;
                key_bytes(
                    k.as_str()
                        .filter(|_| !crate::json::nonfinite(k))
                        .ok_or_else(|| error("invalid publisher key"))?,
                )?;
                if self.shipped.keys().any(|s| s.eq_ignore_ascii_case(n)) {
                    return Err(error("user publisher store shadows a shipped publisher"));
                }
                if !seen.insert(n.to_lowercase()) {
                    return Err(error(
                        "user publisher store has case-colliding publisher names",
                    ));
                }
            }
        }
        if encoding(&value)?.as_bytes() != bytes {
            return Err(error("invalid publisher store encoding"));
        }
        Ok(value)
    }
    pub fn lookup(&self, ctx: &Ctx, publisher: &str) -> Result<Option<Value>, CoreError> {
        name(publisher)?;
        let store = self.load(ctx)?;
        let (key, source) = if let Some(k) = self.shipped.get(publisher) {
            (Some(k.as_str()), "shipped")
        } else {
            (store["publishers"][publisher].as_str(), "user")
        };
        key.map(|key| Ok(json!({"key":key,"fingerprint":fingerprint(key)?,"source":source})))
            .transpose()
    }
    pub fn set(
        &self,
        ctx: &Ctx,
        publisher: &str,
        key: Option<&str>,
        expected: Option<&str>,
    ) -> Result<Value, CoreError> {
        name(publisher)?;
        if let Some(k) = key {
            key_bytes(k)?;
        }
        if expected.is_some_and(|e| {
            e.len() != 64
                || !e
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        }) {
            return Err(invalid("invalid expected fingerprint"));
        }
        parents(&ctx.pacer_home)?;
        crate::private::locked(ctx, "plugins", |ctx| {
            if self.shipped.contains_key(publisher) {
                return Err(CoreError::new(
                    Code::NotAllowed,
                    "shipped publisher key cannot be changed",
                ));
            }
            if self
                .shipped
                .keys()
                .any(|n| n.eq_ignore_ascii_case(publisher))
            {
                return Err(CoreError::new(
                    Code::NotAllowed,
                    "publisher name collides case-insensitively with a shipped publisher",
                ));
            }
            let mut store = self.load(ctx)?;
            if store["publishers"].as_object().is_some_and(|p| {
                p.keys()
                    .any(|n| n != publisher && n.eq_ignore_ascii_case(publisher))
            }) {
                return Err(CoreError::new(
                    Code::Conflict,
                    "publisher name collides case-insensitively with an existing publisher",
                ));
            }
            let actual = store["publishers"][publisher]
                .as_str()
                .map(fingerprint)
                .transpose()?;
            if actual.as_deref() != expected {
                return Err(CoreError::new(
                    Code::Conflict,
                    "publisher fingerprint conflict; review the current key",
                ));
            }
            if let Some(key) = key {
                store["publishers"][publisher] = json!(key);
            } else if let Some(p) = store["publishers"].as_object_mut() {
                p.remove(publisher);
            }
            crate::private::write(
                &ctx.pacer_home.join("plugins/publishers.json"),
                encoding(&store)?.as_bytes(),
            )?;
            Ok(json!({"fingerprint":key.map(fingerprint).transpose()?}))
        })
    }
}
