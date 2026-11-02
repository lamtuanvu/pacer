/** Fixed actual-handler exercise; the isolated stream child never executes SSH. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, healthy, record, type Session } from "./core";
import { createFixtureHome, settingsFixtureRoot } from "./settings";

interface FrameResult {
  cases: { name: string; passed: boolean; cleanup: boolean; bytes?: number; sha256?: string; rejection?: string }[];
  failed: number;
  childProcess: string;
  stageSourceSha256: string;
}

/** A fresh private child only; no existing state or caller program is accepted. */
export async function exerciseBundleFrameHome(home: string): Promise<FrameResult> {
  createFixtureHome(home);
  writeFileSync(join(home, ".bundle-frame-fixture"), "fixed bundle-stage fixture\n", { flag: "wx", mode: 0o600 });
  const fixture = join(checkout, "test/fixtures/bundle-frame.ts");
  const child = Bun.spawn([process.execPath, fixture], {
    env: { HOME: home, PACER_HOME: home }, stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  writeFileSync(join(home, "stdout.json"), stdout, { flag: "wx", mode: 0o600 });
  writeFileSync(join(home, "stderr.log"), stderr, { flag: "wx", mode: 0o600 });
  if (code !== 0 || stderr) throw Error("Fixed bundle framing child failed; evidence retained");
  const result = JSON.parse(stdout) as FrameResult;
  const stageSourceSha256 = createHash("sha256").update(readFileSync(join(checkout, "src/plugins/bundle-stage.ts"))).digest("hex");
  if (result.failed !== 0 || result.childProcess !== "simulated-no-pid" || result.stageSourceSha256 !== stageSourceSha256 ||
    !Array.isArray(result.cases) || result.cases.length !== 28 || result.cases.some(row => row.passed !== true || row.cleanup !== true))
    throw Error("Fixed bundle framing results did not verify");
  writeFileSync(join(home, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(join(home, "sources.json"), `${JSON.stringify({
    stageSourceSha256, fixtureSha256: createHash("sha256").update(readFileSync(fixture)).digest("hex"),
    harnessSha256: createHash("sha256").update(readFileSync(import.meta.path)).digest("hex"),
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result;
}

export async function exerciseBundleFrame(session: Session): Promise<void> {
  settingsFixtureRoot(session);
  if (!await healthy(session)) throw Error("Bundle framing fixture requires a healthy guarded sandbox");
  try {
    const result = await exerciseBundleFrameHome(join(session.root, "home", "bundle-frame-fixture"));
    for (const row of result.cases) {
      record(session, { kind: "note", behavior: `Bundle frame ${row.name}`, surface: "guarded TS bundle-stage fixture", verdict: "PASS",
        text: `Actual issue/prepare/stage/ownership/cleanup with deterministic byte chunks and no child PID; ${row.rejection ? `expected ${row.rejection}` : `${row.bytes} payload bytes, SHA256 ${row.sha256}`}. Source and schedule evidence retained in home/bundle-frame-fixture.` });
    }
    record(session, { kind: "note", behavior: "Remote SSH bundle transfer through public CLI/API", surface: "CLI/API over real SSH", verdict: "UNVERIFIED",
      text: "This fixed handler fixture uses simulated stream events; no SSH command, remote host or executor ran. Public remote integration was not exercised." });
    record(session, { kind: "note", behavior: "Remote bundle presentation in clients", surface: "TUI, web/tray and desktop", verdict: "UNVERIFIED",
      text: "No presentation code changed; these clients were not exercised for this byte-framing correction." });
  } catch (error) {
    record(session, { kind: "note", behavior: "Fixed bundle framing", surface: "guarded TS bundle-stage fixture", verdict: "FAIL",
      text: "Fixed actual-handler fixture failed; its home and raw output are retained." });
    throw error;
  }
}
