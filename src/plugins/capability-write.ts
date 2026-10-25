import * as fs from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { CoreError } from "../core/errors";
import type { CallAuthority } from "./authority";
import { absolutePath, declaredPath } from "./capability-paths";
import {
  NativeWriteError,
  writeNative,
  WRITE_DIRECTORY,
  WRITE_OPEN,
  WRITE_CLOEXEC,
} from "./write-native";

type Operation = "write" | "mkdir" | "remove";
interface Identity {
  dev: number;
  ino: number;
}
interface Directory {
  fd: number;
  identity: Identity;
}
interface Root {
  logical: string;
  canonical: string;
  directories: Map<string, Directory>;
}
interface Resource {
  path: string;
  kind: "file" | "directory";
  operations: readonly Operation[];
  root: Root;
  parts: string[];
  expected?: Identity;
}
interface State {
  roots: Map<string, Root>;
  resources: Resource[];
  fds: Set<number>;
  active?: Promise<void>;
  busy: boolean;
  preparationFailure?: CoreError;
  cleanupFailure?: CoreError;
}
const states = new WeakMap<CallAuthority, State>();
function denied(message = "write is outside the owning call resources"): never {
  throw new CoreError("capability_denied", message);
}
function invalid(message: string): never {
  throw new CoreError("invalid_input", message);
}
const identity = (s: fs.Stats): Identity => ({ dev: s.dev, ino: s.ino });
const same = (a: Identity, b: fs.Stats) => a.dev === b.dev && a.ino === b.ino;
const missing = (e: unknown) => e instanceof NativeWriteError && e.errno === 2;
const key = (parts: readonly string[]) => parts.join("/");
function close(state: State, fd: number) {
  if (state.fds.delete(fd))
    try {
      fs.closeSync(fd);
    } catch {
      state.cleanupFailure ??= new CoreError(
        "plugin_unavailable",
        "write descriptor cleanup unverified",
      );
    }
}
function open(
  state: State,
  parent: number,
  name: string | Uint8Array,
  directory = false,
): number | undefined {
  try {
    const fd = writeNative().openAt(
      parent,
      name,
      directory ? WRITE_DIRECTORY : WRITE_OPEN,
    );
    state.fds.add(fd);
    return fd;
  } catch (e) {
    if (missing(e)) return undefined;
    return denied("write path could not be opened safely");
  }
}
function checkedType(fd: number, kind: "file" | "directory") {
  const stat = fs.fstatSync(fd);
  if (
    kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()
  )
    denied("write target type or link count refused");
  return stat;
}
function rootCurrent(root: Root) {
  try {
    if (
      fs.realpathSync(root.logical) !== root.canonical ||
      !same(root.directories.get("")!.identity, fs.statSync(root.canonical)) ||
      !same(
        root.directories.get("")!.identity,
        fs.fstatSync(root.directories.get("")!.fd),
      )
    )
      denied("write root changed since issuance");
  } catch {
    denied("write root changed since issuance");
  }
}
function directory(
  state: State,
  root: Root,
  parts: readonly string[],
): Directory {
  rootCurrent(root);
  let current = root.directories.get("")!;
  for (let index = 0; index < parts.length; index++) {
    const pin = root.directories.get(key(parts.slice(0, index + 1)));
    if (!pin) denied("write parent was not issued and created");
    const fd = open(state, current.fd, parts[index]!, true);
    if (fd === undefined) denied("write parent disappeared");
    try {
      if (
        !same(pin.identity, checkedType(fd, "directory")) ||
        !same(pin.identity, checkedType(pin.fd, "directory"))
      )
        denied("write parent identity changed");
    } finally {
      close(state, fd);
    }
    current = pin;
  }
  return current;
}
function target(
  state: State,
  r: Resource,
  parent: Directory,
): number | undefined {
  const fd = open(state, parent.fd, r.parts.at(-1)!);
  if (fd === undefined) {
    if (r.expected) denied("write target disappeared");
    return undefined;
  }
  try {
    const stat = checkedType(fd, r.kind);
    if (!r.expected || !same(r.expected, stat))
      denied("write target changed since issuance");
    return fd;
  } catch (e) {
    close(state, fd);
    throw e;
  }
}
/** Issuance only. Host roots may be configured aliases; descendants never follow symlinks. */
export async function prepareWriteAuthority(
  authority: CallAuthority,
): Promise<void> {
  authority.assertActive();
  const previous = states.get(authority);
  if (previous) {
    if (previous.preparationFailure) throw previous.preparationFailure;
    return;
  }
  const state: State = {
    roots: new Map(),
    resources: [],
    fds: new Set(),
    busy: false,
  };
  states.set(authority, state);
  authority.onRevoke(async () => {
    await state.active;
    for (const fd of [...state.fds]) close(state, fd);
    if (state.cleanupFailure) throw state.cleanupFailure;
  });
  try {
    for (const descriptor of authority.resources.writes ?? []) {
      authority.assertActive();
      const path = absolutePath(descriptor.path),
        logical = absolutePath(descriptor.root ?? authority.ctx.pacerHome);
      const rel = relative(logical, path);
      if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
        denied("write path must descend its host root");
      let root = state.roots.get(logical);
      if (!root) {
        const canonical = fs.realpathSync(logical);
        const fd = fs.openSync(canonical, WRITE_DIRECTORY);
        state.fds.add(fd);
        root = {
          logical,
          canonical,
          directories: new Map([
            ["", { fd, identity: identity(checkedType(fd, "directory")) }],
          ]),
        };
        state.roots.set(logical, root);
        rootCurrent(root);
      }
      const parts = rel.split(sep);
      let parent = root.directories.get("")!;
      let absent = false;
      for (let index = 0; index < parts.length - 1; index++) {
        const name = key(parts.slice(0, index + 1));
        const known = root.directories.get(name);
        if (known) {
          parent = known;
          continue;
        }
        if (absent) continue;
        const fd = open(state, parent.fd, parts[index]!, true);
        if (fd === undefined) {
          absent = true;
          continue;
        }
        const node = { fd, identity: identity(checkedType(fd, "directory")) };
        root.directories.set(name, node);
        parent = node;
      }
      const resource: Resource = {
        path,
        kind: descriptor.kind,
        operations: [...descriptor.operations],
        root,
        parts,
      };
      if (!absent) {
        const fd = open(state, parent.fd, parts.at(-1)!);
        if (fd !== undefined) {
          try {
            resource.expected = identity(checkedType(fd, resource.kind));
            if (resource.kind === "directory") {
              root.directories.set(key(parts), {
                fd,
                identity: resource.expected,
              });
            } else close(state, fd);
          } catch (e) {
            close(state, fd);
            throw e;
          }
        }
      }
      state.resources.push(resource);
    }
    authority.assertActive();
  } catch (error) {
    for (const fd of [...state.fds]) close(state, fd);
    state.preparationFailure = new CoreError(
      "capability_denied",
      "write roots unavailable at issuance",
    );
    if (error instanceof CoreError) throw error;
    throw state.preparationFailure;
  }
}
function authorize(
  authority: CallAuthority,
  scopes: readonly string[],
  raw: unknown,
  operation: Operation,
) {
  authority.assertGranted("fs.write");
  const state = states.get(authority) ?? denied("write roots not prepared");
  if (state.preparationFailure) throw state.preparationFailure;
  if (state.cleanupFailure) throw state.cleanupFailure;
  const path = absolutePath(raw);
  const r = state.resources.find(
    (x) => x.path === path && x.operations.includes(operation),
  );
  if (!r || !declaredPath(authority, scopes, path)) denied();
  if (
    (operation === "write" && r.kind !== "file") ||
    (operation === "mkdir" && r.kind !== "directory")
  )
    denied("write operation does not match resource type");
  const parent = directory(state, r.root, r.parts.slice(0, -1));
  const fd = target(state, r, parent);
  if (fd !== undefined) close(state, fd);
  authority.assertActive();
  return { state, r, parent };
}
/** Nonmutating permission and pinned-identity check for host-owned bounded transport staging. */
export function checkWriteAuthority(
  authority: CallAuthority,
  scopes: readonly string[],
  path: unknown,
  operation: Operation,
): void {
  authorize(authority, scopes, path, operation);
}

