// Times the link pump and its heaviest phases over a synthetic history: `bun run perf:tick -- 5000`.
// Each round prints one line so runs on different branches can be compared side by side.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotRealInstall } from "../lib/real-install-guard";
import { snapshotTasks } from "../../src/api/read-model/tasks";
import { execProcess } from "../../src/exec/process";
import { defaultPumpDeps, pumpOnce } from "../../src/link/pump";
import { drainQueue } from "../../src/tasks/drain";
import type { Ctx, RunFn } from "../../src/types";
import { buildSyntheticHome } from "./synthetic-home";

const settled = Number(process.argv[2] ?? 5000);
const ROUNDS = 4;
const root = mkdtempSync(join(tmpdir(), "pacer-perf-tick-"));
const pacerHome = join(root, "pacer"), home = join(root, "home");
assertNotRealInstall(pacerHome, "time the pump"); assertNotRealInstall(home, "time the pump");

// Only git runs for real; no executor, login shell or other external command is reachable.
const run: RunFn = (argv, timeoutMs, o) => argv[0] === "git"
  ? execProcess({ argv, cwd: process.cwd(), env: { ...process.env, ...(o?.env ?? {}) }, timeoutMs })
  : Promise.resolve({ code: 127, stdout: "", stderr: "not available in the benchmark" });
const ctx = (): Ctx => ({ home, pacerHome, now: Date.now() / 1000, run, which: () => null,
  env: { HOME: home, PACER_HOME: pacerHome, PACER_NO_UPDATE_CHECK: "1", PACER_BACKEND: "direct", PACER_LOGIN_ENV: "off", PATH: "/usr/bin:/bin" } });
const time = async (label: string, f: () => unknown) => {
  const t0 = performance.now(); await f(); return `${label} ${Math.round(performance.now() - t0)} ms`;
};

try {
  buildSyntheticHome({ pacerHome, home, repos: [join(root, "repos", "alpha"), join(root, "repos", "beta")], settled, unsettled: 10, runDirs: "last", logBytes: 1024 * 1024 });
  await pumpOnce(ctx(), defaultPumpDeps); // first-open import and cold caches
  for (let i = 0; i < ROUNDS; i++) {
    const c = ctx(), records = await defaultPumpDeps.tasks(c);
    console.log(`round ${i}: ${[
      await time("pumpOnce", () => pumpOnce(ctx(), defaultPumpDeps)),
      await time("drainQueue", () => drainQueue(c)),
      await time("pumpTasks", () => defaultPumpDeps.tasks(c)),
      await time("snapshotTasks", () => snapshotTasks(c, records)),
    ].join(", ")}`);
    await Bun.sleep(1100);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  // The notifier plugin host stays alive after a pump tick and would keep this process open.
  process.exit(0);
}
