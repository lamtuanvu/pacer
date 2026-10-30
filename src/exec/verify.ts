import type { Verification } from "../tasks/types";
import { execProcess } from "./process";

const TAIL_LINES = 20;

function acceptanceHint(code: number, durationS: number, tail: string): string | undefined {
  if (code === 141) {
    return `acceptance exited 141 (SIGPIPE) after ${durationS}s${tail ? "" : " with no output"}: `
      + `an earlier stage of a pipeline (e.g. "cmd | grep -q") can be killed once a later stage exits first — only surfaces with pipefail on`;
  }
  if (code !== 0 && !tail && durationS <= 0.1) {
    return `acceptance exited ${code} after ${durationS}s with no output`;
  }
  return undefined;
}

export async function verifyRepo(
  repo: string, acceptance: string | undefined, env: Record<string, string | undefined>, timeoutMs = 600_000, pipefail = false,
): Promise<Verification> {
  const status = await execProcess({ argv: ["git", "-C", repo, "status", "--porcelain"], cwd: repo, env, timeoutMs: 30_000 });
  let files: string;
  if (status.code !== 0) {
    files = "(not a git repository)";
  } else {
    const stat = await execProcess({ argv: ["git", "-C", repo, "diff", "--stat", "HEAD"], cwd: repo, env, timeoutMs: 30_000 });
    const untracked = status.stdout.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3));
    files = [stat.code === 0 ? stat.stdout.trim() : "", untracked.length ? `untracked: ${untracked.join(", ")}` : ""]
      .filter(Boolean)
      .join("\n") || "(no changes)";
  }
  if (!acceptance?.trim()) return { files };
  const bash = Bun.which("bash", { PATH: env.PATH ?? process.env.PATH });
  let argv: string[];
  let shell: string;
  if (bash) {
    argv = pipefail ? [bash, "-o", "pipefail", "-c", acceptance] : [bash, "-c", acceptance];
    shell = pipefail ? "bash -o pipefail -c" : "bash -c";
  } else if (pipefail) {
    const supportsPipefail = (await execProcess({ argv: ["sh", "-c", "set -o pipefail"], cwd: repo, env, timeoutMs: 30_000 })).code === 0;
    argv = ["sh", "-c", `${supportsPipefail ? "set -o pipefail; " : ""}${acceptance}`];
    shell = supportsPipefail ? "sh -c (set -o pipefail; ...)" : "sh -c (pipefail unsupported)";
  } else {
    argv = ["sh", "-c", acceptance];
    shell = "sh -c";
  }
  const started = performance.now();
  const r = await execProcess({ argv, cwd: repo, env, timeoutMs });
  const durationS = Math.round((performance.now() - started) / 100) / 10;
  const outputTail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-TAIL_LINES).join("\n");
  const timeoutMessage = `acceptance timed out after ${timeoutMs / 1000} s (acceptance_timeout_min=${timeoutMs / 60_000})`;
  const tail = r.timedOut ? [outputTail, timeoutMessage].filter(Boolean).join("\n") : outputTail;
  const passed = tail.match(/(\d+) pass(ed)?/i)?.[1];
  const failed = tail.match(/(\d+) fail(ed)?/i)?.[1];
  const summary = r.timedOut ? timeoutMessage : [passed && `${passed} passed`, failed && `${failed} failed`].filter(Boolean).join(" · ") || undefined;
  const hint = r.timedOut ? "Raise acceptance_timeout_min (or --acceptance-timeout-min) to allow more time, up to 120 minutes." : acceptanceHint(r.code, durationS, tail);
  return {
    files,
    acceptance: {
      cmd: acceptance, passed: r.code === 0 && !r.timedOut, tail, durationS, summary, machine: null,
      exitCode: r.code, shell, ...(r.timedOut ? { timedOut: true } : {}), ...(hint ? { hint } : {}),
    },
  };
}
