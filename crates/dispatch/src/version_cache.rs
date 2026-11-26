//! The in-process `--version` cache that replaces Core's `checkedVersions`
//! (`src/dispatch/enforcement.ts:57`). Owned by the server listener and the
//! stdio session; every dispatch-parts call in one process shares it.
use std::{collections::HashMap, sync::Mutex};

#[derive(Debug, Default)]
pub struct VersionCache(Mutex<HashMap<String, String>>);

impl VersionCache {
    /// A previously verified version for this key (binary path plus mtime).
    pub fn get(&self, key: &str) -> Option<String> {
        self.0.lock().map_or(None, |cache| cache.get(key).cloned())
    }

    /// Record a successful `[binary, "--version"]` check.
    pub fn insert(&self, key: String, version: String) {
        if let Ok(mut cache) = self.0.lock() {
            cache.insert(key, version);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_independent() {
        let cache = VersionCache::default();
        cache.insert("a".into(), "1".into());
        assert_eq!(cache.get("a").as_deref(), Some("1"));
        assert!(cache.get("b").is_none());
    }
}
