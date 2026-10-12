import type { Ctx } from "../types";
import { isObj } from "../util";
import { parseOrcaOutput } from "../exec/orca/client";
import { pacerArgv } from "../install/self";
import { shellCommand } from "../install/fsx";
import { currentSnapshot } from "../link/store";
import { publish } from "../link/publish";

/** Server-local reservations also prevent concurrent requests creating duplicate terminals. */
export function consoleOpener() {
  const lastOpen = new Map<string, number>();
  let opens: { at: number }[] = [];
  const openedHandles = new Map<string, Set<string>>();
  async function result(ctx: Ctx, argv: string[]): Promise<Record<string, unknown>> {
    const r = await ctx.run(argv, 30_000);
    const reply = parseOrcaOutput(r.stdout);
    if (r.code !== 0 || !isObj(reply) || reply.ok !== true || !isObj(reply.result)) throw new Error("Orca request failed");
    return reply.result;
  }
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    const json = (ok: boolean, reason?: string, status = 200, handle?: string) => Response.json({ ok, ...(reason ? { reason } : {}), ...(handle ? { handle } : {}) }, { status, headers: { "X-Pacer": "1" } });
    if (req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return json(false, "content-type", 415);
    // Read incrementally: a missing or dishonest Content-Length cannot bypass the cap.
    const reader = req.body?.getReader();
    let body = "", bytes = 0;
    const decoder = new TextDecoder();
    try {
      if (reader) for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) { await reader.cancel(); return json(false, "body-too-large", 413); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } catch { return json(false, "invalid-body", 400); }
    let data: unknown;
    try { data = JSON.parse(body); } catch { return json(false, "invalid-json", 400); }
    if (!isObj(data) || (data.terminal === undefined && data.branch === undefined)
      || (data.terminal !== undefined && (typeof data.terminal !== "string" || !/^term_[A-Za-z0-9-]{1,100}$/.test(data.terminal)))
      || (data.branch !== undefined && (typeof data.branch !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(data.branch)))) return json(false, "invalid-selector", 400);
    try {
      let selector = "", worktreeKey = "", displayName = "";
      if (typeof data.terminal === "string") {
        try {
          const r = await result(ctx, ["orca", "terminal", "show", "--terminal", data.terminal, "--json"]);
          if (isObj(r.terminal) && typeof r.terminal.worktreeId === "string" && r.terminal.worktreeId) {
            selector = `id:${r.terminal.worktreeId}`; worktreeKey = selector;
            displayName = typeof r.terminal.worktreeDisplayName === "string" ? r.terminal.worktreeDisplayName : "";
          }
        } catch { /* A branch can recover a vanished terminal. */ }
      }
      if (!selector && typeof data.branch === "string") {
        const r = await result(ctx, ["orca", "worktree", "show", "--worktree", `branch:${data.branch}`, "--json"]);
        if (!isObj(r.worktree) || typeof r.worktree.id !== "string" || !r.worktree.id) return json(false, "worktree-unresolved");
        selector = `branch:${data.branch}`; worktreeKey = `id:${r.worktree.id}`;
        displayName = typeof r.worktree.displayName === "string" ? r.worktree.displayName : data.branch;
      }
      if (!selector) return json(false, "worktree-unresolved");
      if (!displayName) {
        const r = await result(ctx, ["orca", "worktree", "show", "--worktree", selector, "--json"]);
        if (isObj(r.worktree) && typeof r.worktree.displayName === "string") displayName = r.worktree.displayName;
      }
      const listed = await result(ctx, ["orca", "terminal", "list", "--worktree", selector, "--json"]);
      if (!Array.isArray(listed.terminals)) return json(false, "worktree-unresolved");
      const handles = new Set(listed.terminals.flatMap(t => isObj(t) && typeof t.handle === "string" ? [t.handle] : []));
      const snap = currentSnapshot(ctx);
      if ([...(snap.consoles ?? []), ...(snap.console ? [snap.console] : [])].some(c => c.handle && handles.has(c.handle) && ctx.now - c.heartbeatAt <= 30)) return json(false, "console-present");
      if (listed.terminals.some(t => isObj(t) && (t.title === "pacer" || (typeof t.handle === "string" && openedHandles.get(worktreeKey)?.has(t.handle))))) return json(false, "console-terminal-exists");
      opens = opens.filter(slot => ctx.now - slot.at < 3600);
      if (ctx.now - (lastOpen.get(worktreeKey) ?? -Infinity) < 60 || opens.length >= 10) return json(false, "rate-limited");
      const previous = lastOpen.get(worktreeKey), slot = { at: ctx.now };
      lastOpen.set(worktreeKey, ctx.now); opens.push(slot);
      let r: Record<string, unknown>;
      try { r = await result(ctx, ["orca", "terminal", "create", "--worktree", selector, "--title", "pacer", "--command", shellCommand([...pacerArgv(ctx.env), "console"]), "--json"]); }
      catch (e) {
        if (previous === undefined) lastOpen.delete(worktreeKey); else lastOpen.set(worktreeKey, previous);
        opens = opens.filter(entry => entry !== slot);
        throw e;
      }
      if (!isObj(r.terminal) || typeof r.terminal.handle !== "string") return json(false, "invalid-orca-response");
      const remembered = openedHandles.get(worktreeKey) ?? new Set<string>();
      remembered.add(r.terminal.handle); openedHandles.set(worktreeKey, remembered);
      await publish(ctx, [{ v: 1, type: "alert", data: { key: `console-open-${r.terminal.handle}`, level: "info", title: `Opened pacer console in ${displayName || (typeof data.branch === "string" ? data.branch : selector)}`, body: "", at: ctx.now } }], { channel: false });
      return json(true, undefined, 200, r.terminal.handle);
    } catch { return json(false, "orca-unavailable"); }
  };
}
