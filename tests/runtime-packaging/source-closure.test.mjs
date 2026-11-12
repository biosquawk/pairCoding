// Developer fixtures only: no install, toolchain, Docker, or release artifact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { requiredFiles as oldRequired, allowedSource, verifyAndCopy, verifyCopiedInputs } from '../../scripts/verify-source-revision.mjs';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scripts = ['prepare-cli','prepare','language-prepare','operator','stage-inputs','files','task','pom','spec','cache','tools','dependencies','artifacts','generate-templates'].map(n => `scripts/runtime-${n}.mjs`);
const assets = [
  'runtimes/README.md', 'runtimes/catalog.json', 'runtimes/images.lock.json', 'runtimes/pin-status.json',
  'runtimes/production-inputs.lock.json', 'runtimes/pylsp-requirements.lock',
  'docker/runtime.Dockerfile','docker/language-java.Dockerfile','docker/language-python.Dockerfile',
  'examples/README.md',
  ...['javascript-counter','typescript-counter','python-calculator','java-pattern','spring-counter'].map(n=>`examples/${n}/task.v2.json`),
  'examples/javascript-counter/package.json','examples/javascript-counter/main.js','examples/javascript-counter/counter.test.js',
  'examples/typescript-counter/package.json','examples/typescript-counter/tsconfig.json','examples/typescript-counter/main.ts','examples/typescript-counter/counter.test.ts',
  'examples/python-calculator/requirements.txt','examples/python-calculator/calculator.py','examples/python-calculator/test_calculator.py',
  'examples/java-pattern/pom.xml','examples/java-pattern/src/main/java/demo/StrategyDemo.java','examples/java-pattern/src/test/java/demo/StrategyDemoTest.java',
  'examples/spring-counter/pom.xml','examples/spring-counter/src/main/java/demo/CounterApplication.java','examples/spring-counter/src/test/java/demo/CounterApplicationTest.java',
];
const runtimeRequired = ['paircoach.runtime.json','docs/windows-polyglot.md',...scripts,...assets];
const excluded = [
  '.env', 'src/secret.key', 'examples/java-pattern/target/stale.xml', 'examples/python-calculator/__pycache__/cached.py',
  'examples/python-calculator/.venv/site.py', 'examples/javascript-counter/node_modules/pkg/index.js',
  'examples/.env.local','runtimes/credentials/auth.json','runtimes/secrets/token.txt','runtimes/artifacts/receipt.json',
  'runtimes/logs/run.json','runtimes/runtime/cache.json','runtimes/cache.tar','runtimes/secret.pem',
  'docker/.aws/config.json','docker/.ssh/private.txt','runtimes/download.whl','runtimes/tools.tar.gz','runtimes/receipts/prepared.json','runtimes/cache/index.json',
  'scripts/runtime-unreviewed.mjs','scripts/arbitrary.mjs','tests/qa/raw.log',
];
const extraSources = ['runtimes/source-metadata.json','docker/support/check.py','examples/other-project/src/Other.java','examples/other-project/task.v2.json'];
function write(root, name, bytes) { const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,bytes); }
function git(root,...args) {const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
function fixture(t) {
  const base=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'runtime-package-'));
  t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const root=path.join(base,'repo');fs.mkdirSync(root);
  for(const name of new Set([...oldRequired,...runtimeRequired])) {
    const real=path.join(repo,name);
    write(root,name,fs.existsSync(real) ? fs.readFileSync(real) : `SYNTHETIC SOURCE ONLY: ${name}\n`);
  }
  write(root,'tests/execution/synthetic.test.ts','// not executed by packager\n');
  for(const name of [...excluded,...extraSources]) write(root,name,`fixture: ${name}\n`);
  // Forced add intentionally includes denylisted files; selection cannot rely on .gitignore.
  git(root,'init','--quiet');git(root,'config','core.autocrlf','false');
  const commit=()=>{git(root,'add','--force','--all');git(root,'-c','user.name=packaging-fixture','-c','user.email=fixture@invalid.local','commit','--quiet','--allow-empty','-m','synthetic source only');return git(root,'rev-parse','HEAD');};
  return {base,root,commit,revision:commit()};
}
function pack(f,args,expected=0) {
  const r=spawnSync(process.execPath,[path.join(f.root,'scripts/package-windows.mjs'),'--commit',f.revision,...args],{cwd:f.root,encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(r.status,expected,r.stderr);return r;
}
function readZip(zip) {
  let end=-1;
  for(let i=zip.length-22;i>=Math.max(0,zip.length-65557);i--) if(zip.readUInt32LE(i)===0x06054b50 && i+22+zip.readUInt16LE(i+20)===zip.length) {end=i;break;}
  assert.notEqual(end,-1);let pos=zip.readUInt32LE(end+16);const files=new Map();
  for(let i=0;i<zip.readUInt16LE(end+10);i++) {
    assert.equal(zip.readUInt32LE(pos),0x02014b50);const method=zip.readUInt16LE(pos+10),size=zip.readUInt32LE(pos+24),len=zip.readUInt16LE(pos+28),local=zip.readUInt32LE(pos+42);
    const name=zip.subarray(pos+46,pos+46+len).toString();pos+=46+len+zip.readUInt16LE(pos+30)+zip.readUInt16LE(pos+32);
    if(name.endsWith('/'))continue;assert.equal(method,0);assert.equal(files.has(name),false);
    const start=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28);files.set(name,zip.subarray(start,start+size));
  }return files;
}
test('list/dry-run: complete finite polyglot source closure, exact SHA256 of every byte, no readiness claim/writes',t=>{
  const f=fixture(t),before=git(f.root,'status','--porcelain');
  const list=pack(f,['--list']).stdout.trim().split('\n');
  for(const name of [...oldRequired,...runtimeRequired,...extraSources])assert.ok(list.includes(name),name);
  for(const name of excluded)assert.ok(!list.includes(name),name);
  const tracked=git(f.root,'ls-tree','-r','--name-only',f.revision).split('\n');
  assert.deepEqual(list,tracked.filter(allowedSource).sort(),'packager/verifier exact finite selection parity');
  const plan=JSON.parse(pack(f,['--dry-run']).stdout);
  assert.deepEqual(plan.files.map(f=>f.path),list);assert.equal(plan.sourceCommit,f.revision);
  assert.equal(plan.commands.length,11);const cmd=plan.commands.find(c=>c.name==='runtime:prepare');
  assert.equal(cmd.command,'node scripts/runtime-prepare-cli.mjs');assert.deepEqual(cmd.requiredFiles,runtimeRequired);
  assert.match(cmd.prerequisite,/plan-only is NOT prepared/);assert.equal(cmd.execution,'NOT_RUN_BY_PACKAGER');
  assert.match(plan.sourceVerification.trust,/colocated SHA256SUMS is not trust/);
  assert.deepEqual(plan.sourceVerification.recoveryTests,['tests/snapshots/snapshot-crash.test.ts']);
  for(const name of [...oldRequired,...runtimeRequired]) assert.ok(plan.sourceVerification.requiredFiles.includes(name) || plan.commands.some(c=>c.requiredFiles.includes(name)),name);
  for(const file of plan.files) {const bytes=fs.readFileSync(path.join(f.root,file.path));assert.equal(file.sha256,sha(bytes));assert.equal(file.bytes,bytes.length);}
  assert.equal(git(f.root,'status','--porcelain'),before);assert.equal(fs.existsSync(path.join(f.root,'node_modules')),false);
});
test('synthetic --output STORE ZIP independently matches all Git bytes/manifest and rejects overwrite/inside-repo',t=>{
  const f=fixture(t),out=path.join(f.base,'synthetic-only');pack(f,['--output',out]);
  const manifestBytes=fs.readFileSync(path.join(out,'manifest.json')),m=JSON.parse(manifestBytes),zip=fs.readFileSync(path.join(out,m.archive.name)),files=readZip(zip);
  assert.equal(sha(zip),m.archive.sha256);assert.equal(zip.length,m.archive.bytes);
  assert.deepEqual([...files.keys()].sort(),m.files.map(f=>m.prefix+f.path).sort());
  for(const file of m.files) {const bytes=files.get(m.prefix+file.path);assert.equal(sha(bytes),file.sha256);assert.equal(bytes.length,file.bytes);
    const blob=spawnSync('git',['show',`${f.revision}:${file.path}`],{cwd:f.root});assert.equal(blob.status,0);assert.deepEqual(bytes,blob.stdout);}
  assert.match(fs.readFileSync(path.join(out,'SHA256SUMS'),'utf8'),new RegExp(sha(manifestBytes)+'  manifest.json'));
  pack(f,['--output',out],1);assert.deepEqual(fs.readFileSync(path.join(out,'manifest.json')),manifestBytes);
  const inside=path.join(f.root,'forbidden');pack(f,['--output',inside],1);assert.equal(fs.existsSync(inside),false);
});
for(const name of ['paircoach.runtime.json','docs/windows-polyglot.md',...scripts,'runtimes/catalog.json','runtimes/images.lock.json','runtimes/production-inputs.lock.json','runtimes/pylsp-requirements.lock','docker/runtime.Dockerfile',...assets.filter(n=>n.endsWith('/task.v2.json')),
  'tests/snapshots/snapshot-crash.test.ts','tests/snapshots/snapshot-child.ts','tests/snapshots/helpers.ts']) {
  test(`missing mandatory input fails closed: ${name}`,t=>{const f=fixture(t);fs.unlinkSync(path.join(f.root,name));f.revision=f.commit();const out=path.join(f.base,'absent');
    assert.match(pack(f,['--output',out],1).stderr,/Brak wymaganego pliku/);assert.equal(fs.existsSync(out),false);});
}
for(const [label,change,expected] of [
  ['missing runtime npm script',f=>{const p=path.join(f.root,'package.json'),pkg=JSON.parse(fs.readFileSync(p));delete pkg.scripts['runtime:prepare'];fs.writeFileSync(p,JSON.stringify(pkg));},/Brak wymaganego npm script/],
  ['changed runtime command',f=>{const p=path.join(f.root,'package.json'),pkg=JSON.parse(fs.readFileSync(p));pkg.scripts['runtime:prepare']+=' --execute';fs.writeFileSync(p,JSON.stringify(pkg));},/Nierozpoznany\/zmieniony npm script/],
  ['lifecycle execution',f=>{const p=path.join(f.root,'package.json'),pkg=JSON.parse(fs.readFileSync(p));pkg.scripts.postinstall='echo BAD';fs.writeFileSync(p,JSON.stringify(pkg));},/Nierozpoznany\/zmieniony npm script/],
  ['case alias',f=>write(f.root,'examples/java-pattern/src/main/java/demo/STRATEGYDEMO.java','bad'),/Niedozwolony typ/],
  ['device name',f=>write(f.root,'runtimes/CON.json','{}'),/Niedozwolony typ/],
  ['runtime script symlink',f=>{fs.unlinkSync(path.join(f.root,scripts[0]));fs.symlinkSync('runtime-prepare.mjs',path.join(f.root,scripts[0]));},/Niedozwolony typ/],
  ['export-ignore runtime source',f=>write(f.root,'.gitattributes','runtimes/catalog.json export-ignore\n'),/ZIP pomija wymagane/],
  ['export-subst runtime source',f=>{write(f.root,'.gitattributes','runtimes/README.md export-subst\n');fs.appendFileSync(path.join(f.root,'runtimes/README.md'),'\n$Format:%H$\n');},/Lista\/format ZIP niezgodne z manifestem/],
]) test(`refuses ${label} before any output`,t=>{const f=fixture(t);change(f);f.revision=f.commit();const out=path.join(f.base,'rejected');assert.match(pack(f,['--output',out],1).stderr,expected);assert.equal(fs.existsSync(out),false);});
test('selected runtime submodule, wrong SHA and mismatched policy fail closed',t=>{
  const f=fixture(t);git(f.root,'update-index','--add','--cacheinfo',`160000,${f.revision},examples/foreign.java`);
  git(f.root,'-c','user.name=packaging-fixture','-c','user.email=fixture@invalid.local','commit','--quiet','-m','synthetic gitlink');f.revision=git(f.root,'rev-parse','HEAD');
  assert.match(pack(f,['--list'],1).stderr,/Niedozwolony typ/);
  pack({...f,revision:'0'.repeat(40)},['--dry-run'],1);
  fs.appendFileSync(path.join(f.root,'scripts/package-windows.mjs'),'\n// changed policy\n');assert.match(pack(f,['--list'],1).stderr,/Skrypt musi być zgodny/);
});

test('expanded verifier: actual Git -> disposable copy and synthetic ZIP -> Gitless trusted copy retain every source byte',t=>{
  const f=fixture(t),gitCopy=path.join(f.base,'git-copy');
  const identity=verifyAndCopy({source:f.root,revision:f.revision,destination:gitCopy});
  assert.equal(identity.trustMode,'GIT_HEAD');assert.equal(identity.byteVerification,'PASS');
  for(const file of identity.files)assert.deepEqual(fs.readFileSync(path.join(gitCopy,file.path)),fs.readFileSync(path.join(f.root,file.path)));
  for(const name of excluded)assert.equal(fs.existsSync(path.join(gitCopy,name)),false,name);
  const out=path.join(f.base,'archive');pack(f,['--output',out]);
  const manifest=path.join(out,'manifest.json'),raw=fs.readFileSync(manifest),m=JSON.parse(raw);
  const entries=readZip(fs.readFileSync(path.join(out,m.archive.name))),extracted=path.join(f.base,'extracted');fs.mkdirSync(extracted);
  for(const file of m.files)write(extracted,file.path,entries.get(m.prefix+file.path));
  assert.equal(fs.existsSync(path.join(extracted,'.git')),false);
  const copy=path.join(f.base,'trusted-copy'),result=verifyAndCopy({source:extracted,revision:f.revision,destination:copy,trustedManifest:manifest,manifestSha256:sha(raw)});
  assert.equal(result.trustMode,'EXTERNAL_MANIFEST_SHA256');assert.equal(result.manifestDigest,sha(raw));assert.equal(result.byteVerification,'PASS');
  assert.deepEqual(result.files.map(f=>f.path),m.files.map(f=>f.path));
  for(const file of m.files)assert.equal(sha(fs.readFileSync(path.join(copy,file.path))),file.sha256);
  // Existing independent trust/revision/source identity protections apply to NEW roots too.
  const rejected=path.join(f.base,'no-copy');
  for(const mutation of [
    ()=>({revision:'0'.repeat(40)}),
    ()=>({manifestSha256:'0'.repeat(64)}),
  ]) {
    assert.throws(()=>verifyAndCopy({source:extracted,revision:f.revision,destination:rejected,trustedManifest:manifest,manifestSha256:sha(raw),...mutation()}));
    assert.equal(fs.existsSync(rejected),false);
  }
  write(extracted,'runtimes/source-metadata.json','TAMPER');
  assert.throws(()=>verifyCopiedInputs(extracted,m.files),/COPIED_BYTES_MISMATCH/);
  assert.throws(()=>verifyAndCopy({source:extracted,revision:f.revision,destination:rejected,trustedManifest:manifest,manifestSha256:sha(raw)}),/COPIED_BYTES_MISMATCH/);
  assert.equal(fs.existsSync(rejected),false);
});
for(const [label,mutate,expected] of [
  ['new source omitted from manifest',root=>write(root,'examples/other-project/extra.py','untrusted'),/SOURCE_SET_MISMATCH/],
  ['new runtime source symlink',root=>{fs.unlinkSync(path.join(root,'runtimes/catalog.json'));fs.symlinkSync('images.lock.json',path.join(root,'runtimes/catalog.json'));},/SYMLINK_OR_REPARSE_PATH/],
]) test(`expanded Gitless verification rejects ${label}`,t=>{
  const f=fixture(t),m=JSON.parse(pack(f,['--dry-run']).stdout),out=path.join(f.base,'manifest.json');write(f.base,'manifest.json',JSON.stringify(m));
  fs.rmSync(path.join(f.root,'.git'),{recursive:true});mutate(f.root);const dest=path.join(f.base,'never');
  assert.throws(()=>verifyAndCopy({source:f.root,revision:f.revision,destination:dest,trustedManifest:out,manifestSha256:sha(fs.readFileSync(out))}),expected);
  assert.equal(fs.existsSync(dest),false);
});
