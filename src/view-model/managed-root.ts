/**
 * A work root a person started keeps the usual task controls. Answer and Send back go through task.* first, which
 * continue the task's session with a message. When it has no session the service refuses and names the dispatch.* op,
 * so the client runs those steps with stable request ids and the current revision.
 */
export interface ManagedStep { op: string; params: Record<string, unknown> }
type Call = (op: string, params: Record<string, unknown>) => Promise<unknown>;

export const userStartedRoot = (task: { work?: { parentId: string | null; userStarted?: boolean } }): boolean =>
  !!task.work?.userStarted && !task.work.parentId;

/** The service's refusal of task.answer / task.review for managed work: "Use dispatch.answer …", "use dispatch.retry …". */
export const dispatchRefusal = (error: unknown): boolean =>
  error instanceof Error && /\buse dispatch\.(?:answer|review|retry)\b/i.test(error.message);

export const answerSteps = (id: string, rev: number, text: string): ManagedStep[] =>
  [{ op: "dispatch.answer", params: { id, expect_rev: rev, requestId: `answer-${id}-${rev}`, text } }];

/** Send back without a session: a finished result is rejected first, then the work restarts in place with the note. */
export const sendBackSteps = (task: { id: string; rev: number; state: string; review?: unknown }, note: string): ManagedStep[] => [
  ...(task.state === "done" && !task.review ? [{ op: "dispatch.review", params: { id: task.id, accepted: false, note, expect_rev: task.rev } }] : []),
  { op: "dispatch.retry", params: { id: task.id, expect_rev: task.rev, requestId: `sendback-${task.id}-${task.rev}`, feedback: note } },
];

const revOf = (result: unknown): number | undefined => {
  const r = result as { rev?: unknown; task?: { rev?: unknown } } | null;
  return typeof r?.rev === "number" ? r.rev : typeof r?.task?.rev === "number" ? r.task.rev : undefined;
};

/** Runs `primary`; on a dispatch refusal runs `fallback` in order, each step expecting the revision the last one left. */
export async function withManagedFallback(call: Call, primary: ManagedStep, fallback: ManagedStep[]): Promise<unknown> {
  try { return await call(primary.op, primary.params); }
  catch (error) {
    if (!dispatchRefusal(error) || !fallback.length) throw error;
    // A session turn that could not start may have moved the revision; read it once before the managed path.
    let rev = (error as { code?: string }).code === "conflict" ? revOf(await call("task.get", { id: primary.params.id })) : undefined;
    let result: unknown;
    for (const step of fallback) {
      result = await call(step.op, rev === undefined ? step.params : { ...step.params, expect_rev: rev });
      rev = revOf(result) ?? rev;
    }
    return result;
  }
}
