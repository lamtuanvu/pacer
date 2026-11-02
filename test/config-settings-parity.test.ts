import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx } from "./helpers";
import * as config from "../src/core/config";
import { toApiError } from "../src/api/protocol";

const fixturePath = join(import.meta.dir, "fixtures/config-settings/settings.json");
test("all pure config settings match shared Rust parity corpus", async () => {
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const cases = fixture.cases;
  for (const c of cases) {
    const ctx = fakeCtx();
    mkdirSync(ctx.pacerHome, { recursive: true });
    const path = join(ctx.pacerHome, "strategy.yaml");
    writeFileSync(path, c.before ?? fixture.base);
    const normalize = (v: unknown) => JSON.parse(JSON.stringify(v).replaceAll(path, "strategy.yaml"));
    let actual: Record<string, unknown>;
    try {
      const result = await config.set(ctx, c.key, c.input, { terminalPresetsOnly: c.presetsOnly });
      actual = { result: normalize(result) };
    } catch (e) { actual = { error: normalize(toApiError(e)) }; }
    const after = readFileSync(path, "utf8");
    if (after !== (c.before ?? fixture.base)) actual.after = after;
    try {
      const keys = normalize(config.get(ctx).keys);
      let index = fixture.views.findIndex((v: unknown) => JSON.stringify(v) === JSON.stringify(keys));
      if (index === -1 && process.env.UPDATE_CONFIG_SETTINGS === "1") index = fixture.views.push(keys) - 1;
      actual.keys = index;
    }
    catch (e) { actual.getError = normalize(toApiError(e)); }
    if (process.env.UPDATE_CONFIG_SETTINGS === "1") c.expected = actual;
    else expect(actual, c.name).toEqual(c.expected);
  }
  if (process.env.UPDATE_CONFIG_SETTINGS === "1") writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + "\n");
}, 120_000);
