"""Explicit GitHub-hosted-only signing-eligibility experiment; never normal test setup."""
import json
import os
from pathlib import Path
import platform
import shutil
import stat
import subprocess
import sys
import tempfile


def guard():
    if (os.environ.get('PACER_OWN_CERT_TRUST_CONTROL') != '1'
            or os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted'
            or platform.system() != 'Darwin'):
        raise RuntimeError('explicit disposable GitHub-hosted macOS control required')
    parent = Path(os.environ['RUNNER_TEMP'])
    if parent.resolve() != parent or not parent.is_dir() or parent.stat().st_uid != os.getuid():
        raise RuntimeError('runner temporary root refused')
    return parent / 'pacer-own-cert-trust-control'


root = guard()
os.umask(0o077)
records = []
receipt_errors = []
trust_removed_confirmed = False


def write_receipt(name, value):
    fd, temporary = tempfile.mkstemp(prefix='receipt-', dir=root)
    try:
        with os.fdopen(fd, 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, root / name)
    finally:
        Path(temporary).unlink(missing_ok=True)


def observed_receipt(name, value):
    # Diagnostics must never prevent the exact own-trust cleanup command.
    try:
        write_receipt(name, value)
    except OSError:
        receipt_errors.append(name)


def run(stage, argv, required=True):
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30)
        def public(data):
            text = data.decode('utf8', 'replace').replace(str(root), '<fixture>')
            home = os.environ.get('HOME')
            if home:
                text = text.replace(home, '<home>')
            return text.encode('utf8')[:4096].decode('utf8', 'ignore')
        records.append({'stage': stage, 'code': result.returncode,
                        'stdout': public(result.stdout), 'stderr': public(result.stderr)})
        observed_receipt('cleanup-attempts.json' if sys.argv[1:] == ['--cleanup'] else 'report.json', records)
        if required and result.returncode:
            raise RuntimeError('fixed control command refused: ' + stage)
        return result
    except subprocess.TimeoutExpired:
        records.append({'stage': stage, 'result': 'timeout-unknown'})
        observed_receipt('cleanup-attempts.json' if sys.argv[1:] == ['--cleanup'] else 'report.json', records)
        raise RuntimeError('fixed control command timed out: ' + stage)


def fingerprint():
    output = run('own-public-fingerprint', ['/usr/bin/openssl', 'x509', '-noout',
                 '-fingerprint', '-sha1', '-in', str(root / 'cert.pem')]).stdout
    value = output.decode().strip().rsplit('=', 1)[-1].replace(':', '')
    if len(value) != 40 or any(c not in '0123456789ABCDEF' for c in value):
        raise RuntimeError('fixture fingerprint refused')
    return value


def cleanup():
    global trust_removed_confirmed
    if not root.exists():
        return
    if root.resolve() != root or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('cleanup ownership refused')
    intent = root / 'trust-intent.json'
    if intent.exists():
        for path in [intent, root / 'cert.pem']:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1:
                raise RuntimeError('cleanup receipt refused')
        expected = json.loads(intent.read_text())['certificateSha1']
        if fingerprint() != expected:
            raise RuntimeError('cleanup certificate identity refused')
        if not trust_removed_confirmed and not (root / 'trust-removed.json').exists():
            run('remove-own-trust', ['/usr/bin/security', 'remove-trusted-cert', str(root / 'cert.pem')])
            trust_removed_confirmed = True
            observed_receipt('trust-removed.json', {'certificateSha1': expected, 'removed': True})
    keychain = root / 'test.keychain-db'
    if keychain.exists():
        run('delete-own-keychain', ['/usr/bin/security', 'delete-keychain', str(keychain)])
    if keychain.exists():
        raise RuntimeError('own keychain remains')
    for name in ['key.pem', 'id.p12']:
        (root / name).unlink(missing_ok=True)
    observed_receipt('cleanup.json', {'keychainAbsent': True, 'privateFilesRemoved': True,
                                 'trustRemovalConfirmed': not intent.exists() or trust_removed_confirmed or (root / 'trust-removed.json').exists()})


if sys.argv[1:] == ['--cleanup']:
    cleanup()
elif sys.argv[1:]:
    raise RuntimeError('unsupported control argument')
else:
    root.mkdir(mode=0o700)
    try:
        (root / 'cs.cnf').write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=pacer trust test\n[ext]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\n')
        run('generate', ['/usr/bin/openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-keyout', str(root/'key.pem'), '-out', str(root/'cert.pem'), '-config', str(root/'cs.cnf')])
        export = ['/usr/bin/openssl', 'pkcs12', '-export', '-passout', 'pass:test', '-inkey', str(root/'key.pem'), '-in', str(root/'cert.pem'), '-out', str(root/'id.p12')]
        if run('export-legacy', export[:3] + ['-legacy'] + export[3:], False).returncode:
            run('export-fallback', export)
        keychain = str(root/'test.keychain-db')
        for stage, args in [('create', ['create-keychain', '-p', 'test', keychain]),
                            ('unlock', ['unlock-keychain', '-p', 'test', keychain]),
                            ('import', ['import', str(root/'id.p12'), '-k', keychain, '-P', 'test', '-T', '/usr/bin/codesign']),
                            ('partition', ['set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', 'test', keychain])]:
            run(stage, ['/usr/bin/security'] + args)
        sha1 = fingerprint()
        def sign(label):
            run(label+'-identities', ['/usr/bin/security', 'find-identity', '-p', 'codesigning', keychain])
            target = root / label
            shutil.copyfile('/usr/bin/true', target)
            target.chmod(0o700)
            result = run(label+'-sign', ['/usr/bin/codesign', '--force', '--timestamp=none', '--sign', sha1, '--keychain', keychain, '--identifier', 'dev.pacer.cli', str(target)], False)
            if result.returncode == 0:
                run(label+'-verify-pin', ['/usr/bin/codesign', '--verify', '--strict', '-R', '=identifier "dev.pacer.cli" and certificate leaf = H"'+sha1+'"', str(target)])
            return result.returncode
        before = sign('A')
        if before == 0:
            write_receipt('comparison.json', {'A': before, 'result': 'original failure not reproduced; no trust mutation'})
            raise RuntimeError('original failure not reproduced; trust experiment refused')
        write_receipt('trust-intent.json', {'certificateSha1': sha1, 'policy': 'codeSign', 'application': '/usr/bin/codesign'})
        run('add-own-policy-trust', ['/usr/bin/security', 'add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-a', '/usr/bin/codesign', '-k', keychain, str(root/'cert.pem')])
        during = sign('B')
        run('remove-own-trust', ['/usr/bin/security', 'remove-trusted-cert', str(root/'cert.pem')])
        trust_removed_confirmed = True
        observed_receipt('trust-removed.json', {'certificateSha1': sha1, 'removed': True})
        after = sign('C')
        write_receipt('comparison.json', {'A': before, 'B': during, 'C': after,
                      'reversibleTrustEffect': before != 0 and during == 0 and after != 0})
        if not (before != 0 and during == 0 and after != 0):
            raise RuntimeError('reversible trust hypothesis NOT established')
    finally:
        cleanup()

if receipt_errors:
    raise RuntimeError('control receipt writes failed; cleanup attempted, evidence incomplete')
