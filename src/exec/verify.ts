import type { Verification } from "../tasks/types";
import { execProcess } from "./process";

const TAIL_LINES = 20;

export async function verifyRepo(
  repo: string, acceptance: string | undefined, env: Record<string, string | undefined>, timeoutMs = 600_000,
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
  const pipefail = bash ? true : (await execProcess({ argv: ["sh", "-c", "set -o pipefail"], cwd: repo, env, timeoutMs: 30_000 })).code === 0;
  const argv = bash ? [bash, "-o", "pipefail", "-c", acceptance] : ["sh", "-c", `${pipefail ? "set -o pipefail; " : ""}${acceptance}`];
  const r = await execProcess({ argv, cwd: repo, env, timeoutMs });
  const tail = `${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-TAIL_LINES).join("\n");
  return { files, acceptance: { cmd: acceptance, passed: r.code === 0 && !r.timedOut, tail } };
}
