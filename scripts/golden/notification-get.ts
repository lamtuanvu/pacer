/** Regenerate the TypeScript reference behavior for M2's native notification read. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLevel } from "../../src/core/notify";
import type { Ctx } from "../../src/types";

const cases: { name: string; settings?: string; legacy?: string }[] = [
  { name: "default" },
  { name: "existing", settings: '{"notifications":"all","other":1}\n' },
  { name: "legacy", legacy: '{"notifications":"off"}' },
  { name: "invalid", settings: '{"other":1,"notifications":"invalid"}' },
  { name: "malformed", settings: "{" },
  { name: "null", settings: "null" },
  { name: "string-unicode", settings: '"😀"' },
];
const output = cases.map(input => {
  const root = mkdtempSync(join(tmpdir(), "pacer-notification-golden-"));
  try {
    const home = join(root, "home");
    const pacerHome = join(root, "pacer");
    const orca = join(root, "orca-profile");
    const settings = join(pacerHome, "settings.json");
    const legacy = join(orca, "plugins-data/lamtuanvu.pacer/settings.json");
    if (input.settings !== undefined) {
      mkdirSync(pacerHome, { recursive: true });
      writeFileSync(settings, input.settings);
    }
    if (input.legacy !== undefined) {
      mkdirSync(join(orca, "plugins-data/lamtuanvu.pacer"), { recursive: true });
      writeFileSync(legacy, input.legacy);
    }
    const ctx = { home, pacerHome, env: { PACER_ORCA_USER_DATA: orca } } as Ctx;
    const result = getLevel(ctx);
    const after = readFileSync(settings, "utf8");
    return { ...input, result, after };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
writeFileSync(join(import.meta.dir, "../../test/fixtures/notifications-get.json"), JSON.stringify(output, null, 2) + "\n");
