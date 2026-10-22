import array
import ctypes
import os
import pathlib
import socket
import struct
import subprocess
import tempfile
import threading
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[3]


class FailureTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.library = pathlib.Path(cls.tmp.name) / 'shim.dylib'
        source = pathlib.Path(cls.tmp.name) / 'test.c'
        source.write_text(
            (ROOT / 'src/update/desktop/native-socket.c').read_text()
            + "\nint pacer_test_wait(int fd, int expired, int *out) {"
            + "return pacer_wait(fd, 1, pacer_millis() + (expired ? -1 : 10), out, 8); }"
        )
        subprocess.run(
            [
                '/usr/bin/clang', '-Wall', '-Wextra', '-Werror',
                '-dynamiclib', '-O2', str(source), '-o', str(cls.library),
            ],
            check=True,
        )
        cls.lib = ctypes.CDLL(str(cls.library))
        cls.request = cls.lib.pacer_request_helper
        cls.request.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint, ctypes.POINTER(ctypes.c_int)]
        cls.request.restype = ctypes.c_int

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def exchange(self, mode):
        a, b = socket.socketpair()
        r, w = os.pipe()
        r2, w2 = os.pipe()
        x, y = socket.socketpair()
        errors = []
        diagnostic = []

        def server():
            try:
                size = struct.unpack('>I', b.recv(4, socket.MSG_WAITALL))[0]
                b.recv(size, socket.MSG_WAITALL)
                if mode == 'eof':
                    b.shutdown(socket.SHUT_WR)
                else:
                    payload = b'H' + struct.pack('>I', 1234)
                    if mode == 'bad-marker':
                        payload = b'X' + payload[1:]
                    fds = [w, r2, x.fileno()] if mode != 'excess-rights' else [w] * 100
                    b.sendmsg([payload], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', fds))])
                diagnostic.append(b.recv(3, socket.MSG_WAITALL))
            except BaseException as e:
                errors.append(e)
        before = len(os.listdir('/dev/fd'))
        t = threading.Thread(target=server)
        t.start()
        out = (ctypes.c_int * 4)(7, 7, 7, 7)
        try:
            self.assertEqual(self.request(a.fileno(), b'{}', 2, out), -1)
            t.join(2)
            self.assertFalse(t.is_alive())
            self.assertFalse(errors)
            self.assertEqual(list(out), [-1] * 4)
            self.assertEqual(len(os.listdir('/dev/fd')), before)
            return diagnostic[0]
        finally:
            a.close()
            b.close()
            x.close()
            y.close()
            for fd in [r, w, r2, w2]:
                os.close(fd)

    def test_eof_has_receive_stage_and_no_fd_leak(self):
        self.assertEqual(self.exchange('eof'), b'D\t\t')

    def test_logical_reply_error_is_not_stale_errno(self):
        self.assertEqual(self.exchange('bad-marker'), b'D\x0b\x01')

    def test_excess_rights_closed_and_ancillary_reason_distinct(self):
        for _ in range(10):
            self.assertEqual(self.exchange('excess-rights'), b'D\n\x0b')

    def test_wait_reports_deadline_timeout_and_invalid_poll_descriptor(self):
        wait = self.lib.pacer_test_wait
        wait.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        wait.restype = ctypes.c_int
        a, b = socket.socketpair()
        out = (ctypes.c_int * 2)(0, 0)
        try:
            self.assertEqual(wait(a.fileno(), 1, out), -1)
            self.assertEqual(list(out), [8, 3])
            self.assertEqual(wait(a.fileno(), 0, out), -1)
            self.assertEqual(list(out), [8, 4])
            r, w = os.pipe()
            os.close(r)
            try:
                self.assertEqual(wait(r, 0, out), -1)
                self.assertEqual(list(out), [8, 6])
            finally:
                os.close(w)
        finally:
            a.close()
            b.close()

    def test_success_keeps_output_and_emits_no_diagnostic(self):
        a, b = socket.socketpair()
        r, w = os.pipe()
        r2, w2 = os.pipe()
        x, y = socket.socketpair()

        def server():
            size = struct.unpack('>I', b.recv(4, socket.MSG_WAITALL))[0]
            b.recv(size, socket.MSG_WAITALL)
            b.sendmsg([b'H' + struct.pack('>I', 1234)], [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', [w, r2, x.fileno()]))])
        t = threading.Thread(target=server)
        t.start()
        out = (ctypes.c_int * 4)(-1, -1, -1, -1)
        try:
            self.assertEqual(self.request(a.fileno(), b'{}', 2, out), 1234)
            t.join(2)
            self.assertFalse(t.is_alive())
            self.assertEqual(b.recv(1), b'R')
            b.setblocking(False)
            with self.assertRaises(BlockingIOError):
                b.recv(4)
        finally:
            for fd in list(out)[:3]:
                if fd >= 0:
                    os.close(fd)
            a.close()
            b.close()
            x.close()
            y.close()
            for fd in [r, w, r2, w2]:
                os.close(fd)

    def test_unconfigured_nosigpipe_guard_does_not_report(self):
        a, b = socket.socketpair()
        out = (ctypes.c_int * 4)(7, 7, 7, 7)
        try:
            self.assertEqual(self.request(a.fileno(), b'x', 8193, out), -1)
            self.assertEqual(list(out), [-1] * 4)
            self.assertEqual(b.recv(4), b'')
        finally:
            a.close()
            b.close()
if __name__ == '__main__':
    unittest.main()
