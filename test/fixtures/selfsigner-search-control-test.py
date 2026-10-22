import ast,json,os,shlex,stat,subprocess,tempfile,unittest
from pathlib import Path
SOURCE=Path(__file__).with_name('selfsigner-order-control.py')
NAMES={'write_receipt','observed_receipt','search_command','read_search','set_search','restore_own_search','search_control'}
tree=ast.parse(SOURCE.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in NAMES]
class Search(unittest.TestCase):
 def exercise(self,mode):
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory).resolve()/'fixture';root.mkdir(mode=0o700)
   own=str(root/'test.keychain-db');original=['/fixture/unrelated-original.keychain'];current=original[:];calls=[];signs=[];sets=0;failed=False
   def subprocess_run(argv,**kwargs):
    nonlocal current,sets,failed
    calls.append(argv)
    if '-s' in argv:
     sets+=1
     if mode=='cleanup-set' and sets==2:raise subprocess.TimeoutExpired(argv,30)
     current=argv[argv.index('-s')+1:]
     if mode=='append-timeout' and sets==1:raise subprocess.TimeoutExpired(argv,30)
     if mode=='post-add-interrupt' and sets==1:raise KeyboardInterrupt()
     if mode=='stale' and sets==1:(root/'search-control.json.next').write_text('stale')
    elif mode=='cleanup-read' and sets==1 and len(signs)>=2 and not failed:
     failed=True;raise subprocess.TimeoutExpired(argv,30)
    output='\n'.join('"'+p+'"' for p in current).encode()
    if mode=='cleanup-verify' and sets==2 and not failed:
     failed=True;output=('"'+own+'"').encode()
    return subprocess.CompletedProcess(argv,0,output,b'')
   def sign(label,*args):
    signs.append(label)
    if len(signs)==1 and mode=='A-positive':return 0
    if len(signs)==2:
     if mode=='unknown-other':current.append('/fixture/unexpected-new.keychain')
     if mode=='sign-exception':raise RuntimeError('synthetic signing failure')
    return 0 if own in current else 1
   env={'PACER_OWN_CERT_SEARCH_CONTROL':'0' if mode=='no-optin' else '1'}
   g={'root':root,'guard':lambda:root,'os':os,'stat':stat,'Path':Path,'json':json,'shlex':shlex,'subprocess':subprocess,'tempfile':tempfile,'records':[],'receipt_errors':[]}
   exec(compile(ast.Module(body=nodes,type_ignores=[]),'exact-search-functions','exec'),g)
   original_replace=os.replace
   def replace(a,b):
    if mode=='receipt-failure' and Path(b).suffix=='.json':raise OSError('synthetic observer failure')
    return original_replace(a,b)
   from unittest.mock import patch
   error=None
   with patch.dict(os.environ,env),patch.object(subprocess,'run',side_effect=subprocess_run),patch.object(os,'replace',side_effect=replace):
    try:
     result=g['search_control'](sign,'A'*40,root/'owned')
     if mode=='unknown-other':self.assertFalse(result['reversibleOwnEntryEffect']);self.assertFalse(result['originalExact'])
    except BaseException as e:error=e
    try:g['restore_own_search']()
    except RuntimeError:
     # A cleanup read/set/verify failure must preserve intent; explicit later retry is modeled.
     self.assertTrue((root/'search-original.state').exists())
     if mode=='cleanup-set':mode='cleanup-set-retry'
     g['restore_own_search']()
   self.assertNotIn(own,current);self.assertIn(original[0],current)
   self.assertFalse((root/'search-original.state').exists())
   if mode=='unknown-other':self.assertIn('/fixture/unexpected-new.keychain',current)
   if mode in ['A-positive','no-optin']:self.assertEqual(sets,0);self.assertIsNotNone(error)
   else:self.assertGreaterEqual(sets,2)
   public=''.join(p.read_text() for p in root.glob('*.json'))
   self.assertNotIn(original[0],public);self.assertNotIn('/fixture/unexpected-new.keychain',public)
   self.assertFalse(any(a[1] in ['default-keychain','add-trusted-cert','remove-trusted-cert'] for a in calls))
 def test_explicit_optin_required(self):self.exercise('no-optin')
 def test_normal(self):self.exercise('normal')
 def test_A_positive(self):self.exercise('A-positive')
 def test_unknown_other_preserved(self):self.exercise('unknown-other')
 def test_append_timeout_unknown(self):self.exercise('append-timeout')
 def test_interrupt_after_add(self):self.exercise('post-add-interrupt')
 def test_stale_observation_temp(self):self.exercise('stale')
 def test_receipt_failure(self):self.exercise('receipt-failure')
 def test_sign_exception(self):self.exercise('sign-exception')
 def test_cleanup_read_failure(self):self.exercise('cleanup-read')
 def test_cleanup_set_failure(self):self.exercise('cleanup-set')
 def test_cleanup_verify_failure(self):self.exercise('cleanup-verify')
unittest.main()
