import { privateWrite } from "../private-file";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Reject redirected agent directories; macOS root aliases are platform paths. */
function checkParents(path: string): void {
  for (let parent = dirname(resolve(path)); parent !== dirname(parent); parent = dirname(parent)) {
    try {
      if (lstatSync(parent).isSymbolicLink() && !["/var", "/tmp", "/etc"].includes(parent)) throw Error(`unsafe integration directory: ${parent}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/** Only ENOENT means missing; unreadable files must never become empty settings. */
export function readInstallFile(path: string): string | null {
  checkParents(path);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error(`unsafe integration file: ${path}`);
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
export function writeInstallFile(path: string, text: string, ownerMode?: number): void {
  const exists = readInstallFile(path) !== null;
  const mode = ownerMode ?? (exists ? lstatSync(path).mode & 0o700 : 0o600);
  privateWrite(path, text, mode & 0o700);
}
