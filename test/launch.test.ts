import { readFileSync } from "node:fs";
import { tmpDir } from "./helpers";
import { expect, test } from "bun:test";
import { validateStrategy } from "../src/config/strategy";
import { launchFor, remoteLaunch, resumeLaunchFor } from "../src/exec/launch";

const s = validateStrategy({
  planner: "opencode",
  providers: {
    "claude-code": { model: "claude-sonnet-5" }, codex: {}, cursor: { model: "sonnet-4" }, agy: {},
    byteplus: { via: "opencode", model: "coding-plan/dola-seed-2.0-code", usage: "quota", quota_source: "arkcli" },
  },
}, "/x");
const ID = "t-20261011-140500-abcd";

test("codex: prompt on stdin, last message to a file, optional model", () => {
  const l = launchFor(s.providers.codex, "PROMPT", "/repo", "/tasks", ID);
  expect(l).toEqual({
    cwd: "/repo", stdin: "PROMPT", lastMessageFile: `/tasks/${ID}.codex-last.md`,
    argv: ["codex", "exec", "-C", "/repo", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-o", `/tasks/${ID}.codex-last.md`, "-"],
  });
  const withModel = launchFor({ ...s.providers.codex, model: "gpt-6-luna" }, "P", "/repo", "/tasks", ID);
  expect(withModel.argv.slice(-3)).toEqual(["-m", "gpt-6-luna", "-"]);
});

test("cursor, agy, claude: prompt as the last argument, cwd = repo", () => {
  expect(launchFor(s.providers.cursor, "P", "/repo", "/t", ID)).toEqual({
    cwd: "/repo", argv: ["cursor-agent", "-p", "--output-format", "text", "--force", "--sandbox", "disabled", "--workspace", "/repo", "--model", "sonnet-4", "P"],
  });
  expect(launchFor(s.providers.agy, "P", "/repo", "/t", ID)).toEqual({
    cwd: "/repo", argv: ["agy", "--dangerously-skip-permissions", "--add-dir", "/repo", "-p", "P"],
  });
  expect(launchFor(s.providers["claude-code"], "P", "/repo", "/t", ID)).toEqual({
    cwd: "/repo", argv: ["claude", "-p", "--dangerously-skip-permissions", "--output-format", "text", "--model", "claude-sonnet-5", "P"],
  });
});

test("opencode-routed providers always pass --agent build and their model", () => {
  expect(launchFor(s.providers["opencode#byteplus"], "P", "/repo", "/t", ID)).toEqual({
    cwd: "/repo", argv: ["opencode", "run", "--standalone", "--agent", "build", "-m", "coding-plan/dola-seed-2.0-code", "--auto", "--title", `pacer ${ID}`, "P"],
  });
});

test("a provider with no launcher throws", () => {
  expect(() => launchFor({ ...s.providers.codex, id: "gemini" }, "P", "/repo", "/t", ID)).toThrow('no launcher for provider "gemini"');
});

for (const id of ["agy", "cursor", "claude-code", "codex", "byteplus"]) {
  test(`${id}: launch contract preserves flag/value pairing`, () => {
    const l = launchFor({ ...s.providers[id === "byteplus" ? "opencode#byteplus" : id], model: "chosen-model" }, "the prompt", "/repo", "/tasks", ID);
    const value = (flag: string) => l.argv[l.argv.indexOf(flag) + 1];
    if (id === "agy") {
      expect(value("-p")).toBe("the prompt");
      expect(value("--add-dir")).toBe("/repo");
    }
    if (id === "cursor") { expect(value("--workspace")).toBe("/repo"); expect(value("--output-format")).toBe("text"); }
    if (id === "claude-code") { expect(l.argv).toContain("--dangerously-skip-permissions"); expect(value("--output-format")).toBe("text"); }
    if (id === "codex") { expect(value("-C")).toBe("/repo"); expect(l.argv).toContain("--dangerously-bypass-approvals-and-sandbox"); expect(value("-o")).toBe(`/tasks/${ID}.codex-last.md`); expect(l.stdin).toBe("the prompt"); }
    if (id === "byteplus") { expect(value("--agent")).toBe("build"); expect(value("--title")).toBe(`pacer ${ID}`); }
    expect(value(["codex", "byteplus"].includes(id) ? "-m" : "--model")).toBe("chosen-model");
  });
}

test("runner interactive setting survives validation and rejects invalid or remote sessions", () => {
  const raw = { planner: "codex", accounts: { main: { kind: "codex" } }, runners: { codex: { session: "interactive" } } };
  const strategy = validateStrategy(raw, "/x");
  expect(strategy.runners.codex.session).toBe("interactive");
  expect(strategy.providers.codex.session).toBe("interactive");
  expect(() => validateStrategy({ ...raw, runners: { codex: { session: "screen" } } }, "/x")).toThrow("session");
});

for (const id of ["codex", "claude-code", "cursor", "agy", "opencode#byteplus"]) {
  test(`${id}: interactive launch keeps PTY stdin and omits headless switches`, () => {
    const l = launchFor({ ...s.providers[id], session: "interactive" }, "PROMPT", "/repo", "/run", ID);
    expect(l.stdin).toBeUndefined();
    expect(l.argv).not.toContain("-p");
    expect(l.argv).not.toContain("exec");
    expect(l.argv).not.toContain("run");
    expect(l.argv).not.toContain("--output-format");
    expect(l.argv.join(" ")).toContain("PROMPT");
  });
}

test("interactive Codex keeps launch environment private and permits run-local reports", () => {
  const l = launchFor({...s.providers.codex, session: "interactive"}, "P", "/repo", "/run", ID);
  expect(l.argv).toContain("--no-daemon");
  expect(l.argv[l.argv.indexOf("--add-dir") + 1]).toBe("/run");
});

test("interactive OpenCode uses a private server for endpoint credentials", () => {
  const l = launchFor({...s.providers["opencode#byteplus"], session: "interactive"}, "P", "/repo", "/run", ID);
  expect(l.argv).toContain("--standalone");
});

test("remote runner cannot opt into a local interactive PTY", () => {
  expect(() => validateStrategy({planner: "codex", accounts: {main: {kind: "codex"}}, hosts: {box: {ssh: "box"}}, runners: {"codex@box": {session: "interactive"}}}, "/x")).toThrow("interactive sessions require a local runner");
});

for (const id of ["codex", "claude-code", "cursor", "agy"]) test(`${id}: interactive prompt cannot become an option and large UTF-8 prompts use a file`, () => {
  const dir = tmpDir(), cfg = {...s.providers[id], session: "interactive" as const};
  expect(launchFor(cfg, "--help", "/repo", dir, ID).argv.slice(-2)).toEqual([id === "agy" ? "--prompt-interactive" : "--", "--help"]);
  const prompt = "界".repeat(12000), launch = launchFor(cfg, prompt, "/repo", dir, ID);
  expect(launch.argv.at(-1)!.length).toBeLessThan(1024);
  expect(launch.argv.at(-1)).toContain(`${dir}/prompt.md`);
  expect(readFileSync(`${dir}/prompt.md`, "utf8")).toBe(prompt);
});

test("Codex trusts only this invocation's worktree through a config override", () => {
  const path = '/repo/with"quote';
  const launch = launchFor({...s.providers.codex, session: "interactive"}, "P", path, "/run", ID);
  const config = launch.argv.find(arg => arg.startsWith("projects="));
  expect(Bun.TOML.parse(config!)).toEqual({projects: {[path]: {trust_level: "trusted"}}});
});

for (const [id, flags] of Object.entries({
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  "claude-code": ["--dangerously-skip-permissions"],
  cursor: ["--force", "--sandbox", "disabled"],
  agy: ["--dangerously-skip-permissions"],
  "opencode#byteplus": ["--auto"],
})) {
  for (const session of ["headless", "interactive"] as const) test(`${id} ${session} explicitly bypasses permission prompts`, () => {
    const launch = launchFor({...s.providers[id], ...(session === "interactive" ? {session} : {})}, "P", "/repo", "/run", ID);
    for (const flag of flags) expect(launch.argv).toContain(flag);
    expect(launch.argv).not.toContain("workspace-write");
    expect(launch.argv).not.toContain("acceptEdits");
    if (id === "agy") expect(launch.argv).not.toContain("--sandbox");
  });
  if (id !== "agy") test(`${id} takeover retains permission bypass`, () => {
    const launch = resumeLaunchFor(s.providers[id], "session-1", "/repo", "/run");
    for (const flag of flags) expect(launch.argv).toContain(flag);
  });
}
for (const id of ["codex", "claude-code"]) test(`${id} remote launch retains permission bypass and stdin contract`, () => {
  const cfg = {...s.providers[id], id: `${id}@box`};
  const launch = remoteLaunch(cfg, "/repo", "/run");
  expect(launch.argv).toContain(id === "codex" ? "--dangerously-bypass-approvals-and-sandbox" : "--dangerously-skip-permissions");
  expect(launch.argv).not.toContain("");
  if (id === "codex") expect(launch.lastMessageFile).toBe("/run/last.md");
});

test("Codex trust overrides preserve literal paths instead of dotted CLI keys", () => {
  const worktree = '/work.tree/with"quote', root = '/original/repo';
  const launches = [
    launchFor({...s.providers.codex, session: "interactive"}, "P", worktree, "/run", ID, undefined, root),
    resumeLaunchFor(s.providers.codex, "session-1", worktree, "/run", root),
  ];
  for (const launch of launches) {
    const config = launch.argv.find(arg => arg.startsWith("projects="));
    expect(config).toBeDefined();
    const parsed = Bun.TOML.parse(config!) as {projects: Record<string, {trust_level: string}>};
    expect(parsed.projects[worktree].trust_level).toBe("trusted");
    expect(parsed.projects[root].trust_level).toBe("trusted");
  }
});

test("interactive OpenCode uses only supported full-TUI flags", () => {
  const launch = launchFor({...s.providers["opencode#byteplus"], session:"interactive"}, "P", "/repo", "/run", ID);
  expect(launch.argv).toEqual(["opencode", "--standalone", "--auto", "--prompt", "P"]);
  expect(resumeLaunchFor(s.providers["opencode#byteplus"], "session-1", "/repo", "/run").argv)
    .toEqual(["opencode", "--standalone", "--auto", "--session", "session-1"]);
});
