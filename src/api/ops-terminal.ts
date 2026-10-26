import { z } from "zod";
import type { OpDef } from "./ops";
import { CoreError } from "../core/errors";
import { isExecutorSession } from "../install/role";
import { closeTerminal, createTerminal, listTerminals, renameTerminal } from "../terminal/workspace";
import type { Ctx } from "../types";

const id = z.string().uuid();
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const op = <P extends z.ZodTypeAny>(def: OpDef<P>) => def as unknown as OpDef;
function requireHuman(ctx: Ctx): void {
  if (isExecutorSession(ctx)) throw new CoreError("not_allowed", "Executor sessions cannot manage general terminals");
}

export const terminalOps: Record<string, OpDef> = {
  "terminal.list": op({
    description: "List the local user's built-in terminal tabs and their live or exited state.",
    params: z.object({}).strict(),
    handler: ctx => { requireHuman(ctx); return listTerminals(ctx); },
  }),
  "terminal.create": op({
    description: "Open an idempotent interactive shell terminal in a local folder.",
    params: z.object({ request_id: requestId, kind: z.literal("shell"), cwd: z.string().min(1).max(4096).optional() }).strict(),
    handler: (ctx, p) => {
      requireHuman(ctx);
      return createTerminal(ctx, { requestId: p.request_id, kind: "shell", title: "Shell", cwd: p.cwd });
    },
  }),
  "terminal.rename": op({
    description: "Rename a terminal tab when its revision still matches.",
    params: z.object({ id, title: z.string().min(1).max(80), expect_rev: z.number().int().positive() }).strict(),
    handler: (ctx, p) => { requireHuman(ctx); return renameTerminal(ctx, p.id, p.title, p.expect_rev); },
  }),
  "terminal.close": op({
    description: "Stop and close a terminal tab when its revision still matches.",
    params: z.object({ id, expect_rev: z.number().int().positive() }).strict(),
    handler: (ctx, p) => { requireHuman(ctx); return closeTerminal(ctx, p.id, p.expect_rev); },
  }),
};
