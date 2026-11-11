import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const front = process.env.PACER_TEST_NATIVE_FRONT_DOOR;
const core = JSON.stringify([process.execPath, join(import.meta.dir, "fixtures/native-host-parity/core.ts")]);
const strategy = `planner: claude-code
providers: {claude-code: {}, codex: {}}
hosts:
  fixture:
    ssh: 192.0.2.1
    repos: {}
`;

async function call(home: string, forward: boolean, method: string, params: unknown) {
  const child = Bun.spawn([front!, "api", "--stdio"], {
    cwd: home, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { HOME: home, PACER_HOME: join(home, ".pacer"), PATH: process.env.PATH ?? "/usr/bin:/bin",
      PACER_CORE_ARGV: core, PACER_TEST_METHOD_LOG: join(home, "methods.log"), PACER_PORT: "1", PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1",
      PACER_DISCOVERY: "off", PACER_DEBUG_NATIVE: "1", ...(forward ? { PACER_FORWARD_OPS: "host.set" } : {}) },
  });
  try {
    writeFileSync(join(home, "methods.log"), "");
    await child.stdin.write([JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hello", params: { protocol: 3 } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method, params })].join("\n") + "\n");
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stderr).toBe(0);
    const lines = stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0].result.protocol).toBe("3.0.0");
    return { reply: lines.find(line => line.id === 2), methods: readFileSync(join(home, "methods.log"), "utf8").trim().split("\n") };
  } finally { if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; } }
}

test.skipIf(!front)("stdio host.set matches forced forwarding for writes, updates and invalid input", async () => {
  const homes = [false, true].map(() => {
    const home = mkdtempSync(join(tmpdir(), "pacer-host-parity-"));
    mkdirSync(join(home, ".pacer"));
    writeFileSync(join(home, ".pacer/strategy.yaml"), strategy);
    return home;
  });
  try {
    for (const params of [
      { alias: "fixture", max_tasks: 4, paused: true },
      { alias: "fixture", max_tasks: 0 },
      { alias: "fixture", max_tasks: 2, paused: false, session: "full" },
    ]) {
      const before = readFileSync(join(homes[0]!, ".pacer/strategy.yaml"), "utf8");
      const native = await call(homes[0]!, false, "host.set", params);
      const forwarded = await call(homes[1]!, true, "host.set", params);
      expect(native.methods).not.toContain("host.set");
      expect(forwarded.methods).toContain("host.set");
      if (params.max_tasks !== 0) expect(native.methods).toContain("_internal.native-config.finish");
      expect(native.reply).toEqual(forwarded.reply);
      if (params.max_tasks === 0) {
        expect(native.reply.error.data.code).toBe("invalid_input");
        expect(readFileSync(join(homes[0]!, ".pacer/strategy.yaml"), "utf8")).toBe(before);
      }
      else expect(native.reply.result).toMatchObject({ alias: "fixture", maxTasks: params.max_tasks, paused: params.paused });
      expect(readFileSync(join(homes[0]!, ".pacer/strategy.yaml"), "utf8"))
        .toBe(readFileSync(join(homes[1]!, ".pacer/strategy.yaml"), "utf8"));
      const nativeList = await call(homes[0]!, false, "host.list", {});
      const forwardList = await call(homes[1]!, true, "host.list", {});
      expect(nativeList.reply).toEqual(forwardList.reply);
      expect(nativeList.reply.result[0]).toMatchObject({ alias: "fixture", maxTasks: params.max_tasks === 0 ? 4 : params.max_tasks });
    }
  } finally { for (const home of homes) rmSync(home, { recursive: true, force: true }); }
}, 120000);
