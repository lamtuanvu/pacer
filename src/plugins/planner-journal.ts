import { dirname, join, relative, sep } from "node:path";
import { lstatSync } from "node:fs";
import { CoreError } from "../core/errors";
import type { Ctx } from "../types";
import type {
  JournalIO,
  PendingFile,
} from "../../packages/plugin-sdk/src/install/journal";
import { createCallAuthority, type CallResources } from "./authority";
import {
  answerWrite,
  prepareWriteAuthority,
  readOwnerFile,
  writeOwnerFile,
  removeOwnerFile,
  type OwnerFileImage,
} from "./capability-write";
function existingRoot(path: string): string {
  let root = dirname(path);
  for (;;) {
    try {
      if (!lstatSync(root).isDirectory())
        throw new CoreError(
          "capability_denied",
          "installation root is not a directory",
        );
      return root;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        root === dirname(root)
      )
        throw error;
      root = dirname(root);
    }
  }
}
/** One private native session retained through journal commit or rollback. */
export async function plannerJournalIO(
  ctx: Ctx,
  files: readonly PendingFile[],
  deadlineMs: number,
  assertRoots = () => {},
) {
  const manifestPath = join(ctx.pacerHome, "install-manifest.json"),
    journalPath = join(ctx.pacerHome, "install-transaction.json");
  const all = [...files.map((file) => file.path), manifestPath, journalPath],
    directories = new Map<string, string>(),
    writes: NonNullable<CallResources["writes"]> = [];
  assertRoots();
  for (const path of all) {
    const root = existingRoot(path);
    writes.push({ path, root, kind: "file", operations: ["write", "remove"] });
    const parts = relative(root, dirname(path)).split(sep).filter(Boolean);
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      directories.set(parent, root);
    }
  }
  for (const [path, root] of directories)
    writes.unshift({ path, root, kind: "directory", operations: ["mkdir"] });
  const owner = createCallAuthority(
    ctx,
    { reads: [], commands: [], stores: [], writes },
    { deadlineMs, grants: ["fs.write"] },
  );
  try {
    assertRoots();
    await prepareWriteAuthority(owner);
    assertRoots();
  } catch (error) {
    await owner.revoke();
    throw error;
  }
  const scopes = all.concat([...directories.keys()]),
    images = new Map<string, OwnerFileImage | null>();
  const read = (path: string) => {
    const image = readOwnerFile(owner, scopes, path);
    images.set(path, image);
    return image;
  };
  const write = async (path: string, text: string, mode?: number) => {
    assertRoots();
    for (const dir of directories.keys())
      if (path.startsWith(dir + sep))
        await answerWrite(owner, scopes, "capability.fs.mkdir", { path: dir });
    const image = images.has(path) ? images.get(path)! : read(path);
    await writeOwnerFile(
      owner,
      scopes,
      path,
      text,
      mode ?? image?.mode ?? 0o600,
      image,
    );
    images.delete(path);
  };
  const remove = async (path: string) => {
    assertRoots();
    await removeOwnerFile(
      owner,
      scopes,
      path,
      images.has(path) ? images.get(path)! : read(path),
    );
    images.delete(path);
  };
  const io: JournalIO = {
    readJournal: async () => read(journalPath)?.text ?? null,
    writeJournal: (text) => write(journalPath, text),
    removeJournal: () => remove(journalPath),
    readManifest: async () => read(manifestPath)?.text ?? null,
    writeManifest: (text) => write(manifestPath, text),
    readFile: async (path) => read(path)?.text ?? null,
    writeFile: write,
    removeFile: remove,
  };
  return {
    io,
    close: () => owner.revoke(),
    preflight: () => {
      for (const file of files) {
        const image = read(file.path);
        if (
          (image?.text ?? null) !== file.before ||
          (image !== null && image.mode !== file.beforeMode)
        )
          throw new CoreError(
            "conflict",
            "installation pinned before-image or mode changed",
          );
      }
    },
  };
}
