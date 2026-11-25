//! Prepare planner uninstall file candidates from a retained record.

use crate::install::{PendingFile, PlanIo, PlannerRecord, apply_undo, sha256};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallReport {
    pub planner: String,
    pub restored: Vec<String>,
    pub removed: Vec<String>,
    pub reverted: Vec<String>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPlannerUninstall {
    pub schema: u8,
    pub record: PlannerRecord,
    pub files: Vec<PendingFile>,
    pub touched: Vec<String>,
    pub notes: Vec<String>,
    pub uninstall_report: UninstallReport,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UninstallFailureReason {
    MissingBackup,
    OccupiedDestination,
    ReadError,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallPreparationFailure {
    pub path: String,
    pub reason: UninstallFailureReason,
}

pub async fn prepare_planner_uninstall_files(
    io: &PlanIo,
    prior: &PlannerRecord,
    mut on_incomplete: Option<&mut dyn FnMut(UninstallPreparationFailure)>,
) -> Result<PreparedPlannerUninstall, String> {
    let record = prior.clone();
    let mut report = UninstallReport {
        planner: record.planner.clone(),
        restored: Vec::new(),
        removed: Vec::new(),
        reverted: Vec::new(),
        notes: Vec::new(),
    };
    let mut files: Vec<PendingFile> = Vec::new();
    for file in record.files.iter().rev() {
        let outcome = read_candidate(io, &file.path).await;
        let image = match outcome {
            Ok(image) => image,
            Err(error) => {
                if let Some(callback) = on_incomplete.as_deref_mut() {
                    callback(UninstallPreparationFailure {
                        path: file.path.clone(),
                        reason: UninstallFailureReason::ReadError,
                    });
                }
                let backup_note = file
                    .backup
                    .as_ref()
                    .map(|backup| format!("; backup kept at {backup}"))
                    .unwrap_or_default();
                report
                    .notes
                    .push(format!("cannot revert {}: {error}{backup_note}", file.path));
                continue;
            }
        };
        if file.action == "moved" {
            let backup = match &file.backup {
                Some(path) => read_candidate(io, path).await.unwrap_or_default(),
                None => None,
            };
            if let Some(ref backup) = backup
                && image.is_none()
            {
                files.push(PendingFile {
                    path: file.path.clone(),
                    before: None,
                    after: Some(backup.text.clone()),
                    mode: Some(backup.mode & 0o700),
                    before_mode: None,
                });
                let backup_path = file.backup.clone().unwrap_or_default();
                files.push(PendingFile {
                    path: backup_path,
                    before: Some(backup.text.clone()),
                    after: None,
                    mode: None,
                    before_mode: Some(backup.mode & 0o700),
                });
                report.restored.push(file.path.clone());
            } else {
                let reason = if backup.is_some() {
                    UninstallFailureReason::OccupiedDestination
                } else {
                    UninstallFailureReason::MissingBackup
                };
                if let Some(callback) = on_incomplete.as_deref_mut() {
                    callback(UninstallPreparationFailure {
                        path: file.path.clone(),
                        reason,
                    });
                }
                report.notes.push(format!(
                    "cannot restore {}; backup kept at {}",
                    file.path,
                    file.backup.clone().unwrap_or_default()
                ));
            }
            continue;
        }
        let text = image.as_ref().map(|image| image.text.clone());
        let intact = text
            .as_ref()
            .is_some_and(|text| Some(sha256(text)) == file.after_hash);
        if file.action == "created" && intact && (file.exact != Some(false) || file.undo.is_empty())
        {
            files.push(PendingFile {
                path: file.path.clone(),
                before: text,
                after: None,
                mode: None,
                before_mode: image.as_ref().map(|image| image.mode & 0o700),
            });
            report.removed.push(file.path.clone());
        } else if file.action == "edited"
            && intact
            && file.exact == Some(true)
            && file.backup.is_some()
        {
            let backup_path = file.backup.clone().unwrap_or_default();
            let backup = read_candidate(io, &backup_path).await.unwrap_or_default();
            if let Some(backup) = backup {
                files.push(PendingFile {
                    path: file.path.clone(),
                    before: text,
                    after: Some(backup.text.clone()),
                    mode: Some(backup.mode & 0o700),
                    before_mode: image.as_ref().map(|image| image.mode & 0o700),
                });
                files.push(PendingFile {
                    path: backup_path,
                    before: Some(backup.text),
                    after: None,
                    mode: None,
                    before_mode: Some(backup.mode & 0o700),
                });
                report.restored.push(file.path.clone());
            } else {
                if let Some(callback) = on_incomplete.as_deref_mut() {
                    callback(UninstallPreparationFailure {
                        path: file.path.clone(),
                        reason: UninstallFailureReason::MissingBackup,
                    });
                }
                if let Some(text) = text
                    && !file.undo.is_empty()
                {
                    let after = apply_undo(&text, &file.undo, &mut report.notes)?;
                    files.push(PendingFile {
                        path: file.path.clone(),
                        before: Some(text),
                        after: Some(after),
                        mode: None,
                        before_mode: image.as_ref().map(|image| image.mode & 0o700),
                    });
                    report.reverted.push(file.path.clone());
                } else {
                    report.notes.push(format!("left {} unchanged", file.path));
                }
                report.notes.push(format!(
                    "backup kept at {}",
                    file.backup.clone().unwrap_or_default()
                ));
            }
        } else {
            if let Some(text) = text
                && !file.undo.is_empty()
            {
                let after = apply_undo(&text, &file.undo, &mut report.notes)?;
                files.push(PendingFile {
                    path: file.path.clone(),
                    before: Some(text),
                    after: Some(after),
                    mode: None,
                    before_mode: image.as_ref().map(|image| image.mode & 0o700),
                });
                report.reverted.push(file.path.clone());
            } else {
                report.notes.push(format!("left {} unchanged", file.path));
            }
            if let Some(backup) = &file.backup {
                report.notes.push(format!("backup kept at {backup}"));
            }
        }
    }
    Ok(PreparedPlannerUninstall {
        schema: 1,
        record,
        files,
        touched: Vec::new(),
        notes: report.notes.clone(),
        uninstall_report: report,
    })
}

async fn read_candidate(
    io: &PlanIo,
    path: &str,
) -> Result<Option<crate::install::FileImage>, String> {
    io.read(path).await
}
