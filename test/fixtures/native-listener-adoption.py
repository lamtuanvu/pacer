"""Fixed disposable OS boundary fixture; never installs a service."""
import array
import hashlib
import json
import os
import socket
import stat
import struct
import subprocess
import sys
import tempfile

mode = sys.argv[3]
directory = '/private/tmp/pacer-native-' + str(os.getuid())
try:
    os.mkdir(directory, 0o700)
except FileExistsError:
    pass
info = os.lstat(directory)
assert stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o077
assert os.path.realpath(directory) == directory

with tempfile.TemporaryDirectory(prefix='pacer-native-adoption-') as temporary:
    home = os.path.realpath(temporary)
    key = hashlib.sha256((home + '\n7543\n' + str(os.getuid())).encode()).hexdigest()[:32]
    path = directory + '/' + key + '.sock'
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    other = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    parent, child = socket.socketpair()
    process = None
    owner_inode = None
    socket_inode = None
    try:
        listener.bind(path)
        listener.listen(1)
        os.chmod(path, 0o600)
        socket_inode = os.lstat(path).st_ino
        # Only the decoy uses a relative name; the adopted listener retains its
        # exact absolute production path for the ownership/provenance checks.
        previous = os.getcwd()
        try:
            os.chdir(home)
            other.bind('other.sock')
        finally:
            os.chdir(previous)
        other.listen(1)
        process = subprocess.Popen([sys.argv[1], sys.argv[2], 'adopt', path], stdin=child,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        child.close()
        announcement = json.loads(process.stdout.readline())
        owner = announcement['owner']
        assert owner['pid'] == os.getpid()
        record = {'process': dict(owner), 'inode': socket_inode}
        if mode == 'birth': record['process']['birth'] = 'reused'
        if mode == 'inode': record['inode'] += 1
        if mode == 'process': record['process']['pid'] += 1000000
        if mode == 'permissions': os.chmod(path, 0o644)
        owner_path = path + '.owner'
        if mode == 'symlink':
            with open(home + '/owner', 'w') as output: json.dump(record, output)
            os.symlink(home + '/owner', owner_path)
        else:
            fd = os.open(owner_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as output: json.dump(record, output)
        owner_inode = os.lstat(owner_path).st_ino
        parent.sendmsg([b'P'], [(socket.SOL_SOCKET, socket.SCM_RIGHTS,
                                array.array('i', [(other if mode == 'path' else listener).fileno()]))])
        ready = json.loads(process.stdout.readline())
        if ready.get('phase') == 'listening':
            client_code = '''
import json,os,socket,struct,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.connect(sys.argv[1])
root=struct.unpack('8I',s.getsockopt(0,6,32))[5]
payload=b'{"ping":true}';s.sendall(struct.pack('!I',len(payload))+payload)
def exact(n):
 data=b''
 while len(data)<n:
  part=s.recv(n-len(data))
  if not part: raise RuntimeError('closed native channel')
  data+=part
 return data
reply=json.loads(exact(struct.unpack('!I',exact(4))[0]))
assert root==int(sys.argv[2]) and reply['pid']==os.getpid()
print(json.dumps({'client':os.getpid()}))
'''
            result = subprocess.run([sys.executable, '-c', client_code, path, str(os.getpid())],
                                    capture_output=True, text=True, timeout=5)
            assert result.returncode == 0, result.stderr
            completed = json.loads(process.stdout.readline())
            assert completed['peerPid'] == json.loads(result.stdout)['client']
            process.communicate(timeout=5)
            assert process.returncode == 0
            assert os.lstat(path).st_ino == socket_inode and os.lstat(owner_path).st_ino == owner_inode
            print(json.dumps({'accepted': True, 'originalPeer': True, 'rootListener': True, 'preservedSocket': True}))
        else:
            process.communicate(timeout=5)
            print(json.dumps({'accepted': False}))
    finally:
        if process and process.poll() is None:
            process.kill()
            process.wait()
        parent.close()
        child.close()
        listener.close()
        other.close()
        if socket_inode is not None and os.path.lexists(path) and os.lstat(path).st_ino == socket_inode:
            os.unlink(path)
        if owner_inode is not None and os.path.lexists(path + '.owner') and os.lstat(path + '.owner').st_ino == owner_inode:
            os.unlink(path + '.owner')
