import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { front, type Home } from "./native-plugin-door";
import { useMatrixRoot, type Run, type Scenario, connectClaude, expectIdentical, fileText, fileTree, httpForward, httpOff, httpOn, planners, poll, replyText, runModes, storeBytes } from "./plugins-native-owner-matrix-support";

// Startup reconcile and notifier rows of the flag-on matrix.
useMatrixRoot();

const integrationLines = (stderr: string) => stderr.split("\n").filter(line => line.startsWith("pacer: integration")).join("\n");

const RECONCILE_COMMIT_MS = 60000;

/**
 * Startup reconcile commits through the install journal: it writes install-transaction.json, then the integration
 * files, then install-manifest.json, and removes the journal last. A restored file can precede its manifest record.
 * Call after a file the commit writes has appeared, so an absent journal means the commit has finished.
 * The whole path runs after a fresh front-door start that boots its bundled core, so keep 60s: a single
 * mode here can sit at or past 20s on a loaded runner before the manifest changes.
 */
async function reconcileCommitted(h: Home, manifestBefore: string) {
  const journal = join(h.state, "install-transaction.json"), manifest = join(h.state, "install-manifest.json");
  const committed = () => !existsSync(journal) && existsSync(manifest) && readFileSync(manifest, "utf8") !== manifestBefore;
  const deadline = Date.now() + RECONCILE_COMMIT_MS;
  while (!committed()) {
    if (Date.now() > deadline) {
      throw Error(`startup reconcile restored a file but did not commit install-manifest.json within ${RECONCILE_COMMIT_MS} ms`
        + `\njournal: ${existsSync(journal) ? "present" : "absent"}\nmanifest:\n${storeBytes(h, "install-manifest.json")}`);
    }
    await Bun.sleep(100);
  }
}

const startupReconcile: Scenario = async (door, h, observe, restart) => {
  observe("agent.connect", replyText(h, await connectClaude(door)));
  observe("manifest after connect", storeBytes(h, "install-manifest.json"));
  observe("agent.connect again", replyText(h, await connectClaude(door)));
  observe("manifest after reconnect", storeBytes(h, "install-manifest.json"));
  const reconnected = readFileSync(join(h.state, "install-manifest.json"), "utf8");
  await restart(() => unlinkSync(join(h.home, ".claude", "rules", "pacer.md")));
  observe("restored rules file", await poll(async () => fileText(h, ".claude/rules/pacer.md"), text => text !== "<absent>", 60000));
  await reconcileCommitted(h, reconnected);
  observe("integration files after refresh", fileTree(h, ".claude"));
  observe("manifest after refresh", storeBytes(h, "install-manifest.json"));
  await restart(() => writeFileSync(join(h.home, ".claude", "skills", "pacer", "SKILL.md"), "edited by hand\n"));
  observe("conflict warning", await poll(async () => integrationLines(door.stderr()), text => text !== "", 60000));
  observe("integration files after conflict", fileTree(h, ".claude"));
};

let reconcileMemo: Promise<Run[]> | undefined;
const reconcileRuns = () => reconcileMemo ??= runModes("reconcile", [httpOff, httpOn, httpForward], startupReconcile, ["install-manifest.json"]);

test.skipIf(!front)("startup reconcile refreshes a deleted integration file and reports a hand-edited one", async () => {
  const runs = await reconcileRuns();
  for (const run of runs) expect(run.observed["restored rules file"], run.mode.label).not.toBe("<absent>");
  for (const run of runs) expect(run.observed["conflict warning"], run.mode.label).toContain("managed integration content changed");
  const refreshed = JSON.parse(runs[0]!.observed["manifest after refresh"]!).planners?.["claude-code"];
  expect(refreshed?.integration?.fingerprint ?? "<missing>", `${runs[0]!.mode.label}: startup reconcile records its refresh in install-manifest.json`).toMatch(/^[0-9a-f]{64}$/);
  console.log(expectIdentical(runs).join("\n"));
}, 240000);

test.skipIf(!front)("flag-on planner reconnect and refresh keep install-manifest.json key order", async () => {
  const runs = await reconcileRuns();
  const [off, on] = runs;
  for (const key of ["manifest after reconnect", "manifest after refresh", "install-manifest.json"]) expect(on!.observed[key], key).toBe(off!.observed[key]);
}, 240000);

/** The delivery ledger keys each attention item by id and since; delivery times are the clock's. */
function ledgerKeys(h: Home) {
  const path = join(h.state, "state", "notified.json");
  if (!existsSync(path)) return "<absent>";
  return Object.keys(JSON.parse(readFileSync(path, "utf8"))).map(key => key.replace(/:[\d.]+$/, ":<clock>")).sort().join("\n");
}

const notifier: Scenario = async (_door, h, observe) => {
  const delivered = await poll(async () => fileText(h, "notify.log"), text => text !== "<absent>", 20000);
  await Bun.sleep(2000);
  observe("notifier first delivery", delivered === "<absent>" ? delivered : "delivered");
  observe("notifier argv", fileText(h, "notify.log").split("\n").filter(Boolean).sort().join("\n"));
  observe("notified ledger", ledgerKeys(h));
};

test.skipIf(!front)("notifier: serve delivers attention through pacer-notify's sealed OS command", async () => {
  const runs = await runModes("notifier", [httpOff, httpOn, httpForward], notifier);
  for (const run of runs) expect(run.observed["notifier first delivery"], run.mode.label).toBe("delivered");
  console.log(expectIdentical(runs).join("\n"));
}, 240000);
