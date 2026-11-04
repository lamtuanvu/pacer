//! Task types matching the TypeScript definitions in `src/tasks/types.ts`.
use serde::{Deserialize, Serialize};

/// Repository reference matching `src/api/read-model/types.ts`
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RepoRef {
    pub key: String,
    pub label: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreachable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "identityUnverified")]
    pub identity_unverified: Option<bool>,
}

pub type TaskState = String;

pub const TERMINAL_STATES: &[&str] = &["done", "partial", "failed", "limit", "stopped", "needs_input"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum InteractionMode {
    Delegated,
    Conversation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ConversationActivity {
    Starting,
    Working,
    Waiting,
    Idle,
    Ended,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ConversationState {
    pub activity: ConversationActivity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Brief {
    pub goal: String,
    pub repo: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qa: Option<Vec<QaPair>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "worktreeBase")]
    pub worktree_base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QaPair {
    pub q: String,
    pub a: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutingNote {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eligibility: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy: Option<PolicyNote>,
    pub kind: Option<String>,
    #[serde(rename = "kindSource")]
    pub kind_source: String,
    pub rule: String,
    pub chosen: String,
    pub why: String,
    pub skipped: Vec<SkippedExecutor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PolicyNote {
    pub source: String,
    #[serde(rename = "repoKey")]
    pub repo_key: String,
    pub rev: u64,
    pub executors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SkippedExecutor {
    pub executor: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptUsage {
    pub account: String,
    #[serde(rename = "usedPct")]
    pub used_pct: Option<f64>,
    pub window: Option<String>,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Attempt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing: Option<RoutingNote>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "usageAtStart")]
    pub usage_at_start: Option<AttemptUsage>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "usageAtEnd")]
    pub usage_at_end: Option<AttemptUsage>,
    pub executor: String,
    pub model: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    #[serde(rename = "endedAt")]
    pub ended_at: u64,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
    #[serde(rename = "timedOut")]
    pub timed_out: bool,
    #[serde(rename = "limitHit")]
    pub limit_hit: bool,
    pub log: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "brokenReason")]
    pub broken_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Verification {
    pub files: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceptance: Option<AcceptanceResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcceptanceResult {
    pub cmd: String,
    pub passed: bool,
    pub tail: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "durationS")]
    pub duration_s: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskResult {
    pub status: TaskState,
    pub executor: Option<String>,
    pub model: Option<String>,
    pub report: String,
    pub backend: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "brokenExecutor")]
    pub broken_executor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "brokenReason")]
    pub broken_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub check: Option<serde_json::Value>,
    #[serde(flatten)]
    pub verification: Verification,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeRequest {
    Current,
    New,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResolvedPlacement {
    pub mode: String,
    pub why: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskPlacement {
    #[serde(flatten)]
    pub resolved: Option<ResolvedPlacement>,
    pub requested: WorktreeRequest,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunRef {
    #[serde(skip_serializing_if = "Option::is_none", rename = "interactionMode")]
    pub interaction_mode: Option<InteractionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "agentSession")]
    pub agent_session: Option<AgentSession>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "remoteDir")]
    pub remote_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "remoteWorktree")]
    pub remote_worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "remoteBranch")]
    pub remote_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "transferredHead")]
    pub transferred_head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "baseSha")]
    pub base_sha: Option<String>,
    pub dir: String,
    pub attempt: u32,
    pub executor: String,
    #[serde(rename = "startedAt")]
    pub started_at: u64,
    pub mode: String,
    pub workdir: String,
    #[serde(rename = "logFile")]
    pub log_file: String,
    #[serde(skip_serializing_if = "Option::is_none", rename = "lastMessageFile")]
    pub last_message_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentSession {
    pub id: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReviewRequest {
    pub note: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Review {
    pub accepted: bool,
    pub kind: Option<String>,
    pub note: Option<String>,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Takeover {
    pub state: String,
    pub at: u64,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QueueInfo {
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub since: u64,
    pub position: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<CapacityInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CapacityInfo {
    pub used: u32,
    pub max: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExecutorFallback {
    pub requested: String,
    pub reason: String,
    pub executor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_draft_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "interactionMode")]
    pub interaction_mode: Option<InteractionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation: Option<ConversationState>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "reviewRequest")]
    pub review_request: Option<ReviewRequest>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "settledAt")]
    pub settled_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "archivePath")]
    pub archive_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "requestId")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<RepoRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "pendingAttempt")]
    pub pending_attempt: Option<PendingAttempt>,
    pub rev: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<Question>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<RunRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover: Option<Takeover>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "resumeSpawnedAt")]
    pub resume_spawned_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<Review>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "resolutionCheckedAt")]
    pub resolution_checked_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "baseBranch")]
    pub base_branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "baseSha")]
    pub base_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub placement: Option<TaskPlacement>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    pub id: String,
    #[serde(rename = "createdAt")]
    pub created_at: u64,
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "requestedExecutor")]
    pub requested_executor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "executorFallback")]
    pub executor_fallback: Option<ExecutorFallback>,
    #[serde(rename = "timeoutS")]
    pub timeout_s: u64,
    pub brief: Brief,
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue: Option<QueueInfo>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "runnerPid")]
    pub runner_pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "attemptStartedAt")]
    pub attempt_started_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dismissed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "retryOf")]
    pub retry_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "retriedBy")]
    pub retried_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "fromPanel")]
    pub from_panel: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "childPid")]
    pub child_pid: Option<u32>,
    pub attempts: Vec<Attempt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<TaskResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingAttempt {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routing: Option<RoutingNote>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "usageAtStart")]
    pub usage_at_start: Option<AttemptUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Question {
    pub text: String,
    pub at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "answeredAt")]
    pub answered_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct TaskFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub states: Option<Vec<TaskState>>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "updatedSince")]
    pub updated_since: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "settledBefore")]
    pub settled_before: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

impl TaskRecord {
    pub fn is_terminal(&self) -> bool {
        TERMINAL_STATES.contains(&self.state.as_str())
    }
}