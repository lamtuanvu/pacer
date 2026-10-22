import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CASES, runCase } from "../conformance/run";
import { assertPingReceipts, type ConformanceCase } from "../conformance/cases";

const serialization = CASES.find(c => c.name.startsWith("serialisation:"))!;
const host = [process.execPath, join(import.meta.dir, "..", "src/cli.ts")];
const homes = join(tmpdir(), "pacer-conformance", "overlap-oracle");
for (const wrong of ["force-serial-reentrant", "force-overlap-serial"] as const) {
  test(`overlap oracle refuses opposite host queue: ${wrong}`, async () => {
    const mutant: ConformanceCase = {
      ...serialization,
      async run(t) {
        try {
          await serialization.run({
            ...t,
            install(name, overrides) {
              const changed = name === (wrong === "force-serial-reentrant" ? "reentrant" : "serial");
              return t.install(name, { ...overrides, manifest: { ...overrides?.manifest,
                ...(changed ? { reentrant: wrong === "force-overlap-serial" } : {}) } });
            },
          });
        } finally {
          for (const id of ["fx-serial", "fx-reentrant"]) {
            const receipt = join(t.pluginsDir, id, "ping-receipts.jsonl");
            if (existsSync(receipt)) console.info(`CONTROL ${wrong} ${id} receipts ${readFileSync(receipt, "utf8").trim().split("\n").join(";")}`);
          }
        }
      },
    };
    let failure: unknown;
    try { await runCase(mutant, host, homes); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toMatch(wrong === "force-serial-reentrant"
      ? /fx-reentrant both measured calls finish.*plugin_timeout/
      : /event order proves the declared queue behavior/);
    console.info(`CONTROL ${wrong} expected rejection: ${message}`);
  }, 20000);
}
test("actual source host satisfies serial and reentrant causal receipts", () => runCase(serialization, host, homes), 20000);

const overlap = [
  { seq: 1, ping: 2, phase: "enter", active: 1 },
  { seq: 2, ping: 3, phase: "enter", active: 2 },
  { seq: 3, ping: 2, phase: "exit", active: 1 },
  { seq: 4, ping: 3, phase: "exit", active: 0 },
];
const text = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
test("receipt reconstruction refuses incomplete, forged and aborted ordering", () => {
  expect(() => assertPingReceipts(text(overlap), true)).not.toThrow();
  for (const mutate of [
    (rows: typeof overlap) => rows.pop(),
    (rows: typeof overlap) => rows[1]!.seq = 1,
    (rows: typeof overlap) => rows[1]!.ping = 2,
    (rows: typeof overlap) => rows[1]!.active = 1,
    (rows: typeof overlap) => rows[2]!.phase = "abort",
    (rows: typeof overlap) => rows[0]!.ping = 1,
  ]) {
    const rows = structuredClone(overlap); mutate(rows);
    expect(() => assertPingReceipts(text(rows), true)).toThrow();
  }
  expect(() => assertPingReceipts(text(overlap), false)).toThrow();
  expect(() => assertPingReceipts("x".repeat(4097), true)).toThrow();
});
