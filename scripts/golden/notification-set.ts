/** Regenerate the TypeScript reference behavior for M2's native notification write. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callOp } from "../../src/api/ops";
import type { Ctx } from "../../src/types";

const cases: { name: string; settings?: string; level: string }[] = [
  { name: "default", level: "all" },
  { name: "existing", settings: '{"other":1,"notifications":"off"}\n', level: "all" },
  { name: "array", settings: '["one","two"]', level: "off" },
  { name: "null", settings: "null", level: "important" },
  { name: "invalid-json", settings: "{", level: "all" },
  { name: "unicode-string", settings: '"😀"', level: "off" },
  { name: "invalid-level", settings: '{"other":1}', level: "bad" },
];
const output = [];
for (const input of cases) {
  const root = mkdtempSync(join(tmpdir(), "pacer-notification-set-golden-"));
  try {
    const pacerHome = join(root, "pacer");
    const settings = join(pacerHome, "settings.json");
    if (input.settings !== undefined) {
      mkdirSync(pacerHome, { recursive: true });
      writeFileSync(settings, input.settings);
    }
    const ctx = {
      home: join(root, "home"), pacerHome, now: 42, env: {},
      run: async () => ({ code: 127, stdout: "", stderr: "" }), which: () => null,
    } as Ctx;
    let result: unknown;
    try { result = await callOp(ctx, "notifications.set", { level: input.level }); }
    catch (error) {
      const e = error as { code?: string; message?: string; hint?: string };
      result = { error: { code: e.code, message: e.message, hint: e.hint } };
    }
    const optional = (path: string) => { try { return readFileSync(path, "utf8"); } catch { return null; } };
    const outbox = optional(join(pacerHome, "link/outbox.jsonl"));
    output.push({
      ...input, result, after: optional(settings),
      activity: optional(join(pacerHome, "state/activity.jsonl"))?.replace(/"id":"[^"]+"/, '"id":"<ID>"') ?? null,
      outbox: outbox?.replace(/"id":"[^"]+"/g, '"id":"<ID>"') ?? null,
      latest: optional(join(pacerHome, "link/latest.json")),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
writeFileSync(join(import.meta.dir, "../../test/fixtures/notifications-set.json"), JSON.stringify(output, null, 2) + "\n");
