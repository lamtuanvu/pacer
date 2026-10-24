import { expect, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { probeAgentSession } from "../src/session/agent-probe";
import { capabilities } from "../plugins/agent-session";

const codexHelp = "--config --cd --sandbox --add-dir --model --image --dangerously-bypass-hook-trust --no-daemon";
test("a newer compatible CLI is supported using its actual account environment", async () => {
  const seen: unknown[] = [];
  const env = {CODEX_HOME: "/tmp/account", PATH: "/tmp/bin"};
  const ctx = fakeCtx({run: async (argv, _timeout, options) => {
    seen.push(options?.env);
    return {code: 0, stdout: argv[1] === "--version" ? "codex-cli 0.164.0" : codexHelp, stderr: ""};
  }});
  const probe = await probeAgentSession(ctx, "codex", env);
  expect(probe).toMatchObject({agent: "codex", version: "0.164.0"});
  expect(capabilities(probe).interactive).toBe(true);
  expect(seen).toHaveLength(3);
  expect(seen.every(value => value === env)).toBe(true);
});
for (const failed of ["--version", "--help", "resume"]) {
  test(`failed ${failed} probe refuses launch with an actionable reason`, async () => {
    const ctx = fakeCtx({run: async argv => argv[1] === failed
      ? {code: 127, stdout: "", stderr: "secret must not leak"}
      : {code: 0, stdout: argv[1] === "--version" ? "codex-cli 0.164.0" : codexHelp, stderr: ""}});
    const probe = await probeAgentSession(ctx, "codex", {});
    expect(probe.reason).toContain("codex");
    expect(probe.reason).toContain("probe");
    expect(JSON.stringify(probe)).not.toContain("secret must not leak");
  });
}
test("an unparseable version is allowed when the actual interface is compatible", async () => {
  const probe = await probeAgentSession(fakeCtx({run: async argv => ({code: 0, stdout: argv[1] === "--version" ? "custom build" : codexHelp, stderr: ""})}), "codex", {});
  expect(probe.version).toBe("unknown");
  expect(probe.reason).toBeUndefined();
  expect(capabilities(probe).interactive).toBe(true);
});
test("spawn errors and empty help become explicit unavailability", async () => {
  const probe = await probeAgentSession(fakeCtx({run: async () => {throw Error("ENOENT secret");}}), "claude-code", {});
  expect(probe.reason).toContain("probe");
  expect(probe.reason).not.toContain("secret");
  const empty = await probeAgentSession(fakeCtx({run: async () => ({code: 0, stdout: "", stderr: ""})}), "opencode", {});
  expect(empty.reason).toContain("probe");
});
