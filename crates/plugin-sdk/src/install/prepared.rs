//! Preparation of planner installs: commands may run, but files are never
//! committed and effects are never settled here.

use crate::install::{
    BoxFuture, FileImage, InstallError, InstallPlan, PendingFile, PlanEnv, PlanIo, PlannerRecord,
    shell_command,
};
use serde::{Deserialize, Serialize};
use std::{future::Future, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerCommandIntent {
    pub argv: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub undo: Option<Vec<String>>,
    pub timeout_ms: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlannerCommandResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunOptions {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub quiet: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub success_note: Option<String>,
}

#[derive(Clone)]
pub struct PreparedPlannerIo {
    pub base: PlanIo,
    run: Arc<
        dyn Fn(PlannerCommandIntent) -> BoxFuture<'static, Result<PlannerCommandResult, String>>
            + Send
            + Sync,
    >,
}

impl PreparedPlannerIo {
    pub fn new<RF, RFut, RN, RNFut>(read: RF, run: RN) -> Self
    where
        RF: Fn(String) -> RFut + Send + Sync + 'static,
        RFut: Future<Output = Result<Option<FileImage>, String>> + Send + 'static,
        RN: Fn(PlannerCommandIntent) -> RNFut + Send + Sync + 'static,
        RNFut: Future<Output = Result<PlannerCommandResult, String>> + Send + 'static,
    {
        Self {
            base: PlanIo::new(read),
            run: Arc::new(move |intent| Box::pin(run(intent))),
        }
    }

    pub fn from_parts(
        base: PlanIo,
        run: Arc<
            dyn Fn(PlannerCommandIntent) -> BoxFuture<'static, Result<PlannerCommandResult, String>>
                + Send
                + Sync,
        >,
    ) -> Self {
        Self { base, run }
    }

    pub fn with_signal(mut self, signal: CancellationToken) -> Self {
        self.base = self.base.with_signal(signal);
        self
    }

    pub async fn run(&self, intent: PlannerCommandIntent) -> Result<PlannerCommandResult, String> {
        (self.run)(intent).await
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPlannerPlan {
    pub schema: u8,
    pub record: PlannerRecord,
    pub files: Vec<PendingFile>,
    pub touched: Vec<String>,
    pub notes: Vec<String>,
}

pub struct PreparedPlannerBuilder {
    pub plan: InstallPlan,
    backend: PreparedPlannerIo,
    planner: String,
    reconcile: bool,
    commands_closed: bool,
    command_failure: Option<String>,
    preparation: Option<PreparedPlannerPlan>,
}

impl PreparedPlannerBuilder {
    pub fn new(
        backend: PreparedPlannerIo,
        env: PlanEnv,
        prior: Option<&PlannerRecord>,
    ) -> Result<Self, InstallError> {
        let planner = env
            .planner_key
            .clone()
            .or_else(|| prior.map(|p| p.planner.clone()))
            .ok_or_else(|| InstallError("installation planner identity missing".into()))?;
        let plan = InstallPlan::new(backend.base.clone(), env, &planner, prior);
        if plan.record.planner != planner {
            return Err(InstallError(
                "installation planner identity mismatch".into(),
            ));
        }
        let reconcile = plan.env.mode.as_deref() == Some("reconcile");
        Ok(Self {
            plan,
            backend,
            planner,
            reconcile,
            commands_closed: false,
            command_failure: None,
            preparation: None,
        })
    }

    fn admit(&mut self) -> Result<(), InstallError> {
        let failure = if self.commands_closed {
            Some("installation planning closed")
        } else if self.reconcile {
            Some("automatic refresh cannot execute agent commands")
        } else if self.plan.active().is_err() {
            Some("installation planning cancelled")
        } else {
            None
        };
        if let Some(message) = failure {
            let error = InstallError(message.into());
            if self.command_failure.is_none() {
                self.command_failure = Some(error.0.clone());
            }
            return Err(error);
        }
        Ok(())
    }

    fn intent(argv: &[String], undo: Option<&[String]>) -> PlannerCommandIntent {
        PlannerCommandIntent {
            argv: argv.to_vec(),
            undo: undo.map(|u| u.to_vec()),
            timeout_ms: 30000,
        }
    }

    fn record_undo(&mut self, reverse: Option<&[String]>) {
        let Some(reverse) = reverse else { return };
        if !self
            .plan
            .record
            .commands
            .iter()
            .any(|command| command.undo.as_slice() == reverse)
        {
            self.plan.record.commands.push(crate::install::CommandUndo {
                undo: reverse.to_vec(),
            });
        }
    }

    /// Real status and errors; undo compensation is recorded either way.
    pub async fn run_raw(
        &mut self,
        argv: &[String],
        undo: Option<&[String]>,
    ) -> Result<PlannerCommandResult, InstallError> {
        self.admit()?;
        let intent = Self::intent(argv, undo);
        let reverse = undo.map(<[String]>::to_vec);
        let outcome = self.backend.run(intent).await;
        self.record_undo(reverse.as_deref());
        outcome.map_err(InstallError)
    }

    /// Command results become notes; errors are swallowed unless `admit` failed.
    pub async fn run(
        &mut self,
        argv: &[String],
        undo: Option<&[String]>,
        options: RunOptions,
    ) -> Result<(), InstallError> {
        self.admit()?;
        let intent = Self::intent(argv, undo);
        let reverse = undo.map(<[String]>::to_vec);
        let outcome = self.backend.run(intent).await;
        let quiet = options.quiet.unwrap_or(false);
        match outcome {
            Ok(result) => {
                if result.code == 0
                    && let Some(note) = &options.success_note
                {
                    self.plan.notes.push(note.clone());
                }
                if !quiet && result.code != 0 {
                    let first_line = if !result.stderr.is_empty() {
                        &result.stderr
                    } else {
                        &result.stdout
                    }
                    .lines()
                    .next()
                    .unwrap_or_default();
                    self.plan.notes.push(format!(
                        "`{}` failed (exit {}): {first_line}",
                        shell_command(argv),
                        result.code
                    ));
                }
            }
            Err(error) => {
                if !quiet {
                    self.plan
                        .notes
                        .push(format!("`{}` failed: {error}", shell_command(argv)));
                }
            }
        }
        self.record_undo(reverse.as_deref());
        Ok(())
    }

    pub async fn prepare(&mut self) -> Result<PreparedPlannerPlan, InstallError> {
        if let Some(plan) = &self.preparation {
            return Ok(plan.clone());
        }
        self.commands_closed = true;
        let staging = self.plan.finish_planning();
        // Staging failure has precedence, as in the TypeScript drain.
        staging?;
        if let Some(failure) = &self.command_failure {
            return Err(InstallError(failure.clone()));
        }
        self.plan.active()?;
        if self.plan.record.planner != self.planner {
            return Err(InstallError(
                "installation planner identity mismatch".into(),
            ));
        }
        self.plan.record.notes = self.plan.notes.clone();
        let files = self
            .plan
            .pending
            .values()
            .filter(|file| self.reconcile || file.before != file.after)
            .cloned()
            .collect();
        let plan = PreparedPlannerPlan {
            schema: 1,
            record: self.plan.record.clone(),
            files,
            touched: self.plan.touched.clone(),
            notes: self.plan.notes.clone(),
        };
        self.preparation = Some(plan.clone());
        Ok(plan)
    }
}

pub async fn prepare_planner_install<F>(
    io: PreparedPlannerIo,
    env: PlanEnv,
    prior: Option<&PlannerRecord>,
    callback: F,
) -> Result<PreparedPlannerPlan, String>
where
    F: for<'a> FnOnce(&'a mut PreparedPlannerBuilder) -> BoxFuture<'a, Result<(), String>>,
{
    let captured = env.clone();
    let mut builder = PreparedPlannerBuilder::new(io, captured.clone(), prior).map_err(|e| e.0)?;
    if captured.pacer_argv.len() > 1 {
        builder.plan.notes.push(format!(
            "WARNING: development install bakes this command into integrations: {}",
            shell_command(&captured.pacer_argv)
        ));
    }
    if let Err(error) = callback(&mut builder).await {
        let _ = builder.prepare().await;
        return Err(error);
    }
    builder.prepare().await.map_err(|e| e.0)
}
