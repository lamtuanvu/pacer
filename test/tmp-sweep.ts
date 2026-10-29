import { lstatSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const marker = ".pacer-test-owner.json", hour = 60 * 60 * 1000;
const startedAt = Date.now() - process.uptime() * 1000;

export function markTestTmp(dir: string): void {
  writeFileSync(join(dir, marker), JSON.stringify({ pid: process.pid, startedAt }));
}

export function sweepTestTmp(): void {
  if (process.env.PACER_KEEP_TEST_TMP) return;
  const root = tmpdir();
  for (const name of readdirSync(root)) {
    if (!name.startsWith("pacer-test-")) continue;
    const dir = join(root, name);
    try {
      const stat = lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) continue;
      let owner: { pid: number; startedAt: number };
      try {
        const file = join(dir, marker);
        if (!lstatSync(file).isFile()) throw new Error("marker is not a file");
        owner = JSON.parse(readFileSync(file, "utf8"));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(owner.startedAt)) throw new Error("invalid marker");
      } catch {
        // Missing or unreadable marker: only age tells whether a run still owns it.
        if (Date.now() - stat.mtimeMs > 6 * hour) rmSync(dir, { recursive: true, force: true });
        continue;
      }
      // No test run lasts a day; an older marker with a live pid means the pid was reused.
      if (Date.now() - owner.startedAt > 24 * hour) { rmSync(dir, { recursive: true, force: true }); continue; }
      try { process.kill(owner.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`test temp sweep: ${dir}: ${error}`);
    }
  }
}
