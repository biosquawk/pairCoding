/** Explicit MATERIAL verification on Docker, not a GUI/AI/WriteGate substitute.
 * stage creates fresh owned exercises; verify uses one existing prepared receipt.
 * No prepare fallback, network, image pull/build, changes to source tests or curriculum. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {XMLParser} from 'fast-xml-parser';
import {encodeSpec} from './runtime-spec.mjs';
const root=fileURLToPath(new URL('../learning-packs/rest-spring/',import.meta.url));
const [mode,output,prepared]=process.argv.slice(2);
const check=(v,m)=>{if(!v)throw Error(m);};
check(['stage','verify'].includes(mode)&&output&&path.isAbsolute(output),'Use stage ABS_NEW or verify ABS_NEW ABS_PREPARED_JOB');
check(!fs.existsSync(output),'Evidence/output already exists; preserve it, do not retry blindly.');
fs.mkdirSync(output,{mode:0o700});
const pack=JSON.parse(fs.readFileSync(path.join(root,'curriculum.json'),'utf8'));
const sha=b=>createHash('sha256').update(b).digest('hex');
const copy=(from,to)=>{
 fs.mkdirSync(to,{mode:0o755});
 for(const e of fs.readdirSync(from,{withFileTypes:true})){
  check(!e.isSymbolicLink()&&!['.paircoach','target','references'].includes(e.name),'Unsafe exercise');
  const a=path.join(from,e.name),b=path.join(to,e.name);
  if(e.isDirectory())copy(a,b);else fs.writeFileSync(b,fs.readFileSync(a),{mode:0o644,flag:'wx'});
 }
};
if(mode==='stage'){
 for(const task of pack.tasks){
  const to=path.join(output,task.id);copy(path.join(root,task.exercisePath),to);
  fs.mkdirSync(path.join(to,'.paircoach'),{mode:0o700});
  fs.copyFileSync(path.join(to,'settings.v2.json'),path.join(to,'.paircoach/settings.json'),fs.constants.COPYFILE_EXCL);
 }
 console.log(JSON.stringify({project:path.join(output,pack.tasks[0].id),profile:'java-maven-21',tasks:pack.tasks.map(t=>t.id)}));
} else {
 check(prepared&&path.isAbsolute(prepared),'Explicit prepared job required');
 const receipt=JSON.parse(fs.readFileSync(path.join(prepared,'receipt.json'),'utf8'));
 check(receipt.status==='PREPARED_REQUIRES_OFFLINE_AND_TOOL_VALIDATION'&&/^sha256:[a-f0-9]{64}$/.test(receipt.imageId)&&
  receipt.request.family==='java-maven'&&receipt.request.workingDirectory==='.'&&receipt.cacheEvidence.root,'Prepared Java receipt required');
 const deadline=Date.now()+275000,results=[];
 let active=null,cleaning=false;
 const cleanup=()=>{
  if(!active||cleaning)return;cleaning=true;
  const evidence={intent:active,steps:[]};
  const call=(args)=>{const r=spawnSync('docker',args,{encoding:'utf8',timeout:4500,maxBuffer:1048576});
    evidence.steps.push({args,status:r.status,signal:r.signal,error:r.error?.message,stdout:r.stdout,stderr:r.stderr});return r;};
  try {
   const read=call(['inspect',active.id??active.name]);
   check(read.status===0,'Cleanup inspect unavailable: retain intent and reconcile');
   const c=JSON.parse(read.stdout)[0];
   check(/^[a-f0-9]{64}$/.test(c.Id)&&(!active.id||c.Id===active.id)&&c.Config.Image===receipt.imageId&&
     c.Config.Labels['paircoach.material']===active.name,'Cleanup ownership mismatch: no stop');
   active.id=c.Id;
   if(c.State.Running){call(['stop','--time','1',c.Id]);const after=call(['inspect',c.Id]);
     check(after.status===0&&!JSON.parse(after.stdout)[0].State.Running,'STOP_UNCONFIRMED: retain container');}
   // Failure cleanup retains terminal container and artifacts for diagnosis, never blind rm.
  } catch(error){evidence.error=error.message;console.error('Cleanup:',error.message);}
  finally {fs.writeFileSync(path.join(output,'cleanup.json'),JSON.stringify(evidence,null,2)+'\n');cleaning=false;}
 };
 const terminated=()=>{cleanup();process.exit(143);};
 process.on('SIGTERM',terminated);process.on('SIGINT',terminated);
 try {
 const docker=(args)=>{
  check(Date.now()<deadline,'275s material verification deadline reached');
  const r=spawnSync('docker',args,{encoding:'utf8',timeout:Math.max(1,deadline-Date.now()),maxBuffer:16*1024*1024});
  return r;
 };
 const run=(args)=>{const r=docker(args);check(!r.error&&!r.signal&&r.status===0,r.stderr||r.error?.message||'Docker command failed');return r.stdout;};
 const pomHash=sha(fs.readFileSync(path.join(root,pack.tasks[0].exercisePath,'pom.xml')));
 for(const task of pack.tasks){
  check(sha(fs.readFileSync(path.join(root,task.exercisePath,'pom.xml')))===pomHash,'Pack POM identity differs');
  const testSource=fs.readFileSync(path.join(root,task.exercisePath,'src/test/java/demo/ApiContractTest.java'));
  const pair=[];
  for(const variant of ['starter','reference']){
   const name=task.id+'-'+variant,dir=path.join(output,name);fs.mkdirSync(dir,{mode:0o755});
   const input=path.join(dir,'input'),build=path.join(dir,'build'),artifacts=path.join(dir,'artifacts');
   copy(path.join(root,task.exercisePath),input);
   if(variant==='reference')fs.writeFileSync(path.join(input,'src/main/java/demo/ApiApplication.java'),fs.readFileSync(path.join(root,'references',task.id,'ApiApplication.java')));
   check(sha(testSource)===sha(fs.readFileSync(path.join(input,'src/test/java/demo/ApiContractTest.java'))),'Changed test oracle');
   copy(input,build);fs.chmodSync(build,0o777);fs.mkdirSync(artifacts,{mode:0o777});fs.chmodSync(artifacts,0o777);
   const runId=randomUUID(),label='learning-'+runId;
   const taskSpec=JSON.parse(fs.readFileSync(path.join(input,'settings.v2.json'),'utf8')).runProfiles.find(p=>p.kind==='RUN_TESTS').task;
   const spec=encodeSpec({schemaVersion:1,family:'java-maven',release:21,preview:false,runId,manifestSha256:sha(testSource),mode:'RUN_TESTS',task:taskSpec,cache:'/cache/0'});
   active={id:null,name:label};fs.writeFileSync(path.join(dir,'container-intent.json'),JSON.stringify(active));
   const id=run(['create','--name',label,'--pull=never','--network=none','--label','paircoach.material='+label,'--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only',
    '--memory=2g','--cpus=2','--pids-limit=256','--tmpfs','/tmp:rw,nosuid,size=256m,mode=1777',
    '--mount',`type=bind,source=${input},target=/input,readonly`,
    '--mount',`type=bind,source=${build},target=/workspace`,
    '--mount',`type=bind,source=${artifacts},target=/artifacts`,
    '--mount',`type=bind,source=${receipt.cacheEvidence.root},target=/cache/0,readonly`,
    receipt.imageId,'/opt/paircoach/node/bin/node','/opt/paircoach/runtime-task.mjs',spec]).trim();
   check(/^[a-f0-9]{64}$/.test(id),'Exact created container ID required');active.id=id;
   const result=docker(['start','--attach',id]);fs.writeFileSync(path.join(dir,'docker.log'),(result.stdout??'')+'\n'+(result.stderr??''));
   const state=JSON.parse(run(['inspect',id]))[0];
   check(state.Id===id&&state.Config.Image===receipt.imageId&&state.Config.Labels['paircoach.material']===label,'Container ownership changed');
   if(state.State.Running)throw Error('Material run timed out; cleanup will settle exact owned container');
   const xml=fs.readFileSync(path.join(artifacts,'junit/TEST-demo.ApiContractTest.xml'),'utf8');
   const suite=new XMLParser({ignoreAttributes:false}).parse(xml).testsuite;
   const counts=Object.fromEntries(['tests','failures','errors','skipped'].map(k=>[k,Number(suite['@_'+k]??0)]));
   check(counts.tests>0&&counts.skipped===0&&counts.errors===0,'Tests absent, skipped or infrastructure error; not an expected starter FAIL');
   check(variant==='starter'?state.State.ExitCode!==0&&counts.failures>0:state.State.ExitCode===0&&counts.failures===0,'Unexpected '+name+' outcome');
   pair.push({variant,containerId:id,exitCode:state.State.ExitCode,counts,testSha256:sha(testSource),
    sourceSha256:sha(fs.readFileSync(path.join(input,'src/main/java/demo/ApiApplication.java'))),pomSha256:pomHash});
   run(['rm',id]);active=null; // Only proven terminal owned container; evidence already copied by dispatcher.
  }
  results.push({taskId:task.id,pair});fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({imageId:receipt.imageId,prepared,results},null,2)+'\n');
 }
 } finally {cleanup();process.off('SIGTERM',terminated);process.off('SIGINT',terminated);}
 console.log(JSON.stringify({MATERIAL:results.length+'/'+pack.tasks.length,results:path.join(output,'results.json')}));
}
