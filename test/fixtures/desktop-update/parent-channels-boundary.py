"""Real Darwin transport tests; no signed authority is enabled by this fixture."""
import array
import ctypes
import fcntl
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[3]


class ParentChannelsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='pacer-parent-channels-')
        cls.addClassCleanup(cls.directory.cleanup)
        library = Path(cls.directory.name) / 'shim.dylib'
        subprocess.run([
            '/usr/bin/clang', '-Wall', '-Wextra', '-Werror', '-dynamiclib', '-O2',
            str(ROOT / 'src/update/desktop/native-socket.c'), '-o', str(library),
        ], check=True)
        cls.library = ctypes.CDLL(str(library))
        cls.receive = cls.library.pacer_receive_parent_channels
        cls.receive.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        cls.receive.restype = ctypes.c_int
        cls.ack = cls.library.pacer_acknowledge_parent
        cls.ack.argtypes = [ctypes.c_int]
        cls.ack.restype = ctypes.c_int

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix='pacer-parent-receiver-')
        self.addCleanup(self.directory.cleanup)
        self.listener = socket.socket(socket.AF_UNIX)
        self.addCleanup(self.listener.close)
        # Only the listener's descriptor/type is under test, not its absolute
        # pathname. Keep sun_path short inside the private, managed temp root.
        previous = os.getcwd()
        try:
            os.chdir(self.directory.name)
            self.listener.bind('listener')
        finally:
            os.chdir(previous)
        self.listener.listen(1)
        self.root, self.core = socket.socketpair()
        self.addCleanup(self.root.close)
        self.addCleanup(self.core.close)
        self.helpers, self.remote = socket.socketpair()
        self.addCleanup(self.helpers.close)
        self.addCleanup(self.remote.close)
        self.out = (ctypes.c_int * 2)(-1, -1)
        self.addCleanup(self.close_received)

    def close_received(self):
        for fd in self.out:
            if fd >= 0:
                os.close(fd)

    def send(self, marker=b'B', fds=None):
        if fds is None:
            fds = [self.listener.fileno(), self.remote.fileno()]
        controls = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array('i', fds))] if fds else []
        self.root.sendmsg([marker], controls)

    def test_delayed_receipt_ack_precedes_source_close_and_channels_work(self):
        self.send()
        time.sleep(0.15)  # Exceeds the observed Darwin queued-rights failure interval.
        self.assertEqual(self.receive(self.core.fileno(), self.out), 0)
        self.assertTrue(fcntl.fcntl(self.out[0], fcntl.F_GETFL) & os.O_NONBLOCK)
        self.assertFalse(fcntl.fcntl(self.out[1], fcntl.F_GETFL) & os.O_NONBLOCK)
        for fd in self.out:
            self.assertTrue(fcntl.fcntl(fd, fcntl.F_GETFD) & fcntl.FD_CLOEXEC)
        self.root.setblocking(False)
        with self.assertRaises(BlockingIOError):
            self.root.recv(1)  # Receipt alone does not ACK before TS revalidation.
        self.assertEqual(self.ack(self.core.fileno()), 0)
        self.assertEqual(self.root.recv(1), b'A')
        self.remote.close()
        self.helpers.sendall(b'R')
        self.assertEqual(os.read(self.out[1], 1), b'R')
        os.write(self.out[1], b'C')
        self.assertEqual(self.helpers.recv(1), b'C')

    def test_refuses_bad_marker_missing_extra_and_reversed_roles_without_leaks(self):
        for marker, fds in [
            (b'P', [self.listener.fileno(), self.remote.fileno()]),
            (b'B', []),
            (b'B', [self.listener.fileno()]),
            (b'B', [self.remote.fileno(), self.listener.fileno()]),
            (b'B', [self.listener.fileno(), self.listener.fileno()]),
        ]:
            before = len(os.listdir('/dev/fd'))
            self.send(marker, fds)
            self.assertEqual(self.receive(self.core.fileno(), self.out), -1)
            self.assertEqual(list(self.out), [-1, -1])
            self.assertEqual(len(os.listdir('/dev/fd')), before)

    def test_legacy_coalesced_p_c_refused_and_all_rights_closed(self):
        before = len(os.listdir('/dev/fd'))
        self.root.sendmsg([b'PC'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                  array.array('i', [self.listener.fileno(), self.remote.fileno()]))])
        self.assertEqual(self.receive(self.core.fileno(), self.out), -1)
        self.assertEqual(list(self.out), [-1, -1])
        self.assertEqual(len(os.listdir('/dev/fd')), before)

    def test_repeated_100_and_254_rights_refusals_close_every_installed_fd(self):
        before = len(os.listdir('/dev/fd'))
        for count in [100, 254] * 5:
            self.send(fds=[self.listener.fileno()] * count)
            self.assertEqual(self.receive(self.core.fileno(), self.out), -1)
            self.assertEqual(list(self.out), [-1, -1])
            self.assertEqual(len(os.listdir('/dev/fd')), before)

    def test_regular_file_role_refused(self):
        with tempfile.TemporaryFile() as regular:
            self.send(fds=[self.listener.fileno(), regular.fileno()])
            self.assertEqual(self.receive(self.core.fileno(), self.out), -1)
            self.assertEqual(list(self.out), [-1, -1])

    def test_eof_and_ack_closed_peer_fail_without_sigpipe(self):
        self.root.close()
        self.assertEqual(self.receive(self.core.fileno(), self.out), -1)
        self.assertEqual(list(self.out), [-1, -1])
        self.assertEqual(self.ack(self.core.fileno()), -1)

    def test_receive_timeout_is_bounded(self):
        started = time.monotonic()
        self.assertEqual(self.receive(self.core.fileno(), self.out), -1)
        self.assertGreater(time.monotonic() - started, 9)
        self.assertLess(time.monotonic() - started, 12)
        self.assertEqual(list(self.out), [-1, -1])


if __name__ == '__main__':
    unittest.main()
