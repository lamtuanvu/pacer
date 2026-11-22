import { expect, test } from "bun:test";
import { classify } from "../scripts/test-triage";

const c = (path: string, text: string, imports: string[] = []) => classify({ path, text, imports });

test("parity wins over everything", () => {
  expect(c("test/native-x-parity.test.ts", "", ["src/api/ops.ts"])).toEqual({ bucket: "parity", signal: "parity" });
  expect(c("test/a.test.ts", "", ["test/parity-harness.ts", "plugins/pacer-ssh/index.ts"]).bucket).toBe("parity");
  expect(c("test/a.test.ts", "if (process.env.PACER_TEST_NATIVE_FRONT_DOOR) {}").bucket).toBe("parity");
});

test("plugin source imports are plugin tests; bundled.ts alone is not", () => {
  expect(c("test/plugins-ssh.test.ts", "", ["plugins/pacer-ssh/index.ts", "src/plugins/registry.ts"]).bucket).toBe("plugin");
  expect(c("test/plugins-bundled.test.ts", "", ["plugins/bundled.ts", "src/plugins/registry.ts"]).bucket).toBe("src-unit");
});

test("spawning the CLI or binary is e2e", () => {
  expect(c("test/cli-x.test.ts", 'Bun.spawnSync([process.execPath, "src/cli.ts", "status"])', ["src/types.ts"]).bucket).toBe("binary-e2e");
  expect(c("test/bin.test.ts", 'spawnSync(join(root, "target/debug/pacer"), ["--version"])').bucket).toBe("binary-e2e");
  expect(c("test/no.test.ts", 'const s = "src/cli.ts";').bucket).toBe("kept");
});

test("src imports are unit tests; everything else is kept", () => {
  expect(c("test/tasks-store.test.ts", "", ["src/tasks/store.ts"])).toEqual({ bucket: "src-unit", signal: "src" });
  expect(c("test/app-x.test.tsx", "", ["app/src/app.tsx", "packages/view-model/src/words.ts"])).toEqual({ bucket: "kept", signal: "none" });
});