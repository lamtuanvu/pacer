/** macOS system-library trust root. No executable supplied by a peer is run. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  dlopen,
  FFIType,
  ptr,
  toArrayBuffer,
  CString,
  type Pointer,
} from "bun:ffi";
import {
  compiledNativeFixture,
  fixturePermitsPath,
  type NativeFixture,
} from "./native-fixture";
import { CoreError } from "../../core/errors";
import {
  ownProcessIdentity,
  processIdentity,
  sameProcess,
  type ProcessIdentity,
} from "./process-identity";

declare const PACER_BUILD_APPLE_TEAM_ID: string | undefined;
export function compiledAppleTeamId(): string | null {
  const team =
    typeof PACER_BUILD_APPLE_TEAM_ID === "string"
      ? PACER_BUILD_APPLE_TEAM_ID
      : "";
  return /^[A-Z0-9]{10}$/.test(team) ? team : null;
}
export function nativeSocketPath(
  home: string,
  port: number,
  uid: number,
): string {
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  )
    throw denied();
  const key = createHash("sha256")
    .update(`${realpathSync(home)}\n${port}\n${uid}`)
    .digest("hex")
    .slice(0, 32);
  return `/private/tmp/pacer-native-${uid}/${key}.sock`;
}
const denied = () =>
  new CoreError(
    "not_allowed",
    "Native desktop identity could not be verified",
    "Use the supported signed desktop and bundled service baseline.",
  );
export type NativeCodeRole = "desktop" | "cli" | "helper";
const identifiers: Record<NativeCodeRole, string> = {
  desktop: "dev.pacer.desktop",
  cli: "dev.pacer.cli",
  helper: "dev.pacer.desktop.update-helper",
};
const P = FFIType.ptr,
  I = FFIType.i32,
  U = FFIType.u32,
  L = FFIType.i64;
const cstr = (text: string) => Buffer.from(text + "\0");
const pointer = (out: BigUint64Array) => Number(out[0]) as Pointer;
export type NativePeer = {
  process: ProcessIdentity;
  uid: number;
  executable: string;
  auditToken: Uint8Array;
  role: NativeCodeRole;
};
export class DarwinAuthority {
  private cf;
  private sec;
  private sys;
  private proc;
  private keyCallbacks: Pointer;
  private valueCallbacks: Pointer;
  private auditKey: Pointer;
  private pidKey: Pointer;
  static configured(): DarwinAuthority | null {
    const team = compiledAppleTeamId(),
      fixture = compiledNativeFixture();
    if (team && fixture) throw denied();
    return process.platform === "darwin" && (team || fixture)
      ? new DarwinAuthority(team ?? "", fixture ?? undefined)
      : null;
  }
  /** Internal constructor for OS boundary tests. Production composition uses configured(). */
  constructor(
    private readonly team: string,
    private readonly fixture?: NativeFixture,
  ) {
    if (
      process.platform !== "darwin" ||
      (!fixture && !/^[A-Z0-9]{10}$/.test(team))
    )
      throw denied();
    const cfPath =
        "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
      secPath = "/System/Library/Frameworks/Security.framework/Security";
    this.sys = dlopen("/usr/lib/libSystem.B.dylib", {
      dlopen: { args: [P, I], returns: P },
      dlsym: { args: [P, P], returns: P },
    });
    this.cf = dlopen(cfPath, {
      CFStringCreateWithCString: { args: [P, P, U], returns: P },
      CFNumberCreate: { args: [P, L, P], returns: FFIType.u64 },
      CFDataCreate: { args: [P, P, L], returns: P },
      CFDictionaryCreate: { args: [P, P, P, L, P, P], returns: P },
      CFURLCreateFromFileSystemRepresentation: {
        args: [P, P, L, FFIType.bool],
        returns: P,
      },
      CFRelease: { args: [FFIType.u64], returns: FFIType.void },
    });
    this.sec = dlopen(secPath, {
      SecRequirementCreateWithString: { args: [P, U, P], returns: I },
      SecCodeCopyGuestWithAttributes: { args: [P, P, U, P], returns: I },
      SecCodeCheckValidity: { args: [P, U, P], returns: I },
      SecStaticCodeCreateWithPath: { args: [P, U, P], returns: I },
      SecStaticCodeCheckValidity: { args: [P, U, P], returns: I },
    });
    this.proc = dlopen("/usr/lib/libproc.dylib", {
      proc_pidpath_audittoken: { args: [P, P, U], returns: I },
    });
    const symbol = (library: string, name: string) => {
      const h = this.sys.symbols.dlopen(ptr(cstr(library)), 1);
      if (!h) throw denied();
      const s = this.sys.symbols.dlsym(h, ptr(cstr(name)));
      if (!s) throw denied();
      return Number(s) as Pointer;
    };
    this.keyCallbacks = symbol(cfPath, "kCFTypeDictionaryKeyCallBacks");
    this.valueCallbacks = symbol(cfPath, "kCFTypeDictionaryValueCallBacks");
    this.pidKey = Number(
      new BigUint64Array(
        toArrayBuffer(symbol(secPath, "kSecGuestAttributePid"), 0, 8),
      )[0],
    ) as Pointer;
    this.auditKey = Number(
      new BigUint64Array(
        toArrayBuffer(symbol(secPath, "kSecGuestAttributeAudit"), 0, 8),
      )[0],
    ) as Pointer;
  }
  private check(
    role: NativeCodeRole | "native-shim",
    action: (requirement: Pointer, refs: (Pointer | bigint)[]) => void,
  ): void {
    const refs: (Pointer | bigint)[] = [];
    try {
      const identifier = role === "native-shim" ? "dev.pacer.desktop.native-shim" : identifiers[role];
      const requirement = this.fixture
        ? `identifier "${identifier}"`
        : `anchor apple generic and identifier "${identifier}" and certificate leaf[subject.OU] = "${this.team}"`;
      const text = this.cf.symbols.CFStringCreateWithCString(
        null,
        ptr(cstr(requirement)),
        0x08000100,
      );
      if (!text) throw denied();
      refs.push(Number(text) as Pointer);
      const out = new BigUint64Array(1);
      if (
        this.sec.symbols.SecRequirementCreateWithString(text, 0, ptr(out)) !==
          0 ||
        !out[0]
      )
        throw denied();
      refs.push(pointer(out));
      action(pointer(out), refs);
    } catch {
      throw denied();
    } finally {
      for (const ref of refs.reverse()) this.cf.symbols.CFRelease(BigInt(ref));
    }
  }
  verifyStatic(path: string, role: NativeCodeRole): void {
    this.verifyStaticRole(path, role);
  }
  /** Static-only component role; never accepted as a native peer identity. */
  verifyNativeShim(path: string): void {
    this.verifyStaticRole(path, "native-shim");
  }
  private verifyStaticRole(path: string, role: NativeCodeRole | "native-shim"): void {
    if (this.fixture) fixturePermitsPath(this.fixture, path);
    this.check(role, (requirement, refs) => {
      const bytes = cstr(realpathSync(path));
      const url = this.cf.symbols.CFURLCreateFromFileSystemRepresentation(
        null,
        ptr(bytes),
        bytes.length - 1,
        false,
      );
      if (!url) throw denied();
      refs.push(Number(url) as Pointer);
      const out = new BigUint64Array(1);
      if (
        this.sec.symbols.SecStaticCodeCreateWithPath(url, 0, ptr(out)) !== 0 ||
        !out[0]
      )
        throw denied();
      refs.push(pointer(out));
      if (
        this.sec.symbols.SecStaticCodeCheckValidity(
          pointer(out),
          25,
          requirement,
        ) !== 0
      )
        throw denied();
    });
  }
  verifyProcess(
    expected: ProcessIdentity,
    role: NativeCodeRole,
  ): NativeProcess {
    const before = nativeProcess(expected.pid);
    if (
      !before ||
      !before.executable ||
      !sameProcess(before.process, expected) ||
      before.uid !== process.getuid?.()
    )
      throw denied();
    if (this.fixture) fixturePermitsPath(this.fixture, before.executable);
    this.check(role, (requirement, refs) => {
      const pid = new Int32Array([expected.pid]);
      const number = this.cf.symbols.CFNumberCreate(null, 3, ptr(pid));
      if (!number) throw denied();
      refs.push(BigInt(number));
      const keys = new BigUint64Array([BigInt(this.pidKey)]),
        values = new BigUint64Array([BigInt(number)]);
      const attrs = this.cf.symbols.CFDictionaryCreate(
        null,
        ptr(keys),
        ptr(values),
        1,
        this.keyCallbacks,
        this.valueCallbacks,
      );
      if (!attrs) throw denied();
      refs.push(Number(attrs) as Pointer);
      const out = new BigUint64Array(1);
      if (
        this.sec.symbols.SecCodeCopyGuestWithAttributes(
          null,
          attrs,
          0,
          ptr(out),
        ) !== 0 ||
        !out[0]
      )
        throw denied();
      refs.push(pointer(out));
      if (
        this.sec.symbols.SecCodeCheckValidity(pointer(out), 16, requirement) !==
        0
      )
        throw denied();
    });
    if (!sameProcess(before.process, processIdentity(expected.pid)))
      throw denied();
    return before;
  }
  verifyPeer(
    auditToken: Uint8Array,
    role: NativeCodeRole,
    expected?: ProcessIdentity,
  ): NativePeer {
    if (auditToken.byteLength !== 32) throw denied();
    const view = new DataView(
        auditToken.buffer,
        auditToken.byteOffset,
        auditToken.byteLength,
      ),
      pid = view.getUint32(20, true),
      uid = view.getUint32(4, true);
    const before = processIdentity(pid);
    if (
      !before ||
      uid !== process.getuid?.() ||
      (expected && !sameProcess(before, expected))
    )
      throw denied();
    const path = new Uint8Array(4096);
    if (
      this.proc.symbols.proc_pidpath_audittoken(
        ptr(auditToken),
        ptr(path),
        path.length,
      ) <= 0
    )
      throw denied();
    const executable = realpathSync(new CString(ptr(path)).toString());
    if (this.fixture) fixturePermitsPath(this.fixture, executable);
    this.check(role, (requirement, refs) => {
      const data = this.cf.symbols.CFDataCreate(null, ptr(auditToken), 32);
      if (!data) throw denied();
      refs.push(Number(data) as Pointer);
      const keys = new BigUint64Array([BigInt(this.auditKey)]),
        values = new BigUint64Array([BigInt(data)]);
      const attrs = this.cf.symbols.CFDictionaryCreate(
        null,
        ptr(keys),
        ptr(values),
        1,
        this.keyCallbacks,
        this.valueCallbacks,
      );
      if (!attrs) throw denied();
      refs.push(Number(attrs) as Pointer);
      const out = new BigUint64Array(1);
      if (
        this.sec.symbols.SecCodeCopyGuestWithAttributes(
          null,
          attrs,
          0,
          ptr(out),
        ) !== 0 ||
        !out[0]
      )
        throw denied();
      refs.push(pointer(out));
      if (
        this.sec.symbols.SecCodeCheckValidity(pointer(out), 16, requirement) !==
        0
      )
        throw denied();
    });
    if (!sameProcess(before, processIdentity(pid))) throw denied();
    return {
      process: before,
      uid,
      executable,
      auditToken: auditToken.slice(),
      role,
    };
  }
}

