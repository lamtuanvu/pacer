import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { withLock } from "../core/lock";
import { CoreError } from "../core/errors";
import { withWork } from "../update/desktop/admission";
import {
  createTask,
  listTasksWhere,
  readTask,
  taskDatabase,
  updateTask,
} from "../tasks/store";
import { launchTaskRunner, spawnRunner, type SpawnRunner } from "../tasks/api";
import { claimAttachments } from "../attachments/claims";
import { prepareSession } from "./capabilities";
import { isExecutorSession } from "../install/role";
import type { Ctx } from "../types";
import type { TaskRecord } from "../tasks/types";

export interface SessionCreateInput {
  request_id: string;
  draftId: string;
  request: string;
  repo: string;
  executor: string;
  workspace: { mode: "new"; base: string } | { mode: "current"; path: string };
  attachments: string[];
}
export async function createConversation(
  ctx: Ctx,
  input: SessionCreateInput,
  deps: { prepare?: typeof prepareSession; spawnRunner?: SpawnRunner } = {},
): Promise<{ task_id: string; state: string }> {
  if (isExecutorSession(ctx))
    throw new CoreError(
      "not_allowed",
      "An executor session cannot start another session",
    );
  if (!input.request.trim())
    throw new CoreError("invalid_input", "A request is required");
  const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const db = taskDatabase(ctx);
  db.run(
    "CREATE TABLE IF NOT EXISTS session_requests (id TEXT PRIMARY KEY, payload TEXT NOT NULL, task TEXT NOT NULL)",
  );
  const existing = () => {
    const row = db
      .query<
        { payload: string; task: string },
        [string]
      >("SELECT * FROM session_requests WHERE id=?")
      .get(input.request_id);
    if (!row) return null;
    if (row.payload !== hash)
      throw new CoreError(
        "conflict",
        "This request ID was already used with different session details",
      );
    const task = readTask(ctx, row.task);
    if (!task)
      throw new CoreError("conflict", "Session creation needs recovery");
    return { task_id: task.id, state: task.state };
  };
  const previous = existing();
  if (previous) return previous;
  return withWork(
    ctx,
    {
      kind: "operation",
      id: input.request_id,
      label: "Starting interactive session",
    },
    async () => {
      const preparation = await (deps.prepare ?? prepareSession)(ctx, input);
      const executor = preparation.executors.find(
        (e) => e.id === input.executor,
      );
      if (!executor?.available)
        throw new CoreError(
          "not_allowed",
          executor?.reason ?? "Choose an available interactive executor",
        );
      let repo = preparation.repo.path,
        baseSha: string | undefined;
      if (input.workspace.mode === "current") {
        const tree = preparation.checkouts.find(
          (t) =>
            realpathSync(t.path) ===
            realpathSync(
              input.workspace.mode === "current" ? input.workspace.path : "",
            ),
        );
        if (!tree)
          throw new CoreError(
            "invalid_input",
            "Choose an existing checkout of this repository",
          );
        repo = tree.path;
      } else {
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(input.workspace.base) ||
          input.workspace.base.includes("..")
        )
          throw new CoreError("invalid_input", "Choose a valid base branch");
        const resolved = await ctx.run(
          [
            "git",
            "-C",
            repo,
            "rev-parse",
            "--verify",
            `${input.workspace.base}^{commit}`,
          ],
          5000,
        );
        if (resolved.code || !/^[a-f0-9]{40,64}$/.test(resolved.stdout.trim()))
          throw new CoreError(
            "invalid_input",
            "Base branch cannot be resolved",
          );
        baseSha = resolved.stdout.trim();
      }
      return withLock(ctx, "session-create", async () => {
        const duplicate = existing();
        if (duplicate) return duplicate;
        if (
          input.workspace.mode === "current" &&
          listTasksWhere(ctx, { states: ["queued", "running"] }).some(
            (t) =>
              (t.placement?.requested === "current" ||
                t.placement?.mode === "current") &&
              realpathSync(t.brief.repo) === realpathSync(repo),
          )
        ) {
          throw new CoreError("conflict", "Another session owns this checkout");
        }
        const task = createTask(
          ctx,
          {
            brief: {
              goal: input.request,
              repo,
              ...(baseSha ? { base: baseSha } : {}),
            },
            kind: null,
            requestedExecutor: input.executor,
            timeoutS: 3600,
            interactionMode: "conversation",
            conversation: { activity: "starting" },
            sessionDraftId: input.draftId,
            requestId: input.request_id,
            source: "ui",
            repo: preparation.repo,
            placement: { requested: input.workspace.mode },
            ...(baseSha
              ? {
                  baseSha,
                  baseBranch:
                    input.workspace.mode === "new"
                      ? input.workspace.base
                      : undefined,
                }
              : {}),
          },
          (created, transaction) => {
            claimAttachments(ctx, {
              ids: input.attachments,
              draftId: input.draftId,
              taskId: created.id,
            });
            transaction
              .query(
                "INSERT INTO session_requests(id,payload,task) VALUES (?,?,?)",
              )
              .run(input.request_id, hash, created.id);
          },
        );
        try {
          launchTaskRunner(ctx, task.id, deps.spawnRunner ?? spawnRunner);
        } catch (error) {
          updateTask(ctx, task.id, (t) => {
            t.state = "failed";
            t.conversation = { activity: "ended", endReason: "failure" };
            t.result = {
              status: "failed",
              executor: input.executor,
              model: null,
              files: "",
              report: String(error),
              backend: "direct",
            };
          });
        }
        return { task_id: task.id, state: readTask(ctx, task.id)!.state };
      });
    },
  );
}

export function requireConversation(ctx: Ctx, id: string): TaskRecord {
  const task = readTask(ctx, id);
  if (!task) throw new CoreError("unknown_task", `unknown task ${id}`);
  if (task.interactionMode !== "conversation")
    throw new CoreError(
      "not_allowed",
      "This task is not an interactive conversation",
    );
  return task;
}
