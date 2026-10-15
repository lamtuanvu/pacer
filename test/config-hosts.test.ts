import { expect, test } from "bun:test";
import { repoKey } from "../src/config/hosts";
import { validateStrategy } from "../src/config/strategy";

const base = (extra: Record<string, unknown>) => ({ accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, team: { kind: "codex", home: "~/.codex-team" } }, planner: "claude-code", ...extra });
const errs = (raw: unknown) => { try { validateStrategy(raw, "t"); return []; } catch (e) { return String((e as Error).message).split("\n"); } };

test("repoKey canonicalises ssh, https and ssh:// URLs", () => {
  expect(repoKey("git@github.com:LamTuanVu/Pacer.git")).toBe("github.com/lamtuanvu/pacer");
  expect(repoKey("https://github.com/lamtuanvu/pacer")).toBe("github.com/lamtuanvu/pacer");
  expect(repoKey("ssh://git@git.example.com:2222/a/b.git")).toBe("git.example.com/a/b");
  expect(repoKey("/local/path")).toBeNull();
});

test("a declared host makes @alias runners valid, with defaults", () => {
  const s = validateStrategy(base({ hosts: { box: { ssh: "box-ssh", repos: { "github.com/o/r": "~/src/r" }, accounts: { team: { home: "~/.codex-team" } } } }, routing: [{ default: ["codex@box", "codex#team@box", "codex"] }] }), "t");
  expect(s.hosts.box).toMatchObject({ alias: "box", ssh: "box-ssh", maxTasks: 2, repos: { "github.com/o/r": "~/src/r" } });
  expect(Object.keys(s.runners)).toEqual(expect.arrayContaining(["codex@box", "codex#team@box"]));
});

test("@local is the local runner", () => {
  const s = validateStrategy(base({ routing: [{ default: ["codex@local"] }] }), "t");
  expect(Object.keys(s.runners)).toContain("codex");
  expect(Object.keys(s.runners).some((id) => id.includes("@"))).toBe(false);
});

test("host and remote runner validation messages", () => {
  expect(errs(base({ routing: [{ default: ["codex@nowhere"] }] })).join("\n")).toContain("unknown host nowhere");
  expect(errs(base({ hosts: { local: { ssh: "x" } } })).join("\n")).toContain('"local" is reserved');
  expect(errs(base({ hosts: { box: { ssh: "-oProxyCommand=x" } } })).join("\n")).toContain("hosts.box.ssh must be an ssh alias");
  expect(errs(base({ hosts: { box: { ssh: "b", max_tasks: 0 } } })).join("\n")).toContain("max_tasks must be 1..16");
  expect(errs(base({ hosts: { box: { ssh: "b", repos: { "pacer": "~/p" } } } })).join("\n")).toContain("not a canonical repo key");
  expect(errs(base({ hosts: { box: { ssh: "b", extra: 1 } } })).join("\n")).toContain("unknown key extra");
  expect(errs(base({ hosts: { box: { ssh: "b" } }, accounts: { claude: { kind: "claude" }, codex: { kind: "codex" }, cursor: { kind: "cursor" } }, routing: [{ default: ["cursor@box"] }] })).join("\n")).toContain("remote runners support codex and claude-code");
  expect(errs(base({ hosts: { box: { ssh: "b" } }, routing: [{ default: ["codex#team@box"] }] })).join("\n")).toContain("needs hosts.box.accounts.team.home");
  expect(errs(base({ hosts: { box: { ssh: "b" } }, planner: "claude-code@box" })).join("\n")).toContain("the planner can't run on a host");
});

test("hosts reject malformed mappings, nested unknown keys and invalid values", () => {
  for (const hosts of [null, [], "box", { Box: { ssh: "b", repos: {} } }, { box: null },
    { box: { ssh: "b", repos: [] } }, { box: { ssh: "b", repos: { "github.com/o/r": "" } } },
    { box: { ssh: "b", repos: { "GitHub.com/O/R.git": "~/r" } } },
    { box: { ssh: "b", repos: {}, max_tasks: 1.5 } },
    { box: { ssh: "b", repos: {}, accounts: { team: { home: "~/team", extra: true } } } },
    { box: { ssh: "b", repos: {}, accounts: { team: {} } } }]) {
    expect(errs(base({ hosts })).length).toBeGreaterThan(0);
  }
  expect(validateStrategy(base({}), "t").hosts).toEqual({});
});

test("pacing ids and explicit declarations preserve and validate remote identity", () => {
  const hosts = { box: { ssh: "b", repos: {}, accounts: { team: { home: "~/team" } } } };
  const s = validateStrategy(base({ hosts, runners: { "codex#team@box": { agent: "codex", account: "team" } }, pacing: { order: ["codex#team@box"] } }), "t");
  expect(s.runners["codex#team@box"].host).toBe("box");
  expect(s.providers["codex#team@box"].id).toBe("codex#team@box");
  expect(errs(base({ pacing: { order: ["codex@nowhere"] } })).join("\n")).toContain("runner codex@nowhere: unknown host nowhere (hosts: none)");
  expect(errs(base({ hosts, pacing: { order: ["codex@other"] } })).join("\n")).toContain("unknown host other (hosts: box)");
});

test("remote status does not require the agent binary installed locally", async () => {
  const { computeStatus } = await import("../src/engine/status");
  const { fakeCtx } = await import("./helpers");
  const s = validateStrategy(base({ hosts: { box: { ssh: "b", repos: {} } }, routing: [{ default: ["codex@box", "codex"] }] }), "t");
  const status = await computeStatus(fakeCtx({ which: () => null }), s, { profile: null });
  expect(status.providers.find(p => p.id === "codex@box")?.installed).toBe(true);
  expect(status.providers.find(p => p.id === "codex")?.installed).toBe(false);
});

test("a remote planner declaration cannot lose its host through an alias", () => {
  const raw = base({ hosts: { box: { ssh: "b", repos: {} } }, planner: "claude-code@box", runners: { "claude-code@box": { agent: "claude-code", account: "claude" } } });
  expect(errs(raw).join("\n")).toContain("the planner can't run on a host");
});

test("a host with only ssh is valid; repos are optional", () => {
  const s = validateStrategy(base({ hosts: { box: { ssh: "box-ssh" } }, routing: [{ default: ["codex@box"] }] }), "t");
  expect(s.hosts.box).toMatchObject({ ssh: "box-ssh", repos: {}, maxTasks: 2, accounts: {} });
});
