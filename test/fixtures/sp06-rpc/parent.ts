import { join } from "node:path";
import { readFileSync, statSync } from "node:fs";
import { withPlannerInstall } from "../../../src/plugins/planner-install";
import { recoverPlannerInstall } from "../../../src/plugins/planner-recovery";
import { withInstallLock } from "../../../src/install/lock";
import { writeNative } from "../../../src/plugins/write-native";
import { PluginRegistry } from "../../../src/plugins/registry";
import type { PluginManifest } from "../../../src/plugins/protocol";
const [mode, home] = process.argv.slice(2),
  folder = join(home!, ".codex");
const ctx = {
  home: home!,
  pacerHome: join(home!, ".pacer"),
  now: 1,
  env: { HOME: home!, PACER_HOME: join(home!, ".pacer") },
  which: () => null,
  run: async () => {
    throw Error("unadmitted command");
  },
};
if (mode === "recover") {
  await withInstallLock(ctx, () => recoverPlannerInstall(ctx));
  process.stdout.write(
    JSON.stringify({
      text: readFileSync(join(folder, "settings.json"), "utf8"),
      mode: statSync(join(folder, "settings.json")).mode & 0o777,
    }),
  );
} else {
  const manifest: PluginManifest = {
    id: "sp06-install",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1",
    contributes: { planner: {} },
    capabilities: [
      { name: "fs.read", scopes: [folder + "/**"] },
      { name: "fs.write", scopes: [folder + "/**"] },
    ],
    tier: "free",
    reentrant: false,
  };
  const registry = new PluginRegistry({
    bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
    spawnBundled: () => ({
      argv: [process.execPath, join(import.meta.dir, "install.ts")],
      cwd: ctx.home,
      env: {},
    }),
  });
  const native = writeNative(),
    rename = native.renameAt;
  native.renameAt = (from, old, to, name) => {
    rename(from, old, to, name);
    if (name === "settings.json") {
      process.stdout.write("APPLIED\n");
      process.kill(process.pid, "SIGSTOP");
    }
  };
  try {
    await withPlannerInstall(
      { ctx, pacerArgv: ["pacer"], folder },
      "synthetic",
      { pluginId: "sp06-install", roots: [folder], binaries: [], registry },
    );
  } finally {
    await registry.shutdown();
  }
}
