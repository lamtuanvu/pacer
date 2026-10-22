import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const driver = `
import array,json,os,socket,subprocess,sys,tempfile
with tempfile.TemporaryDirectory(prefix='pacer-native-handoff-') as root:
    listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    listener.bind(root+'/listener.sock');listener.listen(1)
    parent,child=socket.socketpair()
    process=subprocess.Popen([sys.argv[1],sys.argv[2],sys.argv[3]],stdin=child,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    child.close()
    mode=sys.argv[3]
    regular=open(root+'/regular','w+')
    if mode not in ['eof','timeout']:
        fds=[] if mode=='missing' else [regular.fileno() if mode=='regular' else listener.fileno()]*(16 if mode=='truncated' else 2 if mode=='extra' else 1)
        ancillary=[] if not fds else [(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',fds))]
        parent.sendmsg([b'X' if mode=='marker' else b'P'],ancillary)
        if mode=='leak':
            for n in range(50): parent.sendmsg([b'P'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[listener.fileno()]*2))])
    if mode=='eof': parent.close()
    stdout,stderr=process.communicate(timeout=12)
    parent.close()
    if process.returncode: raise RuntimeError(stderr)
    print(stdout.strip())
    sys.stderr.write(stderr)
    regular.close();listener.close()
`;

test.skipIf(process.platform !== "darwin")("native listener handoff accepts exactly one socket and closes malformed transfers", () => {
  const python = Bun.which("python3");
  if (!python) throw Error("python3 is required for the macOS descriptor boundary test");
  for (const mode of ["valid", "marker", "missing", "regular", "extra", "truncated", "eof", "timeout", "leak"]) {
    const result = Bun.spawnSync([python, "-c", driver, process.execPath, resolve("test/fixtures/native-listener-handoff.ts"), mode], {
      env: process.env, stdout: "pipe", stderr: "pipe", timeout: 15000,
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString()), mode + ": " + result.stderr.toString()).toEqual(mode === "valid" || mode === "leak" ? { accepted: true, socket: true } : { accepted: false });
  }
}, 30000);

test.skipIf(process.platform !== "darwin")("native descriptor wrapper matches the installed Darwin SDK ABI", () => {
  const source = `
#include <sys/socket.h>
#include <sys/time.h>
#include <stddef.h>
#define recvmsg pacer_abi_recvmsg
#define setsockopt pacer_abi_setsockopt
#define getsockopt pacer_abi_getsockopt
${readFileSync(resolve("src/update/desktop/native-socket.c"), "utf8")}
_Static_assert(sizeof(struct msghdr) == sizeof(struct pacer_msghdr), "message size");
_Static_assert(sizeof(struct cmsghdr) == sizeof(struct pacer_cmsghdr), "control size");
_Static_assert(sizeof(struct iovec) == sizeof(struct pacer_iovec), "vector size");
_Static_assert(sizeof(struct timeval) == 2 * sizeof(long), "timeout size");
_Static_assert(offsetof(struct msghdr, msg_iov) == offsetof(struct pacer_msghdr, iov), "vector offset");
_Static_assert(offsetof(struct msghdr, msg_control) == offsetof(struct pacer_msghdr, control), "control offset");
_Static_assert(offsetof(struct msghdr, msg_flags) == offsetof(struct pacer_msghdr, flags), "flags offset");
_Static_assert(CMSG_LEN(sizeof(int)) == 16 && CMSG_SPACE(8 * sizeof(int)) == 44, "rights layout");
_Static_assert(SOL_SOCKET == 0xffff && SCM_RIGHTS == 1 && SO_TYPE == 0x1008 && SO_RCVTIMEO == 0x1006, "socket options");
_Static_assert(MSG_TRUNC == 0x10 && MSG_CTRUNC == 0x20, "truncation flags");
`;
  const result = Bun.spawnSync(["/usr/bin/xcrun", "clang", "-x", "c", "-fsyntax-only", "-"], {
    stdin: Buffer.from(source), stdout: "pipe", stderr: "pipe", timeout: 10000,
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
