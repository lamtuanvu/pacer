use super::*;
use crate::orca_policy::{OrcaPolicy, account_environment, launch_argv};
use std::{collections::BTreeSet, fs};
use unicode_normalization::UnicodeNormalization;

/// All newly written state uses descriptor-pinned atomic 0600 publication and
/// explicit 0700 ancestor creation; never alter the agent's own config.
pub(super) fn write_private(home: &Path, relative: &Path, bytes: &[u8]) -> Result<(), BrokerError> {
    let mut resources = vec![];
    let mut dirs = vec![];
    let mut path = home.to_path_buf();
    for component in relative.parent().ok_or_else(denied)?.components() {
        if !matches!(component, std::path::Component::Normal(_)) {
            return Err(denied());
        }
        path.push(component);
        let text = path.to_str().ok_or_else(denied)?.to_owned();
        dirs.push(text.clone());
        resources.push(crate::WriteResource {
            path: text,
            kind: "directory".into(),
            operations: vec!["mkdir".into()],
        });
    }
    let target = home.join(relative).to_str().ok_or_else(denied)?.to_owned();
    resources.push(crate::WriteResource {
        path: target.clone(),
        kind: "file".into(),
        operations: vec!["write".into()],
    });
    let mut writer = crate::NativeWrite::prepare(home, &resources)?;
    for dir in dirs {
        writer.answer("capability.fs.mkdir", &json!({"path":dir}))?;
    }
    writer.write_bytes(&target, bytes)?;
    Ok(())
}
fn keys(path: &Path) -> Vec<PathBuf> {
    let mut result = vec![PathBuf::from(
        path.to_string_lossy().nfc().collect::<String>(),
    )];
    if let Ok(real) = fs::canonicalize(path) {
        let real = PathBuf::from(real.to_string_lossy().nfc().collect::<String>());
        if !result.contains(&real) {
            result.push(real);
        }
    }
    result
}
fn read_json(path: &Path) -> Result<Option<Value>, BrokerError> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| {
            BrokerError::Effect("source MCP settings are not a valid JSON object".into())
        }),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(_) => Err(BrokerError::Effect(
            "source MCP settings are unreadable".into(),
        )),
    }
}
pub fn mcp_choices(config: &Path, roots: &[PathBuf]) -> Result<Value, BrokerError> {
    let roots = roots.iter().flat_map(|p| keys(p)).collect::<BTreeSet<_>>();
    let mut enabled = BTreeSet::new();
    let mut disabled = BTreeSet::new();
    let mut take = |v: &Value| {
        for (key, set) in [
            ("enabledMcpjsonServers", &mut enabled),
            ("disabledMcpjsonServers", &mut disabled),
        ] {
            if let Some(names) = v[key].as_array() {
                for s in names
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    set.insert(s.to_owned());
                }
            }
        }
    };
    for root in &roots {
        if let Some(local) = read_json(&root.join(".claude/settings.local.json"))? {
            if !local.is_object() {
                return Err(denied());
            }
            take(&local);
        }
    }
    if let Some(config) = read_json(config)? {
        if !config.is_object() {
            return Err(denied());
        }
        if let Some(projects) = config.get("projects") {
            if !projects.is_object() {
                return Err(denied());
            }
            for root in roots {
                take(&projects[root.to_string_lossy().as_ref()]);
            }
        }
    }
    // JS default sort compares UTF-16 code units, not Unicode scalar values.
    let sort = |mut names: Vec<String>| {
        names.sort_by_key(|s| s.encode_utf16().collect::<Vec<_>>());
        names
    };
    Ok(
        json!({"enabled":sort(enabled.into_iter().filter(|s|!disabled.contains(s)).collect()),"disabled":sort(disabled.into_iter().collect())}),
    )
}
impl OrcaAttempt {
    pub(super) async fn compose_launch(
        &mut self,
        policy: &OrcaPolicy,
        run: &Path,
    ) -> Result<(), BrokerError> {
        let agent = &self.spec.agent;
        let id = policy.provider["id"].as_str().ok_or_else(denied)?;
        let runner = policy.strategy["runners"].get(id).or_else(|| {
            policy.strategy["runnerAliases"][id]
                .as_str()
                .and_then(|alias| policy.strategy["runners"].get(alias))
        });
        let account_name = runner.and_then(|r| r["account"].as_str()).or_else(|| {
            id.split_once('#')
                .map(|(_, a)| a.split('@').next().unwrap_or(a))
        });
        let account = account_name.and_then(|a| policy.strategy["accounts"].get(a));
        if account_name.is_some() && account.is_none() {
            return Err(BrokerError::Effect(format!("runner not configured: {id}")));
        }
        let default = json!({"source":"default"});
        let account = account.unwrap_or(&default);
        let root = policy
            .login
            .env
            .get("ORCA_USER_DATA_PATH")
            .or(policy.login.env.get("PACER_ORCA_USER_DATA"))
            .cloned()
            .or_else(|| {
                policy
                    .login
                    .env
                    .get("XDG_CONFIG_HOME")
                    .map(|p| Path::new(p).join("orca").to_string_lossy().into_owned())
            });
        self.spec.account_env = account_environment(
            account,
            agent,
            &policy.user_home,
            root.as_deref(),
            &policy.login,
        )?;
        let variable = if agent == "claude" {
            "CLAUDE_CONFIG_DIR"
        } else {
            "CODEX_HOME"
        };
        if account["source"] == "default" && policy.login.login_shell {
            let path = self.home.join("state/default-account-folders.json");
            let mut folders = fs::read(&path)
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .filter(Value::is_object)
                .unwrap_or(json!({}));
            let kind = if agent == "claude" { "claude" } else { "codex" };
            if let Some(folder) = self.spec.account_env.get(variable) {
                folders[kind] = json!(folder);
            } else {
                folders.as_object_mut().map(|o| o.remove(kind));
            }
            // TS treats the default-folder record as best effort. It has no
            // authority to alter or prevent the actual account selection.
            let _ = write_private(
                &self.home,
                Path::new("state/default-account-folders.json"),
                &serde_json::to_vec(&folders).map_err(|_| denied())?,
            );
        }
        let top = self
            .selector
            .split_once("::")
            .map(|(_, p)| p)
            .ok_or_else(denied)?;
        self.spec.launch = launch_argv(
            agent,
            self.spec.model.as_deref(),
            top,
            self.home.join("tasks").to_str().ok_or_else(denied)?,
            &self.spec.top,
        )?;
        if agent == "claude" {
            let mut settings = json!({"skipDangerousModePermissionPrompt":true});
            if self.created.is_some() {
                let folder = self
                    .spec
                    .account_env
                    .get(variable)
                    .filter(|s| !s.is_empty())
                    .map(PathBuf::from);
                let legacy = folder
                    .clone()
                    .unwrap_or_else(|| policy.user_home.join(".claude"))
                    .join(".config.json");
                let config = if legacy.exists() {
                    legacy
                } else {
                    folder.unwrap_or_else(|| policy.user_home.clone()).join(
                        if policy
                            .login
                            .env
                            .get("CLAUDE_CODE_CUSTOM_OAUTH_URL")
                            .is_some_and(|s| !s.is_empty())
                        {
                            ".claude-custom-oauth.json"
                        } else {
                            ".claude.json"
                        },
                    )
                };
                let task = self.task()?;
                let main = self
                    .git
                    .as_ref()
                    .ok_or_else(denied)?
                    .text(
                        &self.spec.top,
                        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
                        &[],
                        self.deadline,
                    )
                    .await?;
                let main = Path::new(&main)
                    .parent()
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from(&self.spec.top));
                if let Ok(choices) = mcp_choices(
                    &config,
                    &[
                        PathBuf::from(task["brief"]["repo"].as_str().ok_or_else(denied)?),
                        PathBuf::from(&self.spec.top),
                        main,
                    ],
                ) {
                    settings["enableAllProjectMcpServers"] = json!(true);
                    for (key, source) in [
                        ("enabledMcpjsonServers", "enabled"),
                        ("disabledMcpjsonServers", "disabled"),
                    ] {
                        if choices[source].as_array().is_some_and(|a| !a.is_empty()) {
                            settings[key] = choices[source].clone();
                        }
                    }
                }
            }
            let file = run.join("claude-settings.json");
            write_private(
                &self.home,
                file.strip_prefix(&self.home).map_err(|_| denied())?,
                &serde_json::to_vec(&settings).map_err(|_| denied())?,
            )?;
            self.spec.launch.splice(
                1..1,
                ["--settings".into(), file.to_string_lossy().into_owned()],
            );
        }
        Ok(())
    }
}
