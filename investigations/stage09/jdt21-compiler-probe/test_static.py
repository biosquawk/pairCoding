"""STATIC ONLY: artifact/byte provenance; not Java/Docker/compiler behavior."""
import hashlib, io, json, pathlib, struct, tarfile, unittest, zipfile
HERE=pathlib.Path(__file__).resolve().parent
sha=lambda b:hashlib.sha256(b).hexdigest()
class Static(unittest.TestCase):
 def test_source_manifest_exact_and_no_symlinks(self):
  m=json.loads((HERE/'source-manifest.json').read_text());actual=[q for q in HERE.rglob('*') if q.is_file() and q.name!='source-manifest.json'];self.assertEqual(set(m),{str(q.relative_to(HERE)) for q in actual})
  for q in actual:self.assertFalse(q.is_symlink());self.assertEqual(sha(q.read_bytes()),m[str(q.relative_to(HERE))])
 def test_primary_from_original_wire_and_accepted_source(self):
  p=json.loads((HERE/'provenance.json').read_text()); b=(HERE/'sources/preview/Demo.java').read_bytes()
  self.assertEqual(sha(b),p['exactSnippet']['sha256']);self.assertEqual(b,(HERE.parent/'jdt21/raw/Demo.java').read_bytes())
  wire=pathlib.Path(p['exactSnippet']['source']);self.assertEqual(sha(wire.read_bytes()),p['exactSnippet']['sourceSha256'])
  rows=[json.loads(x) for x in wire.read_text().splitlines()];texts=[r['message']['params']['textDocument']['text'] for r in rows if r.get('direction')=='out' and r.get('message',{}).get('method')=='textDocument/didOpen']
  self.assertIn(b,[s.encode() for s in texts]);self.assertIn(b'\r\n',b)
 def test_original_evidence_refs_still_match(self):
  p=json.loads((HERE/'provenance.json').read_text())
  for r in p['references'].values():self.assertEqual(sha(pathlib.Path(r['path']).read_bytes()),r['sha256'])
 def test_exact_archive_class_compatibility(self):
  p=json.loads((HERE/'compatibility.json').read_text());a=pathlib.Path(p['archive']);self.assertEqual(sha(a.read_bytes()),p['archiveSha256'])
  with tarfile.open(a) as t:b=t.extractfile(p['jar']).read()
  self.assertEqual(sha(b),p['jarSha256'])
  with zipfile.ZipFile(io.BytesIO(b)) as z:
   c=z.read(p['mainClass']);self.assertEqual(sha(c),p['mainClassSha256']);self.assertEqual(struct.unpack('>H',c[6:8])[0],61)
   majors=[struct.unpack('>H',z.read(n)[6:8])[0] for n in z.namelist() if n.endswith('.class')];self.assertEqual(set(majors),{61});self.assertEqual(len(majors),812)
   self.assertIn(b'Main-Class: org.eclipse.jdt.internal.compiler.batch.Main',z.read('META-INF/MANIFEST.MF'))
   self.assertIn(b'--release',c);self.assertIn(b'-log',c);self.assertIn(b'-proc:none',c)
   logger=z.read('org/eclipse/jdt/internal/compiler/batch/Main$Logger.class');self.assertEqual(sha(logger),p['nativeXmlLogStatic']['loggerClassSha256'])
   for k in p['nativeXmlLogStatic']['constantStrings']:self.assertIn(k.encode(),logger)
 def test_image_paths_are_existing_dockerfile_data(self):
  p=json.loads((HERE/'provenance.json').read_text());s=pathlib.Path(p['references']['dockerfile']['path']).read_text()
  self.assertIn('FROM eclipse-temurin:21-jdk@sha256:',s);self.assertIn('ADD --chown=10001:10001 jdt.tar.gz /opt/jdt/',s);self.assertIn('USER 10001:10001',s)
  actual=json.loads(pathlib.Path(p['references']['actualSummary']['path']).read_text());self.assertEqual(actual['prepared']['images']['java']['imageId'],'sha256:fea3e1e7a3012c541d476906ccb74b71df3e1ef49ef769e3fd6bd5aab8bbcdeb')
  self.assertEqual(actual['cases']['java21']['javaVersions']['target']['javaMajor'],21)
 def test_new_controls_are_not_modified_preview_oracle(self):
  self.assertEqual((HERE/'sources/valid/Valid.java').read_text(),'public class Valid { static int answer() { return 42; } }\n')
  self.assertEqual((HERE/'sources/type-error/TypeError.java').read_text(),'public class TypeError { int broken = "not-an-int"; }\n')
  s=(HERE/'Probe.java').read_text();self.assertNotIn('enable-preview',s);self.assertNotIn('Runtime.getRuntime',s);self.assertIn('classOrigin',s);self.assertIn('NOT_READ',s)
 def test_readonly_input_and_scoped_no_force_cleanup(self):
  s=(HERE/'harness.mjs').read_text();self.assertIn('dst=/probe,readonly',s);self.assertIn("['rm',data.Id]",s);self.assertNotIn("['rm','-f'",s);self.assertNotIn('prune',s);self.assertNotIn("['build'",s);self.assertNotIn("['pull'",s)
if __name__=='__main__':unittest.main()
