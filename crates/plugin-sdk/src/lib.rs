//! Rust plugin SDK for pacer.

mod error;
mod host;
mod serve;
#[cfg(feature = "testing")]
pub mod testing;
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

    pub use pacer_plugin_hosts_protocol::*;
    pub use pacer_plugin_install_protocol::*;
    pub use pacer_plugin_protocol::*;
    // Every protocol crate emits these; the entry crate's definitions take precedence.
    pub use pacer_plugin_protocol::{PacerPluginProtocol1100, VERSION, error};
}

pub use error::PluginError;
pub use host::{Host, MachineSignature};
pub use serve::{Ctx, HandlerResult, Manifest, Plugin, Progress};
pub use tokio_util::sync::CancellationToken;
