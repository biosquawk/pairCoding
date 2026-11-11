import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {HERE,NAME,IMAGE,OUTPUT,LABELS,owned,createArgs,cleanupDecision,parseProbe} from './harness.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const good=()=>({Id:'a'.repeat(64),Name:`/${NAME}`,Image:IMAGE,Config:{Labels:{...LABELS}},State:{Running:false,Paused:false,Restarting:false}});
function fixture(change=()=>{}) {
 const files={},commands=[];
 for(const a of ['preview','valid','type-error'])for(const b of ['javac','ecj']) {
  const id=`${a}-${b}`,exit=a==='valid'||(a==='preview'&&b==='ecj')?0:1;
  files[id+'.stdout']=Buffer.from('');files[id+'.stderr']=Buffer.from(exit&&b==='javac'?'test.java:1: error: actual synthetic error':'');
  if(b==='ecj')files[id+'.xml']=Buffer.from(a==='preview'?'<compiler><problem problemID="4195412" severity="WARNING"/></compiler>':a==='type-error'?'<compiler><problem severity="ERROR"/></compiler>':'<compiler/>');
  commands.push({id,exit,status:'EXITED',timedOut:false,outputOverflow:false,classes:a==='valid'?[{relative:'Valid.class'}]:[],stdout:{sha256:sha(files[id+'.stdout'])},stderr:{sha256:sha(files[id+'.stderr'])},...(b==='ecj'?{xml:{sha256:sha(files[id+'.xml'])}}:{})});
 }
 const p={scope:'COMPILER_ONLY_DIAGNOSTIC_NOT_PRODUCT_OR_FULL_PASS',status:'EVIDENCE_COMPLETE_NO_PASS_CLAIM',classOrigin:{status:'NOT_READ'},commands};change(p,files);
 for(const c of commands)if(c.xml&&files[c.id+'.xml'])c.xml.sha256=sha(files[c.id+'.xml']);
 return ()=>parseProbe(JSON.stringify(p),n=>files[n]);
}
test('STATIC/MOCK only: no compiler/product/full PASS inference',()=>{const p=fixture()();assert.equal(p.prediction,'SUPPORTED_FOR_THIS_BATCH_INPUT_ONLY');assert.equal(p.wholeSuite,'NOT_RUN');assert.equal(p.originalFULL,'FAIL');assert.equal(p.productFinding,'OPEN');assert.equal(p.classOrigin.status,'NOT_READ');});
test('STATIC/MOCK: primary ECJ actual nonzero falsifies prediction',()=>{const p=fixture(p=>p.commands[1].exit=1)();assert.equal(p.prediction,'FALSIFIED');assert.match(p.reason,/ECJ_NONZERO/);});
test('STATIC/MOCK: control failure is separately inconclusive',()=>assert.equal(fixture(p=>p.commands[2].exit=1)().reason,'CONTROL_FAIL'));
test('STATIC/MOCK: launch failure is not semantic proof',()=>assert.equal(fixture(p=>{p.status='HARNESS_OR_LAUNCH_FAILURE';p.failure='UnsupportedClassVersionError';})().prediction,'INCONCLUSIVE'));
test('STATIC/MOCK: missing6/duplicate ID reject',()=>{assert.throws(fixture(p=>p.commands.pop()));assert.throws(fixture(p=>p.commands[1].id='preview-javac'));});
test('STATIC/MOCK: timeout/overflow rejects',()=>{assert.throws(fixture(p=>p.commands[0].timedOut=true));assert.throws(fixture(p=>p.commands[0].outputOverflow=true));});
test('STATIC/MOCK: XML DTD/entities rejected',()=>assert.throws(fixture((p,f)=>f['preview-ecj.xml']=Buffer.from('<!DOCTYPE x>'))));
test('STATIC/MOCK: ID and severity must share a problem tag',()=>assert.equal(fixture((p,f)=>f['preview-ecj.xml']=Buffer.from('<problem problemID="4195412" severity="ERROR"/><problem severity="WARNING"/>'))().prediction,'FALSIFIED'));
test('STATIC/MOCK: no severity promotion or message string oracle',()=>assert.equal(fixture((p,f)=>f['preview-ecj.xml']=Buffer.from('<problem problemID="4195412" severity="INFO"/>'))().warning4195412,false));
test('STATIC/MOCK: raw stream hash mismatch rejected',()=>assert.throws(fixture((p,f)=>f['preview-javac.stderr']=Buffer.from('different'))));
test('ownership validates name/image/labels/full ID',()=>{for(const key of Object.keys(LABELS)){const g=good();g.Config.Labels[key]='other';assert.throws(()=>owned(g));}for(const key of ['Id','Name','Image']){const g=good();g[key]='other';assert.throws(()=>owned(g));}});
test('no cleanup on unknown, running or without collection/durable receipt',()=>{assert.equal(cleanupDecision({}),'RECONCILE_ONLY');const data=good();assert.equal(cleanupDecision({data,collected:false,durable:true}),'COLLECT_AND_PERSIST');assert.equal(cleanupDecision({data,collected:true,durable:false}),'COLLECT_AND_PERSIST');data.State.Running=true;assert.equal(cleanupDecision({data,collected:true,durable:true}),'STOP_OR_RECONCILE');});
test('cleanup requires terminal+collected+durable and returns exact nonforce only',()=>assert.equal(cleanupDecision({data:good(),collected:true,durable:true}),'EXACT_NONFORCE_RM'));
test('strict approved flags, pinned image, no shell, no prepare/network/pull',()=>{const a=createArgs(join(OUTPUT,'input'),join(OUTPUT,'artifacts'));for(const flag of ['--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=10001:10001','--memory=1024m','--pids-limit=128'])assert.ok(a.includes(flag));assert.ok(a.includes(IMAGE));assert.ok(a.some(x=>x.endsWith('dst=/probe,readonly')));assert.ok(!a.some(x=>/privileged|docker.sock|\/home\/[^,]*,dst=\/home/.test(x)));assert.deepEqual(a.slice(-5),['-Xmx128m','-Djava.io.tmpdir=/tmp','--source','21','/probe/Probe.java']);assert.ok(!a.includes('sh')&&!a.includes('-c'));});
test('arbitrary host binds rejected',()=>{assert.throws(()=>createArgs('/tmp',join(OUTPUT,'artifacts')));assert.throws(()=>createArgs(join(OUTPUT,'input'),'/tmp/output'));});
test('fake-driver/prepare CLI refused without running Docker',()=>{for(const mode of ['fake-driver','prepare','retry']){const r=spawnSync(process.execPath,[join(HERE,'harness.mjs'),mode],{encoding:'utf8'});assert.notEqual(r.status,0);assert.match(r.stderr,/no prepare\/retry\/fake-driver/);}});
test('source launcher is target21, fixed bounded6 commands, no host compiler use',()=>{const j=readFileSync(join(HERE,'Probe.java'),'utf8');assert.match(j,/command\(id,argv,26\)/);assert.match(j,/List.of\("preview","valid","type-error"\)/);assert.match(j,/List.of\("javac","ecj"\)/);assert.ok(!/Runtime\.getRuntime|"sh"|"bash"|enable-preview/.test(j));});
test('repo layout parent is exactly3 levels',()=>assert.match(readFileSync(join(resolve(HERE,'../../..'),'.git/HEAD'),'utf8'),/^ref:/));

