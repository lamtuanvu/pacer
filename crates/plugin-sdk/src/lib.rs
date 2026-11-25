//! Rust plugin SDK for pacer.

mod chunk;
mod error;
mod fs;
mod host;
mod http;
pub mod js;
#[cfg(feature = "install")]
pub mod install;
mod serve;
mod stream;
#[cfg(feature = "testing")]
pub mod testing;
#[cfg(feature = "testing")]
pub use testing::HostError;
#[cfg(feature = "usage")]
pub mod usage;
pub mod wire;

/// Plugin protocol types, re-exported from the generated protocol crates (CRATE-3 area split).
pub mod types {
    pub use pacer_plugin_agent_session_protocol::*;
    pub use pacer_plugin_decision_protocol::*;
    pub use pacer_plugin_exec_protocol::*;
    pub use pacer_plugin_exec_protocol::{
        CapabilityProcessDuplexCloseParams, CapabilityProcessDuplexCloseParamsHandle,
        CapabilityProcessDuplexCloseResult, CapabilityProcessDuplexCloseResultSignal,
        CapabilityProcessDuplexOpenParams, CapabilityProcessDuplexOpenParamsArgvItem,
        CapabilityProcessDuplexOpenResult, CapabilityProcessDuplexOpenResultHandle,
        CapabilityProcessDuplexReadParams, CapabilityProcessDuplexReadParamsHandle,
        CapabilityProcessDuplexReadResult, CapabilityProcessDuplexReadResultBase64,
        CapabilityProcessDuplexWriteParams, CapabilityProcessDuplexWriteParamsBase64,
        CapabilityProcessDuplexWriteParamsHandle, CapabilityProcessDuplexWriteResult,
        CapabilityProcessInspectRunParams, CapabilityProcessInspectRunParamsTaskId,
        CapabilityProcessInspectRunResult, CapabilityProcessInspectRunResultState,
        CapabilityProcessOutputChunkParams, CapabilityProcessOutputChunkParamsHandle,
        CapabilityProcessOutputChunkResult, CapabilityProcessOutputChunkResultBase64,
        CapabilityProcessSpawnParams, CapabilityProcessSpawnParamsArgvItem,
        CapabilityProcessSpawnParamsCwd, CapabilityProcessSpawnParamsEnvKey,
        CapabilityProcessSpawnParamsEnvValue,
        CapabilityProcessSpawnParamsEnvValueVariant1SecretRef, CapabilityProcessSpawnParamsStdin,
        CapabilityProcessSpawnResult, CapabilityProcessSpawnResultVariant1Output,
        CapabilityProcessSpawnResultVariant1OutputStderr,
        CapabilityProcessSpawnResultVariant1OutputStdout, CapabilityProcessStageBundleParams,
        CapabilityProcessStageBundleParamsArgvItem, CapabilityProcessStageBundleResult,
        CapabilityProcessStageBundleResultHandle, CapabilityProcessStageBundleResultSha256,
        CapabilityProcessStartRunParams, CapabilityProcessStartRunParamsTask,
        CapabilityProcessStartRunParamsTaskId, CapabilityProcessStartRunResult,
        CapabilityProcessStopRunParams, CapabilityProcessStopRunParamsTaskId,
        CapabilityProcessStopRunResult, ExecutorAvailableParams, ExecutorAvailableParamsStrategy,
        ExecutorAvailableParamsStrategyName, ExecutorAvailableResult,
        ExecutorAvailableResultReason, ExecutorRunParams,
        ExecutorRunParamsVariant0Effect as ExecutorRunParamsEffect,
        ExecutorRunParamsVariant0EffectArgvItem as ExecutorRunParamsEffectArgvItem,
        ExecutorRunParamsVariant0EffectCwd as ExecutorRunParamsEffectCwd,
        ExecutorRunParamsVariant0EffectEnvKey as ExecutorRunParamsEffectEnvKey,
        ExecutorRunParamsVariant0EffectSecretEnvKey as ExecutorRunParamsEffectSecretEnvKey,
        ExecutorRunParamsVariant0EffectSecretEnvValue as ExecutorRunParamsEffectSecretEnvValue,
        ExecutorRunParamsVariant0EffectStdin as ExecutorRunParamsEffectStdin,
        ExecutorRunParamsVariant0Task as ExecutorRunParamsTask,
        ExecutorRunParamsVariant0TaskId as ExecutorRunParamsTaskId, ExecutorRunResult,
        ExecutorRunResultVariant0Variant0Report as ExecutorRunResultVariant0Report,
        ExecutorRunResultVariant0Variant0Status as ExecutorRunResultVariant0Status,
        ExecutorRunResultVariant0Variant1Report as ExecutorRunResultVariant1Report,
        ExecutorRunResultVariant1Report as ExecutorRunOwnedResultReport,
        ExecutorSessionStateParams, ExecutorSessionStateParamsTaskId, ExecutorSessionStateResult,
        ExecutorStopParams, ExecutorStopParamsTaskId, ExecutorStopResult,
    };

    pub use pacer_plugin_assistant_protocol::*;
    pub use pacer_plugin_hosts_protocol::*;
    pub use pacer_plugin_install_protocol::*;
    pub use pacer_plugin_protocol::*;
    pub use pacer_plugin_workflow_protocol::*;
    // Every protocol crate emits these; the entry crate's definitions take precedence.
    pub use pacer_plugin_protocol::{PacerPluginProtocol1120, VERSION, error};
}

pub use error::PluginError;
pub use fs::FileSystem;
pub use host::{Host, MachineSignature};
pub use http::HttpResponse;
pub use serve::{Ctx, HandlerResult, Manifest, Plugin, Progress};
pub use stream::{InputFrame, OwnedStream, stream_input_notification};
pub use tokio_util::sync::CancellationToken;

/// Feature the plugin can negotiate with the host over `plugin.hello`.
pub const FEATURE_CHUNKED_RESULTS: &str = "chunkedResults";
/// Negotiated before the plugin may send oversized HTTP bodies as chunk references.
pub const FEATURE_HTTP_BODY_CHUNKS: &str = "httpBodyChunks";
/// Negotiated before the plugin may reserve owner-bound writes larger than the frame.
pub const FEATURE_FILE_WRITE_CHUNKS: &str = "fileWriteChunks";
/// Negotiated before `planner.install`/`planner.uninstall` may use transaction chunks.
pub const FEATURE_PLANNER_INSTALL_TRANSACTIONS: &str = "plannerInstallTransactions";
/// Negotiated before policy observation transport may be used.
pub const FEATURE_POLICY_OBSERVATIONS: &str = "policyObservations";
/// Negotiated before policy redaction metadata is carried.
pub const FEATURE_POLICY_REDACTION_METADATA: &str = "policyRedactionMetadata";

/// Every feature the TypeScript `@pacer/plugin` SDK can negotiate, in offer order.
pub const TS_SDK_FEATURES: &[&str] = &[
    FEATURE_CHUNKED_RESULTS,
    FEATURE_HTTP_BODY_CHUNKS,
    FEATURE_FILE_WRITE_CHUNKS,
    FEATURE_PLANNER_INSTALL_TRANSACTIONS,
    FEATURE_POLICY_OBSERVATIONS,
    FEATURE_POLICY_REDACTION_METADATA,
];
