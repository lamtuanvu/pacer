import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertPingReceipts, type ConformanceCase } from "../conformance/cases";
import { CASES, runCase } from "../conformance/run";
import { conformanceRoot, cases, doctor, doors, listed } from "./plugin-conformance-native-owner-support";

// A representative conformance subset against the Rust front door with the native process owner,
// over a self-owned `api --stdio` connection and over a flag-on `serve`. The full CASES list stays
// on the TypeScript host (plugin-conformance.test.ts).

const root = conformanceRoot();

const PID_NULL = "known: flag-on plugin.doctor reports pid null for owner-supervised children (ADR 0027, ledger row 22)";

/** Subset of CASES, by name, with the reason a case is expected to fail on the owner doors. */
const SUBSET: Record<string, string | null> = {
  "lazy start: list starts nothing, doctor starts the process": PID_NULL,
  "capability denial: undeclared calls are refused, declared ones answer": null,
  "serialisation: one call at a time unless reentrant": PID_NULL,
  "logs: stderr lands in the plugin log file, never on stdout": null,
  "shutdown: closing the host terminates its plugins": null,
  "observations: task callback task reads work without public subscribe": null,
  "observations: activity callback task reads work without public subscribe": null,
};
const subset = CASES.filter(c => Object.hasOwn(SUBSET, c.name));
test("the native owner subset names existing conformance cases", () => expect(subset.map(c => c.name).sort()).toEqual(Object.keys(SUBSET).sort()));

/**
 * The two PID_NULL cases with every pid check replaced by what the owner reports instead, and the
 * observations cases' bootstrap call on its own.
 */
const OWNER_VARIANTS: (ConformanceCase & { reason?: string | null })[] = [
  { name: "lazy start without pids: list starts nothing, doctor makes the plugin ready", async run(t) {
    t.install("good");
    const h = await t.host();
    await h.call("plugin.enable", { id: "fx-good", grant: true });
    assert((await listed(h)).find(p => p.id === "fx-good")?.state === "idle", "the plugin is idle before the first call");
    const r = await doctor(h, "fx-good");
    assert(r.ok && r.pid === null, `doctor starts the plugin; the owner's pid is not reported (got ${JSON.stringify(r)})`);
    assert((await listed(h)).find(p => p.id === "fx-good")?.state === "ready", "the plugin is ready after the first call");
  } },
  ...([["fx-serial", "serial"], ["fx-reentrant", "barrier"]] as const).map(([id, probe]): ConformanceCase => ({
    name: `serialisation without pids: ${id} ${probe === "serial" ? "runs one call at a time" : "overlaps two calls"}`, async run(t) {
      t.install(id === "fx-serial" ? "serial" : "reentrant", { fixture: { pingProbe: probe, ...(probe === "barrier" ? { barrierTimeoutMs: 3000 } : {}) } });
      const h = await t.host();
      await h.call("plugin.enable", { id, grant: true });
      assert((await doctor(h, id)).ok, `${id} warmup succeeds`);
      const reports = await Promise.all([doctor(h, id), doctor(h, id)]);
      if (probe === "barrier") {
        const peak = Math.max(...readFileSync(join(t.pluginsDir, id, "ping-receipts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).active as number));
        assert(peak === 2, `${id} overlaps the two calls (receipts peak at ${peak} active; errors: ${reports.map(report => report.error).join()})`);
      }
      assert(reports.every(report => report.ok), `${id} both measured calls finish (got ${reports.map(report => report.error).join()})`);
      // The receipts are the measured event order; the plugin log lines are covered by the logs case.
      assertPingReceipts(readFileSync(join(t.pluginsDir, id, "ping-receipts.jsonl"), "utf8"), probe === "barrier");
    },
  })),
  { name: "observation bootstrap: plugin.doctor answers the sealed observation call", async run(t) {
    t.install("observations");
    writeFileSync(join(t.home, ".pacer", "strategy.yaml"), "planner: claude-code\nproviders: {claude-code: {}}\nplugins:\n  config:\n    fx-observations:\n      types: [task]\n");
    const h = await t.host({ subscribe: false });
    await h.call("plugin.enable", { id: "fx-observations", grant: true });
    const r = await doctor(h, "fx-observations");
    assert(r.ok, `the owner answers the observation bootstrap (got ${r.error})`);
  } },
];

for (const { label, argv, door } of doors) {
  for (const c of subset) {
    const reason = SUBSET[c.name]!;
    cases(reason)(`native owner conformance (${label}): ${c.name}${reason ? ` [${reason.split(":")[0]}]` : ""}`, () => runCase(c, argv, root, door), 60000);
  }
  for (const c of OWNER_VARIANTS) {
    cases(c.reason ?? null)(`native owner conformance (${label}): ${c.name}${c.reason ? ` [${c.reason.split(":")[0]}]` : ""}`, () => runCase(c, argv, root, door), 60000);
  }
}
