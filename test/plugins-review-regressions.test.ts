import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StrategyDoc } from "../src/config/edit";
import { createPublisherTrust } from "../src/plugins/publishers";
import { tmpDir } from "./helpers";
import strategies from "./fixtures/plugin-strategy-byte-parity.json";
import publishers from "./fixtures/plugin-publisher-store-parity.json";

test("strategy byte corpus matches the TypeScript source span editor", () => {
  for (const row of strategies) {
    const doc = new StrategyDoc(row.before);
    if (row.op === "enable") doc.setIn(["plugins", "installed", "fx-ui"], row.grant);
    else if (row.op === "disable") doc.setIn(["plugins", "disabled"], row.disabled);
    else {
      doc.setIn(["plugins", "disabled"], row.disabled);
      doc.deleteIn(["plugins", "installed", "fx-ui"]);
    }
    expect(doc.toString(), row.name).toBe(row.after);
  }
});

test("publisher decoding errors match the shared raw byte matrix", () => {
  for (const row of publishers) {
    const pacerHome = realpathSync(tmpDir());
    mkdirSync(join(pacerHome, "plugins"), { mode: 0o700 });
    const file = join(pacerHome, "plugins/publishers.json");
    writeFileSync(file, Buffer.from(row.base64, "base64"), { mode: 0o600 });
    chmodSync(file, 0o600);
    let error: { code: string; message: string } | null = null;
    try { createPublisherTrust({}).lookup({ pacerHome } as any, "Fixture"); }
    catch (e) { const err = e as { code: string; message: string }; error = { code: err.code, message: err.message }; }
    expect(error, row.name).toEqual(row.error);
    expect(readFileSync(file).toString("base64")).toBe(row.base64);
  }
});
