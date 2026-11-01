import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  const mode = (name: string) => existsSync(join(home, name)) ? statSync(join(home, name)).mode & 0o777 : null;
  return { active: read("active"), base: read("strategy.yaml"), work: read("strategies/work.yaml"), broken: read("strategies/broken.yaml"), homeMode: mode("."), activeMode: mode("active") };
}

test("strategy activation and removal match TS results, errors, bytes, and modes on isolated homes", () => {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "strategy_write_diff", "--locked"], { cwd: root });
  const binary = join(root, "target/debug/examples/strategy_write_diff");
  const cases: { op: "use" | "remove"; name: string; active?: string | null; yaml?: string; errorKind?: "syntax" | "validation" }[] = [
    { op: "use", name: "work" }, { op: "use", name: "default" },
    { op: "use", name: "missing" }, { op: "use", name: "broken", errorKind: "syntax" },
    { op: "use", name: "invalid", yaml: "planner: invalid\nproviders:\n  codex: {}\n", errorKind: "validation" },
    { op: "use", name: "a", yaml: fixture.files["strategies/work.yaml"] },
    { op: "use", name: "0", yaml: fixture.files["strategies/work.yaml"] },
    { op: "use", name: "a-b", yaml: fixture.files["strategies/work.yaml"] },
    { op: "use", name: "a".repeat(39), yaml: fixture.files["strategies/work.yaml"] },
    { op: "use", name: "a".repeat(40), yaml: fixture.files["strategies/work.yaml"] },
    { op: "use", name: "" }, { op: "use", name: "a".repeat(41) }, { op: "use", name: "Bad" },
    { op: "use", name: "-bad" }, { op: "use", name: "bad_name" },
    { op: "use", name: "é" }, { op: "use", name: "a/b" },
    { op: "use", name: "work", active: null },
    { op: "use", name: "work", active: "ghost" },
    { op: "use", name: "work", active: "broken" },
    { op: "remove", name: "work", active: "default" },
    { op: "remove", name: "work" }, { op: "remove", name: "default" },
    { op: "remove", name: "missing", active: "default" },
    { op: "remove", name: "" }, { op: "remove", name: "a".repeat(41) }, { op: "remove", name: "Bad" },
    { op: "remove", name: "-bad" }, { op: "remove", name: "bad_name" },
    { op: "remove", name: "é" }, { op: "remove", name: "a/b" },
    { op: "remove", name: "work", active: null },
    { op: "remove", name: "work", active: "ghost" },
    { op: "remove", name: "work", active: "broken" },
  ];
  for (const item of cases) {
    const tsHome = seededHome(), rustHome = seededHome();
    chmodSync(tsHome, 0o755);
    chmodSync(rustHome, 0o755);
    chmodSync(join(tsHome, "active"), 0o644);
    chmodSync(join(rustHome, "active"), 0o644);
    if (item.yaml) {
      for (const home of [tsHome, rustHome]) writeFileSync(join(home, "strategies", `${item.name}.yaml`), item.yaml);
    }
    if (item.active === "default") {
      useStrategy(fakeCtx({ pacerHome: tsHome }), "default");
      execFileSync(binary, [], { input: JSON.stringify({ home: rustHome, op: "use", name: "default" }) + "\n" });
    } else if (item.active === null) {
      for (const home of [tsHome, rustHome]) rmSync(join(home, "active"));
    } else if (item.active) {
      for (const home of [tsHome, rustHome]) writeFileSync(join(home, "active"), `${item.active}\n`);
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
    if (item.errorKind === "syntax" || item.errorKind === "validation") {
      expect(ts.ok).toBe(false);
      expect(rust.ok).toBe(false);
      expect(ts.error).toMatch(item.errorKind === "syntax" ? /YAML Parse error/ : /planner must be/);
      expect(rust.error).toMatch(item.errorKind === "syntax" ? /YAML syntax error/ : /planner must be/);
      ts.error = rust.error = item.errorKind;
    }
    if (item.active === "broken" && !ts.ok && !rust.ok) {
      expect(ts.error).toContain("YAML syntax error");
      expect(rust.error).toContain("YAML syntax error");
      ts.error = rust.error = "current_active_syntax";
    }
    if (ts.error) ts.error = ts.error.replaceAll(tsHome, "$HOME");
    if (rust.error) rust.error = rust.error.replaceAll(rustHome, "$HOME");
    expect(rust).toEqual(ts);
    expect(state(rustHome)).toEqual(state(tsHome));
  }
}, 120_000);

test("strategy activation tightens existing modes under both common umasks", () => {
  for (const mask of [0o022, 0o077]) {
    const previous = process.umask(mask);
    try {
      const home = seededHome();
      chmodSync(home, 0o755);
      chmodSync(join(home, "active"), 0o644);
      const previousInode = statSync(join(home, "active")).ino;
      useStrategy(fakeCtx({ pacerHome: home }), "work");
      expect(statSync(home).mode & 0o777).toBe(0o700);
      expect(statSync(join(home, "active")).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, "active")).ino).not.toBe(previousInode);
      expect(readdirSync(home).filter(name => /^active\..*\.tmp$/.test(name))).toEqual([]);
      rmSync(home, { recursive: true, force: true });
    } finally {
      process.umask(previous);
    }
  }
});
