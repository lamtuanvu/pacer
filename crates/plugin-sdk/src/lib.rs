//! Rust plugin SDK for pacer.

mod error;
mod host;
mod serve;
#[cfg(feature = "testing")]
pub mod testing;
pub mod wire;

pub use error::PluginError;
pub use host::Host;
/// Wire types from independent generated areas; existing SDK paths stay stable.
pub mod types {
    pub use pacer_plugin_agent_protocol::{
        AgentSessionAttachmentParams, AgentSessionAttachmentParamsAgent,
        AgentSessionAttachmentParamsApiHelp, AgentSessionAttachmentParamsAttachment,
        AgentSessionAttachmentParamsAttachmentId, AgentSessionAttachmentParamsAttachmentMime,
        AgentSessionAttachmentParamsAttachmentName, AgentSessionAttachmentParamsAttachmentPath,
        AgentSessionAttachmentParamsHelp, AgentSessionAttachmentParamsPhase,
        AgentSessionAttachmentParamsResumeHelp, AgentSessionAttachmentParamsVersion,
        AgentSessionAttachmentParamsWorkspace, AgentSessionAttachmentResult,
        AgentSessionCapabilitiesParams, AgentSessionCapabilitiesParamsAgent,
        AgentSessionCapabilitiesParamsApiHelp, AgentSessionCapabilitiesParamsHelp,
        AgentSessionCapabilitiesParamsResumeHelp, AgentSessionCapabilitiesParamsVersion,
        AgentSessionCapabilitiesResult, AgentSessionIdentityParams,
        AgentSessionIdentityParamsAgent, AgentSessionIdentityParamsApiHelp,
        AgentSessionIdentityParamsHelp, AgentSessionIdentityParamsResumeHelp,
        AgentSessionIdentityParamsSessionId, AgentSessionIdentityParamsTaskId,
        AgentSessionIdentityParamsVersion, AgentSessionIdentityResult,
        AgentSessionIdentityResultId, AgentSessionPrepareParams, AgentSessionPrepareParamsAgent,
        AgentSessionPrepareParamsApiHelp, AgentSessionPrepareParamsAttachmentDir,
        AgentSessionPrepareParamsAttachmentsItem, AgentSessionPrepareParamsAttachmentsItemId,
        AgentSessionPrepareParamsAttachmentsItemMime, AgentSessionPrepareParamsAttachmentsItemName,
        AgentSessionPrepareParamsAttachmentsItemPath, AgentSessionPrepareParamsHelp,
        AgentSessionPrepareParamsNewSessionId, AgentSessionPrepareParamsRequest,
        AgentSessionPrepareParamsResumeHelp, AgentSessionPrepareParamsRunDir,
        AgentSessionPrepareParamsSessionId, AgentSessionPrepareParamsVersion,
        AgentSessionPrepareParamsWorkspace, AgentSessionPrepareResult,
        AgentSessionPrepareResultCwd, AgentSessionPrepareResultReporting,
        AgentSessionPrepareResultReportingConfigEnv, AgentSessionPrepareResultReportingConfigKey,
        AgentSessionPrepareResultReportingSource,
    };
    pub use pacer_plugin_dispatch_protocol::{
        DecisionDecideParams, DecisionDecideParamsCandidatesItem,
        DecisionDecideParamsCandidatesItemAccount, DecisionDecideParamsCandidatesItemActualModel,
        DecisionDecideParamsCandidatesItemBinding, DecisionDecideParamsCandidatesItemBindingExact,
        DecisionDecideParamsCandidatesItemExecutor, DecisionDecideParamsCandidatesItemId,
        DecisionDecideParamsCandidatesItemLearnedFit,
        DecisionDecideParamsCandidatesItemPoolIdsItem,
        DecisionDecideParamsCandidatesItemProvenance, DecisionDecideParamsCandidatesItemRunner,
        DecisionDecideParamsCandidatesItemStrengthsItem, DecisionDecideParamsCandidatesItemTier,
        DecisionDecideParamsConfig, DecisionDecideParamsConfigDiscovery,
        DecisionDecideParamsConfigDiscoveryModelsItem,
        DecisionDecideParamsConfigDiscoveryRunnersItem, DecisionDecideParamsConfigEngine,
        DecisionDecideParamsConfigEngineFallback, DecisionDecideParamsConfigLearning,
        DecisionDecideParamsConfigOnNoMatch, DecisionDecideParamsConfigStepsItem,
        DecisionDecideParamsConfigStepsItemCandidates,
        DecisionDecideParamsConfigStepsItemCandidatesExecutorsItem,
        DecisionDecideParamsConfigStepsItemCandidatesModelsItem,
        DecisionDecideParamsConfigStepsItemCapacity, DecisionDecideParamsConfigStepsItemId,
        DecisionDecideParamsConfigStepsItemMatch, DecisionDecideParamsConfigStepsItemMatchKind,
        DecisionDecideParamsConfigStepsItemPrefer,
        DecisionDecideParamsConfigStepsItemPreferModelsItem,
        DecisionDecideParamsConfigStepsItemPreferStrengthsItem,
        DecisionDecideParamsConfigStepsItemRankItem, DecisionDecideParamsConfigStepsItemRequire,
        DecisionDecideParamsConfigStepsItemRequireMinTier, DecisionDecideParamsObservationRevision,
        DecisionDecideParamsObservationsItem, DecisionDecideParamsObservationsItemMethod,
        DecisionDecideParamsObservationsItemScope,
        DecisionDecideParamsObservationsItemScopeAccount,
        DecisionDecideParamsObservationsItemScopeBinding,
        DecisionDecideParamsObservationsItemScopeBindingExact,
        DecisionDecideParamsObservationsItemScopeRunner,
        DecisionDecideParamsObservationsItemSource, DecisionDecideParamsObservationsItemState,
        DecisionDecideParamsObservationsItemValue, DecisionDecideParamsObservationsItemValueModel,
        DecisionDecideParamsObservationsItemValueModelsItem,
        DecisionDecideParamsObservationsItemValueModelsItemId,
        DecisionDecideParamsObservationsItemValueModelsItemStrengthsItem,
        DecisionDecideParamsObservationsItemValueModelsItemTier,
        DecisionDecideParamsObservationsItemValueWindowsItem,
        DecisionDecideParamsObservationsItemValueWindowsItemPool, DecisionDecideParamsRequestId,
        DecisionDecideParamsStrategyHash, DecisionDecideParamsTask,
        DecisionDecideParamsTaskDifficulty, DecisionDecideParamsTaskKind,
        DecisionDecideParamsTaskModel, DecisionDecideParamsTaskPreferences,
        DecisionDecideParamsTaskPreferencesModelsItem,
        DecisionDecideParamsTaskPreferencesStrengthsItem, DecisionDecideParamsTaskRequirements,
        DecisionDecideParamsTaskRequirementsMinTier, DecisionDecideResult,
        DecisionDecideResultVariant0ChoicesItem, DecisionDecideResultVariant0ChoicesItemId,
        DecisionDecideResultVariant0ChoicesItemReason, DecisionDecideResultVariant0SkippedItem,
        DecisionDecideResultVariant0Step, DecisionDecideResultVariant1Reason,
        DecisionDecideResultVariant1SkippedItem, DecisionDecideResultVariant1State,
        ObservationObserveParams, ObservationObserveParamsMethod, ObservationObserveParamsScope,
        ObservationObserveParamsScopeAccount, ObservationObserveParamsScopeBinding,
        ObservationObserveParamsScopeBindingExact, ObservationObserveParamsScopeRunner,
        ObservationObserveResult, ObservationObserveResultItem, ObservationObserveResultItemMethod,
        ObservationObserveResultItemScope, ObservationObserveResultItemScopeAccount,
        ObservationObserveResultItemScopeBinding, ObservationObserveResultItemScopeBindingExact,
        ObservationObserveResultItemScopeRunner, ObservationObserveResultItemSource,
        ObservationObserveResultItemState, ObservationObserveResultItemValue,
        ObservationObserveResultItemValueModel, ObservationObserveResultItemValueModelsItem,
        ObservationObserveResultItemValueModelsItemId,
        ObservationObserveResultItemValueModelsItemStrengthsItem,
        ObservationObserveResultItemValueModelsItemTier,
        ObservationObserveResultItemValueWindowsItem,
        ObservationObserveResultItemValueWindowsItemPool,
    };
    pub use pacer_plugin_protocol::*;
}
pub use serve::{Ctx, HandlerResult, Manifest, Plugin, Progress};
pub use tokio_util::sync::CancellationToken;
