import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useStrategy } from "../src/config/strategy";
import { remove, show } from "../src/strategy/service";
import { fakeCtx } from "./helpers";
import fixture from "./fixtures/strategy-read/named.json";

const root = join(import.meta.dir, "..");

function seededHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pacer-strategy-write-"));
  for (const [name, contents] of Object.entries(fixture.files)) {
    const path = join(home, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  writeFileSync(join(home, "active"), fixture.active);
  return home;
}

function state(home: string) {
  const read = (name: string) => existsSync(join(home, name)) ? readFileSync(join(home, name), "utf8") : null;
  return { active: read("active"), base: read("strategy.yaml"), work: read("strategies/work.yaml"), broken: read("strategies/broken.yaml") };
}

test("strategy activation and removal match TS results, errors, and bytes on isolated homes", () => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "strategy_write_diff", "--locked"], { cwd: root });
  const binary = join(root, "target/debug/examples/strategy_write_diff");
  const cases = [
    { op: "use", name: "work" }, { op: "use", name: "default" },
    { op: "use", name: "missing" }, { op: "use", name: "broken" },
    { op: "remove", name: "work", active: "default" },
    { op: "remove", name: "work" }, { op: "remove", name: "default" },
    { op: "remove", name: "missing", active: "default" },
  ] as const;
  for (const item of cases) {
    const tsHome = seededHome(), rustHome = seededHome();
    if ("active" in item && item.active === "default") {
      useStrategy(fakeCtx({ pacerHome: tsHome }), "default");
      execFileSync(binary, [], { input: JSON.stringify({ home: rustHome, op: "use", name: "default" }) + "\n" });
    }
    let ts: { ok: boolean; value?: unknown; error?: string };
    try {
      const ctx = fakeCtx({ pacerHome: tsHome });
      const value = item.op === "use" ? (show(ctx, item.name), { name: item.name, path: useStrategy(ctx, item.name) }) : remove(ctx, item.name);
      ts = { ok: true, value };
    } catch (error) { ts = { ok: false, error: (error as Error).message }; }
    const rust = JSON.parse(execFileSync(binary, [], { input: JSON.stringify({ home: rustHome, op: item.op, name: item.name }) + "\n" }).toString());
    if (ts.ok && item.op === "use") {
      (ts.value as { path: string }).path = (ts.value as { path: string }).path.replace(tsHome, "$HOME");
      rust.value.path = rust.value.path.replace(rustHome, "$HOME");
    }
    if (item.name === "broken") {
      if (!ts.ok) ts.error = "yaml_syntax";
      if (!rust.ok) rust.error = "yaml_syntax";
    }
    expect(rust).toEqual(ts);
    expect(state(rustHome)).toEqual(state(tsHome));
  }
});
