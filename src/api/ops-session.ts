import { z } from "zod";
import type { OpDef } from "./ops";
import { sessionInfo, openSession } from "../session/service";
import { takeoverTask } from "../session/takeover";
import { createConversation, requireConversation } from "../session/create";
import { prepareSession } from "../session/capabilities";
import {
  createDraft,
  listAttachments,
  claimAttachments,
  resolveAttachments,
} from "../attachments/store";
import { prepareAgentAttachment } from "../plugins/agent-session";
import { admissionCtx, prepareDelegate, launchTaskRunner, spawnRunner, taskStop } from "../tasks/api";
import { withWork } from "../update/desktop/admission";
import { readTask, withTaskLock, updateTask } from "../tasks/store";
import { CoreError } from "../core/errors";
import { pidAlive } from "../link/store";
import { readSessionFile } from "../session/files";
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const op = <P extends z.ZodTypeAny>(def: OpDef<P>) => def as unknown as OpDef;
export const sessionOps: Record<string, OpDef> = {
  "session.file.read": op({
    description: "Read a bounded UTF-8 file inside one local session attempt's workspace.",
    params: z.object({ id, attempt: z.number().int().positive(), reference: z.string().min(1).max(4096) }),
    handler: (ctx, p) => readSessionFile(ctx, p),
  }),
  "session.draft.create": op({
    description:
      "Create a private attachment draft, expiring after 24 hours if unclaimed.",
    params: z.object({}),
    handler: (ctx) => createDraft(ctx),
  }),
  "session.prepare": op({
    description:
      "Interactive executor capabilities and explicit workspace choices.",
    params: z.object({
      repo: z.string().min(1),
      executor: z.string().optional(),
    }),
    handler: (ctx, p) => prepareSession(ctx, p),
  }),
  "session.create": op({
    description:
      "Start an idempotent persistent conversation in an explicit workspace.",
    params: z.object({
      request_id: id,
      draftId: z.string().uuid(),
      request: z.string().min(1).max(200000),
      repo: z.string().min(1),
      executor: z.string().min(1).max(256),
      workspace: z.discriminatedUnion("mode", [
        z.object({ mode: z.literal("new"), base: z.string().min(1) }),
        z.object({ mode: z.literal("current"), path: z.string().min(1) }),
      ]),
      attachments: z.array(z.string().uuid()).max(20),
    }),
    handler: (ctx, p, deps) =>
      createConversation(ctx, p, { spawnRunner: deps.spawnRunner }),
  }),
  "session.context": op({
    description: "Private attachment draft and metadata for a conversation.",
    params: z.object({ id }),
    handler: ctxWithId,
  }),
  "session.end": op({
    description: "End a conversation while retaining its workspace and output.",
    params: z.object({ id, expect_rev: z.number().int().positive() }),
    handler: (ctx, p) => {
      const task = requireConversation(ctx, p.id);
      if (task.rev !== p.expect_rev)
        throw new CoreError(
          "conflict",
          "Session changed; refresh and try again",
        );
      taskStop(ctx, p.id);
      return updateTask(ctx, p.id, (t) => {
        t.conversation = {
          ...t.conversation,
          activity: "ended",
          endReason: "user",
        };
      });
    },
  }),
  "session.resume": op({
    description:
      "Explicitly resume the native conversation with the same agent and account.",
    params: z.object({ id, expect_rev: z.number().int().positive() }),
    handler: async (ctx, p, deps) => withWork(ctx,{kind:"operation",id:p.id,label:"Resuming interactive session"},async()=>{
      const task = requireConversation(ctx, p.id);
      if (
        task.rev !== p.expect_rev ||
        ["queued", "running"].includes(task.state)
      )
        throw new CoreError(
          "conflict",
          "Session is active or changed; refresh and try again",
        );
      if (
        (task.runnerPid && pidAlive(task.runnerPid)) ||
        (await sessionInfo(ctx, p.id, undefined, false)).live
      )
        throw new CoreError(
          "conflict",
          "The previous session is still stopping; wait and try again",
        );
      const identity =
        task.conversation?.agentSessionId ?? task.run?.agentSession?.id;
      if (!identity)
        throw new CoreError(
          "not_allowed",
          "The agent did not report a resumable session identity",
        );
      const prepared = await prepareSession(ctx, {
        repo: task.repo?.key ?? task.brief.repo,
      });
      const executor = prepared.executors.find(
        (e) => e.id === task.requestedExecutor,
      );
      if (!executor?.available || !executor.capabilities.resume)
        throw new CoreError(
          "not_allowed",
          executor?.reason ?? "Resume is unavailable for this agent",
        );
      const mode=task.placement?.mode??task.run?.mode??(task.placement?.requested==="new"?"new":"current");
      let currentPreparation=prepared;
      const admission=await prepareDelegate(admissionCtx(ctx),{
        brief:task.brief,kind:null,executor:task.requestedExecutor,worktree:mode,repoRef:prepared.repo,repoValidated:true,admissionTaskLock:p.id,
        admissionContext:()=>JSON.stringify({task:readTask(ctx,p.id),preparation:currentPreparation}),
      },deps.spawnRunner??spawnRunner,undefined,()=>"conversation-resume",candidate=>candidate.kind===null&&candidate.executor===task.requestedExecutor&&candidate.worktree===mode);
      if(admission.policies) currentPreparation=await prepareSession(admissionCtx(ctx),{repo:task.repo?.key??task.brief.repo});
      if((await sessionInfo(admissionCtx(ctx),p.id,undefined,false)).live) throw new CoreError("conflict","The previous session is still active");
      return admission.consume(({revalidate})=>{
      revalidate();
      withTaskLock(ctx,p.id,()=>{
       revalidate();
       updateTask(admissionCtx(ctx), p.id, (t) => {
        if (t.rev !== p.expect_rev)
          throw new CoreError("conflict", "Session changed");
        t.state = "queued";
        t.conversation = { activity: "starting", agentSessionId: identity };
        delete t.result;
        delete t.run;
        delete t.runnerPid;
        delete t.queue;
       });
      });
      try {
        launchTaskRunner(ctx, p.id, deps.spawnRunner ?? spawnRunner);
      } catch (error) {
        updateTask(ctx, p.id, (t) => {
          t.state = "failed";
          t.run = task.run;
          t.result = task.result;
          t.conversation = {
            ...task.conversation,
            activity: "ended",
            endReason: "failure",
          };
        });
        throw new CoreError(
          "not_allowed",
          "Could not launch the resumed session",
          String(error),
        );
      }
      return { task_id: p.id, state: "queued" };
      });
    }),
  }),
  "session.attachment.prepare": op({
    description:
      "Claim a later attachment and prepare explicit delivery without submitting agent input.",
    params: z.object({ id, attachmentId: z.string().uuid() }),
    handler: async (ctx, p) => {
      const task = requireConversation(ctx, p.id);
      if (!task.sessionDraftId || task.state !== "running")
        throw new CoreError("conflict", "Session is not running");
      claimAttachments(ctx, {
        ids: [p.attachmentId],
        draftId: task.sessionDraftId,
        taskId: p.id,
      });
      const prepared = await prepareSession(ctx, {
        repo: task.repo?.key ?? task.brief.repo,
      });
      const executor = prepared.executors.find(
        (e) => e.id === task.requestedExecutor,
      );
      if (!executor)
        throw new CoreError("unknown_executor", "Executor no longer exists");
      return prepareAgentAttachment(ctx, {
        agent: executor.agent,
        version: executor.version,
        workspace: task.worktree ?? task.brief.repo,
        attachment: resolveAttachments(ctx, p.id, [p.attachmentId])[0]!,
        phase: "live",
      });
    },
  }),
  "task.takeover": op({
    description:
      "Stop a local headless run and resume its conversation interactively.",
    params: z.object({ id }),
    handler: (ctx, p) => takeoverTask(ctx, p.id),
  }),
  "task.session": op({
    description: "Session host, capabilities and available viewers.",
    params: z.object({ id }),
    handler: (ctx, p) => sessionInfo(ctx, p.id),
  }),
  "task.attach": op({
    description: "Open a task viewer, or return a command when unavailable.",
    params: z.object({
      id,
      target: z.enum(["app", "orca", "here", "terminal", "tmux"]),
    }),
    handler: (ctx, p) => openSession(ctx, p.id, p.target),
  }),
};

function ctxWithId(ctx: import("../types").Ctx, p: { id: string }) {
  const task = requireConversation(ctx, p.id);
  return {
    draftId: task.sessionDraftId,
    attachments: task.sessionDraftId
      ? listAttachments(ctx, task.sessionDraftId)
      : [],
    rev: task.rev,
  };
}
