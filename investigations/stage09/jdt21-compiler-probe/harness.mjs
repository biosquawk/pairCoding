import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

export const HERE=dirname(fileURLToPath(import.meta.url));
export const WORK='paircoach-seq09-de-jdt21-compiler-probe';
export const NONCE='e7903be918a4';
export const NAME=`paircoach-p1-2-jdt21-${NONCE}`;
export const IMAGE='sha256:fea3e1e7a3012c541d476906ccb74b71df3e1ef49ef769e3fd6bd5aab8bbcdeb';
export const OUTPUT='/home/darulec/dev/codex_prjects/projects/software_dev_2/Desks/SharedDesk/deliveries/_drafts/ROOT/sequential-review-20261111/stage09-jdt21-probe-e7903be918a4-run01';
export const LABELS={'paircoach.owner':WORK,'paircoach.installation':'p1-2-jdt21-probe','paircoach.nonce':NONCE};
const hash=b=>createHash('sha256').update(b).digest('hex');
export function createArgs(source,artifacts) {
  assert.equal(source,join(OUTPUT,'input'));assert.ok(artifacts===join(OUTPUT,'artifacts'));
  return ['create','--name',NAME,...Object.entries(LABELS).flatMap(([k,v])=>['--label',`${k}=${v}`]),'--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=10001:10001','--cpus=2','--memory=1024m','--pids-limit=128','--log-driver=json-file','--log-opt=max-size=10m','--log-opt=max-file=1','--tmpfs','/tmp:rw,nosuid,nodev,size=192m,mode=1777','--mount',`type=bind,src=${source},dst=/probe,readonly`,'--mount',`type=bind,src=${artifacts},dst=/artifacts`,'--workdir=/tmp','--env=HOME=/tmp','--env=LANG=C.UTF-8','--entrypoint=/opt/java/openjdk/bin/java',IMAGE,'-Xmx128m','-Djava.io.tmpdir=/tmp','--source','21','/probe/Probe.java'];
}
export function owned(data) {
  assert.equal(data.Name,`/${NAME}`);assert.equal(data.Image,IMAGE);
  for(const [k,v] of Object.entries(LABELS))assert.equal(data.Config?.Labels?.[k],v);
  assert.match(data.Id,/^[0-9a-f]{64}$/);return data;
}
export function cleanupDecision({data,collected,durable}) {
  if(!data)return 'RECONCILE_ONLY';owned(data);
  if(data.State?.Running!==false || data.State?.Paused || data.State?.Restarting)return 'STOP_OR_RECONCILE';
  return collected&&durable?'EXACT_NONFORCE_RM':'COLLECT_AND_PERSIST';
}
export function parseProbe(text,read) {
  const p=JSON.parse(text);
  if(p.scope!=='COMPILER_ONLY_DIAGNOSTIC_NOT_PRODUCT_OR_FULL_PASS')throw Error('scope mismatch');
  const base={scope:'COMPILER_COMPARISON_ONLY',wholeSuite:'NOT_RUN',productFinding:'OPEN',originalFULL:'FAIL',classOrigin:p.classOrigin};
  if(p.status!=='EVIDENCE_COMPLETE_NO_PASS_CLAIM')return {...base,prediction:'INCONCLUSIVE',reason:p.failure??'supervisor/launch failure',rawStatus:p.status};
  assert.equal(p.commands?.length,6);
  const map=new Map(p.commands.map(c=>[c.id,c]));
  for(const a of ['preview','valid','type-error'])for(const b of ['javac','ecj']) {
    const id=`${a}-${b}`,r=map.get(id);assert.ok(r,id);assert.equal(r.status,'EXITED');assert.ok(Number.isInteger(r.exit));assert.equal(r.timedOut,false);assert.equal(r.outputOverflow,false);assert.ok(Array.isArray(r.classes));
    for(const stream of ['stdout','stderr']) {const bytes=read(id+`.${stream}`);assert.equal(hash(bytes),r[stream].sha256);}
    if(b==='ecj') {const bytes=read(id+'.xml');assert.ok(bytes.length<=262144);assert.equal(hash(bytes),r.xml?.sha256);assert.ok(!/<!DOCTYPE|<!ENTITY/i.test(bytes.toString()));}
  }
  const err=id=>{const r=map.get(id);return r.exit!==0 && (id.endsWith('javac')?/\berror:/.test(read(id+'.stderr').toString()):/severity="ERROR"/.test(read(id+'.xml').toString()));};
  const valid=map.get('valid-javac').exit===0&&map.get('valid-ecj').exit===0&&map.get('valid-javac').classes.length>0&&map.get('valid-ecj').classes.length>0;
  const typeError=err('type-error-javac')&&err('type-error-ecj');
  if(!valid||!typeError)return {...base,prediction:'INCONCLUSIVE',reason:'CONTROL_FAIL',observedPrimaryExit0Prediction:map.get('preview-ecj').exit!==0?'FALSIFIED':'NOT_FALSIFIED_BY_EXIT',controls:{valid,typeError}};
  const preview=map.get('preview-ecj'),xml=read('preview-ecj.xml').toString();
  // Require actual ECJ problem identity+raw warning in the SAME problem tag, not arbitrary text.
  const warning4195412=[...xml.matchAll(/<problem\b([^>]*)>/g)].some(m=>/\bproblemID="4195412"/.test(m[1])&&/\bseverity="WARNING"/.test(m[1]));
  const javacReject=err('preview-javac');
  let prediction,reason;
  if(preview.exit!==0){prediction='FALSIFIED';reason='ECJ_NONZERO_INSTEAD_OF_PREDICTED_EXIT0';}
  else if(javacReject&&warning4195412){prediction='SUPPORTED_FOR_THIS_BATCH_INPUT_ONLY';reason='javac error/nonzero; ECJ raw4195412 warning/exit0';}
  else {prediction='FALSIFIED';reason='Expected javac reject and ECJ4195412 warning not both observed';}
  return {...base,prediction,reason,controls:{valid,typeError},javacReject,ecjExit:preview.exit,warning4195412};
}
function verifySources() {
  const m=JSON.parse(fs.readFileSync(join(HERE,'source-manifest.json')));
  const actual=[];function walk(dir,prefix=''){for(const n of fs.readdirSync(dir)){const file=join(dir,n),r=prefix+n,st=fs.lstatSync(file);assert.ok(!st.isSymbolicLink(),'input symlink');if(st.isDirectory())walk(file,r+'/');else{assert.ok(st.isFile(),'nonregular input');actual.push(r);}}}walk(HERE);
  assert.deepEqual(actual.sort(),[...Object.keys(m),'source-manifest.json'].sort(),'unmanifested/ignored mount input');
  for(const [name,expected] of Object.entries(m)) {
    assert.ok(!name.includes('..')&&!name.startsWith('/'));const file=join(HERE,name);assert.ok(fs.lstatSync(file).isFile());assert.equal(hash(fs.readFileSync(file)),expected,name);
  }
  assert.equal(hash(fs.readFileSync(join(HERE,'sources/preview/Demo.java'))),'d9a01bba6dd72195bddce0aa57afe4eba51d761d8eacf7097bfa121d674704c8');
  return m;
}
// Fixed production driver only; tests cannot inject a fake compiler/Docker into run().
export async function run(expectedSha,out) {
  assert.match(expectedSha,/^[0-9a-f]{40}$/);assert.equal(out,OUTPUT);
  const end=Date.now()+360000;let created=false,data=null,collected=false,durable=false,interrupted=false;
  const records=[];let engineId=null;const repo=resolve(HERE,'../../..');
  const onSignal=()=>{interrupted=true;};process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
  async function command(exe,args,budget=8000) {
    const remaining=end-Date.now();if(remaining<200)throw Error('OPERATION_DEADLINE; readback required');
    const timeout=Math.min(budget,remaining),start=Date.now();
    const r=await new Promise(done=>{
      const child=spawn(exe,args,{shell:false,stdio:['ignore','pipe','pipe'],env:exe==='git'?{PATH:process.env.PATH,HOME:'/nonexistent',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}:Object.fromEntries(['PATH','HOME','DOCKER_CONFIG','DOCKER_HOST','DOCKER_CONTEXT'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]))});
      let stdout='',stderr='',bytes=0,error=null,timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);
      for(const [stream,name] of [[child.stdout,'stdout'],[child.stderr,'stderr']])stream.on('data',b=>{bytes+=b.length;if(bytes>1048576){error='CLI_OUTPUT_LIMIT';child.kill('SIGKILL');return;}if(name==='stdout')stdout+=b;else stderr+=b;});
      child.on('error',e=>{error=e.message;});child.on('close',(exit,signal)=>{clearTimeout(timer);done({argv:[exe,...args],exit,signal,timedOut,error,stdout,stderr,elapsedMs:Date.now()-start});});
    });
    records.push(r);fs.appendFileSync(join(out,'commands.jsonl'),JSON.stringify(r)+'\n');return r;
  }
  const ok=r=>{if(r.exit!==0||r.error||r.timedOut)throw Error(`operation failed/UNKNOWN ${r.argv[1]}: ${r.exit}/${r.error}/${r.timedOut}`);return r;};
  async function inspect() {const r=await command('docker',['inspect',NAME]);if(r.exit!==0)throw Error('INSPECT_UNKNOWN: retain exact name; no retry/create/rm');return owned(JSON.parse(ok(r).stdout)[0]);}
  function persist(stage,extra={}) {const tmp=join(out,'summary.tmp'),fd=fs.openSync(tmp,'w',0o600);fs.writeFileSync(fd,JSON.stringify({scope:'OPERATOR_COMPILER_PROBE_NOT_PRODUCT_ACCEPTANCE',expectedSha,nonce:NONCE,name:NAME,image:IMAGE,engineId,stage,created,collected,durable,container:data,...extra},null,2)+'\n');fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(tmp,join(out,'summary.json'));const dir=fs.openSync(out,'r');fs.fsyncSync(dir);fs.closeSync(dir);}
  // Output must be the one approved fresh path: parent canonical/no aliases; no arbitrary binds.
  assert.equal(fs.realpathSync(dirname(out)),dirname(out));fs.mkdirSync(out,{mode:0o700});fs.chmodSync(out,0o700);
  try {
    const m=verifySources();assert.equal(ok(await command('git',['-C',repo,'rev-parse','HEAD'])).stdout.trim(),expectedSha);assert.equal(ok(await command('git',['-C',repo,'status','--porcelain'])).stdout,'');
    fs.writeFileSync(join(out,'source-manifest.json'),JSON.stringify(m,null,2)+'\n');
    const absent=await command('docker',['inspect',NAME]);
    assert.ok(absent.exit===1&&!absent.timedOut&&!absent.error&&/No such (object|container)/i.test(absent.stderr),'NAME_NOT_PROVEN_ABSENT: no create/touch');
    if(interrupted)throw Error('INTERRUPTED_BEFORE_CREATE');
    engineId=JSON.parse(ok(await command('docker',['info','--format','{{json .ID}}'])).stdout);assert.equal(typeof engineId,'string');assert.ok(engineId.length>0);
    const image=JSON.parse(ok(await command('docker',['image','inspect',IMAGE])).stdout)[0];assert.equal(image.Id,IMAGE);assert.equal(image.Os,'linux');assert.equal(image.Architecture,'amd64');assert.equal(image.Config.User,'10001:10001');fs.writeFileSync(join(out,'image-inspect.json'),JSON.stringify(image,null,2)+'\n');
    const input=join(out,'input'),inputNames=['Probe.java','sources/preview/Demo.java','sources/valid/Valid.java','sources/type-error/TypeError.java'];
    for(const d of ['', 'sources','sources/preview','sources/valid','sources/type-error']){const p=join(input,d);fs.mkdirSync(p,{mode:0o755});fs.chmodSync(p,0o755);}
    const inputManifest={};for(const n of inputNames){const dst=join(input,n),bytes=fs.readFileSync(join(HERE,n));assert.equal(hash(bytes),m[n]);fs.writeFileSync(dst,bytes,{flag:'wx',mode:0o644});fs.chmodSync(dst,0o644);inputManifest[n]=hash(bytes);}
    assert.equal(fs.realpathSync(input),input);fs.writeFileSync(join(out,'input-manifest.json'),JSON.stringify(inputManifest,null,2)+'\n');
    const artifactPath=join(out,'artifacts');fs.mkdirSync(artifactPath,{mode:0o777});fs.chmodSync(artifactPath,0o777); // generated writable child inside private0700 parent only
    persist('DURABLE_CREATE_INTENT');
    const r=await command('docker',createArgs(input,artifactPath));
    // ALWAYS reconcile create (including timeout/unknown); NEVER repeat it.
    data=await inspect();created=true;
    ok(r);assert.equal(data.State.Status,'created');
    if(interrupted)throw Error('INTERRUPTED_AFTER_CREATE');
    const start=await command('docker',['start',NAME]);data=await inspect();ok(start);
    const runningDeadline=Math.min(end-60000,Date.now()+240000);
    while(data.State.Running && Date.now()<runningDeadline && !interrupted) {await new Promise(r=>setTimeout(r,1000));data=await inspect();}
    if(data.State.Running) {await command('docker',['stop','--time','2',NAME],10000);data=await inspect();}
    if(data.State.Running!==false)throw Error('PROCESS_STOP_UNCONFIRMED');
    // No artifact consumption before confirmed terminal state. Compiler outputs were generated inside tmpfs;
    // supervisor durably records raw streams + hashes/inventory in this own bind before natural exit.
    const logs=ok(await command('docker',['logs',NAME]));fs.writeFileSync(join(out,'container.stdout'),logs.stdout);fs.writeFileSync(join(out,'container.stderr'),logs.stderr);
    const inventory=[];let total=0;for(const name of fs.readdirSync(artifactPath).sort()) {assert.match(name,/^[a-z0-9-]+\.(json|xml|stdout|stderr)$/);const p=join(artifactPath,name),s=fs.lstatSync(p);assert.ok(s.isFile()&&!s.isSymbolicLink());assert.ok(s.size<=1048576);total+=s.size;assert.ok(total<=8388608&&inventory.length<96);inventory.push({name,size:s.size,sha256:hash(fs.readFileSync(p))});}
    fs.writeFileSync(join(out,'artifact-inventory.json'),JSON.stringify(inventory,null,2)+'\n');
    let result;try {result=parseProbe(fs.readFileSync(join(artifactPath,'probe.json'),'utf8'),n=>fs.readFileSync(join(artifactPath,n)));}catch(e){result={prediction:'INCONCLUSIVE',reason:e.message,remaining:'NOT_RUN_OR_UNVERIFIED'};}
    if(data.State.ExitCode!==0)result={...result,prediction:'INCONCLUSIVE',probeReason:result.reason,reason:'CONTAINER_LAUNCH_OR_HARNESS_FAILURE',actualExit:data.State.ExitCode};
    for(const [n,h] of Object.entries(inputManifest)){assert.ok(fs.lstatSync(join(input,n)).isFile());assert.equal(hash(fs.readFileSync(join(input,n))),h);}
    assert.deepEqual(verifySources(),m);collected=true;persist('COLLECTED_TERMINAL_EVIDENCE',{result});
    // Immutable terminal summary retained even when mutable operation summary advances after rm.
    fs.copyFileSync(join(out,'summary.json'),join(out,'terminal-summary.json'),fs.constants.COPYFILE_EXCL);
    // Durable receipt + fsync before cleanup decision. No success inference from exit0.
    const receipt=join(out,'durable-receipt.json'),fd=fs.openSync(receipt,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({containerId:data.Id,terminalSummarySha256:hash(fs.readFileSync(join(out,'terminal-summary.json'))),inventorySha256:hash(fs.readFileSync(join(out,'artifact-inventory.json'))),result})+'\n');fs.fsyncSync(fd);fs.closeSync(fd);
    for(const dir of [artifactPath,out]) {for(const n of fs.readdirSync(dir)){const p=join(dir,n);if(fs.lstatSync(p).isFile()){const f=fs.openSync(p,'r');fs.fsyncSync(f);fs.closeSync(f);}}const d=fs.openSync(dir,'r');fs.fsyncSync(d);fs.closeSync(d);}durable=true;
    assert.equal(cleanupDecision({data,collected,durable}),'EXACT_NONFORCE_RM');data=await inspect();assert.equal(cleanupDecision({data,collected,durable}),'EXACT_NONFORCE_RM');
    const rm=await command('docker',['rm',data.Id]);persist(rm.exit===0&&!rm.error&&!rm.timedOut?'REMOVED':'REMOVE_UNKNOWN_READBACK_REQUIRED',{result,rm});
    if(rm.exit!==0||rm.error||rm.timedOut)throw Error('REMOVE_UNKNOWN: readback required; no retry');return result;
  } catch(e) {
    // Readback-first recovery, not a new operation. Retain resources if ownership/stop/collection is unknown.
    if(created || data) {try {data=await inspect();if(data.State.Running){await command('docker',['stop','--time','2',NAME],10000);data=await inspect();}}catch{} }
    persist('RECONCILIATION_REQUIRED_NO_AUTOMATIC_RM',{error:e.message});throw e;
  } finally {process.removeListener('SIGTERM',onSignal);process.removeListener('SIGINT',onSignal);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const [mode,sha,out,...extra]=process.argv.slice(2);if(mode!=='run'||extra.length||!sha||!out)throw Error('Only K-reviewed run EXACT_SHA EXACT_NEW_OUTPUT; no prepare/retry/fake-driver');
  await run(sha,out);
}
