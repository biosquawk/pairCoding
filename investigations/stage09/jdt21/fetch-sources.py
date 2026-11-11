"""Bounded, pinned official-source read; no execution/toolchain installation."""
import urllib.request, pathlib, hashlib, json
root=pathlib.Path(__file__).parent
batch='5a4dd839342e057849b378ec912c47035db65dbb'
core='79ceacffdea9ca0b7f57ce3476a57e34bc154188'
ls='d98abba8f04cf041542d9ebb6df0d472a1395606'
entries=[('eclipse-jdt/eclipse.jdt.core',batch,p) for p in [
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/problem/ProblemReporter.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/impl/CompilerOptions.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/lookup/BinaryTypeBinding.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/classfmt/ClassFileReader.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/classfmt/AnnotationInfo.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/lookup/TagBits.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/classfmt/ClassFileConstants.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/codegen/ConstantPool.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/ast/ASTNode.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/env/IBinaryAnnotation.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/core/compiler/IProblem.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/problem/messages.properties',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/util/JrtFileSystem.java',
'org.eclipse.jdt.core.compiler.batch/src/org/eclipse/jdt/internal/compiler/util/CtSym.java',
]]
entries += [('eclipse-jdt/eclipse.jdt.core',core,p) for p in [
'org.eclipse.jdt.core/model/org/eclipse/jdt/internal/core/builder/ClasspathJrtWithReleaseOption.java',
'org.eclipse.jdt.core/model/org/eclipse/jdt/internal/core/JrtPackageFragmentRoot.java',
'org.eclipse.jdt.core/model/org/eclipse/jdt/core/JavaCore.java',
]]
entries += [('eclipse/eclipse.jdt.ls',ls,'org.eclipse.jdt.ls.core/src/org/eclipse/jdt/ls/core/internal/handlers/'+n+'.java') for n in ['DiagnosticsHandler','BaseDiagnosticsHandler']]
entries += [('openjdk/jdk21u','ba94eace682733f66e623c089bcafcf4a1b8e39c',p) for p in [
'make/langtools/src/classes/build/tools/symbolgenerator/CreateSymbols.java',
'src/java.base/share/classes/java/lang/ScopedValue.java',
'src/java.base/share/classes/jdk/internal/javac/PreviewFeature.java',
'src/jdk.compiler/share/classes/com/sun/tools/javac/code/Preview.java',
'src/jdk.compiler/share/classes/com/sun/tools/javac/comp/Check.java',
'src/jdk.compiler/share/classes/com/sun/tools/javac/jvm/ClassReader.java',
]]
out=[]
for repo,rev,p in entries:
 url=f'https://raw.githubusercontent.com/{repo}/{rev}/{p}'
 name=('javac21-' if repo.startswith('openjdk/') else 'jdtls-' if repo.endswith('jdt.ls') else 'jdt-')+p.rsplit('/',1)[1]
 dest=root/'raw'/name
 try:
  if dest.exists() and not repo.startswith('openjdk/'):
   b=dest.read_bytes()
  else:
   with urllib.request.urlopen(url,timeout=30) as r:
    b=r.read(2_000_001)
    if len(b)>2_000_000:raise ValueError('source exceeds cap')
  dest.write_bytes(b)
  entry=dict(url=url,revision=rev,path=p,local='raw/'+name,sha256=hashlib.sha256(b).hexdigest(),bytes=len(b),status='OK')
  print(name,len(b),entry['sha256'])
 except Exception as e:entry=dict(url=url,status='FAIL',error=str(e));print('FAIL',url,str(e))
 out.append(entry)
(root/'sources.json').write_text(json.dumps(out,indent=2)+'\n')
