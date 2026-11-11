import { exportMavenReports } from './runtime-artifacts.mjs';
// Image-internal dispatcher. Never run on the host. No arbitrary commands or shell.
import { createHash } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, cpSync, lstatSync, readdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { validateSpec, decodeSpec } from './runtime-spec.mjs';
import { inspectEffectivePom } from './runtime-pom.mjs';
export function runTask(spec) {
  const s = validateSpec(spec), project = '/workspace', artifact = '/artifacts', state='/workspace/.paircoach/runtime';
  if (existsSync(state)) throw new Error('Build state must be fresh'); mkdirSync(artifact, { recursive: true });
  if(readdirSync(artifact).length) throw new Error('Artifacts directory must be fresh');
  // Source inventory was sealed by executor. Refuse links again; only input is copied, never original workspace mounted RW.
  verifyBuildCopy('/input',project);
  mkdirSync(state,{recursive:true}); mkdirSync(state+'/home');
  const cwd = path.join(project,s.task.workingDirectory);
  if (!lstatSync(cwd).isDirectory()) throw new Error('Task directory absent');
  const report = { runId: s.runId, manifestSha256: s.manifestSha256, effective: null };
  const env = buildChildEnvironment(s.family,cwd);
  const call = (exe,args,capture = false) => {
    const p = spawnSync(exe,args,{ cwd,env,shell:false,stdio:capture ? ['ignore','pipe','pipe'] : 'inherit',maxBuffer:4*1024*1024 });
    if (p.error || p.signal) throw new Error(`Tool failed: ${p.error?.message ?? p.signal}`);
    if (p.status !== 0) { if(capture) { process.stdout.write(p.stdout); process.stderr.write(p.stderr); } throw Object.assign(new Error('Tool exit ' + p.status),{exitCode:p.status}); }
    return p;
  };
  const node = '/opt/paircoach/node/bin/node';
  let exe = node, args = [], executionCwd = cwd;
  if (s.family === 'node' || s.family === 'typescript') {
    if (existsSync(`${s.cache}/node_modules`)) symlinkSync(`${s.cache}/node_modules`,`${cwd}/node_modules`,'dir');
    let output = cwd;
    if (s.family === 'typescript') {
      call(node,['/opt/paircoach/tools/node_modules/typescript/bin/tsc','--project','tsconfig.json','--outDir','/workspace/.paircoach/runtime/compiled','--rootDir',cwd,'--noEmit','false','--noEmitOnError','true','--incremental','false']);
      output = '/workspace/.paircoach/runtime/compiled';
      if (existsSync(path.join(cwd,'package.json'))) cpSync(path.join(cwd,'package.json'),path.join(output,'package.json'));
      if (existsSync(`${s.cache}/node_modules`)) symlinkSync(`${s.cache}/node_modules`,`${output}/node_modules`,'dir');
    }
    const source = p => path.join(output,s.family === 'typescript' ? p.replace(/\.ts$/,'.js') : p);
    args = s.mode === 'RUN_TESTS' ? ['--test','--test-reporter=junit',`--test-reporter-destination=${artifact}/junit-node.xml`,...s.task.tests.paths.map(source)] : [source(s.task.entry.path)];
    executionCwd = output;
  } else if (s.family === 'python') {
    exe = '/usr/local/bin/python3';
    args = s.mode === 'RUN_TESTS' ? ['-m','pytest','-p','no:cacheprovider',`--junitxml=${artifact}/junit-python.xml`,'--',...s.task.tests.paths] : s.task.entry.kind === 'MODULE' ? ['-m',s.task.entry.name] : [s.task.entry.path];
  } else {
    mkdirSync('/workspace/.paircoach/runtime/m2',{recursive:true}); cpSync(`${s.cache}/m2`,'/workspace/.paircoach/runtime/m2',{recursive:true});
    const mvn = '/usr/share/maven/bin/mvn', options = ['--offline','--batch-mode','--no-transfer-progress','-Dmaven.repo.local=/workspace/.paircoach/runtime/m2','-Dstyle.color=never'];
    // Real effective model, active profiles/inheritance/property interpolation resolved by selected Maven.
    call(mvn,[...options,'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom','-Doutput=/workspace/.paircoach/runtime/effective-pom.xml']);
    report.effective = inspectEffectivePom(readFileSync('/workspace/.paircoach/runtime/effective-pom.xml','utf8'),s.release,s.preview);
    const version = call('/opt/java/openjdk/bin/javac',['-version'],true);
    if (!new RegExp(`^javac ${s.release}(?:[. +\\r\\n]|$)`).test(Buffer.concat([version.stdout,version.stderr]).toString())) throw new Error('TARGET_PROFILE_CONFLICT: actual javac');
    // Compiles with selected javac, not ECJ/JDT. No release/preview rewrite; effective pom must already agree.
    if (s.mode === 'RUN_TESTS') {
      exe = mvn; args = [...options,'test'];
      if (s.task.tests.names.length) args.push('-Dtest='+s.task.tests.names.join(','));
    } else if (s.task.entry.kind === 'SPRING_BOOT') {
      if (report.effective.springVersion !== '4.1.2') throw new Error('Spring task requires reviewed pinned Spring Boot4.1.2');
      exe = mvn; args = [...options,'spring-boot:run',`-Dspring-boot.run.arguments=--server.port=${s.task.entry.containerPort} --server.address=0.0.0.0`];
    } else {
      call(mvn,[...options,'compile','org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath','-Dmdep.outputFile=/workspace/.paircoach/runtime/classpath.txt']);
      exe = '/opt/java/openjdk/bin/java'; args = [...(s.preview ? ['--enable-preview'] : []),'-cp',`${cwd}/target/classes:${readFileSync('/workspace/.paircoach/runtime/classpath.txt','utf8').trim()}`,s.task.entry.className];
    }
  }
  writeFileSync('/artifacts/runtime-input.json',JSON.stringify(report));
  // Async child keeps PID1 dispatcher responsive to container Stop and forwards termination.
  const child = spawn(exe,args,{ cwd:executionCwd,env,shell:false,stdio:'inherit' });
  const term = () => child.kill('SIGTERM'); process.on('SIGTERM',term); process.on('SIGINT',term);
  child.once('error',err => { console.error(err.message); process.exitCode=1; });
  child.once('exit',(code,signal) => {
    process.off('SIGTERM',term); process.off('SIGINT',term);
    try { if(s.family==='java-maven' && s.mode==='RUN_TESTS') exportMavenReports(cwd,artifact); }
    catch(error) { console.error(error.message); process.exitCode=1; return; }
    process.exitCode=signal ? 128 : code ?? 1;
  });
  return child;
}
export function verifyBuildCopy(inputRoot,workspaceRoot) {
  const inventory = root => {
    const result=[]; let files=0,bytes=0;
    const check=(dir,rel='',depth=0)=>{
      if(depth>64) throw new Error('Input depth');
      for(const n of readdirSync(dir).sort()) {
        if(n.startsWith('.env') || ['.git','.paircoach','.paircoach-runtime','.m2','.aws','.ssh','node_modules','target','__pycache__','dist','build','artifacts','test-results'].includes(n)) throw new Error('Excluded secret/dependency/build input');
        if(++files>20000) throw new Error('Input files');
        const p=path.join(dir,n),st=lstatSync(p),r=rel?rel+'/'+n:n;
        if(st.isSymbolicLink() || !st.isDirectory() && !st.isFile()) throw new Error('Nonregular input');
        if(st.isDirectory()) check(p,r,depth+1); else {
          if((bytes+=st.size)>128*1024*1024) throw new Error('Input bytes');
          result.push({path:r,sha256:createHash('sha256').update(readFileSync(p)).digest('hex')});
        }
      }
    }; check(root); return result;
  };
  const sealed=inventory(inputRoot);
  if(JSON.stringify(inventory(workspaceRoot))!==JSON.stringify(sealed)) throw new Error('RUN_INPUT_CHANGED: build copy differs from sealed input');
}
export function buildChildEnvironment(family,cwd) {
  if(!['node','typescript','python','java-maven'].includes(family) || typeof cwd!=='string' || !(cwd==='/workspace' || cwd.startsWith('/workspace/')) || cwd.split('/').some(p=>p==='..')) throw new Error('Invalid tool environment scope');
  return { CI:'true', LANG:'C.UTF-8', LC_ALL:'C.UTF-8', TZ:'UTC', PYTHONDONTWRITEBYTECODE:'1',
    PATH:'/opt/paircoach/node/bin:/opt/java/openjdk/bin:/usr/share/maven/bin:/opt/python/bin:/usr/local/bin:/usr/bin:/bin',
    HOME:'/workspace/.paircoach/runtime/home', TMPDIR:'/tmp', JAVA_HOME:'/opt/java/openjdk', PYTHONNOUSERSITE:'1', PYTEST_DISABLE_PLUGIN_AUTOLOAD:'1',
    ...(family==='python'?{PYTHONPATH:'/cache/0/site-packages:'+cwd}:{}) };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv.length !== 3) throw new Error('One strict encoded task required');
    runTask(decodeSpec(process.argv[2]));
  } catch (err) { console.error(err.message); process.exitCode = Number.isInteger(err.exitCode) && err.exitCode > 0 && err.exitCode < 256 ? err.exitCode : 1; }
}
