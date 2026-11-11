// Narrow operator-harness helper. No Docker execution and no product imports.
import {constants, mkdirSync, chmodSync, lstatSync, readdirSync, openSync, fstatSync, readSync, closeSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const bootLimits = Object.freeze({fileBytes:8*1024*1024,totalBytes:32*1024*1024,entries:2048,depth:12});
export function javaLaunch(target, launcher) {
  if(![21,27].includes(target)||!/^org\.eclipse\.equinox\.launcher_[a-zA-Z0-9._-]+\.jar$/.test(launcher))throw new Error('Invalid pinned Java launch data');
  const serverJava='/opt/jdk27/bin/java';
  const targetHome=target===21?'/opt/java/openjdk':'/opt/jdk27';
  const script=[
    'set -eu',
    `${serverJava} -version > /artifacts/server-java-version.txt 2>&1`,
    `${targetHome}/bin/java -version > /artifacts/target-java-version.txt 2>&1`,
    `${targetHome}/bin/javac --version > /artifacts/target-javac-version.txt 2>&1`,
    "printf 'ready\\n' > /artifacts/versions-ready.tmp",
    'mv /artifacts/versions-ready.tmp /artifacts/versions-ready.txt',
    'cp -r /opt/jdt/config_linux /artifacts/jdt-config',
    `exec ${serverJava} -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 -Declipse.product=org.eclipse.jdt.ls.core.product -Dosgi.logfile=/artifacts/osgi.log -XX:ErrorFile=/artifacts/hs_err_pid%p.log -Xmx1024m --add-modules=ALL-SYSTEM --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED -jar /opt/jdt/plugins/${launcher} -configuration /artifacts/jdt-config -data /jdt-state`
  ].join(' && ');
  return {serverJava,serverExpectedMajor:27,targetHome,targetRelease:target,argv:['sh','-c',script]};
}
export function prepareBootDirectory(out,kind) {
  if(!/^java(?:21|27)$/.test(kind))throw new Error('Invalid Java case');
  const path=join(out,`boot-${kind}`);
  mkdirSync(path,{mode:0o777});chmodSync(path,0o777);return path;
}
// JDT workspace metadata must not contain or be inside the imported project.
// This generated bind is a sibling of shadow-/boot-<case> on the host too.
export function prepareJdtStateDirectory(out,kind) {
  if(!/^java(?:21|27)$/.test(kind))throw new Error('Invalid Java case');
  const path=join(out,`jdt-state-${kind}`);
  mkdirSync(path,{mode:0o777});chmodSync(path,0o777);return path;
}
// Pinned JDT java.project.getAll with arguments:[] returns Java project URIs.
// A completion alone is not proof of import: default/non-project mode can complete.
export function assertJavaProjectImported(status,projects) {
  if(status?.type!=='Started')throw new Error(`JDT project initialization failed: ${JSON.stringify(status)}`);
  if(!Array.isArray(projects)||!projects.every(uri=>typeof uri==='string'))throw new Error('Invalid JDT project list');
  const imported=projects.some(uri=>{
    try{const u=new URL(uri);return u.protocol==='file:'&&!u.host&&!u.search&&!u.hash&&u.pathname.replace(/\/$/,'')==='/work';}
    catch{return false;}
  });
  if(!imported)throw new Error(`Imported Java project /work missing: ${JSON.stringify(projects)}`);
  return {status:'PASS',initialization:status,projectUris:projects,importedProject:'file:///work'};
}
export function assertJavaProjectDiagnostics(history,uri) {
  const warnings=history.filter(event=>event.message.method==='textDocument/publishDiagnostics'&&event.message.params.uri===uri)
    .flatMap(event=>event.message.params.diagnostics)
    .filter(d=>/non-project file|not on the classpath|only syntax errors/i.test(d.message));
  if(warnings.length)throw new Error(`JDT non-project/classpath diagnostics: ${JSON.stringify(warnings)}`);
  return {status:'PASS',scope:'No non-project/classpath warnings in observed document diagnostics; not version correlation proof'};
}
export function readBoundedFile(path,limit=bootLimits.fileBytes) {
  const before=lstatSync(path);
  if(!before.isFile()||before.isSymbolicLink()||before.size>limit)throw new Error(`Unsafe/oversize artifact ${path}`);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino||opened.size>limit)throw new Error('Artifact changed during open');
    const bytes=Buffer.alloc(limit+1);let size=0,n;
    do{n=readSync(fd,bytes,size,bytes.length-size,null);size+=n;}while(n&&size<bytes.length);
    if(size>limit)throw new Error(`Oversize artifact ${path}`);
    return bytes.subarray(0,size);
  }finally{closeSync(fd);}
}
export function readJavaVersions(boot,target) {
  if(readBoundedFile(join(boot,'versions-ready.txt'),64).toString('utf8')!=='ready\n')throw new Error('Invalid bootstrap version readiness marker');
  const serverJava=readBoundedFile(join(boot,'server-java-version.txt'),65536).toString('utf8');
  const targetJava=readBoundedFile(join(boot,'target-java-version.txt'),65536).toString('utf8');
  const targetJavac=readBoundedFile(join(boot,'target-javac-version.txt'),65536).toString('utf8');
  const javaMajor=text=>Number(/(?:openjdk|java) version "(\d+)/.exec(text)?.[1]);
  const serverMajor=javaMajor(serverJava),targetMajor=javaMajor(targetJava),javacMajor=Number(/^javac (\d+)/.exec(targetJavac)?.[1]);
  if(serverMajor!==27||targetMajor!==target||javacMajor!==target)throw new Error('Observed server/target Java version conflict');
  return {server:{executable:'/opt/jdk27/bin/java',major:serverMajor,raw:serverJava},target:{release:target,javaMajor:targetMajor,javacMajor,javaRaw:targetJava,javacRaw:targetJavac},observedUTC:new Date().toISOString()};
}
// Called only after owner-verified terminal state. Bind-backed originals survive rm.
// Hash bounded config/log evidence, not binary index caches. Never follow links.
export function collectBootArtifacts(out,kind) {
  if(!/^java(?:21|27)$/.test(kind))throw new Error('Invalid Java case');
  const boot=join(out,`boot-${kind}`),state=join(out,`jdt-state-${kind}`);
  const result={status:'PASS',scope:'Bounded boot/config/log collection only; NOT LSP PASS',kind,root:boot,limits:bootLimits,entries:0,totalBytes:0,files:[],missing:[],errors:[]};
  const add=(path,relative)=>{
    const bytes=readBoundedFile(path,Math.min(bootLimits.fileBytes,bootLimits.totalBytes-result.totalBytes));
    result.totalBytes+=bytes.length;result.files.push({path:relative,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
    return bytes;
  };
  const walk=(dir,prefix='',depth=0)=>{
    if(depth>bootLimits.depth)throw new Error('Boot artifact depth limit');
    if(!lstatSync(dir).isDirectory())throw new Error('Unsafe boot artifact directory');
    for(const name of readdirSync(dir).sort()){
      if(++result.entries>bootLimits.entries)throw new Error('Boot artifact entry limit');
      const path=join(dir,name),relative=prefix?`${prefix}/${name}`:name,s=lstatSync(path);
      if(s.isSymbolicLink())throw new Error(`Artifact symlink rejected: ${relative}`);
      if(s.isDirectory())walk(path,relative,depth+1);
      else if(!s.isFile())throw new Error(`Nonregular artifact rejected: ${relative}`);
      else if(/\.(?:log|txt|ini|info|properties)$/.test(name))add(path,relative);
    }
  };
  try {
    if(!lstatSync(boot).isDirectory())throw new Error('Unsafe boot artifact root');
    // Read ONLY this log from the dedicated metadata bind, never walk binary indexes.
    const metadata=join(state,'.metadata');
    try {
      for(const dir of [state,metadata])if(!lstatSync(dir).isDirectory())throw new Error('Unsafe JDT metadata directory');
      const bytes=readBoundedFile(join(metadata,'.log'));
      const destination=join(boot,'jdt-workspace.log');
      try{writeFileSync(destination,bytes,{flag:'wx',mode:0o600});}
      catch(error){if(error.code!=='EEXIST'||!readBoundedFile(destination).equals(bytes))throw error;}
    }catch(error){if(error.code==='ENOENT')result.missing.push('jdt-state/.metadata/.log');else throw error;}
    walk(boot);
  }catch(error){result.status='FAIL';result.errors.push(error.message);}
  writeFileSync(join(out,`${kind}-boot-artifacts.json`),JSON.stringify(result,null,2)+'\n');
  return result;
}
