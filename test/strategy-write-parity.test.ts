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

function strategyBinary(): string {
  execFileSync("cargo", ["build", "-q", "-p", "pacer-config", "--example", "strategy_write_diff", "--locked"], { cwd: root });
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--locked", "--format-version", "1"], { cwd: root }).toString());
  return join(metadata.target_directory, "debug/examples/strategy_write_diff");
}

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
  const binary = strategyBinary();
  const cases: { op: "use" | "remove"; name: string; active?: string | null; yaml?: string; errorKind?: "syntax" | "validation"; staleTemp?: boolean }[] = [
    { op: "use", name: "work" }, { op: "use", name: "work", staleTemp: true }, { op: "use", name: "default" },
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
  let seed = 0x568e6f5;
  const pick = <T>(items: readonly T[]): T => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return items[(seed >>> 0) % items.length]!;
  };
  for (let i = 0; i < 128; i++) {
    cases.push({
      op: pick(["use", "remove"] as const),
      name: pick(["work", "default", "missing", "broken", "a", "a-b", "Bad", "", "é"]),
      active: pick([undefined, null, "work", "default", "ghost", "broken"]),
      ...(i % 7 === 0 ? { yaml: fixture.files["strategies/work.yaml"] } : {}),
    });
  }
  for (const item of cases) {
    const tsHome = seededHome(), rustHome = seededHome();
    chmodSync(tsHome, 0o755);
    chmodSync(rustHome, 0o755);
    chmodSync(join(tsHome, "active"), 0o644);
    chmodSync(join(rustHome, "active"), 0o644);
    if (item.yaml) {
      for (const home of [tsHome, rustHome]) writeFileSync(join(home, "strategies", `${item.name}.yaml`), item.yaml);
    }
    if (item.staleTemp) writeFileSync(join(tsHome, "active.stale.0.tmp"), "stale\n");
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
    const input = JSON.stringify({ home: rustHome, op: item.op, name: item.name }) + "\n";
    const rustOutput = item.staleTemp
      ? execFileSync("sh", ["-c", 'printf "stale\\n" > "$2/active.$$.0.tmp"; exec "$1"', "sh", binary, rustHome], { input })
      : execFileSync(binary, [], { input });
    const rust = JSON.parse(rustOutput.toString());
    if (ts.ok) expect(rust.ok).toBe(true);
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
    if (item.name === "broken" && item.op === "use" && !ts.ok && !rust.ok
      && ts.error?.includes("YAML Parse error") && rust.error?.includes("YAML syntax error")) {
      ts.error = rust.error = "yaml_syntax";
    }
    if (item.active === "broken" && !ts.ok && !rust.ok
      && ts.error?.includes("YAML syntax error") && rust.error?.includes("YAML syntax error")) {
      ts.error = rust.error = "current_active_syntax";
    }
    if (ts.error) ts.error = ts.error.replaceAll(tsHome, "$HOME");
    if (rust.error) rust.error = rust.error.replaceAll(rustHome, "$HOME");
    expect(rust).toEqual(ts);
    expect(state(rustHome)).toEqual(state(tsHome));
    if (item.staleTemp) {
      const stale = readdirSync(rustHome).find(name => /^active\.\d+\.0\.tmp$/.test(name));
      expect(stale).toBeDefined();
      expect(readFileSync(join(rustHome, stale!), "utf8")).toBe("stale\n");
      expect(readFileSync(join(tsHome, "active.stale.0.tmp"), "utf8")).toBe("stale\n");
    }
  }
}, 120_000);

test("TS strategy activation retains its existing write behavior", () => {
  for (const mask of [0o022, 0o077]) {
    const previous = process.umask(mask);
    try {
      const home = seededHome();
      chmodSync(home, 0o755);
      chmodSync(join(home, "active"), 0o644);
      const previousInode = statSync(join(home, "active")).ino;
      useStrategy(fakeCtx({ pacerHome: home }), "work");
      expect(statSync(home).mode & 0o777).toBe(0o755);
      expect(statSync(join(home, "active")).mode & 0o777).toBe(0o644);
      expect(statSync(join(home, "active")).ino).toBe(previousInode);
      expect(readdirSync(home).filter(name => /^active\..*\.tmp$/.test(name))).toEqual([]);
      rmSync(home, { recursive: true, force: true });
    } finally {
      process.umask(previous);
    }
  }
});
