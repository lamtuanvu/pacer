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
    if (!supportsPipefail) {
      // Running without the requested pipefail could pass a failing non-final pipeline stage.
      const shell = "sh -c (pipefail unsupported)";
      const tail = "acceptance not run: acceptance_pipefail was requested, but bash is not on PATH and sh does not support set -o pipefail";
      const hint = "install bash, or drop acceptance_pipefail and check each pipeline stage in the command itself";
      return { files, acceptance: { cmd: acceptance, passed: false, tail, durationS: 0, machine: null, shell, hint } };
    }
    argv = ["sh", "-c", `set -o pipefail; ${acceptance}`];
    shell = "sh -c (set -o pipefail; ...)";
  } else {
    argv = ["sh", "-c", acceptance];
    shell = "sh -c";
  }
  const started = performance.now();
  const r = await execProcess({ argv, cwd: repo, env, timeoutMs });
  const durationS = Math.round((performance.now() - started) / 100) / 10;
  const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-TAIL_LINES).join("\n");
  const passed = tail.match(/(\d+) pass(ed)?/i)?.[1];
  const failed = tail.match(/(\d+) fail(ed)?/i)?.[1];
  const summary = [passed && `${passed} passed`, failed && `${failed} failed`].filter(Boolean).join(" · ") || undefined;
  const hint = acceptanceHint(r.code, durationS, tail);
  return {
    files,
    acceptance: {
      cmd: acceptance, passed: r.code === 0 && !r.timedOut, tail, durationS, summary, machine: null,
      exitCode: r.code, shell, ...(hint ? { hint } : {}),
    },
  };
}
