"""Explicit GitHub-hosted-only no-trust option-order experiment; never normal test setup."""
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
    if (os.environ.get('PACER_OWN_CERT_ORDER_CONTROL') != '1'
            or os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('RUNNER_ENVIRONMENT') != 'github-hosted'
            or platform.system() != 'Darwin'):
        raise RuntimeError('explicit disposable GitHub-hosted macOS control required')
    parent = Path(os.environ['RUNNER_TEMP'])
    if parent.resolve() != parent or not parent.is_dir() or parent.stat().st_uid != os.getuid():
        raise RuntimeError('runner temporary root refused')
    return parent / 'pacer-own-cert-order-control'


root = guard()
os.umask(0o077)
records = []
receipt_errors = []


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
    # Diagnostics must never prevent cleanup of the owned keychain.
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


def own_identity_probe(sha1):
    if guard() != root or len(sha1) != 40 or any(c not in '0123456789ABCDEF' for c in sha1):
        raise RuntimeError('own identity probe binding refused')
    if root.resolve() != root or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('own identity probe root refused')
    for name in ['cert.pem', 'test.keychain-db']:
        info = (root / name).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise RuntimeError('own identity probe file refused')
    run('own-public-der', ['/usr/bin/openssl', 'x509', '-in', str(root/'cert.pem'), '-outform', 'DER', '-out', str(root/'cert.der')])
    executable = root / 'own-identity-probe'
    source = Path(__file__).resolve().with_name('selfsigner-own-identity.c')
    run('compile-own-identity-probe', ['/usr/bin/clang', '-Wno-deprecated-declarations', str(source), '-framework', 'Security', '-framework', 'CoreFoundation', '-o', str(executable)])
    result = run('own-identity-public-api', [str(executable), str(root), sha1], False)
    return result.returncode


def cleanup():
    if not root.exists():
        return
    if root.resolve() != root or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('cleanup ownership refused')
    keychain = root / 'test.keychain-db'
    if keychain.exists():
        run('delete-own-keychain', ['/usr/bin/security', 'delete-keychain', str(keychain)])
    if keychain.exists():
        raise RuntimeError('own keychain remains')
    for name in ['key.pem', 'id.p12']:
        (root / name).unlink(missing_ok=True)
    observed_receipt('cleanup.json', {'keychainAbsent': True, 'privateFilesRemoved': True, 'trustNeverMutated': True})


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
        run('own-keychain-settings', ['/usr/bin/security', 'show-keychain-info', keychain])
        def sign(label, selector, keychain_first, source='/usr/bin/true'):
            target = root / label
            shutil.copyfile(source, target)
            target.chmod(0o700)
            options = ['--keychain', keychain, '--sign', selector] if keychain_first else ['--sign', selector, '--keychain', keychain]
            result = run(label, ['/usr/bin/codesign', '--force', '--timestamp=none'] + options + ['--identifier', 'dev.pacer.cli', str(target)], False)
            if result.returncode == 0:
                run(label+'-verify-pin', ['/usr/bin/codesign', '--verify', '--strict', '-R', 'identifier "dev.pacer.cli" and certificate leaf = H"'+sha1+'"', str(target)])
            return result.returncode
        run('own-identities', ['/usr/bin/security', 'find-identity', '-p', 'codesigning', keychain])
        results = {
            'originalSha': sign('A-original-sha', sha1, False),
            'keychainFirstSha': sign('B-keychain-first-sha', sha1, True),
            'originalShaRepeated': sign('C-original-sha-repeat', sha1, False),
            'keychainFirstCn': sign('D-keychain-first-cn', 'pacer trust test', True),
            'originalCn': sign('E-original-cn', 'pacer trust test', False),
        }
        run('immediate-own-unlock', ['/usr/bin/security', 'unlock-keychain', '-p', 'test', keychain])
        results['afterUnlockOriginalSha'] = sign('F-unlocked-original-sha', sha1, False)
        results['afterUnlockKeychainFirstSha'] = sign('G-unlocked-keychain-first-sha', sha1, True)
        # Same identity/keychain/selection; contrast platform bytes with user-target code.
        source = root / 'owned.c'
        owned = root / 'owned-fixture'
        source.write_text('int main(void) { return 0; }\n')
        run('compile-owned-target', ['/usr/bin/clang', '-x', 'c', str(source), '-o', str(owned)])
        run('target-architecture-metadata', ['/usr/bin/file', '/usr/bin/true', str(owned)])
        run('target-contrast-own-unlock', ['/usr/bin/security', 'unlock-keychain', '-p', 'test', keychain])
        results['ownedOriginalSha'] = sign('H-owned-original-sha', sha1, False, owned)
        results['ownedKeychainFirstSha'] = sign('I-owned-keychain-first-sha', sha1, True, owned)
        results['platformAfterOwnedSha'] = sign('J-platform-after-owned-sha', sha1, True)
        results['ownIdentityPublicApi'] = own_identity_probe(sha1)
        write_receipt('comparison.json', results)
        if results['keychainFirstSha'] != 0:
            raise RuntimeError('keychain-first SHA control did not resolve signing failure')
    finally:
        cleanup()

if receipt_errors:
    raise RuntimeError('control receipt writes failed; cleanup attempted, evidence incomplete')
