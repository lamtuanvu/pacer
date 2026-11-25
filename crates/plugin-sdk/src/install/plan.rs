//! Staged planner file planning. Nothing here writes to disk.

use crate::install::{
    BoxFuture, FileChange, InstallError, UndoOp, backup_path, managed_content, merge_undo, sha256,
};
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use indexmap::IndexMap;
use std::{collections::BTreeMap, future::Future, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileImage {
    pub text: String,
    pub mode: u32,
}

type ReadFn =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<Option<FileImage>, String>> + Send + Sync>;

/// A read callback; only `Ok(None)` means a missing file. All other errors
/// reject so a permission or redirection failure can never look like absence.
#[derive(Clone)]
pub struct PlanIo {
    read: ReadFn,
    pub signal: Option<CancellationToken>,
}

impl PlanIo {
    pub fn new<F, Fut>(read: F) -> Self
    where
        F: Fn(String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<FileImage>, String>> + Send + 'static,
    {
        Self {
            read: Arc::new(move |path| Box::pin(read(path))),
            signal: None,
        }
    }

    pub fn with_signal(mut self, signal: CancellationToken) -> Self {
        self.signal = Some(signal);
        self
    }

    pub async fn read(&self, path: &str) -> Result<Option<FileImage>, String> {
        (self.read)(path.to_string()).await
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanEnv {
    pub now: i64,
    pub pacer_argv: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mcp: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub planner_account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub planner_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub config_env: Option<BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub skill_folder: Option<String>,
}

impl PlanEnv {
    pub fn new(now: i64, pacer_argv: &[&str]) -> Self {
        Self {
            now,
            pacer_argv: pacer_argv.iter().map(|s| s.to_string()).collect(),
            mcp: None,
            folder: None,
            planner_account: None,
            planner_key: None,
            config_env: None,
            mode: None,
            skill_folder: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingFile {
    pub path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mode: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub before_mode: Option<u32>,
}

pub struct InstallPlan {
    pub record: crate::install::PlannerRecord,
    pub touched: Vec<String>,
    pub notes: Vec<String>,
    pub pending: IndexMap<String, PendingFile>,
    pub env: PlanEnv,
    pub io: PlanIo,
    pub closed: bool,
    pub failure: Option<String>,
}

impl InstallPlan {
    pub fn new(
        io: PlanIo,
        env: PlanEnv,
        planner: &str,
        prior: Option<&crate::install::PlannerRecord>,
    ) -> Self {
        let env = env.clone();
        let record = match prior {
            Some(prior) => prior.clone(),
            None => crate::install::PlannerRecord {
                mcp: None,
                integration: None,
                planner: env
                    .planner_key
                    .clone()
                    .unwrap_or_else(|| planner.to_string()),
                account: None,
                folder: None,
                config_env: None,
                installed_at: env.now,
                pacer_argv: env.pacer_argv.clone(),
                files: Vec::new(),
                commands: Vec::new(),
                notes: Vec::new(),
                undo_connect: None,
                undone_at: None,
            },
        };
        let mut plan = Self {
            record,
            touched: Vec::new(),
            notes: Vec::new(),
            pending: IndexMap::new(),
            env,
            io,
            closed: false,
            failure: None,
        };
        plan.record.pacer_argv = plan.env.pacer_argv.clone();
        if plan.env.mcp.is_some() && plan.env.mode.as_deref() != Some("reconcile") {
            plan.record.mcp = plan.env.mcp;
        }
        if let Some(account) = &plan.env.planner_account {
            plan.record.account = Some(account.clone());
        }
        if let Some(folder) = &plan.env.folder {
            plan.record.folder = Some(folder.clone());
        }
        if let Some(config) = &plan.env.config_env {
            plan.record.config_env = Some(config.clone());
        }
        plan
    }

    pub fn active(&self) -> Result<(), InstallError> {
        if self
            .io
            .signal
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(InstallError("installation planning cancelled".into()));
        }
        Ok(())
    }

    pub fn finish_planning(&mut self) -> Result<(), InstallError> {
        self.closed = true;
        if let Some(failure) = self.failure.take() {
            return Err(InstallError(failure));
        }
        self.active()
    }

    pub fn reject(&mut self, error: String) {
        if self.failure.is_none() {
            self.failure = Some(error);
        }
    }

    async fn external(&self, path: &str) -> Result<Option<FileImage>, InstallError> {
        self.active()?;
        let image = self.io.read(path).await.map_err(InstallError)?;
        self.active()?;
        Ok(image)
    }

    async fn image(&self, path: &str) -> Result<Option<FileImage>, InstallError> {
        self.active()?;
        if let Some(staged) = self.pending.get(path) {
            return Ok(staged.after.as_ref().map(|text| FileImage {
                text: text.clone(),
                mode: staged.mode.or(staged.before_mode).unwrap_or(0o600),
            }));
        }
        self.external(path).await
    }

    pub async fn read(&mut self, path: &str) -> Result<Option<String>, InstallError> {
        self.active()?;
        Ok(self.image(path).await?.map(|image| image.text))
    }

    async fn backup(&mut self, path: &str) -> Result<String, InstallError> {
        let mut occupied: std::collections::BTreeSet<String> =
            self.pending.keys().cloned().collect();
        loop {
            self.active()?;
            let candidate = backup_path(path, self.env.now, &TimeZone::system(), |name| {
                occupied.contains(name)
            });
            let image = self.external(&candidate).await?;
            if image.is_none() && !self.pending.contains_key(&candidate) {
                return Ok(candidate);
            }
            occupied.insert(candidate);
        }
    }

    /// A caught staging error is retained so the final drain still rejects.
    pub async fn edit<F>(
        &mut self,
        path: &str,
        edit: F,
        undo: Vec<UndoOp>,
        backup_dir: Option<&str>,
    ) -> Result<bool, InstallError>
    where
        F: FnOnce(Option<&str>) -> Result<String, String>,
    {
        let outcome = self.edit_inner(path, edit, undo, backup_dir).await;
        if let Err(error) = &outcome {
            self.reject(error.0.clone());
        }
        outcome
    }

    async fn edit_inner<F>(
        &mut self,
        path: &str,
        edit: F,
        undo: Vec<UndoOp>,
        backup_dir: Option<&str>,
    ) -> Result<bool, InstallError>
    where
        F: FnOnce(Option<&str>) -> Result<String, String>,
    {
        self.active()?;
        let image = self.image(path).await?;
        let old = image.as_ref().map(|i| i.text.clone());
        self.active()?;
        let next = edit(old.as_deref())
            .map_err(|error| InstallError(format!("cannot update {path}: {error}")))?;
        self.active()?;
        let prior = self.record.files.iter().position(|file| file.path == path);
        if prior.is_some_and(|index| self.record.files[index].action == "moved") {
            return Err(InstallError(format!(
                "cannot update {path}: already moved aside"
            )));
        }
        if prior.is_none() && old.as_deref() == Some(next.as_str()) {
            return Ok(false);
        }
        let mut change = match prior {
            Some(index) => self.record.files[index].clone(),
            None => {
                let backup = if old.is_none() {
                    None
                } else {
                    let candidate = match backup_dir {
                        Some(dir) => {
                            let name = Path::new(path)
                                .file_name()
                                .map_or(path, |n| n.to_str().unwrap_or(path));
                            Path::new(dir).join(name).to_string_lossy().into_owned()
                        }
                        None => path.to_string(),
                    };
                    Some(self.backup(&candidate).await?)
                };
                FileChange {
                    path: path.to_string(),
                    action: if old.is_none() {
                        "created".into()
                    } else {
                        "edited".into()
                    },
                    managed: None,
                    backup,
                    after_hash: None,
                    exact: Some(true),
                    undo: Vec::new(),
                }
            }
        };
        if prior.is_some()
            && (old.is_none()
                || sha256(old.as_deref().unwrap_or_default())
                    != change.after_hash.clone().unwrap_or_default())
        {
            change.exact = Some(false);
        }
        change.undo = merge_undo(&change.undo, &undo);
        change.after_hash = Some(sha256(&next));
        let fingerprint = managed_content(&next, &change.undo).map_err(InstallError)?;
        change.managed = Some(crate::install::ManagedHash {
            schema: 1,
            hash: sha256(&fingerprint),
        });
        self.active()?;
        if prior.is_none()
            && let (Some(backup), Some(old), Some(image)) = (&change.backup, &old, &image)
        {
            self.pending.insert(
                backup.clone(),
                PendingFile {
                    path: backup.clone(),
                    before: None,
                    after: Some(old.clone()),
                    mode: Some(image.mode & 0o700),
                    before_mode: None,
                },
            );
        }
        match prior {
            Some(index) => self.record.files[index] = change,
            None => self.record.files.push(change),
        }
        let staged = self.pending.get(path);
        let before = staged
            .and_then(|s| s.before.clone())
            .or_else(|| old.clone());
        let before_mode = staged
            .and_then(|s| s.before_mode)
            .or_else(|| image.as_ref().map(|i| i.mode & 0o700));
        self.pending.insert(
            path.to_string(),
            PendingFile {
                path: path.to_string(),
                before,
                after: Some(next.clone()),
                mode: None,
                before_mode,
            },
        );
        let changed = old.as_deref() != Some(next.as_str());
        if changed && !self.touched.iter().any(|p| p == path) {
            self.touched.push(path.to_string());
        }
        Ok(changed)
    }

    pub async fn move_aside(&mut self, path: &str) -> Result<(), InstallError> {
        let outcome = self.move_aside_inner(path).await;
        if let Err(error) = &outcome {
            self.reject(error.0.clone());
        }
        outcome
    }

    async fn move_aside_inner(&mut self, path: &str) -> Result<(), InstallError> {
        if self.env.mode.as_deref() == Some("reconcile") {
            return Ok(());
        }
        if self.record.files.iter().any(|file| file.path == path) {
            self.notes
                .push(format!("{path} already recorded; skipping move"));
            return Ok(());
        }
        let Some(image) = self.image(path).await? else {
            return Ok(());
        };
        let backup = self.backup(path).await?;
        self.active()?;
        self.pending.insert(
            backup.clone(),
            PendingFile {
                path: backup.clone(),
                before: None,
                after: Some(image.text.clone()),
                mode: Some(image.mode & 0o700),
                before_mode: None,
            },
        );
        self.pending.insert(
            path.to_string(),
            PendingFile {
                path: path.to_string(),
                before: Some(image.text),
                after: None,
                mode: None,
                before_mode: Some(image.mode & 0o700),
            },
        );
        self.record.files.push(FileChange {
            path: path.to_string(),
            action: "moved".into(),
            managed: None,
            backup: Some(backup),
            after_hash: None,
            exact: None,
            undo: Vec::new(),
        });
        if !self.touched.iter().any(|p| p == path) {
            self.touched.push(path.to_string());
        }
        Ok(())
    }
}