async function write(
  authority: CallAuthority,
  state: State,
  r: Resource,
  parent: Directory,
  text: string,
) {
  const bytes = Buffer.from(text, "utf8");
  const existing = target(state, r, parent);
  if (existing !== undefined) {
    try {
      const before = checkedType(existing, "file");
      if (before.size === bytes.length) {
        const prior = Buffer.alloc(bytes.length);
        let count = 0;
        while (count < prior.length) {
          authority.assertActive();
          const n = fs.readSync(
            existing,
            prior,
            count,
            Math.min(262144, prior.length - count),
            count,
          );
          if (!n) denied("write target changed during comparison");
          count += n;
        }
        const after = fs.fstatSync(existing);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
          denied("write target changed during comparison");
        if (prior.equals(bytes)) {
          directory(state, r.root, r.parts.slice(0, -1));
          authority.assertActive();
          if ((after.mode & 0o777) !== 0o600) fs.fchmodSync(existing, 0o600);
          checkedType(existing, "file");
          directory(state, r.root, r.parts.slice(0, -1));
          const named = target(state, r, parent);
          if (named !== undefined) close(state, named);
          authority.assertActive();
          return;
        }
      }
    } finally {
      close(state, existing);
    }
  }
  const name = ".pacer-write-" + randomUUID() + ".tmp";
  let staged: number | undefined;
  let exists = false;
  try {
    authority.assertActive();
    staged = writeNative().openAt(
      parent.fd,
      name,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW |
        WRITE_CLOEXEC,
      0o600,
    );
    state.fds.add(staged);
    exists = true;
    fs.fchmodSync(staged, 0o600);
    let offset = 0;
    while (offset < bytes.length) {
      authority.assertActive();
      const n = fs.writeSync(
        staged,
        bytes,
        offset,
        Math.min(262144, bytes.length - offset),
        offset,
      );
      if (n <= 0)
        throw new CoreError(
          "plugin_unavailable",
          "private write did not advance",
        );
      offset += n;
    }
    fs.fsyncSync(staged);
    const expected = identity(checkedType(staged, "file"));
    directory(state, r.root, r.parts.slice(0, -1));
    const now = target(state, r, parent);
    if (now !== undefined) close(state, now);
    authority.assertActive();
    writeNative().renameAt(parent.fd, name, parent.fd, r.parts.at(-1)!);
    exists = false;
    r.expected = expected;
    directory(state, r.root, r.parts.slice(0, -1));
    const current = target(state, r, parent);
    if (current !== undefined) close(state, current);
    authority.assertActive();
  } finally {
    if (exists) {
      try {
        const check = open(state, parent.fd, name);
        if (check === undefined || staged === undefined)
          throw Error("missing stage");
        try {
          if (!same(identity(fs.fstatSync(staged)), checkedType(check, "file")))
            throw Error("stage replaced");
        } finally {
          close(state, check);
        }
        writeNative().unlinkAt(parent.fd, name, false);
      } catch {
        state.cleanupFailure ??= new CoreError(
          "plugin_unavailable",
          "private write cleanup unverified",
        );
      }
    }
    if (staged !== undefined) close(state, staged);
    if (state.cleanupFailure) throw state.cleanupFailure;
  }
}
function removeTree(
  authority: CallAuthority,
  state: State,
  parent: number,
  name: string | Uint8Array,
  expected?: Identity,
) {
  authority.assertActive();
  const fd = open(state, parent, name);
  if (fd === undefined) return;
  try {
    const stat = fs.fstatSync(fd);
    if (expected && !same(expected, stat))
      denied("removal target identity changed");
    if (stat.isFile()) {
      if (stat.nlink !== 1) denied("hardlinked removal refused");
      authority.assertActive();
      writeNative().unlinkAt(parent, name, false);
    } else if (stat.isDirectory()) {
      for (const child of writeNative().entries(fd))
        removeTree(authority, state, fd, child);
      authority.assertActive();
      writeNative().unlinkAt(parent, name, true);
    } else denied("nonregular removal refused");
  } finally {
    close(state, fd);
  }
}
/** Complete bounded-text primitive; wire framing/chunk transfer remains host-owned. */
export async function answerWrite(
  authority: CallAuthority,
  scopes: readonly string[],
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: true }> {
  const operation =
    method === "capability.fs.write"
      ? "write"
      : method === "capability.fs.mkdir"
        ? "mkdir"
        : method === "capability.fs.remove"
          ? "remove"
          : undefined;
  if (!operation) throw new CoreError("unknown_op", "unknown write capability");
  if (
    Object.keys(params).some(
      (k) =>
        k !== "path" &&
        (operation !== "write" || k !== "text") &&
        (operation !== "remove" || k !== "recursive"),
    )
  )
    invalid("unknown write parameter");
  if (
    operation === "write" &&
    (typeof params.text !== "string" ||
      Buffer.byteLength(params.text, "utf8") > 4194304)
  )
    invalid("write text exceeds bounded UTF8 limit");
  if (params.recursive !== undefined && typeof params.recursive !== "boolean")
    invalid("invalid recursive removal");
  const { state, r, parent } = authorize(
    authority,
    scopes,
    params.path,
    operation,
  );
  if (state.busy)
    throw new CoreError("conflict", "one write operation is already active");
  let finish!: () => void;
  state.active = new Promise<void>((resolve) => {
    finish = resolve;
  });
  state.busy = true;
  try {
    if (operation === "write")
      await write(authority, state, r, parent, params.text as string);
    else if (operation === "mkdir") {
      const current = target(state, r, parent);
      if (current !== undefined) {
        try {
          authority.assertActive();
          fs.fchmodSync(current, 0o700);
        } finally {
          close(state, current);
        }
      } else {
        authority.assertActive();
        writeNative().mkdirAt(parent.fd, r.parts.at(-1)!, 0o700);
        const fd = open(state, parent.fd, r.parts.at(-1)!, true);
        if (fd === undefined) denied("created directory disappeared");
        fs.fchmodSync(fd, 0o700);
        r.expected = identity(checkedType(fd, "directory"));
        r.root.directories.set(key(r.parts), { fd, identity: r.expected });
      }
      directory(state, r.root, r.parts);
      authority.assertActive();
    } else {
      const current = target(state, r, parent);
      if (current !== undefined) {
        close(state, current);
        if (r.kind === "directory" && params.recursive !== true) {
          authority.assertActive();
          writeNative().unlinkAt(parent.fd, r.parts.at(-1)!, true);
        } else
          removeTree(authority, state, parent.fd, r.parts.at(-1)!, r.expected);
        for (const resource of state.resources)
          if (
            resource.root === r.root &&
            (resource.path === r.path || resource.path.startsWith(r.path + sep))
          )
            resource.expected = undefined;
        for (const [path, node] of r.root.directories)
          if (path === key(r.parts) || path.startsWith(key(r.parts) + "/")) {
            close(state, node.fd);
            r.root.directories.delete(path);
          }
      }
      directory(state, r.root, r.parts.slice(0, -1));
      authority.assertActive();
    }
    if (state.cleanupFailure) throw state.cleanupFailure;
    return { ok: true };
  } catch (error) {
    if (error instanceof NativeWriteError && error.cleanupFailure)
      state.cleanupFailure ??= new CoreError(
        "plugin_unavailable",
        "directory descriptor cleanup unverified",
      );
    if (state.cleanupFailure) throw state.cleanupFailure;
    if (error instanceof CoreError) throw error;
    throw new CoreError(
      "capability_denied",
      "descriptor write operation refused",
    );
  } finally {
    state.busy = false;
    state.active = undefined;
    finish();
  }
}
