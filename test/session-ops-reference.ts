// Reference capture helpers. Import only from the isolated bun:test process.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionFile } from "../src/session/files";
import { cleanSummary, readReport, writeReport } from "../src/session/reports";
import { writeJsonAtomic } from "../src/fsutil";
import { fakeCtx, tmpDir } from "./helpers";
import inputs from "./fixtures/session-ops/inputs.json";

export const sessionId = "t-20261027-120000-abcd";
export async function outcome(action: () => unknown | Promise<unknown>): Promise<unknown> {
  try { return { result: await action() }; }
  catch (error) {
    const e = error as { code?: string; message: string };
    return { error: { ...(e.code ? { code: e.code } : {}), message: e.message } };
  }
}
export function fileHome() {
  const ctx = fakeCtx(), workdir = join(ctx.home, "repo");
  mkdirSync(workdir, { recursive: true });
  writeJsonAtomic(join(ctx.pacerHome, "tasks", `${sessionId}.json`), {
    id: sessionId, rev: 2, state: "stopped", createdAt: 1,
    brief: { goal: "view", repo: workdir }, attempts: [], interactionMode: "conversation",
    conversation: { activity: "ended", agentSessionId: "native" },
    run: { attempt: 2, workdir, dir: join(ctx.pacerHome, "runs", sessionId, "2"), host: null, mode: "current" },
  } as any);
  return { ctx, workdir };
}
export function summaryView(summary: string) {
  return summary.length <= 256 ? { codeUnits: Array.from({ length: summary.length }, (_, i) => summary.charCodeAt(i)) } : { units: summary.length, first: summary.slice(0, 8), last: summary.slice(-8) };
}
export async function pureReference() {
  const { ctx, workdir } = fileHome();
  const references = [];
  // Create every valid literal filename as well as the numeric-suffix variants.
  for (const reference of inputs.references) {
    for (const name of [reference, reference.replace(/:\d+(?::\d+)?$/, "")]) {
      if (name && !/[\x00-\x1f\x7f]/.test(name)) writeFileSync(join(workdir, name), "text");
    }
    const expected = await outcome(() => {
      const value = readSessionFile(ctx, { id: sessionId, attempt: 2, reference });
      return { name: value.path, ...(value.line === undefined ? {} : { line: value.line }), ...(value.column === undefined ? {} : { column: value.column }) };
    });
    references.push({ reference, expected });
  }
  // Both the direct helper and the API's Zod layer matter: this is UTF-16 length.
  const tooLong = "😀".repeat(2049);
  references.push({ reference: tooLong, expected: await outcome(() => readSessionFile(ctx, { id: sessionId, attempt: 2, reference: tooLong })) });
  const summaries = [];
  for (const input of inputs.summaries) {
    const summary = ("units" in input ? String.fromCharCode(...input.units!) : input.text!).repeat("repeat" in input ? input.repeat! : 1), dir = tmpDir();
    writeFileSync(join(dir, "session-status.json"), JSON.stringify({ status: "running", summary, at: 1 }));
    const read = readReport(dir);
    const written = await outcome(() => {
      writeReport(dir, "running", summary);
      return summaryView(readReport(dir)!.summary);
    });
    summaries.push({ input, clean: summaryView(cleanSummary(summary)), read: read ? summaryView(read.summary) : null, written });
  }
  return { references, summaries };
}
