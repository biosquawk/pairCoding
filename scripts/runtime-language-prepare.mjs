// Called ONLY by reviewed sequential operator harness, never runtime auto-start.
import * as fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {canonicalDirectory,readPrivate} from './runtime-files.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),hash=b=>createHash('sha256').update(b).digest('hex');
export function prepareLanguageImages(root,lock,{run,save,receipt},kinds=['java','python']) {
 if(!Array.isArray(kinds)||!kinds.length||kinds.length>2||new Set(kinds).size!==kinds.length||kinds.some(k=>!['java','python'].includes(k)))throw new Error('Explicit nonempty unique language kinds required');
 const make=d=>{canonicalDirectory(path.dirname(d));fs.mkdirSync(d,{mode:0o700});canonicalDirectory(d);};
 const put=(p,b)=>{canonicalDirectory(path.dirname(p));const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,b);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
 const artifact=(a,p)=>{const b=readPrivate(p,128*1024*1024).bytes;if(b.length!==a.bytes||hash(b)!==a.sha256)throw new Error('Language staging hash differs');return b;};
 make(path.join(root,'language-contexts'));receipt.language=[];save();
 for(const kind of kinds) {
  const context=path.join(root,'language-contexts',kind);make(context);
  const key=kind==='java'?'jdt-runtime-27':'pylsp-runtime-3.13',tag=kind==='java'?'paircoach/language-jdt:stage09':'paircoach/language-pylsp:stage09';
  const item={key,engine:receipt.engine,status:'BUILD_INTENT',imageTag:tag,tools:[]};receipt.language.push(item);save();
  put(path.join(context,'Dockerfile'),readPrivate(path.join(repo,`docker/language-${kind}.Dockerfile`),65536).bytes);
  if(kind==='java') {
   const a=lock.language.artifacts.find(a=>a.kind==='jdt');put(path.join(context,'jdt.tar.gz'),artifact(a,path.join(root,'stage/language/jdt.tar.gz')));
   for(const k of ['java11','java17','java21','java27'])run(['pull','--platform=linux/amd64',lock.images[k].reference]);
  }else{
   make(path.join(context,'wheels'));for(const a of lock.language.artifacts.filter(a=>a.kind==='language-wheel'))put(path.join(context,'wheels',a.filename),artifact(a,path.join(root,'stage/wheels',a.filename)));
   put(path.join(context,'requirements.lock'),readPrivate(path.join(repo,'runtimes/pylsp-requirements.lock'),65536).bytes);
   run(['pull','--platform=linux/amd64',lock.images.python.reference]);
  }
  run(['build','--pull=false','--network=none','--tag',tag,context]);
  const image=JSON.parse(run(['image','inspect',tag]).stdout)[0];
  if(!image || !/^sha256:[a-f0-9]{64}$/.test(image.Id) || image.Config.User!=='10001:10001' || image.Config.Entrypoint?.length)throw new Error('Language image identity/user/entrypoint mismatch');
  item.observedImage={Id:image.Id,RepoDigests:image.RepoDigests??[],Descriptor:image.Descriptor??null};item.status='TOOL_PROBES_PENDING';save();
  const wheels=lock.language.artifacts.filter(a=>a.kind==='language-wheel'),pythonCode='import sys,json,importlib.metadata as m;print(json.dumps({"python":sys.version.split()[0],"packages":{n:m.version(n) for n in '+JSON.stringify(wheels.map(a=>a.name))+'}}))';
  const probes=kind==='java'?[
   {name:'jdt-server-java',exe:'/opt/jdk27/bin/java',args:['-version'],version:'27.0.1.0'},
   ...[11,17,21,27].map(release=>({name:'target-javac-'+release,exe:(release===21?'/opt/java/openjdk':'/opt/jdk'+release)+'/bin/javac',args:['-version'],version:({11:'11.0.33',17:'17.0.21',21:'21.0.13',27:'27.0.1.0'})[release]}))
  ]:[{name:'python-pylsp-inventory',exe:'/usr/local/bin/python',args:['-c',pythonCode]}];
  for(const probe of probes) {
   const name='paircoach-stage09-language-'+probe.name,record={name,status:'CREATE_INTENT'};item.tools.push(record);save();
   run(['create','--pull=never','--name',name,'--label','paircoach.installation=stage09-runtime-assets','--label','paircoach.role=language-tool-probe','--user','10001:10001','--cap-drop=ALL','--security-opt=no-new-privileges','--read-only','--network=none','--memory=1g','--cpus=1','--pids-limit=128','--log-driver=json-file','--log-opt','max-size=10m','--log-opt','max-file=1','--tmpfs','/tmp:rw,nosuid,size=256m,mode=1777',image.Id,probe.exe,...probe.args]);
   const raw=run(['start','--attach',name]),state=JSON.parse(run(['inspect',name]).stdout)[0];
   if(!state || !/^[a-f0-9]{64}$/.test(state.Id) || state.State.Running || state.State.ExitCode!==0 || state.Config.Image!==image.Id || state.Config.Labels?.['paircoach.installation']!=='stage09-runtime-assets' || state.Config.Labels?.['paircoach.role']!=='language-tool-probe')throw new Error('Language probe terminal ownership/exit uncertain');
   run(['logs',name]);const text=(raw.stdout+raw.stderr).trim();
   if(kind==='java') {const version=text.match(probe.name==='jdt-server-java'?/version "([^"]+)"/:/^javac (\S+)/)?.[1];if(version!==probe.version)throw new Error('Language actual Java tool version mismatch');record.version=version;}
   else {const actual=JSON.parse(raw.stdout);if(actual.python!==lock.language.pylsp.pythonVersion || wheels.some(a=>actual.packages[a.name]!==a.version))throw new Error('Language actual Python tool inventory mismatch');record.inventory=actual;}
   record.container=state;record.stdout=raw.stdout;record.stderr=raw.stderr;record.status='COLLECTED_DURABLE';save();
   run(['rm',state.Id]);record.status='TOOL_PROBE_PASS_REMOVED';save();
  }
  item.status='BUILT_TOOLS_CHECKED_NOT_LSP_FUNCTIONAL_ACCEPTANCE';item.readiness='NOTREADY_UNTIL_K_REVIEWED_ACTUAL_IMAGE_DIGEST_AND_BOOT_MANIFEST';save();
 }
 return receipt.language;
}
