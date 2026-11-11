// Image-internal explicit preparation only; never used by Run/Test.
import { literalPath } from './runtime-spec.mjs';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
const [family,expectedEncoded,workingDirectory,dependencySha256] = process.argv.slice(2);
if (process.argv.length !== 6 || workingDirectory!=='.' && !literalPath(workingDirectory) || !/^[a-f0-9]{64}$/.test(dependencySha256) || !/^[A-Za-z0-9_-]{1,16384}$/.test(expectedEncoded) || !['node','typescript','python','java-maven'].includes(family)) throw new Error('Explicit known family required');
const expected=JSON.parse(Buffer.from(expectedEncoded,'base64url').toString('utf8'));
if(!Array.isArray(expected) || !expected.length || expected.some(t=>!t || Object.keys(t).sort().join(',')!=='name,version' || typeof t.name!=='string' || typeof t.version!=='string')) throw new Error('Expected versions required');
mkdirSync('/workspace/.paircoach/runtime/home',{recursive:true}); cpSync('/input','/workspace',{recursive:true});
const cwd=workingDirectory==='.'?'/workspace':'/workspace/'+workingDirectory;
const env = { PATH:'/opt/paircoach/node/bin:/opt/java/openjdk/bin:/usr/share/maven/bin:/usr/local/bin:/usr/bin:/bin', JAVA_HOME:'/opt/java/openjdk', HOME:'/workspace/.paircoach/runtime/home', LANG:'C.UTF-8', TMPDIR:'/tmp', PIP_CONFIG_FILE:'/dev/null', PIP_DISABLE_PIP_VERSION_CHECK:'1', PYTHONNOUSERSITE:'1' };
mkdirSync(env.HOME,{recursive:true});
const run = (exe,args) => { const r=spawnSync(exe,args,{cwd,env,shell:false,stdio:'inherit'}); if(r.error || r.status !== 0) throw new Error(`Prepare failed ${r.error?.message ?? r.status}`); };
if (family === 'node' || family === 'typescript') {
  // Lock required for dependencies. No task lifecycle scripts during preparation.
  const pkg=JSON.parse(readFileSync(cwd+'/package.json','utf8'));
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.devDependencies ?? {}).length) {
    if(!existsSync(cwd+'/package-lock.json')) throw new Error('Pinned package-lock required');
    run('/opt/paircoach/node/bin/node',['/usr/local/lib/node_modules/npm/bin/npm-cli.js','ci','--ignore-scripts','--no-audit','--no-fund','--cache=/cache/0/npm']);
    cpSync(cwd+'/node_modules','/cache/0/node_modules',{recursive:true});
  } else mkdirSync('/cache/0/node_modules',{recursive:true});
} else if(family === 'python') {
  // requirements includes pytest and all transitive dependencies with real hashes; never invent hashes.
  if(!/^[A-Za-z0-9_.-]+==[^\s]+.*--hash=sha256:/m.test(readFileSync(cwd+'/requirements.txt','utf8'))) throw new Error('NOTREADY: hash-locked pytest requirements required');
  run('/usr/local/bin/python3',['-m','pip','--isolated','install','--require-hashes','--only-binary=:all:','--no-compile','--target=/cache/0/site-packages','-r','requirements.txt']);
} else {
  const mvn='/usr/share/maven/bin/mvn',args=['--batch-mode','--no-transfer-progress','-Dmaven.repo.local=/cache/0/m2','-Dstyle.color=never'];
  run(mvn,[...args,'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom','-Doutput=/cache/0/effective-pom.xml']);
  run(mvn,[...args,'org.apache.maven.plugins:maven-dependency-plugin:3.8.1:go-offline']);
  // Materialize compiler/test/provider and optional Spring runtime plugin dependencies explicitly.
  run(mvn,[...args,'test','-DskipTests']);
}
const probe=spawnSync('/opt/paircoach/node/bin/node',['/opt/paircoach/runtime-tools.mjs',...expected.map(t=>t.name)],{cwd,env,shell:false,encoding:'utf8',maxBuffer:65536});
if(probe.error || probe.status!==0) throw new Error('Pinned tools probe failed: '+probe.stderr);
const actual=JSON.parse(probe.stdout).tools;
writeFileSync('/cache/0/tools.json',JSON.stringify(actual));
if(expected.some(t=>!actual.some(a=>a.name===t.name && a.version===t.version))) throw new Error('Actual tools differ from pinned expected versions');
writeFileSync('/cache/0/dependencies-prepared.json',JSON.stringify({family,workingDirectory,dependencySha256,tools:actual,preparedAt:new Date().toISOString()}));
