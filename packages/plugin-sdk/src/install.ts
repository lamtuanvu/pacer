/** Pure helpers for planning and undoing planner integration edits. */
export {blockText,hasBlock,upsertBlock,removeBlock,type BlockStyle} from './install/blocks';
export {addHooks,removeHooks,restoreHooks,isPacerHook,upsertHooks,editHooksFile,type HookFormat,type HookSpec,type RemovedHook} from './install/hookjson';
export {JsoncError,stripJsonc,parseJsonc,getMember,isEmptyObject,setMember,removeMember} from './install/jsonc';
export {removeTomlTable,applyUndo,mergeUndo,piecesPresent,type UndoOp,type FileChange,type PlannerRecord,type Manifest} from './install/undo';
export {sha256,backupPath,shellCommand} from './install/helpers';

export {PreparedPlannerBuilder,preparePlannerInstall,type PreparedPlannerIO,type PreparedPlannerPlan,type PlannerCommandIntent,type PlannerCommandResult} from "./install/prepared";
export {createPlannerIO,readPlannerPrior} from "./install/transport";
export type {PlanEnv,PlanIO,PendingFile} from "./install/plan";
export {preparePlannerUninstallFiles,type PreparedPlannerUninstall,type UninstallReport,type UninstallPreparationFailure} from "./install/uninstall";
