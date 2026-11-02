//! Best-effort default-folder record: retain only known absolute strings, exactly.
use super::*;
use crate::{WireReply, orca_policy::LoginEnvironment};
use serde::{
    Deserialize, Deserializer,
    de::{MapAccess, Visitor},
};
use serde_json::value::RawValue;

#[derive(Default)]
struct Selected([Option<Box<RawValue>>; 2]);
impl<'de> Deserialize<'de> for Selected {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Selected;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("default account folders object")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Selected, M::Error> {
                let mut selected = Selected::default();
                while let Some(key) = map.next_key::<Box<RawValue>>()? {
                    let value = map.next_value::<Box<RawValue>>()?;
                    // Foreign keys may contain unpaired UTF-16 units. Only the
                    // two scalar ASCII names need decoding; last duplicate wins.
                    let index = match serde_json::from_str::<String>(key.get()).as_deref() {
                        Ok("claude") => Some(0),
                        Ok("codex") => Some(1),
                        _ => None,
                    };
                    if let Some(index) = index {
                        selected.0[index] = Some(value);
                    }
                }
                Ok(selected)
            }
        }
        deserializer.deserialize_map(Fields)
    }
}
fn read(bytes: &[u8]) -> Result<WireReply, BrokerError> {
    let text = String::from_utf8_lossy(bytes);
    let mut folders = WireReply::new(json!({}));
    // Validate the whole grammar/EOF without materializing ignored values or
    // applying WireReply's object-key/depth limits to foreign fields.
    let Ok(raw) = serde_json::from_str::<Box<RawValue>>(&text) else {
        return Ok(folders);
    };
    if !raw.get().starts_with('{') {
        return Ok(folders);
    }
    let selected: Selected = serde_json::from_str(raw.get()).map_err(|_| denied())?;
    for (kind, raw) in ["claude", "codex"].into_iter().zip(selected.0) {
        if let Some(raw) = raw.filter(|r| r.get().starts_with('"')) {
            let value = WireReply::parse(raw.get()).map_err(|_| denied())?;
            if value.preview().as_str().is_some_and(|s| s.starts_with('/')) {
                folders
                    .put(&format!("/{kind}"), value)
                    .map_err(|_| denied())?;
            }
        }
    }
    Ok(folders)
}
pub(super) fn record(
    home: &Path,
    agent: &str,
    account: &HashMap<String, String>,
    base: &LoginEnvironment,
) -> Result<(), BrokerError> {
    let (kind, variable) = match agent {
        "claude" => ("claude", "CLAUDE_CONFIG_DIR"),
        "codex" => ("codex", "CODEX_HOME"),
        _ => return Ok(()),
    };
    if account.contains_key(variable) || !base.login_shell {
        return Ok(());
    }
    let next = base
        .profile_keys
        .iter()
        .any(|key| key == variable)
        .then(|| base.env.get(variable))
        .flatten()
        .filter(|s| s.starts_with('/'));
    let relative = Path::new("state/default-account-folders.json");
    let bytes = std::fs::read(home.join(relative)).unwrap_or_default();
    let mut folders = read(&bytes)?;
    let path = format!("/{kind}");
    let prior = folders.subtree(&path).ok();
    let next = next.map(|s| WireReply::new(json!(s)));
    let json = |value: &WireReply| value.to_json().map_err(|_| denied());
    if prior.as_ref().map(json).transpose()? == next.as_ref().map(json).transpose()? {
        return Ok(());
    }
    if let Some(next) = next {
        folders.put(&path, next).map_err(|_| denied())?;
    } else {
        folders.remove(&path).map_err(|_| denied())?;
    }
    super::launch::write_private(
        home,
        relative,
        folders.to_json().map_err(|_| denied())?.as_bytes(),
    )
}
#[cfg(test)]
mod tests;
