/** Modeled Docker ONLY. Real private FS + actual staged accepted prepare/retention/client.
 * No worker Docker/host lane, downloads or execution of tools. */
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const shared=path.resolve(repo,'../../../..');
export const historical=path.join(shared,'deliveries/_drafts/ROOT/sequential-review-20261111');
export const controller=path.join(repo,'scripts/runtime-operator-image-recovery.mjs');
export const hash=b=>createHash('sha256').update(b).digest('hex');
export const json=file=>JSON.parse(fs.readFileSync(file));
export const put=(file,value)=>fs.writeFileSync(file,typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2),{mode:0o600});
export const proof=file=>({file,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))});
export const originalOptions=outputRoot=>({
 proposalFile:path.join(shared,'deliveries/work-paircoach-seq09-producer-image-retention-1d932e7b/822b2d54-6d6a-4526-a37e-b7e5a4356187-555d056b499ec37c31e572483f803e34530f9ffd99587ccf25abff8e73502960/14-76519849a518-proposal.json'),
 cacheSnapshotFile:path.join(historical,'producer-retention-f6a0-independent-readback/all-nine-historical-cache-preflight.json'),
 producerRoot:path.join(historical,'stage09-host-operator/prepare-only-source-f6a0a856'),outputRoot,
});
export function root(t){const dir=fs.mkdtempSync(path.join(path.dirname(repo),'recovery-unit-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
export function guard(plan,planHash,root){
 const evidence=path.join(root,'unit-measured-disk.json');if(!fs.existsSync(evidence))put(evidence,{unitOnly:true,freeBytes:20*1024**3});
 return {schemaVersion:1,operator:'ROOT',observedAtMs:Date.now(),planSha256:planHash,controllerSha256:plan.controller.sha256,closureSha256:hash(JSON.stringify(plan.sourceInventory)),base:plan.base,engine:plan.engine,
  measurements:Object.fromEntries(['vm','physical','host'].map(k=>[k,{freeBytes:20*1024**3,storagePath:plan.guardPolicy.storagePaths[k],evidenceFile:evidence,evidenceSha256:proof(evidence).sha256}])),singleHeavyLane:true};
}
export async function load(file=controller){return import(pathToFileURL(file).href);}
export function dockerModel(plan){
 const images=new Map(),refs=new Map(),containers=new Map(),calls=[],events=[],configs=new Set();let counter=0,hook=()=>{};
 const p=json(plan.options.proposalFile);
 for(const pin of plan.initialRequiredPins)images.set(pin.observedImage.Id,structuredClone(pin.observedImage));
 for(const j of p.preserveRun)refs.set(json(j.leafReceipt.file).request.imageTag,j.pin.observedImage.Id);
 for(const l of p.preserveLanguage)refs.set(json(l.receipt.file).language.find(x=>x.key===l.key).imageTag,l.pin.observedImage.Id);
 const ok=v=>({status:0,signal:null,stdout:typeof v==='string'?v:JSON.stringify(v),stderr:''});
 const absent=(kind,ref)=>({status:1,signal:null,stdout:'[]\n',stderr:`Error: No such ${kind}: ${ref}\n`});
 const model={images,refs,containers,calls,events,configs,engine:plan.engine,
  set hook(fn){hook=fn;},
  spawn(exe,argv,options){
   assert.equal(exe,'docker');assert.equal(options.shell,false);assert.ok(options.timeout>0&&options.timeout<=480000);assert.equal(options.maxBuffer,4194304);
   assert.deepEqual(argv.slice(0,3),['--host','unix:///var/run/docker.sock','--config']);
   assert.equal(configs.has(argv[3]),false,'one empty config per outer AND leaf command');configs.add(argv[3]);assert.deepEqual(fs.readdirSync(argv[3]),[]);
   const client=path.dirname(path.dirname(argv[3]));assert.deepEqual(options.env,{PATH:process.env.PATH,HOME:path.join(client,'docker-home'),BUILDX_CONFIG:path.join(client,'docker-buildx')});
   const args=argv.slice(4);calls.push(args);const intercepted=hook(args,model);if(intercepted)return intercepted;
   if(args[0]==='info')return ok(model.engine);
   if(args[0]==='ps')return ok('');
   if(args[0]==='container')return absent('container',args[2]);
   if(args[0]==='image'){
    const image=images.get(args[2])??images.get(refs.get(args[2]));if(!image)return absent('image',args[2]);
    const actual=structuredClone(image);
    // Genuine manifest/Id/Config stable; name-derived aliases grow/reorder/disappear on retarget.
    actual.RepoDigests=[...refs].filter(([,id])=>id===image.Id).map(([ref])=>ref.slice(0,ref.lastIndexOf(':'))+'@'+image.Descriptor.digest).reverse();
    return ok([actual]);
   }
   if(args[0]==='tag'){
    assert.equal(refs.has(args[2]),false);assert.ok(images.has(args[1]));refs.set(args[2],args[1]);events.push({type:'tag',id:args[1],reference:args[2]});return ok('');
   }
   if(args[0]==='pull')return ok('UNIT pinned base-image acquisition modeled; no network');
   if(args[0]==='build'){
    const tag=args[args.indexOf('--tag')+1],prior=refs.get(tag),id='sha256:'+hash('UNIT recovered Pure image '+(++counter));
    const image={Id:id,Descriptor:{digest:'sha256:'+hash('UNIT manifest '+counter),size:856,mediaType:'application/vnd.oci.image.index.v1+json'},RepoDigests:[],Config:{User:'10001:10001',Entrypoint:null,Env:['UNIT=1']}};
    images.set(id,image);refs.set(tag,id);
    if(prior && ![...refs.values()].includes(prior))images.delete(prior); // reference loss regression is genuine in this model
    events.push({type:'build',tag,id});return ok('UNIT '+id);
   }
   if(args[0]==='create'){
    const name=args[args.indexOf('--name')+1],script=args.indexOf('/opt/paircoach/runtime-cache.mjs');
    const cache=args.find(s=>s.startsWith('type=bind,source=')&&s.endsWith(',target=/cache/0')).slice('type=bind,source='.length).split(',')[0];
    const family=args[script+1],tools=JSON.parse(Buffer.from(args[script+2],'base64url')),workingDirectory=args[script+3],dependencySha256=args[script+4];
    put(path.join(cache,'tools.json'),tools);put(path.join(cache,'dependencies-prepared.json'),{family,tools,workingDirectory,dependencySha256});
    put(path.join(cache,'effective-pom.xml'),'<project/>');
    const state={Id:hash(name),Config:{Image:args[script-2],Labels:{'paircoach.installation':args[args.indexOf('--label')+1].split('=')[1],'paircoach.role':'prepare'}},State:{Running:false,ExitCode:0}};
    containers.set(name,state);events.push({type:'create',name});return ok(state.Id);
   }
   if(args[0]==='start'||args[0]==='logs')return ok('UNIT');
   if(args[0]==='inspect'){assert.ok(containers.has(args[1]));return ok([containers.get(args[1])]);}
   if(args[0]==='rm'){const entry=[...containers].find(([,s])=>s.Id===args[1]);assert.ok(entry);containers.delete(entry[0]);events.push({type:'rm',id:args[1]});return ok(args[1]);}
   assert.fail('unmodeled Docker command '+JSON.stringify(args));
  },
 };return model;
}
/** Small private historical FS fixture. ONLY two hardcoded historical input hash literals are
 * adapted in a copied controller, with exact replacement count. All executable logic and actual
 * staged f6a0 producer/lock/catalog remain unchanged. The unmodified planner is checked separately
 * against the real full 9-cache ROOT evidence. No FS/Docker/prepare/planner injection. */
export async function fixture(t){
 const dir=root(t),o=originalOptions(path.join(dir,'unused-output')),p=json(o.proposalFile),oldRoots=[...new Set([...p.preserveRun,...p.recoverOnly].map(j=>path.resolve(path.dirname(j.leafReceipt.file),'../..')))];
 const producer=path.join(dir,'producer');for(const entry of p.producerSource.sourceClosure){const dest=path.join(producer,entry.path);fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.copyFileSync(path.join(o.producerRoot,entry.path),dest);}o.producerRoot=producer;
 const mapping=new Map(oldRoots.map((r,i)=>[r,path.join(dir,i===0?'r1':'r3')]));
 const relocate=file=>{for(const [old,next] of mapping)if(file===old||file.startsWith(old+'/'))return next+file.slice(old.length);return file;};
 const copyDir=(from,to)=>{fs.mkdirSync(path.dirname(to),{recursive:true,mode:0o700});fs.cpSync(from,to,{recursive:true,mode:fs.constants.COPYFILE_FICLONE});};
 for(const [old,next] of mapping){fs.mkdirSync(next,{mode:0o700});copyDir(path.join(old,'stage'),path.join(next,'stage'));for(const sub of ['projects','requests'])copyDir(path.join(old,sub),path.join(next,sub));}
 const languageRoot=path.dirname(p.preserveLanguage[0].receipt.file);copyDir(path.join(languageRoot,'language-contexts'),relocate(path.join(languageRoot,'language-contexts')));
 const caches=[];
 for(const record of [...p.preserveRun,...p.recoverOnly]){
  const leaf=json(record.leafReceipt.file),oldFile=record.leafReceipt.file;
  leaf.request.tools.root=relocate(leaf.request.tools.root);leaf.request.project.root=relocate(leaf.request.project.root);leaf.request.outputRoot=relocate(leaf.request.outputRoot);
  const cache=relocate(leaf.cacheEvidence.root);fs.mkdirSync(cache,{recursive:true,mode:0o700});
  put(path.join(cache,'tools.json'),leaf.cacheEvidence.tools.actual);put(path.join(cache,'dependencies-prepared.json'),leaf.cacheEvidence.dependencies.actual);put(path.join(cache,'old-artifact.bin'),'OLD '+record.job);
  leaf.cacheEvidence.root=cache;
  const file=relocate(oldFile);put(file,leaf);record.leafReceipt=proof(file);
  if(record.request){record.request=structuredClone(leaf.request);record.proposedRequest={...structuredClone(leaf.request),installationId:'stage09-image-recovery2-f6a0a856',outputRoot:relocate(record.proposedRequest.outputRoot)};record.sourceFiles=record.sourceFiles.map(f=>proof(relocate(f.file)));}
  else {record.cacheRoot=cache;record.pin.source=file;}
  const files=fs.readdirSync(cache).sort().map(name=>({path:name,bytes:fs.statSync(path.join(cache,name)).size,sha256:hash(fs.readFileSync(path.join(cache,name)))}));
  caches.push({job:record.job,leafReceipt:file,leaf_sha256:record.leafReceipt.sha256,root:cache,files,bytes:files.reduce((n,f)=>n+f.bytes,0)});
 }
 const aggregate=json(p.preserveLanguage[0].receipt.file),aggregateFile=relocate(p.preserveLanguage[0].receipt.file);put(aggregateFile,aggregate);
 for(const l of p.preserveLanguage){l.receipt=proof(aggregateFile);l.pin.source=aggregateFile+'#language/'+l.key;}
 p.initialRequiredPins=[...p.preserveRun.map(j=>j.pin),...p.preserveLanguage.map(l=>l.pin)];
 const stageManifest=json(p.staging.frozenManifestSource.file);stageManifest.staging.root=relocate(stageManifest.staging.root);
 const manifestFile=path.join(dir,'old-stage-plan.json');put(manifestFile,stageManifest);p.staging.frozenManifestSource=proof(manifestFile);p.staging.root=stageManifest.staging.root;
 const r1=path.dirname(p.staging.root);fs.mkdirSync(path.join(r1,'download-journal'),{mode:0o700});put(path.join(r1,'download-journal/receipt.json'),{status:'STAGED_NOT_PREPARED'});
 const prior=path.join(dir,'prior-readonly-evidence.json');put(prior,{unitOnly:true});p.requiredPriorEvidence=[proof(prior)];
 o.proposalFile=path.join(dir,'proposal.json');o.cacheSnapshotFile=path.join(dir,'cache-snapshot.json');put(o.proposalFile,p);put(o.cacheSnapshotFile,{roots:caches});
 const original=fs.readFileSync(controller,'utf8');let adapted=original;
 for(const [before,after] of [['76519849a51863fb65bd92a81d844604b1ec3d623a53a122faa64bdb57bbbb73',proof(o.proposalFile).sha256],['26af27ad2fa0aa1e083412ef0a8f9d93eb13f39debd3b005410f28f0a581aa5c',proof(o.cacheSnapshotFile).sha256]]){assert.equal(adapted.split(before).length,2);adapted=adapted.replace(before,after);}
 fs.mkdirSync(path.join(dir,'controller'),{mode:0o700});const file=path.join(dir,'controller/operator.mjs');put(file,adapted);
 const m=await load(file);return {dir,o,p,m,file,async plan(name){return m.buildRecoveryPlan({...o,outputRoot:path.join(dir,name)});}};
}
