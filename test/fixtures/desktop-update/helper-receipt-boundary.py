"""Synthetic transport scheduling only; never production helper authority."""
import array
import ctypes
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[3]


class ReceiptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix='pacer-helper-receipt-')
        source = (ROOT / 'src/update/desktop/native-socket.c').read_text()
        point = '    if (pacer_receive_rights(channel, reply, 5,'
        if source.count(point) != 1:
            raise RuntimeError('request receive scheduling point changed')
        source = source.replace(point, '    (void)poll((struct pacer_pollfd *)0, 0, 150);\n' + point)
        path = Path(cls.directory.name) / 'shim.c'
        path.write_text(source)
        library = path.with_suffix('.dylib')
        subprocess.run(['/usr/bin/clang', '-Wall', '-Wextra', '-Werror', '-dynamiclib', '-O2',
                        str(path), '-o', str(library)], check=True)
        cls.library = ctypes.CDLL(str(library))
        cls.request = cls.library.pacer_request_helper
        cls.request.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint,
                                ctypes.POINTER(ctypes.c_int)]
        cls.request.restype = ctypes.c_int

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def exchange(self, valid):
        root, core = socket.socketpair()
        reader, writer = os.pipe()
        output, output_writer = os.pipe()
        control, remote = socket.socketpair()
        errors = []
        receipts = []
        closed_sender = set()
        out = (ctypes.c_int * 4)(-1, -1, -1, -1)

        def server():
            try:
                root.settimeout(2)
                size = struct.unpack('>I', root.recv(4, socket.MSG_WAITALL))[0]
                root.recv(size, socket.MSG_WAITALL)
                payload = (b'H' if valid else b'X') + struct.pack('>I', 1234)
                root.sendmsg([payload], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                         array.array('i', [writer, output, remote.fileno()]))])
                receipt = root.recv(1)
                receipts.append(receipt)
                if valid:
                    if receipt != b'R':
                        raise RuntimeError('missing receipt acknowledgement')
                    remote.close()  # Only after C installed and validated every right.
                    for fd in [writer, output]:
                        os.close(fd)
                        closed_sender.add(fd)
                    control.sendall(struct.pack('>i', 7))
                    control.shutdown(socket.SHUT_WR)
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=server)
        thread.start()
        try:
            result = self.request(core.fileno(), b'{}', 2, out)
            thread.join(3)
            self.assertFalse(thread.is_alive())
            self.assertFalse(errors, repr(errors))
            if valid:
                self.assertEqual(result, 1234)
                self.assertEqual(receipts, [b'R'])
                os.write(out[0], b'I')
                self.assertEqual(os.read(reader, 1), b'I')
                os.write(output_writer, b'O')
                self.assertEqual(os.read(out[1], 1), b'O')
                self.assertEqual(os.read(out[2], 4), struct.pack('>i', 7))
                self.assertEqual(os.read(out[2], 1), b'')
            else:
                self.assertEqual(result, -1)
                self.assertEqual(list(out), [-1] * 4)
                self.assertNotEqual(receipts, [b'R'])
        finally:
            for fd in list(out)[:3]:
                if fd >= 0:
                    os.close(fd)
            for sock in [root, core, control, remote]:
                sock.close()
            for fd in [reader, writer, output, output_writer]:
                if fd not in closed_sender:
                    os.close(fd)

    def test_delayed_h_receipt_preserves_all_three_rights_until_r(self):
        self.exchange(True)

    def test_invalid_h_does_not_acknowledge_receipt(self):
        self.exchange(False)


if __name__ == '__main__':
    unittest.main()
