/** Fixed public signed-bundle metadata, not private transaction evidence. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";

export function readFixtureBundleMetadata(app: string): string {
  const path = join(app, "Contents/Resources/pacer-release.json");
  if (realpathSync(path) !== path) throw Error("Fixture bundle metadata path is not canonical");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.()
      || before.mode & 0o022 || before.size > 65536) throw Error("Fixture bundle metadata is not owned and bounded");
    const buffer = Buffer.alloc(65537);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd), linked = lstatSync(path);
    if (size > 65536 || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || linked.dev !== after.dev || linked.ino !== after.ino || linked.isSymbolicLink()
      || realpathSync(path) !== path) throw Error("Fixture bundle metadata changed while reading");
    return buffer.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}
