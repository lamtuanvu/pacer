import { isExecutorSession } from '../install/role';
import { ApiError } from './client-types';
import type { Ctx } from '../types';

/** Preserve caller role when a planner-owned daemon performs the operation. */
export function assertCallerCanInvoke(ctx: Ctx, name: string, params: Record<string, unknown>): void {
  if (!isExecutorSession(ctx)) return;
  if (name.startsWith('assistant.')) throw new ApiError('not_allowed', 'PACER_ROLE=executor: executors cannot use the assistant or read its history.');
  if (name.startsWith('plugin.ui.') || name.startsWith('plugin.settings.')) throw new ApiError('not_allowed', 'PACER_ROLE=executor: plugin UI and settings are for the app and the operator, not executor sessions.');
  if (name === 'plugin.enable' && params.grant === true) throw new ApiError('not_allowed', 'PACER_ROLE=executor: executor sessions cannot grant plugin access.');
  if (name === 'dispatch.explain') throw new ApiError('not_allowed', 'PACER_ROLE=executor: route explanations are for planners and people; executors do not choose where work goes.');
  if (name === 'files.search') throw new ApiError('not_allowed', 'PACER_ROLE=executor: file search over registered repositories is for planners and people; work in your own worktree.');
  if (name === 'issue.import' || name === 'issue.search') throw new ApiError('not_allowed', 'PACER_ROLE=executor: issue import is for planners and people starting tasks; executors work from their brief.');
  const launches = ['task.delegate', 'task.retry', 'task.retry_all', 'task.answer', 'task.send', 'session.create', 'session.resume', 'task.takeover', 'strategy.build', 'onboarding.try'];
  if (launches.includes(name) || (name === 'task.review' && ['send_back', 'retry'].includes(String(params.verdict)))) {
    throw new ApiError('not_allowed', 'PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.');
  }
}
