"""Execute the exact control with every subprocess mocked; no trust/keychain access."""
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).with_name('selfsigner-trust-control.py').read_text()
SHA = 'A' * 40


class Lifecycle(unittest.TestCase):
    def exercise(self, mode):
        with tempfile.TemporaryDirectory() as directory:
            parent = Path(directory).resolve()
            root = parent / 'pacer-own-cert-trust-control'
            calls = []
            trusted = False
            signatures = 0
            def fake(argv, **kwargs):
                nonlocal trusted, signatures
                calls.append(argv)
                code = 0
                output = b''
                if argv[1:2] == ['req']:
                    (root/'cert.pem').write_text('own synthetic public cert')
                    (root/'key.pem').write_text('disposable synthetic key')
                if argv[1:2] == ['pkcs12']:
                    (root/'id.p12').write_text('synthetic')
                if argv[1:2] == ['x509']:
                    output = ('SHA1 Fingerprint=' + SHA + '\n').encode()
                if argv[1:2] == ['create-keychain']:
                    (root/'test.keychain-db').touch()
                if argv[1:2] == ['add-trusted-cert']:
                    trusted = True
                    if mode == 'stale':
                        (root/'report.json.next').write_text('interrupted old receipt')
                    if mode == 'add-timeout':
                        raise subprocess.TimeoutExpired(argv, 30)
                if argv[1:2] == ['remove-trusted-cert']:
                    trusted = False
                if argv[1:2] == ['delete-keychain']:
                    (root/'test.keychain-db').unlink()
                if argv[0] == '/usr/bin/codesign' and '--sign' in argv:
                    signatures += 1
                    if signatures == 2 and mode == 'sign-timeout':
                        raise subprocess.TimeoutExpired(argv, 30)
                    if signatures == 2 and mode == 'exception':
                        raise OSError('synthetic pipe error')
                    code = 0 if trusted or mode == 'A-positive' else 1
                return subprocess.CompletedProcess(argv, code, output, b'')
            original_replace = os.replace
            def replace(source, target):
                if mode == 'receipt-error' and Path(target).name in ['report.json', 'cleanup.json', 'trust-removed.json']:
                    raise OSError('synthetic receipt failure')
                return original_replace(source, target)
            env = {'PACER_OWN_CERT_TRUST_CONTROL': '1', 'GITHUB_ACTIONS': 'true',
                   'RUNNER_ENVIRONMENT': 'github-hosted', 'RUNNER_TEMP': str(parent)}
            with patch.dict(os.environ, env), patch.object(platform, 'system', return_value='Darwin'), \
                    patch.object(subprocess, 'run', side_effect=fake), patch.object(sys, 'argv', ['control']), \
                    patch.object(os, 'replace', side_effect=replace):
                try:
                    exec(compile(SOURCE, 'exact-private-control', 'exec'), {})
                    error = None
                except Exception as failure:
                    error = failure
            self.assertFalse(trusted)
            self.assertFalse((root/'test.keychain-db').exists())
            self.assertFalse((root/'key.pem').exists())
            self.assertFalse((root/'id.p12').exists())
            add = [i for i, a in enumerate(calls) if a[1:2] == ['add-trusted-cert']]
            remove = [i for i, a in enumerate(calls) if a[1:2] == ['remove-trusted-cert']]
            delete = [i for i, a in enumerate(calls) if a[1:2] == ['delete-keychain']]
            if mode == 'A-positive':
                self.assertFalse(add)
                self.assertFalse(remove)
                self.assertIsNotNone(error)
            else:
                self.assertEqual(len(add), 1)
                self.assertEqual(len(remove), 1)
                self.assertLess(remove[0], delete[0])
                self.assertEqual(error is None, mode in ['normal', 'stale'])
            return calls

    def test_normal(self): self.exercise('normal')
    def test_stale_receipt_does_not_block_removal(self): self.exercise('stale')
    def test_positive_original_never_mutates_trust(self): self.exercise('A-positive')
    def test_exception_cleanup(self): self.exercise('exception')
    def test_timeout_after_unknown_trust_add(self): self.exercise('add-timeout')
    def test_sign_timeout_cleanup(self): self.exercise('sign-timeout')
    def test_observation_write_failure_does_not_block_cleanup(self): self.exercise('receipt-error')


if __name__ == '__main__':
    unittest.main()
