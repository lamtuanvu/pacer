"""Real Darwin Unix rights boundary checks for the additive helper shim."""
import array,ctypes,fcntl,json,os,pathlib,socket,struct,subprocess,tempfile,threading,unittest
ROOT=pathlib.Path(__file__).resolve().parents[3]
class Boundary(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  cls.tmp=tempfile.TemporaryDirectory(prefix='pacer-helper-channel-')
  lib=pathlib.Path(cls.tmp.name)/'shim.dylib'
  subprocess.run(['clang','-Wall','-Wextra','-Werror','-dynamiclib',str(ROOT/'src/update/desktop/native-socket.c'),'-o',str(lib)],check=True)
  cls.lib=ctypes.CDLL(str(lib));cls.receive=cls.lib.pacer_receive_helper_channel;cls.receive.argtypes=[ctypes.c_int];cls.receive.restype=ctypes.c_int
  cls.request=cls.lib.pacer_request_helper;cls.request.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint,ctypes.POINTER(ctypes.c_int)];cls.request.restype=ctypes.c_int
 @classmethod
 def tearDownClass(cls):cls.tmp.cleanup()
 def rights(self,s,data,fds):s.sendmsg([data],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',fds))]if fds else [])
 def test_startup_accepts_only_unix_stream_and_cloexec_blocking(self):
  a,b=socket.socketpair();x,y=socket.socketpair()
  try:
   self.rights(b,b'C',[x.fileno()]);fd=self.receive(a.fileno());self.assertGreaterEqual(fd,0)
   try:self.assertTrue(fcntl.fcntl(fd,fcntl.F_GETFD)&fcntl.FD_CLOEXEC);self.assertFalse(fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_NONBLOCK)
   finally:os.close(fd)
  finally:a.close();b.close();x.close();y.close()
 def test_startup_rejects_wrong_marker_missing_extra_and_pipe(self):
  for marker,count,pipe in [(b'P',1,False),(b'C',0,False),(b'C',2,False),(b'C',1,True)]:
   a,b=socket.socketpair();x,y=socket.socketpair();r,w=os.pipe();before=len(os.listdir('/dev/fd'))
   try:
    self.rights(b,marker,([r]if pipe else[x.fileno()])*count);self.assertEqual(self.receive(a.fileno()),-1);self.assertEqual(len(os.listdir('/dev/fd')),before)
   finally:a.close();b.close();x.close();y.close();os.close(r);os.close(w)
 def exchange(self,payload=b'H'+struct.pack('>I',1234),rights_mode='valid',fragment=False):
  a,b=socket.socketpair();r,w=os.pipe();r2,w2=os.pipe();x,y=socket.socketpair();errors=[];observed=[]
  os.set_blocking(w,False);os.set_blocking(r2,False)
  fds={'valid':[w,r2,x.fileno()],'missing':[w,r2],'extra':[w,r2,x.fileno(),w],'truncated':[w]*100,'reversed':[r,w2,x.fileno()],'regular':[],'none':[]}[rights_mode]
  regular=tempfile.TemporaryFile()
  if rights_mode=='regular':fds=[regular.fileno(),r2,x.fileno()]
  def server():
   try:
    size=struct.unpack('>I',b.recv(4,socket.MSG_WAITALL))[0];observed.append(b.recv(size,socket.MSG_WAITALL))
    if fragment:
     self.rights(b,payload[:1],fds)
     for byte in payload[1:]:b.sendall(bytes([byte]))
    else:self.rights(b,payload,fds)
   except BaseException as e:errors.append(e)
  t=threading.Thread(target=server);t.start();out=(ctypes.c_int*4)(-1,-1,-1,-1);request=b'{"schema":1}';before=len(os.listdir('/dev/fd'))
  try:
   pid=self.request(a.fileno(),request,len(request),out);t.join(2);self.assertFalse(t.is_alive());self.assertFalse(errors);self.assertEqual(observed,[request])
   if pid<0:self.assertEqual(list(out),[-1]*4);self.assertEqual(len(os.listdir('/dev/fd')),before)
   else:
    self.assertEqual(pid,1234)
    for fd in list(out)[:3]:self.assertTrue(fcntl.fcntl(fd,fcntl.F_GETFD)&fcntl.FD_CLOEXEC)
    os.write(out[0],b'I');self.assertEqual(os.read(r,1),b'I');os.write(w2,b'O');self.assertEqual(os.read(out[1],1),b'O')
    self.assertTrue(fcntl.fcntl(out[2],fcntl.F_GETFL)&os.O_NONBLOCK)
    sock=socket.socket(fileno=os.dup(out[2]));self.assertEqual(sock.getsockopt(socket.SOL_SOCKET,0x1022),1);sock.close()
    for fd in list(out)[:2]:self.assertFalse(fcntl.fcntl(fd,fcntl.F_GETFL)&os.O_NONBLOCK)
   return pid
  finally:
   for fd in list(out)[:3]:
    if fd>=0:os.close(fd)
   a.close();b.close();x.close();y.close();regular.close()
   for fd in[r,w,r2,w2]:os.close(fd)
 def test_response_accepts_fragmented_exact_frame_and_three_rights(self):self.assertEqual(self.exchange(fragment=True),1234)
 def test_rejects_right_counts_directions_regular_files_and_leaks(self):
  for mode in ['missing','extra','truncated','reversed','regular','none']:self.assertEqual(self.exchange(rights_mode=mode),-1)
 def test_rejects_invalid_markers_zero_pid_and_error_with_rights(self):
  for data in[b'X\0\0\0\1',b'H\0\0\0\0',b'E\0\0\0\0']:self.assertEqual(self.exchange(payload=data),-1)
 def test_error_without_rights_fails_closed(self):self.assertEqual(self.exchange(payload=b'E\0\0\0\0',rights_mode='none'),-1)
 def test_invalid_request_length_initializes_output(self):
  a,b=socket.socketpair();out=(ctypes.c_int*4)(7,7,7,7)
  try:
   self.assertEqual(self.request(a.fileno(),b'x',8193,out),-1);self.assertEqual(list(out),[-1]*4)
  finally:a.close();b.close()
 def test_listener_and_helper_startup_repeated_excess_rights_do_not_leak(self):
  for marker,receiver in [(b'P',self.lib.pacer_receive_listener),(b'C',self.receive)]:
   a,b=socket.socketpair();x,y=socket.socketpair();before=len(os.listdir('/dev/fd'))
   try:
    for count in [100]*50+[254]:
     self.rights(b,marker,[x.fileno()]*count);self.assertEqual(receiver(a.fileno()),-1)
     self.assertEqual(len(os.listdir('/dev/fd')),before)
   finally:a.close();b.close();x.close();y.close()
 def test_startup_rejects_datagram_and_inet_stream(self):
  for delivered in [socket.socket(socket.AF_UNIX,socket.SOCK_DGRAM),socket.socket(socket.AF_INET,socket.SOCK_STREAM)]:
   a,b=socket.socketpair()
   try:self.rights(b,b'C',[delivered.fileno()]);self.assertEqual(self.receive(a.fileno()),-1)
   finally:a.close();b.close();delivered.close()
 def test_sdk_layout_and_constants_match_both_supported_darwin_architectures(self):
  source=(ROOT/'src/update/desktop/native-socket.c').read_text()
  a=source.index('struct pacer_stat64 {');b=source.index('};',a)+2
  declarations=source[a:b]
  checks=r"""
#include <sys/stat.h>
#include <sys/socket.h>
#include <fcntl.h>
#include <time.h>
#include <stddef.h>
"""+declarations+r"""
_Static_assert(sizeof(struct pacer_stat64)==sizeof(struct stat), "stat size");
_Static_assert(offsetof(struct pacer_stat64,mode)==offsetof(struct stat,st_mode), "mode offset");
_Static_assert(CLOCK_MONOTONIC==6 && O_NONBLOCK==4 && FD_CLOEXEC==1, "fd/time constants");
_Static_assert(SOL_SOCKET==0xffff && SO_NOSIGPIPE==0x1022 && SO_TYPE==0x1008, "socket constants");
_Static_assert(AF_UNIX==1 && SOCK_STREAM==1 && MSG_DONTWAIT==0x80 && MSG_CTRUNC==0x20 && MSG_TRUNC==0x10, "message constants");
_Static_assert(CMSG_LEN(0)==12, "ancillary header ABI");
"""
  path=pathlib.Path(self.tmp.name)/'abi.c';path.write_text(checks)
  for arch in ['arm64','x86_64']:subprocess.run(['clang','-arch',arch,'-fsyntax-only','-Wall','-Werror',str(path)],check=True)
 def test_actual_bun_parent_spawner_stream_exit_abort_and_error_interop(self):
  for mode in ['echo','abort','malformed','eof']:
   a,b=socket.socketpair();r,w=os.pipe();r2,w2=os.pipe();x,y=socket.socketpair();errors=[]
   os.set_blocking(w,False);os.set_blocking(r2,False)
   def server():
    try:
     size=struct.unpack('>I',b.recv(4,socket.MSG_WAITALL))[0];json.loads(b.recv(size,socket.MSG_WAITALL))
     self.rights(b,b'H'+struct.pack('>I',os.getpid()),[w,r2,x.fileno()]);os.close(w);os.close(r2);x.close()
     if mode=='abort':self.assertEqual(y.recv(1),b'A');output=b''
     else:
      output=b''
      while True:
       data=os.read(r,4096)
       if not data:break
       output+=data
     __import__('time').sleep(0.03);os.write(w2,output);os.close(w2)
     if mode=='malformed':y.sendall(b'bad')
     elif mode!='eof':
      status=struct.pack('>i',-15 if mode=='abort' else 7);y.sendall(status[:2]);y.sendall(status[2:])
     y.shutdown(socket.SHUT_WR)
    except BaseException as error:errors.append(error)
   thread=threading.Thread(target=server);thread.start()
   try:
    try:run=subprocess.run(['bun',str(ROOT/'test/fixtures/desktop-update/helper-channel-client.ts'),mode],stdin=a,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=8)
    except subprocess.TimeoutExpired as error:
     print('BUN STDERR',error.stderr,flush=True);raise
    thread.join(2);self.assertFalse(thread.is_alive());self.assertFalse(errors);self.assertEqual(run.returncode,0,run.stderr.decode())
    result=json.loads(run.stdout);self.assertEqual(result['bytes'],''if mode=='abort' else 'input echo λ');self.assertEqual(result['rejected'],mode in ['malformed','eof']);self.assertEqual(result['exit'],None if mode in ['malformed','eof']else -15 if mode=='abort'else 7)
   finally:
    a.close();b.close();y.close()
    for fd in[r,w,r2,w2]:
     try:os.close(fd)
     except OSError:pass
if __name__=='__main__':unittest.main()
