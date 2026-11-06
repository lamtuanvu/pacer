import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const TARGET = join(ROOT, "target");

type Amend = { kind: string | null; requestedExecutor: string | null; placement: "auto" | "current" | "new" };

function mapPolicyAmendment(input: Record<string, unknown>, amend: Amend) {
  const policyKind =
    (input.dispatch as { kind?: string | null } | undefined)?.kind ?? (input.kind as string | null | undefined) ?? null;
  const changed = amend.kind !== policyKind;
  return {
    ...input,
    kind: changed ? amend.kind : input.kind,
    executor: amend.requestedExecutor,
    worktree: amend.placement,
    ...(input.dispatch && changed
      ? { dispatch: { ...(input.dispatch as object), kind: amend.kind ?? undefined } }
      : {}),
  };
}

function rustProbe(command: string, ...args: string[]) {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-lifecycle", "--bin", "prepared_admission_probe"], {
    cwd: ROOT,
    env: { ...process.env, CARGO_TARGET_DIR: TARGET },
  });
  const probe = join(TARGET, "debug", "prepared_admission_probe");
  return JSON.parse(execFileSync(probe, [command, ...args], { encoding: "utf8" })) as unknown;
}

const goldens = JSON.parse(
  readFileSync(new URL("./fixtures/task-admission/prepared-admission-goldens.json", import.meta.url), "utf8"),
) as Array<{
  id: string;
  input?: Record<string, unknown>;
  amend?: Amend;
  mapped?: Record<string, unknown>;
  brief?: { goal: string; repo: string; executor?: string };
  strategy?: unknown;
  accept?: boolean;
  error?: string;
}>;

for (const row of goldens.filter(r => r.amend)) {
  test(`map policy amendment golden: ${row.id}`, () => {
    const ts = mapPolicyAmendment(row.input!, row.amend!);
    const rust = rustProbe("map", JSON.stringify(row.input), JSON.stringify(row.amend));
    expect(rust).toEqual(ts);
    expect(rust).toEqual(row.mapped);
  });
}

for (const row of goldens.filter(r => r.strategy)) {
  test(`prepare delegate admission golden: ${row.id}`, () => {
    const repo = mkdtempSync(join(tmpdir(), "pacer-prepared-"));
    mkdirSync(join(repo, "repo"), { recursive: true });
    const repoPath = join(repo, "repo");
    const brief = { ...row.brief!, repo: repoPath };
    if (row.accept) {
      const out = rustProbe("prepare", repoPath, JSON.stringify(brief), JSON.stringify(row.strategy)) as {
        brief: { goal: string; repo: string };
      };
      expect(out.brief.goal).toBe(brief.goal);
    } else {
      expect(() =>
        execFileSync(
          join(TARGET, "debug", "prepared_admission_probe"),
          ["prepare", repoPath, JSON.stringify(brief), JSON.stringify(row.strategy)],
          { encoding: "utf8" },
        ),
      ).toThrow();
    }
  });
}
