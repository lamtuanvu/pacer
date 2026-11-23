"""A paired native Core's secrets frame on its parent channel (#918, ADR 0027 item 9).

The parent sends `B` with two rights, waits for Core's `A`, then writes the frame. Core
receives `B` with the real descriptor shim (a one-byte buffer), acknowledges, and reads the
frame with its real reader. No signed authority is enabled by this fixture.
"""
import array
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]
BUN = os.environ['PACER_TEST_BUN']
SECRETS = {'internalToken': 'a' * 64, 'ownerKey': 'b' * 64}
BODY = json.dumps(SECRETS, separators=(',', ':')).encode()
FRAME = b'pacer-core-secrets/1 %d\n' % len(BODY) + BODY

CORE = '''
import { dlopen, FFIType, ptr } from "bun:ffi";
import { readSync } from "node:fs";
import { readCoreSecrets } from %(reader)s;
const shim = dlopen(process.env.PACER_TEST_SHIM!, {
  pacer_receive_parent_channels: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  pacer_acknowledge_parent: { args: [FFIType.i32], returns: FFIType.i32 },
});
const out = new Int32Array([-1, -1]);
const result: Record<string, unknown> = { received: shim.symbols.pacer_receive_parent_channels(0, ptr(out)) };
const early = process.env.PACER_TEST_MODE === "early";
const read = () => {
  try { result.secrets = readCoreSecrets(0, early ? 500 : 10000); } catch (error) { result.error = (error as Error).message; }
};
if (early) read();
result.acked = shim.symbols.pacer_acknowledge_parent(0);
if (!early) {
  read();
  const next = Buffer.alloc(1);
  result.next = readSync(0, next, 0, 1, null) === 1 ? next.toString() : null;
}
console.log(JSON.stringify(result));
'''


class PairedSecretsFrameTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='pacer-paired-secrets-')
        cls.addClassCleanup(cls.directory.cleanup)
        cls.shim = Path(cls.directory.name) / 'shim.dylib'
        subprocess.run([
            '/usr/bin/clang', '-Wall', '-Wextra', '-Werror', '-dynamiclib', '-O2',
            str(ROOT / 'src/update/desktop/native-socket.c'), '-o', str(cls.shim),
        ], check=True)
        cls.core = Path(cls.directory.name) / 'core.ts'
        cls.core.write_text(CORE % {'reader': json.dumps(str(ROOT / 'src/core-secrets.ts'))})

    def run_core(self, mode):
        listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(listener.close)
        previous = os.getcwd()
        try:
            os.chdir(self.directory.name)
            listener.bind('listener-' + mode)
        finally:
            os.chdir(previous)
        listener.listen(1)
        root, core = socket.socketpair()
        helpers, remote = socket.socketpair()
        for s in (root, core, helpers, remote):
            self.addCleanup(s.close)
        root.sendmsg([b'B'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                               array.array('i', [listener.fileno(), remote.fileno()]))])
        if mode == 'queued':
            root.sendall(FRAME + b'S')
        child = subprocess.Popen([BUN, str(self.core)], stdin=core.fileno(), stdout=subprocess.PIPE,
                                 env={**os.environ, 'PACER_TEST_SHIM': str(self.shim), 'PACER_TEST_MODE': mode})
        self.addCleanup(lambda: child.poll() is None and child.kill())
        core.close()
        root.settimeout(15)
        self.assertEqual(root.recv(1), b'A')
        if mode != 'queued':
            try:
                root.sendall(FRAME + b'S')
            except (BrokenPipeError, ConnectionResetError):
                # An early-reading Core fails and exits right after its ack, so it may close
                # its end before this write; its result below is what the test checks.
                if mode != 'early':
                    raise
        out, _ = child.communicate(timeout=30)
        self.assertEqual(child.returncode, 0)
        return json.loads(out.decode().strip().splitlines()[-1])

    def test_frame_after_ack_is_read_exactly(self):
        result = self.run_core('after-ack')
        self.assertEqual(result, {'received': 0, 'acked': 0, 'secrets': SECRETS, 'next': 'S'})

    def test_frame_queued_behind_b_survives_the_one_byte_receipt(self):
        result = self.run_core('queued')
        self.assertEqual(result, {'received': 0, 'acked': 0, 'secrets': SECRETS, 'next': 'S'})

    def test_core_reading_before_its_ack_gets_no_frame(self):
        result = self.run_core('early')
        self.assertEqual(result['received'], 0)
        self.assertEqual(result['acked'], 0)
        self.assertNotIn('secrets', result)
        self.assertIn('frame is missing', result['error'])


if __name__ == '__main__':
    unittest.main()
