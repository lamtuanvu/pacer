import { childEnv, fakeServiceManager } from "./child-env";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { installFixture } from "../conformance/install";
import { tmpDir } from "./helpers";

export const front = process.env.PACER_TEST_FRONT_DOOR;

// Forwarded plugin calls need TypeScript to own plugin children; the native host refuses a second owner.
export const tsOwner = { nativeHost: "0" };

export async function service(forward = "", homeKind = "absolute", options: { nativeHost?: string } = {}) {
  // host.sock must fit SUN_LEN (~104). Bun test redirects TMPDIR into a deep
  // isolated home, so homes that may bind it allocate under /tmp directly.
  const shortHome = options.nativeHost !== "0";
  const home = shortHome ? realpathSync(mkdtempSync("/tmp/pnh-")) : realpathSync(tmpDir());
  const state = join(home, ".pacer");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(state, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n# preserve this comment\n", { mode: 0o600 });
  symlinkSync(join(import.meta.dir, "../node_modules"), join(home, "node_modules"), "dir");
  const plugin = installFixture("ui", join(state, "plugins"));
  const socket = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = socket.port!; socket.stop(true);
  let configuredHome = state;
  if (homeKind.includes("symlink")) {
    configuredHome = join(home, "linked");
    symlinkSync(".pacer", configuredHome, "dir");
  }
  if (homeKind.includes("relative")) configuredHome = relative(process.cwd(), configuredHome);
  const child = Bun.spawn([front!, "serve", "--port", String(port)], {
    env: { ...childEnv(home, port), PACER_HOME: configuredHome, PATH: `${fakeServiceManager(home)}:${dirname(process.execPath)}:${process.env.PATH}`,
      PACER_CORE_ARGV: JSON.stringify([process.execPath, join(import.meta.dir, "../src/cli.ts")]),
      PACER_NO_UPDATE_CHECK: "1", PACER_NO_SELF_REPAIR: "1", PACER_DISCOVERY: "off",
      PACER_DEBUG_NATIVE: "1", PACER_FORWARD_OPS: forward,
      ...(options.nativeHost !== undefined ? { PACER_NATIVE_PLUGIN_HOST: options.nativeHost } : {}) },
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const logs = new Response(child.stderr).text();
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  try {
    for (let i = 0; i < 500; i++) {
      try {
        token = readFileSync(join(state, "token"), "utf8").trim();
        const response = await fetch(`${base}/v3/hello`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch { /* Wait for this owned child only. */ }
      if (child.exitCode !== null) throw Error(await logs);
      await Bun.sleep(20);
    }
    if (!token) throw Error("native fixture did not become ready");
  } catch (error) {
    child.kill("SIGTERM"); await child.exited;
    if (shortHome) rmSync(home, { recursive: true, force: true });
    throw error;
  }
  const post = async (op: string, params: unknown) => {
    const response = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(params), signal: AbortSignal.timeout(15000) });
    return await response.json() as any;
  };
  return { home, state, plugin, base, token, post, async stop() {
    if (child.exitCode === null) { child.kill("SIGTERM"); await child.exited; }
    const text = await logs;
    if (shortHome) rmSync(home, { recursive: true, force: true });
    return text;
  } };
}