export type NativeProcess = {
  process: ProcessIdentity;
  uid: number;
  parentPid: number;
  name: string;
  executable: string | null;
};
let processLibrary: ReturnType<typeof processSystem> | undefined;
const processSystem = () =>
  dlopen("/usr/lib/libproc.dylib", {
    proc_listallpids: { args: [P, I], returns: I },
    proc_pidinfo: { args: [I, I, FFIType.u64, P, I], returns: I },
    proc_pidpath: { args: [I, P, U], returns: I },
  });
function nativeProcess(pid: number): NativeProcess | null {
  if (process.platform !== "darwin") throw denied();
  const api = (processLibrary ??= processSystem()).symbols;
  const info = new Uint8Array(136);
  if (api.proc_pidinfo(pid, 3, 0, ptr(info), 136) !== 136) return null;
  const view = new DataView(info.buffer),
    uid = view.getUint32(20, true);
  if (uid !== process.getuid?.() || view.getUint32(4, true) === 5) return null;
  const path = new Uint8Array(4096);
  const pathLength = api.proc_pidpath(pid, ptr(path), path.length);
  const boot = ownProcessIdentity()?.bootId;
  if (!boot) throw denied();
  const identity = {
    pid,
    bootId: boot,
    birth: `${view.getBigUint64(120, true)}:${view.getBigUint64(128, true)}`,
  };
  return {
    process: identity,
    uid,
    name: new TextDecoder().decode(info.subarray(48, 64)).replace(/\0.*$/, ""),
    parentPid: view.getUint32(16, true),
    executable:
      pathLength > 0 ? realpathSync(new CString(ptr(path)).toString()) : null,
  };
}
/** Same-UID executable coverage only; process environments are never inspected. */
export function enumerateNativeProcesses(): NativeProcess[] {
  if (process.platform !== "darwin") throw denied();
  const api = (processLibrary ??= processSystem()).symbols;
  const count = api.proc_listallpids(null, 0);
  if (count <= 0 || count > 131072) throw denied();
  const pids = new Int32Array(count + 1024),
    actual = api.proc_listallpids(ptr(pids), pids.byteLength);
  if (actual < 0 || actual >= pids.length) throw denied();
  const result: NativeProcess[] = [];
  for (const pid of pids.subarray(0, actual)) {
    const value = nativeProcess(pid);
    if (value) result.push(value);
  }
  return result;
}
