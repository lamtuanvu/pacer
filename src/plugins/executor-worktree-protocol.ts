import { z } from "zod";
import type { MethodDef } from "./protocol";

const taskId = z.string().regex(/^t-[A-Za-z0-9_-]{1,120}$/);
const attempt = z.number().int().positive().safe();
const path = z.string().min(1).max(4096);
const sha = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
const owner = z.object({ taskId, attempt }).strict();

/** The plugin never supplies a repository path, branch, Git argv or executable. */
export const WORKTREE_CAPABILITY_METHODS: Record<string, MethodDef> = {
  "capability.worktree.inspect": {
    description: "Read the exact task repository and worktree placement facts without an effect.",
    params: owner,
    result: z.object({ top: path, main: path, sub: z.string().max(4096).nullable(),
      dirty: z.boolean(), busy: z.boolean(), existingWorkdir: path.nullable() }).strict(),
    deadlineMs: 15_000,
  },
  "capability.worktree.resolveBase": {
    description: "Resolve the host-approved base to one immutable Git commit for this task and attempt.",
    params: owner,
    result: z.object({ base: z.string().min(1).max(256), sha }).strict(),
    deadlineMs: 100_000,
  },
  "capability.worktree.createOrReuse": {
    description: "Create or recover one journaled task-owned worktree at the exact approved base.",
    params: owner.extend({ baseSha: sha }).strict(),
    result: z.object({ path, workdir: path, branch: z.string().regex(/^pacer\/t-[A-Za-z0-9_-]{1,120}$/),
      baseSha: sha, reused: z.boolean() }).strict(),
    deadlineMs: 70_000,
  },
};

export const WORKTREE_METHOD_CAPABILITY: Record<string, "worktree"> = Object.fromEntries(
  Object.keys(WORKTREE_CAPABILITY_METHODS).map(name => [name, "worktree"]),
) as Record<string, "worktree">;
