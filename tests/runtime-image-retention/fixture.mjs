/** UNIT installation/privateFS fixture. Copies actual source bytes; slim test-only approved
 * staging inventory. Docker is an explicit in-memory OCI-index lifetime model, NEVER a daemon. */
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const source = process.env.RETENTION_SOURCE ?? repo;
export const hash = b => createHash('sha256').update(b).digest('hex');
export const put = (file, value) => fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), {mode:0o600});
export const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const copy = v => structuredClone(v);
export const image = n => {
 const id='sha256:'+hash('config-or-index-'+n),digest='sha256:'+hash('manifest-'+n);
 return {Id:id,Descriptor:{digest,size:856,mediaType:'application/vnd.oci.image.index.v1+json',annotations:{a:'1',b:['x','y']}},RepoDigests:[],Config:{User:'10001:10001',Entrypoint:null,Env:['A=1','B=2'],Labels:{kind:'UNIT'}}};
};
export const engine = { ID:'unit-only-engine',ServerVersion:'29.7.2',OSType:'linux',Architecture:'x86_64' };
export function privateRoot(t) {
 const root=fs.mkdtempSync(path.join(process.env.TMPDIR??path.dirname(repo),'retention-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root;
}
export async function fixture(t) {
 const root=privateRoot(t),install=path.join(root,'installed');fs.mkdirSync(install,{mode:0o700});
 for(const dir of ['scripts','src','runtimes','docker','examples'])fs.cpSync(path.join(source,dir),path.join(install,dir),{recursive:true});
 fs.copyFileSync(path.join(source,'package.json'),path.join(install,'package.json'));
 fs.symlinkSync(path.join(repo,'node_modules'),path.join(install,'node_modules'));
 // Isolated test metadata, never production locks/catalog edits. Old code and final code receive
 // exactly these bytes; real expected tool versions/base pins and all catalog schemas stay intact.
 const file=path.join(install,'runtimes/production-inputs.lock.json'),lock=json(file);
 lock.artifacts=[{kind:'npm',name:'unit-tool',files:[{path:'x',sha256:hash('unit-tool')}]}];put(file,lock);
 const load=name=>import(pathToFileURL(path.join(install,'scripts',name)).href);
 const cli=await load('runtime-prepare-cli.mjs'),producer=await load('runtime-prepare.mjs'),operator=await load('runtime-operator.mjs');
 const stageTools=tools=>{fs.mkdirSync(path.join(tools,'node_modules/unit-tool'),{recursive:true,mode:0o700});put(path.join(tools,'node_modules/unit-tool/x'),'unit-tool');};
 const stage=async assets=>{fs.mkdirSync(assets,{mode:0o700});stageTools(path.join(assets,'stage/tools'));};
 const project=(name,example='javascript-counter',release=null)=>{
  const dir=path.join(root,name);fs.cpSync(path.join(install,'examples',example),dir,{recursive:true});
  if(release){const p=path.join(dir,'pom.xml');put(p,fs.readFileSync(p,'utf8').replace(/<maven.compiler.release>\d+</g,`<maven.compiler.release>${release}<`).replace(/<java.version>\d+</g,`<java.version>${release}<`));}
  const settings={schemaVersion:2,taskFilePath:null,taskMode:'IMPLEMENTATION',reviewNotesPath:'notes.md',aiConsent:false,contextPatterns:[],runProfiles:json(path.join(dir,'task.v2.json')).runProfiles};
  fs.mkdirSync(path.join(dir,'.paircoach'),{mode:0o700});put(path.join(dir,'.paircoach/settings.json'),settings);return dir;
 };
 return {root,install,cli,producer,operator,project,stage,stageTools,lock,load};
}
export function dockerModel(actualEngine=engine) {
 const images=new Map(),refs=new Map(),containers=new Map(),calls=[],builds=[],removed=[],events=[];
 let counter=0,hook=()=>{};
 const resolve=ref=>images.get(ref)??images.get(refs.get(ref));
 const ok=stdout=>({status:0,signal:null,stdout:typeof stdout==='string'?stdout:JSON.stringify(stdout),stderr:''});
 const missing=ref=>({status:1,signal:null,stdout:'[]\n',stderr:`Error response from daemon: No such image: ${ref}\n`});
 const model={images,refs,containers,calls,builds,removed,events,resolve,actualEngine,
  seed:(tag,value)=>{images.set(value.Id,copy(value));refs.set(tag,value.Id);return value;},
  set hook(fn){hook=fn;},
  command(args){
   calls.push(copy(args));events.push(args.join(' '));const intercepted=hook(args,model);if(intercepted)return intercepted;
   if(args[0]==='info')return ok(actualEngine);
   if(args[0]==='pull')return ok('UNIT local model only');
   if(args[0]==='image'&&args[1]==='inspect'){const v=resolve(args[2]);return v?ok([copy(v)]):missing(args[2]);}
   if(args[0]==='tag'){const value=resolve(args[1]);if(!value)return missing(args[1]);assert.equal(refs.has(args[2]),false,'never overwrite existing tag');refs.set(args[2],value.Id);return ok('');}
   if(args[0]==='build'){
    const tag=args[args.indexOf('--tag')+1],prior=refs.get(tag),next=image(++counter);
    refs.set(tag,next.Id);images.set(next.Id,next);builds.push({tag,id:next.Id});
    // Real failure model: OCI index loses its only reference on same-profile retarget.
    // An explicit retained reference genuinely prevents loss, not just a tag-count assertion.
    if(prior&&!Array.from(refs.values()).includes(prior)){images.delete(prior);removed.push(prior);}
    return ok('UNIT built '+next.Id);
   }
   if(args[0]==='create'){
    const name=args[args.indexOf('--name')+1],cacheArg=args.find(a=>a.startsWith('type=bind,source=')&&a.endsWith(',target=/cache/0'));
    assert.ok(cacheArg,'UNIT actual producer cache mount');const cache=cacheArg.slice('type=bind,source='.length).split(',')[0];
    const script=args.indexOf('/opt/paircoach/runtime-cache.mjs'),family=args[script+1],tools=JSON.parse(Buffer.from(args[script+2],'base64url')),workingDirectory=args[script+3],dependencySha256=args[script+4];
    put(path.join(cache,'tools.json'),tools);put(path.join(cache,'dependencies-prepared.json'),{family,workingDirectory,dependencySha256,tools});
    const input=args.find(a=>a.startsWith('type=bind,source=')&&a.endsWith(',target=/input,readonly')).slice('type=bind,source='.length).split(',')[0];
    if(family==='java-maven')fs.copyFileSync(path.join(input,workingDirectory,'pom.xml'),path.join(cache,'effective-pom.xml'));
    const imageId=args[script-2],installation=args[args.indexOf('--label')+1].split('=')[1];assert.ok(images.has(imageId));
    const state={Id:hash(name),Config:{Image:imageId,Labels:{'paircoach.installation':installation,'paircoach.role':'prepare'}},State:{Running:false,ExitCode:0}};containers.set(name,state);return ok(state.Id);
   }
   if(args[0]==='start'||args[0]==='logs')return ok('UNIT');
   if(args[0]==='inspect'){const c=containers.get(args[1]);assert.ok(c,'UNIT known created container');return ok([c]);}
   if(args[0]==='rm'){const entry=[...containers].find(([,c])=>c.Id===args[1]);assert.ok(entry);containers.delete(entry[0]);return ok(args[1]);}
   throw new Error('Unexpected UNIT operation '+JSON.stringify(args));
  },
  spawn(exe,args,options){
   assert.equal(exe,'docker');assert.equal(options.shell,false);assert.ok(options.timeout>0&&options.timeout<=480000);assert.equal(options.maxBuffer,4*1024*1024);
   assert.deepEqual(args.slice(0,3),['--host',process.platform==='win32'?'npipe:////./pipe/docker_engine':'unix:///var/run/docker.sock','--config']);
   assert.deepEqual(fs.readdirSync(args[3]),[],'each command receives a NEW EMPTY credential config');
   assert.deepEqual(Object.keys(options.env).sort(),['BUILDX_CONFIG','HOME','PATH']);return model.command(args.slice(4));
  },
 };
 return model;
}
