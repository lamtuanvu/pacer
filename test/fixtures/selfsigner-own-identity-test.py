import ast,os,stat,tempfile,unittest
from pathlib import Path
SOURCE=Path(__file__).with_name('selfsigner-order-control.py')
tree=ast.parse(SOURCE.read_text()); function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='own_identity_probe')
class Probe(unittest.TestCase):
 def exercise(self,mode):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp).resolve()/'fixture';root.mkdir(mode=0o700)
   for name in ['cert.pem','test.keychain-db']:
    (root/name).write_text('synthetic');(root/name).chmod(0o600)
   calls=[]
   def run(stage,argv,required=True):
    calls.append((stage,argv,required))
    class R:returncode=0
    return R()
   sha='A'*40
   if mode=='pin':sha='A'*39+'/'
   if mode=='wide':(root/'test.keychain-db').chmod(0o644)
   if mode=='symlink':
    (root/'cert.pem').unlink();(root/'cert.pem').symlink_to(root/'test.keychain-db')
   if mode=='hardlink':
    (root/'cert.pem').unlink();os.link(root/'test.keychain-db',root/'cert.pem')
   g={'guard':lambda:root if mode!='binding' else root/'other','root':root,'os':os,'stat':stat,'Path':Path,'__file__':str(SOURCE),'run':run}
   exec(compile(ast.Module(body=[function],type_ignores=[]),'exact-probe-helper','exec'),g)
   if mode!='normal':
    with self.assertRaises(RuntimeError):g['own_identity_probe'](sha)
    self.assertEqual(calls,[])
   else:
    self.assertEqual(g['own_identity_probe'](sha),0)
    self.assertEqual([c[0] for c in calls],['own-public-der','compile-own-identity-probe','own-identity-public-api'])
    self.assertEqual(calls[-1][1],[str(root/'own-identity-probe'),str(root),sha]);self.assertFalse(calls[-1][2])
    self.assertEqual(calls[0][1],['/usr/bin/openssl','x509','-in',str(root/'cert.pem'),'-outform','DER','-out',str(root/'cert.der')])
    self.assertEqual(calls[1][1][0],'/usr/bin/clang')
    self.assertFalse(any(token in ['-nodes', '-inkey', 'export', 'add-trusted-cert'] for call in calls for token in call[1]))
 def test_all_diagnostic_cli_requirements_are_literal_text(self):
  observed=[]
  for name in ['selfsigner-order-control.py','selfsigner-trust-control.py']:
   source=Path(__file__).with_name(name)
   for node in ast.walk(ast.parse(source.read_text())):
    if not isinstance(node,ast.Call) or not isinstance(node.func,ast.Name) or node.func.id!='run' or len(node.args)<2 or not isinstance(node.args[1],ast.List):continue
    if not any(isinstance(item,ast.Constant) and item.value=='-R' for item in node.args[1].elts):continue
    argv=eval(compile(ast.Expression(body=node.args[1]),'exact-diagnostic-argv','eval'),{'sha1':'A'*40,'str':str,'target':Path('/fixture/target'),'diagnostic':Path('/fixture/diagnostic')})
    self.assertEqual(argv[0],'/usr/bin/codesign')
    self.assertEqual(argv[argv.index('-R')+1],'=identifier "dev.pacer.cli" and certificate leaf = H"'+'A'*40+'"')
    observed.append(argv)
  self.assertEqual(len(observed),3)
 def test_fixed_commands(self):self.exercise('normal')
 def test_pin(self):self.exercise('pin')
 def test_binding(self):self.exercise('binding')
 def test_symlink(self):self.exercise('symlink')
 def test_hardlink(self):self.exercise('hardlink')
 def test_wide_keychain(self):self.exercise('wide')
unittest.main()
