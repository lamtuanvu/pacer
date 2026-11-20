import { z } from "zod";
import { CoreError } from "../core/errors";
import { getTerminal, listTerminals, liveTerminalCount, startReservedShell, stopTerminalSession, terminalShellArgv } from "../terminal/workspace";
import type { Ctx } from "../types";

const id = z.string().regex(/^[0-9a-f-]{36}$/);
/**
 * Params of the sealed terminal parts route: the HTTP `/_internal/terminal-parts` body and the stdio
 * `_internal.terminal.parts` params beside `key`. Native `terminal.*` owns validation, revisions and the registry
 * files; Core keeps what only it can do: the account's login shell, session liveness, and starting or stopping the
 * session host. `terminal.start` takes no command or folder, so this channel can launch only the reserved login shell.
 */
const params = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("terminal.shell") }).strict(),
  z.object({ kind: z.literal("terminal.list") }).strict(),
  z.object({ kind: z.literal("terminal.live") }).strict(),
  z.object({ kind: z.literal("terminal.present"), id }).strict(),
  z.object({ kind: z.literal("terminal.start"), id }).strict(),
  z.object({ kind: z.literal("terminal.stop"), id }).strict(),
]);

export async function terminalPartsFor(ctx: Ctx, input: unknown): Promise<unknown> {
  const parsed = params.safeParse(input);
  if (!parsed.success) throw new CoreError("invalid_input", parsed.error.issues.map(i => `${i.path.join(".") || "params"}: ${i.message}`).join("; "));
  const p = parsed.data;
  switch (p.kind) {
    case "terminal.shell": return { argv: terminalShellArgv(ctx) };
    case "terminal.list": return listTerminals(ctx);
    case "terminal.live": return { live: liveTerminalCount(ctx) };
    case "terminal.present": return getTerminal(ctx, p.id);
    case "terminal.start": return startReservedShell(ctx, p.id);
    case "terminal.stop": await stopTerminalSession(ctx, p.id); return { stopped: true };
  }
}
