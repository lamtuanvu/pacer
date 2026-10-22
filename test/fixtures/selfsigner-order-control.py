"""Explicit GitHub-hosted-only no-trust option-order experiment; never normal test setup."""
import json
import os
from pathlib import Path
import platform
import shutil
import shlex
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


def search_command(stage, argv):
    # Never log argv/stdout/stderr: other keychain paths are private metadata.
    try:
        result = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=30)
    except subprocess.TimeoutExpired:
        records.append({'stage': stage, 'result': 'timeout-unknown'})
        observed_receipt('search-control.json', records)
        raise RuntimeError('search-list command timed out: ' + stage) from None
    except OSError:
        raise RuntimeError('search-list command unavailable: ' + stage) from None
    records.append({'stage': stage, 'code': result.returncode})
    observed_receipt('search-control.json', records)
    if result.returncode:
        raise RuntimeError('search-list command refused: ' + stage)
    return result.stdout


def read_search():
    data = search_command('read-user-search-list', ['/usr/bin/security', 'list-keychains', '-d', 'user'])
    if len(data) > 65536:
        raise RuntimeError('search metadata exceeds bound')
    try:
        paths = shlex.split(data.decode('utf8', 'strict'))
    except (ValueError, UnicodeError):
        raise RuntimeError('search metadata malformed') from None
    if len(paths) > 128 or any(not p.startswith('/') or '\x00' in p or '\n' in p or '\r' in p for p in paths):
        raise RuntimeError('search metadata paths refused')
    return paths


def set_search(paths):
    search_command('set-user-search-list', ['/usr/bin/security', 'list-keychains', '-d', 'user', '-s', *paths])


def restore_own_search():
    state = root / 'search-original.state'
    if not state.exists() and not state.is_symlink():
        return
    if os.environ.get('PACER_OWN_CERT_SEARCH_CONTROL') != '1' or guard() != root:
        raise RuntimeError('explicit hosted search cleanup required')
    info = state.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077 or info.st_size > 65536:
        raise RuntimeError('private search intent refused')
    metadata = json.loads(state.read_text())
    own = str(root / 'test.keychain-db')
    if metadata.get('own') != own or not isinstance(metadata.get('original'), list):
        raise RuntimeError('search intent binding refused')
    current = read_search()
    restored = [p for p in current if p != own]
    if current != restored:
        set_search(restored)
    actual = read_search()
    if actual != restored or own in actual:
        raise RuntimeError('own search removal not established')
    observed_receipt('search-restored.json', {'ownAbsent': True, 'currentOthersPreserved': True,
                     'originalExact': actual == metadata['original'], 'count': len(actual)})
    # Removal is proven even if diagnostic receipt storage failed.
    state.unlink()
    return actual == metadata['original']


def search_control(sign, sha1, owned):
    if os.environ.get('PACER_OWN_CERT_SEARCH_CONTROL') != '1' or guard() != root:
        raise RuntimeError('explicit hosted search experiment required')
    before = sign('L-search-A-original', sha1, False, owned)
    if before == 0:
        raise RuntimeError('original signing failure not reproduced; no search mutation')
    original = read_search()
    own = str(root / 'test.keychain-db')
    if own in original:
        raise RuntimeError('own keychain already in search list; experiment refused')
    # Private non-uploaded intent precedes any mutation, including an unknown timeout.
    write_receipt('search-original.state', {'own': own, 'original': original})
    if read_search() != original:
        raise RuntimeError('search list changed before append')
    set_search([*original, own])
    if read_search() != [*original, own]:
        raise RuntimeError('own search append not established')
    during = sign('M-search-B-appended', sha1, False, owned)
    original_exact = restore_own_search()
    after = sign('N-search-C-restored', sha1, False, owned)
    result = {'A': before, 'B': during, 'C': after,
              'originalExact': original_exact,
              'reversibleOwnEntryEffect': before != 0 and during == 0 and after != 0 and original_exact}
    write_receipt('search-comparison.json', result)
    return result


def cleanup():
    if not root.exists():
        return
    if root.resolve() != root or root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
        raise RuntimeError('cleanup ownership refused')
    restore_own_search()
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
                run(label+'-verify-pin', ['/usr/bin/codesign', '--verify', '--strict', '-R', '=identifier "dev.pacer.cli" and certificate leaf = H"'+sha1+'"', str(target)])
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
        # Capture the actual hosted tool's supported options and one fixed diagnostic attempt.
        run('hosted-codesign-help', ['/usr/bin/codesign', '--help'], False)
        diagnostic = root / 'K-owned-verbose'
        shutil.copyfile(owned, diagnostic)
        diagnostic.chmod(0o700)
        verbose = run('owned-codesign-verbose-six', ['/usr/bin/codesign', '--verbose=6', '--force', '--timestamp=none', '--keychain', keychain, '--sign', sha1, '--identifier', 'dev.pacer.cli', str(diagnostic)], False)
        results['ownedVerboseSix'] = verbose.returncode
        if verbose.returncode == 0:
            run('owned-verbose-verify-pin', ['/usr/bin/codesign', '--verify', '--strict', '-R', '=identifier "dev.pacer.cli" and certificate leaf = H"'+sha1+'"', str(diagnostic)])
        if os.environ.get('PACER_OWN_CERT_SEARCH_CONTROL') == '1':
            results['searchListControl'] = search_control(sign, sha1, owned)
        write_receipt('comparison.json', results)
        if os.environ.get('PACER_OWN_CERT_SEARCH_CONTROL') == '1':
            if not results['searchListControl']['reversibleOwnEntryEffect']:
                raise RuntimeError('reversible own search entry effect not established')
        elif results['keychainFirstSha'] != 0:
            raise RuntimeError('keychain-first SHA control did not resolve signing failure')
    finally:
        cleanup()

if receipt_errors:
    raise RuntimeError('control receipt writes failed; cleanup attempted, evidence incomplete')
