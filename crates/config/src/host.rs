//! Host identity and local strategy edits. SSH execution stays with the plugin.

use crate::{
    doc::{StrategyDoc, parse_value},
    strategy::{StrategyError, validate_strategy},
};
use serde_json::{Value, json};
use std::{fs, path::Path};

fn canonical(key: &str) -> bool {
    let mut parts = key.split('/');
    let (Some(host), Some(owner), Some(repo), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let first = |s: &str| {
        s.as_bytes()
            .first()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
    };
    !host.is_empty()
        && host
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b".-".contains(&c))
        && first(owner)
        && owner
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
        && first(repo)
        && repo
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
        && !key.ends_with(".git")
}

/// Match `repoKey` in `src/config/hosts.ts`; malformed or unsupported URLs have no key.
pub fn repo_key(url: &str) -> Option<String> {
    let scp = url.split_once('@').and_then(|(user, rest)| {
        if user.is_empty()
            || user
                .bytes()
                .any(|c| c.is_ascii_whitespace() || b"/:".contains(&c))
        {
            return None;
        }
        let (host, path) = rest.split_once(':')?;
        if host.is_empty()
            || !host
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b".-".contains(&c))
            || path.is_empty()
            || path.bytes().any(|c| c.is_ascii_whitespace())
        {
            return None;
        }
        Some((host.to_owned(), path.to_owned()))
    });
    let (host, path) = if let Some(pair) = scp {
        pair
    } else {
        let parsed = url::Url::parse(url).ok()?;
        if !["https", "ssh"].contains(&parsed.scheme())
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || parsed.password().is_some()
        {
            return None;
        }
        (
            parsed.host_str()?.to_owned(),
            parsed.path().trim_start_matches('/').to_owned(),
        )
    };
    let key = format!("{host}/{path}").to_ascii_lowercase();
    let key = key.strip_suffix(".git").unwrap_or(&key).to_owned();
    canonical(&key).then_some(key)
}

fn alias_ok(alias: &str) -> bool {
    !alias.is_empty()
        && alias != "local"
        && (alias.as_bytes()[0].is_ascii_lowercase() || alias.as_bytes()[0].is_ascii_digit())
        && alias
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

#[derive(Debug, Clone, Copy)]
pub enum HostEdit<'a> {
    Add {
        alias: &'a str,
        ssh: &'a str,
    },
    Remove {
        alias: &'a str,
    },
    MapRepo {
        alias: &'a str,
        key: &'a str,
        path: &'a str,
    },
    Set {
        alias: &'a str,
        max_tasks: Option<u8>,
        paused: Option<bool>,
        session: Option<&'a str>,
    },
}

fn invalid(message: &str) -> StrategyError {
    StrategyError::Other(message.into())
}

/// Apply the TS host edit to YAML bytes; caller handles endpoint sync and publication.
pub fn edit_host(
    text: &str,
    path: &Path,
    name: &str,
    edit: HostEdit<'_>,
) -> Result<String, StrategyError> {
    let raw = parse_value(text).map_err(|e| invalid(&e.to_string()))?;
    let strategy = validate_strategy(&raw, path, name)?;
    let hosts = strategy["hosts"].as_object();
    let alias = match edit {
        HostEdit::Add { alias, .. }
        | HostEdit::Remove { alias }
        | HostEdit::MapRepo { alias, .. }
        | HostEdit::Set { alias, .. } => alias,
    };
    if let HostEdit::Add { .. } = edit {
        if !alias_ok(alias) {
            return Err(invalid("invalid or reserved host alias"));
        }
        if hosts.is_some_and(|h| h.contains_key(alias)) {
            return Err(invalid(&format!("host {alias} already exists")));
        }
    } else {
        if alias == "local" && matches!(edit, HostEdit::Remove { .. }) {
            return Err(invalid("local is reserved"));
        }
        if !hosts.is_some_and(|h| h.contains_key(alias)) {
            return Err(invalid(&format!("unknown host {alias}")));
        }
    }
    let mut doc = StrategyDoc::new(text);
    let key = |parts: &[&str]| {
        parts
            .iter()
            .map(|s| Value::String((*s).into()))
            .collect::<Vec<_>>()
    };
    match edit {
        HostEdit::Add { ssh, .. } => doc.set_in(&key(&["hosts", alias]), &json!({"ssh":ssh})),
        HostEdit::Remove { .. } => {
            if let Some(runners) = strategy["runners"].as_object()
                && let Some((_, runner)) = runners.iter().find(|(_, r)| r["host"] == alias)
            {
                return Err(invalid(&format!(
                    "{alias} is used by {}",
                    runner["id"].as_str().unwrap_or("")
                )));
            }
            doc.delete_in(&key(&["hosts", alias]))
        }
        HostEdit::MapRepo {
            key: repo, path, ..
        } => {
            let repo = repo.to_ascii_lowercase();
            if !canonical(&repo) {
                return Err(invalid("invalid repo key"));
            }
            doc.set_in(&key(&["hosts", alias, "repos", &repo]), &json!(path))
        }
        HostEdit::Set {
            max_tasks,
            paused,
            session,
            ..
        } => {
            if let Some(n) = max_tasks {
                doc.set_in(&key(&["hosts", alias, "max_tasks"]), &json!(n))
                    .map_err(|e| invalid(&e.to_string()))?;
            }
            if let Some(s) = session {
                doc.set_in(&key(&["hosts", alias, "session"]), &json!(s))
                    .map_err(|e| invalid(&e.to_string()))?;
            }
            if let Some(p) = paused {
                doc.set_in(&key(&["hosts", alias, "paused"]), &json!(p))
                    .map_err(|e| invalid(&e.to_string()))?;
            }
            Ok(())
        }
    }
    .map_err(|e| invalid(&e.to_string()))?;
    let after = doc.as_str();
    let parsed = parse_value(after).map_err(|e| invalid(&e.to_string()))?;
    validate_strategy(&parsed, path, name)?;
    Ok(after.into())
}

/// Optimistic strategy-file edit; TS `editStrategy` checks the same before bytes.
pub fn save_host(path: &Path, name: &str, edit: HostEdit<'_>) -> Result<String, StrategyError> {
    let before = fs::read_to_string(path)?;
    let after = edit_host(&before, path, name, edit)?;
    if before == after {
        return Ok(after);
    }
    if fs::read_to_string(path)? != before {
        return Err(invalid("strategy changed during edit; retry"));
    }
    crate::write::atomic_strategy_write(path, &after)?;
    Ok(after)
}
