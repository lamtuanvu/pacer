import { readFileSync } from "node:fs";
import { checkUiPullRequestEvent } from "./ui-check-evidence";

const usage = "Usage: bun run ui:ready (--pr <number> | --event <path>) [--ready]";
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** Read-only preflight. --ready applies the non-draft contract before leaving draft. */
export function uiReady(args: string[]): number {
  try {
    let prNumber: string | undefined, eventPath: string | undefined, ready = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "--ready" && !ready) { ready = true; continue; }
      if ((arg === "--pr" || arg === "--event") && !prNumber && !eventPath) {
        const value = args[++i];
        if (!value || value.startsWith("--")) throw Error(usage);
        if (arg === "--pr") {
          if (!/^[1-9][0-9]*$/.test(value)) throw Error(usage);
          prNumber = value;
        } else eventPath = value;
      } else throw Error(usage);
    }
    if (!prNumber && !eventPath) throw Error(usage);

    let event: unknown;
    if (prNumber) {
      const result = Bun.spawnSync(["gh", "api", `repos/{owner}/{repo}/pulls/${prNumber}`], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw Error(`Cannot read PR metadata: ${result.stderr.toString().trim()}`);
      event = { pull_request: JSON.parse(result.stdout.toString()) };
    } else event = JSON.parse(readFileSync(eventPath!, "utf8"));

    // Unlike CI's shared validator, this command must reject a push/non-PR input.
    if (!record(event) || !record(event.pull_request)) throw Error("Expected a pull_request event object.");
    const pr = event.pull_request;
    if (typeof pr.draft !== "boolean" || (pr.body !== null && typeof pr.body !== "string")) {
      throw Error("PR metadata requires a boolean draft and a string or null body.");
    }
    const draft = pr.draft && !ready;
    const violations = checkUiPullRequestEvent({ ...event, pull_request: { ...pr, draft } });
    for (const violation of violations) console.error(`[${violation.rule}] ${violation.message}`);
    if (violations.length) return 1;
    console.log(draft
      ? "Draft evidence metadata: PASS (not review readiness). Run again with --ready before leaving draft."
      : "UI review readiness metadata: PASS (or no UI evidence required).");
    console.log("Metadata validation does not verify linked reports or visual evidence; follow .project/rules/ui.md#ui-review-readiness-procedure.");
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exitCode = uiReady(process.argv.slice(2));
