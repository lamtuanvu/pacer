import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const directory = join(home, "Library", "Application Support", "orca", "plugins-data", "pacer.pacer-spike");
const target = join(directory, "storage.json");
let storage: Record<string, unknown> = {};
try {
  const parsed: unknown = JSON.parse(await readFile(target, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("storage.json must contain a JSON object; refusing to overwrite");
  }
  storage = parsed as Record<string, unknown>;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const probe = Date.now();
storage.link = { probe };
if (Object.keys(storage).length > 1024) throw new Error("storage exceeds 1024 keys");
const contents = `${JSON.stringify(storage, null, 2)}\n`;
if (Buffer.byteLength(contents) > 5 * 1024 * 1024) throw new Error("storage exceeds 5 MiB");
await mkdir(directory, { recursive: true });
const tmp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
try {
  await writeFile(tmp, contents, { flag: "wx", mode: 0o600 });
  await rename(tmp, target);
} finally {
  await unlink(tmp).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
console.log(`Storage probe: ${probe}`);
