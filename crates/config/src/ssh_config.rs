//! Read concrete SSH config aliases (and HostName targets) from `~/.ssh`.
//! Matches `src/remote/ssh-config.ts`; no shell evaluation or SSH execution.

use indexmap::IndexSet;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshAlias {
    pub name: String,
    pub host: String,
}

fn words(line: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = '\0';
    let mut escaped = false;
    for ch in line.chars() {
        if escaped {
            word.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if quote != '\0' {
            if ch == quote {
                quote = '\0';
            } else {
                word.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = ch;
            continue;
        }
        if ch == '#' {
            break;
        }
        if ch.is_whitespace() {
            if !word.is_empty() {
                result.push(std::mem::take(&mut word));
            }
        } else {
            word.push(ch);
        }
    }
    if !word.is_empty() {
        result.push(word);
    }
    result
}

struct Block {
    patterns: Vec<String>,
    host: Option<String>,
}

fn parse_directive(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    // Longest keywords first (`Host` is a prefix of `HostName`).
    for keyword in ["HostName", "Include", "Match", "Host"] {
        let key = keyword.to_ascii_lowercase();
        if trimmed.len() >= keyword.len() && trimmed[..keyword.len()].eq_ignore_ascii_case(keyword)
        {
            let rest = trimmed[keyword.len()..].trim_start();
            let rest = rest.strip_prefix('=').unwrap_or(rest).trim_start();
            return Some((key, rest.to_owned()));
        }
    }
    None
}

fn pattern_matches(pattern: &str, name: &str) -> bool {
    fn rec(pat: &[char], name: &[char]) -> bool {
        match (pat.first(), name.first()) {
            (None, None) => true,
            (Some('*'), _) => rec(&pat[1..], name) || (!name.is_empty() && rec(pat, &name[1..])),
            (Some('?'), Some(_)) => rec(&pat[1..], &name[1..]),
            (Some('?'), None) => false,
            (Some(p), Some(n)) if p.eq_ignore_ascii_case(n) => rec(&pat[1..], &name[1..]),
            _ => false,
        }
    }
    if pattern.is_empty() {
        return name.is_empty();
    }
    rec(
        &pattern.chars().collect::<Vec<_>>(),
        &name.chars().collect::<Vec<_>>(),
    )
}

fn visit(
    home: &Path,
    file: PathBuf,
    depth: u8,
    active: &mut HashSet<PathBuf>,
    aliases: &mut IndexSet<String>,
    blocks: &mut Vec<Block>,
    block_idx: &mut Option<usize>,
) {
    let file = file.canonicalize().unwrap_or(file);
    if depth > 8 || !active.insert(file.clone()) {
        return;
    }
    let text = match fs::read_to_string(&file) {
        Ok(t) => t,
        Err(_) => {
            active.remove(&file);
            return;
        }
    };
    let base = home.join(".ssh");
    for line in text.split(['\n', '\r']) {
        let Some((kind, rest)) = parse_directive(line) else {
            continue;
        };
        let values = words(&rest);
        match kind.as_str() {
            "hostname" => {
                if let Some(idx) = *block_idx
                    && blocks[idx].host.is_none()
                    && let Some(first) = values.first()
                {
                    blocks[idx].host = Some(first.clone());
                }
            }
            "match" => *block_idx = None,
            "host" => {
                for value in &values {
                    if !value.contains(['*', '?', '!']) {
                        aliases.insert(value.clone());
                    }
                }
                blocks.push(Block {
                    patterns: values,
                    host: None,
                });
                *block_idx = Some(blocks.len() - 1);
            }
            "include" => {
                for value in values {
                    let expanded = if let Some(rest) = value.strip_prefix("~/") {
                        home.join(rest)
                    } else if value.starts_with('/') {
                        PathBuf::from(&value)
                    } else {
                        base.join(&value)
                    };
                    let expanded = expanded.to_string_lossy().into_owned();
                    if !expanded.contains(['*', '?', '[']) {
                        visit(
                            home,
                            PathBuf::from(&expanded),
                            depth + 1,
                            active,
                            aliases,
                            blocks,
                            block_idx,
                        );
                    } else if let Ok(paths) = glob::glob(&expanded) {
                        let mut files: Vec<_> = paths.filter_map(Result::ok).collect();
                        files.sort();
                        for included in files {
                            visit(
                                home,
                                included,
                                depth + 1,
                                active,
                                aliases,
                                blocks,
                                block_idx,
                            );
                        }
                    }
                }
            }
            _ => {}
        }
    }
    active.remove(&file);
}

/// Concrete aliases in discovery order (matches JavaScript `Set` insertion order).
pub fn ssh_suggestions(home: &Path) -> Vec<SshAlias> {
    let mut aliases = IndexSet::new();
    let mut blocks = Vec::new();
    let mut active = HashSet::new();
    let mut block_idx = None;
    visit(
        home,
        home.join(".ssh/config"),
        0,
        &mut active,
        &mut aliases,
        &mut blocks,
        &mut block_idx,
    );
    aliases
        .into_iter()
        .map(|name| {
            let entry = blocks.iter().find(|block| {
                block.host.is_some()
                    && block
                        .patterns
                        .iter()
                        .any(|pattern| !pattern.starts_with('!') && pattern_matches(pattern, &name))
                    && !block.patterns.iter().any(|pattern| {
                        pattern.starts_with('!') && pattern_matches(&pattern[1..], &name)
                    })
            });
            let host = entry
                .and_then(|b| b.host.as_deref())
                .map(|h| h.replace("%h", &name))
                .unwrap_or_else(|| name.clone());
            SshAlias { name, host }
        })
        .collect()
}

/// SSH aliases not already configured as host `ssh` targets.
pub fn suggest_hosts(home: &Path, used_ssh: &[&str], details: bool) -> Value {
    let used: HashSet<_> = used_ssh.iter().copied().collect();
    let suggestions: Vec<_> = ssh_suggestions(home)
        .into_iter()
        .filter(|a| !used.contains(a.name.as_str()))
        .collect();
    if details {
        json!(
            suggestions
                .into_iter()
                .map(|a| json!({"name": a.name, "host": a.host}))
                .collect::<Vec<_>>()
        )
    } else {
        json!(suggestions.into_iter().map(|a| a.name).collect::<Vec<_>>())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let ssh = home.join(".ssh");
        fs::create_dir_all(ssh.join("conf.d")).unwrap();
        (dir, home)
    }

    #[test]
    fn concrete_aliases_and_includes() {
        let (_dir, home) = fixture();
        let ssh = home.join(".ssh");
        fs::write(
            ssh.join("config"),
            "Host devbox gpu-box\nHost * !private qa?\nInclude conf.d/*\nHost devbox\n",
        )
        .unwrap();
        fs::write(ssh.join("conf.d/a"), "Host staging\nInclude ~/.ssh/extra\n").unwrap();
        fs::write(ssh.join("extra"), "hOsT=\"quoted-box\" # comment\n").unwrap();
        let names: Vec<_> = ssh_suggestions(&home).into_iter().map(|a| a.name).collect();
        assert_eq!(names, vec!["devbox", "gpu-box", "staging", "quoted-box"]);
    }

    #[test]
    fn include_depth_and_cycles() {
        let (_dir, home) = fixture();
        let ssh = home.join(".ssh");
        fs::write(ssh.join("config"), "Include level1\nInclude config\n").unwrap();
        for i in 1..=9 {
            fs::write(
                ssh.join(format!("level{i}")),
                format!("Host level{i}\nInclude level{}\n", i + 1),
            )
            .unwrap();
        }
        let names: Vec<_> = ssh_suggestions(&home).into_iter().map(|a| a.name).collect();
        assert_eq!(
            names,
            (1..=8).map(|i| format!("level{i}")).collect::<Vec<_>>()
        );
    }

    #[test]
    fn hostname_and_wildcards() {
        let (_dir, home) = fixture();
        let ssh = home.join(".ssh");
        fs::write(
            ssh.join("config"),
            "Host devbox gpu-box\nInclude conf.d/name\nHost devbox\nHostName ignored.invalid\nHost *.lab !private.lab\nHostName %h.example\nHost staging.lab private.lab fallback\n",
        )
        .unwrap();
        fs::write(ssh.join("conf.d/name"), "HostName 192.0.2.1\n").unwrap();
        let got: Vec<_> = ssh_suggestions(&home)
            .into_iter()
            .map(|a| json!({"name": a.name, "host": a.host}))
            .collect();
        assert_eq!(
            got,
            vec![
                json!({"name":"devbox","host":"192.0.2.1"}),
                json!({"name":"gpu-box","host":"192.0.2.1"}),
                json!({"name":"staging.lab","host":"staging.lab.example"}),
                json!({"name":"private.lab","host":"private.lab"}),
                json!({"name":"fallback","host":"fallback"}),
            ]
        );
    }

    #[test]
    fn filters_used_ssh() {
        let (_dir, home) = fixture();
        fs::write(home.join(".ssh/config"), "Host fresh-box\nHost devbox\n").unwrap();
        assert_eq!(
            suggest_hosts(&home, &["devbox"], false),
            json!(["fresh-box"])
        );
    }
}