test('STATIC/MOCK: control failure retains falsified actual primary exit0 prediction separately',()=>{const p=fixture(p=>{p.commands[1].exit=1;p.commands[2].exit=1;})();assert.equal(p.reason,'CONTROL_FAIL');assert.equal(p.observedPrimaryExit0Prediction,'FALSIFIED');assert.equal(p.prediction,'INCONCLUSIVE');});

test('immutable generated input uses explicit755/644 even with host umask077',()=>{const s=readFileSync(join(HERE,'harness.mjs'),'utf8');assert.match(s,/fs\.chmodSync\(p,0o755\)/);assert.match(s,/fs\.chmodSync\(dst,0o644\)/);assert.match(s,/createArgs\(input,artifactPath\)/);assert.match(s,/inputManifest/);});

test('durable terminal summary remains immutable across cleanup progress',()=>{const s=readFileSync(join(HERE,'harness.mjs'),'utf8');assert.match(s,/terminal-summary\.json/);assert.match(s,/COPYFILE_EXCL/);assert.match(s,/terminalSummarySha256/);assert.ok(s.indexOf("fs.copyFileSync(join(out,'summary.json')")<s.indexOf("['rm',data.Id]"));assert.match(s,/fs\.renameSync\(tmp,join\(out,'summary\.json'\)\)/);});
