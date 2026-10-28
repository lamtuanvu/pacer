import { isExecutorSession } from '../install/role';
import { ApiError } from './client-types';
import type { Ctx } from '../types';

/** Preserve caller role when a planner-owned daemon performs the operation. */
export function assertCallerCanInvoke(ctx: Ctx, name: string, params: Record<string, unknown>): void {
  if (!isExecutorSession(ctx)) return;
  if (name === 'dispatch.explain') throw new ApiError('not_allowed', 'PACER_ROLE=executor: route explanations are for planners and people; executors do not choose where work goes.');
  if (name === 'session.file.read' || name === 'session.file.resolve') throw new ApiError('not_allowed', 'PACER_ROLE=executor: session files are for people viewing sessions; read your own workspace directly.');
  const launches = ['task.delegate', 'task.retry', 'task.retry_all', 'task.answer', 'session.create', 'session.resume', 'task.takeover', 'strategy.build', 'onboarding.try'];
  if (launches.includes(name) || (name === 'task.review' && ['send_back', 'retry'].includes(String(params.verdict)))) {
    throw new ApiError('not_allowed', 'PACER_ROLE=executor: pacer executors cannot delegate onward; complete the assigned task directly.');
  }
}
