import {spawn} from 'node:child_process';
import {readFile,writeFile,mkdir,chmod,copyFile,stat} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {createHash,randomBytes} from 'node:crypto';
import {resolve,join,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Rpc} from './rpc.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const lock=JSON.parse(await readFile(join(here,'upstream.lock.json'),'utf8'));
const [mode,outArg,archiveArg]=process.argv.slice(2);
if(!['prepare','run'].includes(mode)||!outArg||!isAbsolute(outArg)) throw new Error('Usage: node spike.mjs prepare|run /absolute/NEW-owned-output [absolute/verified-jdt.tar.gz for prepare]');
const out=resolve(outArg);
// Never touch an existing result or accept arbitrary user Docker flags/environment.
// The operator chooses a fresh NEW owned directory, then reuses it only for run.
if(mode==='prepare') await mkdir(out,{recursive:false});
else await stat(join(out,'prepared-images.json'));
const nonce=mode==='prepare'?randomBytes(6).toString('hex'):JSON.parse(await readFile(join(out,'prepared-images.json'),'utf8')).nonce;
if(!/^[a-f0-9]{12}$/.test(nonce)) throw new Error('Invalid owned nonce');
const owner='paircoach-seq09-ab-lsp';
let activeRpc, interrupted=false;
process.on('SIGTERM',()=>{interrupted=true;activeRpc?.fail(new Error('Operator bounded SIGTERM; stop/inspect/collect cleanup'));});
process.on('SIGINT',()=>{interrupted=true;activeRpc?.fail(new Error('Operator interrupt; stop/inspect/collect cleanup'));});
const commandFile=join(out,`${mode}-commands.jsonl`);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const log=(file,event)=>appendFileSync(file,JSON.stringify(event)+'\n');
const command=(args,{timeout=30000,allowFailure=false}={})=>new Promise((done,reject)=>{
  const startedUTC=new Date().toISOString(),start=Date.now();
  const child=spawn('docker',args,{shell:false,env:{PATH:process.env.PATH,HOME:process.env.HOME,DOCKER_CONFIG:process.env.DOCKER_CONFIG,DOCKER_HOST:process.env.DOCKER_HOST,DOCKER_CONTEXT:process.env.DOCKER_CONTEXT},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',bytes=0,timedOut=false,failure,killTimer;
  const terminate=()=>{child.kill('SIGTERM');killTimer=setTimeout(()=>child.kill('SIGKILL'),3000);};
  const timer=setTimeout(()=>{timedOut=true;terminate();},timeout);
  const capture=(key,chunk)=>{bytes+=chunk.length;if(bytes>10*1024*1024){failure=new Error('Command output >10MiB');terminate();return;} if(key==='stdout')stdout+=chunk;else stderr+=chunk;};
  child.stdout.on('data',chunk=>capture('stdout',chunk));child.stderr.on('data',chunk=>capture('stderr',chunk));
  child.on('error',error=>{failure=error;});
  child.on('close',(exit,signal)=>{
    clearTimeout(timer);clearTimeout(killTimer);const record={argv:['docker',...args],cwd:process.cwd(),startedUTC,endedUTC:new Date().toISOString(),wallMs:Date.now()-start,exit,signal,timedOut,stdout,stderr,error:failure?.message};
    log(commandFile,record);
    if((failure||timedOut||exit!==0)&&!allowFailure) reject(new Error(`Docker command failed ${args[0]} exit=${exit} timeout=${timedOut}: ${failure?.message??stderr}`));
    else done(record);
  });
});
async function checkedDownload(url,expected,maxBytes) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:'||!['download.eclipse.org','files.pythonhosted.org'].includes(parsed.hostname))throw new Error('Untrusted artifact URL');
  const response=await fetch(url,{signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw new Error(`HTTP ${response.status} ${url}`);
  const chunks=[];let length=0;
  for await(const chunk of response.body){length+=chunk.length;if(length>maxBytes)throw new Error('Artifact size limit');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);assert.equal(hash(bytes),expected,`Artifact SHA256 ${url}`);return bytes;
}
async function prepare(){
  const info=await command(['version','--format','{{json .}}']);
  await writeFile(join(out,'docker-version.json'),info.stdout);
  const ctx=join(out,'build-context');await mkdir(ctx);await mkdir(join(ctx,'wheels'));
  let archive;
  if(archiveArg){if(!isAbsolute(archiveArg))throw new Error('Archive path must be absolute');archive=await readFile(archiveArg);assert.equal(hash(archive),lock.jdt.sha256);}
  else archive=await checkedDownload(lock.jdt.url,lock.jdt.sha256,70*1024*1024);
  await writeFile(join(ctx,'jdt.tar.gz'),archive);
  for(const wheel of lock.wheels){const bytes=await checkedDownload(wheel.url,wheel.sha256,20*1024*1024);await writeFile(join(ctx,'wheels',wheel.filename),bytes);}
  for(const file of ['Dockerfile.java','Dockerfile.python','requirements.lock'])await copyFile(join(here,file),join(ctx,file));
  const images={nonce,upstreamLockSHA256:hash(await readFile(join(here,'upstream.lock.json'))),createdUTC:new Date().toISOString(),images:{}};
  // Deliberately sequential and bounded; K grants the single shared heavy-build slot.
  for(const language of ['java','python']){
    const tag=`paircoach/spike-lsp-${language}:${nonce}`;
    await command(['build','--network=none','--platform=linux/amd64','--label',`paircoach.owner=${owner}`,'--label',`paircoach.nonce=${nonce}`,'-f',join(ctx,`Dockerfile.${language}`),'-t',tag,ctx],{timeout:300000});
    const inspected=await command(['image','inspect',tag]);
    const [data]=JSON.parse(inspected.stdout);assert.equal(data.Config.User,'10001:10001');
    images.images[language]={tag,imageId:data.Id,repoDigests:data.RepoDigests,inspect:data};
    await writeFile(join(out,'prepared-images.json'),JSON.stringify(images,null,2)+'\n');
  }
}
const containerFlags=(name,shadow,imageId)=>['create','-i','--name',name,'--label',`paircoach.owner=${owner}`,'--label',`paircoach.nonce=${nonce}`,'--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=10001:10001','--memory=2048m','--cpus=2','--pids-limit=192','--log-driver=json-file','--log-opt=max-size=10m','--log-opt=max-file=1','--tmpfs','/tmp:rw,nosuid,nodev,size=768m,mode=1777','--mount',`type=bind,src=${shadow},dst=/work`,'--workdir=/work',imageId];
async function writeShadow(root,path,text){const file=join(root,path);await mkdir(dirname(file),{recursive:true,mode:0o777});await chmod(dirname(file),0o777);await writeFile(file,text,{mode:0o666});return file;}
const javaText=(method,bad=false)=>`import java.lang.ScopedValue;\r\npublic class Demo {\r\n  static class Helper { public String ${method}() { return "żółć 😀"; } }\r\n  ScopedValue<String> scoped = ScopedValue.newInstance();\r\n  void demo() { Helper h = new Helper(); h.${method}(); ${bad?'int broken = "not-int";':''} }\r\n}\r\n`;
const pythonText=(method,bad=false)=>`class Calculator:\r\n    def ${method}(self):\r\n        return "żółć 😀"\r\n\r\ncalc = Calculator()\r\ncalc.${method}()\r\n${bad?'unknown_paircoach_symbol\r\n':''}`;
function position(text,needle){const prefix=text.slice(0,text.indexOf(needle)+needle.length);assert.ok(text.includes(needle));const lines=prefix.split('\n');return {line:lines.length-1,character:lines.at(-1).length};}
const diagnosticEvent=(uri,predicate)=>event=>event.message.method==='textDocument/publishDiagnostics'&&event.message.params.uri===uri&&predicate(event.message.params.diagnostics);
const isError=diagnostics=>diagnostics.some(d=>d.severity===1);
async function exercise(language,target,imageId){
  if(interrupted)throw new Error('Execution interrupted');
  const kind=language==='java'?`java${target}`:'python';
  const name=`paircoach-spike-p1-2-lsp-${nonce}-${kind}`;
  const shadow=join(out,`shadow-${kind}`);await mkdir(shadow,{mode:0o777});await chmod(shadow,0o777);
  const relative=language==='java'?'src/Demo.java':'demo.py',uri=`file:///work/${relative}`;
  if(language==='java'){
    await writeShadow(shadow,'.project','<?xml version="1.0" encoding="UTF-8"?><projectDescription><name>lsp-probe</name><comment/><projects/><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>');
    await writeShadow(shadow,'.classpath',`<?xml version="1.0" encoding="UTF-8"?><classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-${target}"/><classpathentry kind="output" path="bin"/></classpath>`);
    await writeShadow(shadow,'.settings/org.eclipse.jdt.core.prefs',`eclipse.preferences.version=1\norg.eclipse.jdt.core.compiler.codegen.targetPlatform=${target}\norg.eclipse.jdt.core.compiler.compliance=${target}\norg.eclipse.jdt.core.compiler.source=${target}\norg.eclipse.jdt.core.compiler.release=enabled\n`);
  }
  const method='pairCoachUniqueMethod',renamed='pairCoachRenamedMethod';
  const makeText=language==='java'?javaText:pythonText;
  let text=makeText(method);await writeShadow(shadow,relative,text);
  const server=language==='java'?['sh','-c',`cp -r /opt/jdt/config_linux /tmp/jdt-config && exec /opt/java/openjdk/bin/java -Declipse.application=org.eclipse.jdt.ls.core.id1 -Dosgi.bundles.defaultStartLevel=4 -Declipse.product=org.eclipse.jdt.ls.core.product -Xmx1024m --add-modules=ALL-SYSTEM --add-opens java.base/java.util=ALL-UNNAMED --add-opens java.base/java.lang=ALL-UNNAMED -jar /opt/jdt/plugins/${lock.jdt.launcher} -configuration /tmp/jdt-config -data /work/.jdt-data`]:["sh","-c","python -m pip install --no-index --no-deps --require-hashes --find-links=/wheels --target=/tmp/pylsp -r /requirements.lock >&2 && exec python -m pylsp"];
  await command([...containerFlags(name,shadow,imageId),...server]);
  let child,rpc,failure,summary={kind,name,imageId,target:target??'3.13',serverJVM:language==='java'?21:null,status:'NOT_RUN',originalWorkspaceMount:false,shadow,uri};
  try{
    child=spawn('docker',['start','--attach','--interactive',name],{shell:false,stdio:['pipe','pipe','pipe']});
    child.stderr.on('data',chunk=>appendFileSync(join(out,`${kind}-transport.stderr`),chunk));
    let wireBytes=0;
    rpc=new Rpc(child,(direction,message)=>{const record={utc:new Date().toISOString(),direction,message};wireBytes+=Buffer.byteLength(JSON.stringify(record));if(wireBytes>20*1024*1024)throw new Error('Wire capture >20MiB');log(join(out,`${kind}-wire.jsonl`),record);});
    const settings=language==='java'?{java:{configuration:{runtimes:[{name:'JavaSE-21',path:'/opt/java/openjdk',default:target===21},{name:'JavaSE-27',path:'/opt/jdk27',default:target===27}]},autobuild:{enabled:true},import:{maven:{enabled:false},gradle:{enabled:false}},completion:{enabled:true}}}:{pylsp:{plugins:{pyflakes:{enabled:true},pycodestyle:{enabled:false},jedi_completion:{enabled:true}}}};
    activeRpc=rpc;rpc.configuration=settings;
    if(interrupted)throw new Error('Execution interrupted');
    const initialized=await rpc.request('initialize',{processId:null,rootUri:'file:///work',workspaceFolders:[{uri:'file:///work',name:'lsp-probe'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},textDocument:{completion:{completionItem:{snippetSupport:false}},publishDiagnostics:{versionSupport:true}}},initializationOptions:{settings,extendedClientCapabilities:{classFileContentsSupport:false}}},90000);
    summary.capabilities=initialized;
    summary.capabilityObservations={positionEncoding:initialized.capabilities?.positionEncoding??'utf-16 (LSP default)',completionProvider:initialized.capabilities?.completionProvider??null,diagnosticProvider:initialized.capabilities?.diagnosticProvider??null};
    rpc.notify('initialized',{});rpc.notify('workspace/didChangeConfiguration',{settings});
    const tools=language==='java'?['sh','-c','/opt/java/openjdk/bin/java -version; /opt/java/openjdk/bin/javac --version; /opt/jdk27/bin/java -version; /opt/jdk27/bin/javac --version']:['sh','-c','python --version && python -m pip check && python -c "import importlib.metadata as m; print({n:m.version(n) for n in [\'python-lsp-server\',\'jedi\',\'pyflakes\']})"'];
    summary.tools=await command(['exec',name,...tools]);
    rpc.notify('textDocument/didOpen',{textDocument:{uri,languageId:language,version:1,text}});
    async function completion(expected,absent,triggerKind=2){
      const positionValue=position(text,language==='java'?'h.':'calc.');
      const attempts=[];
      for(let attempt=0;attempt<10;attempt++){
        const result=await rpc.request('textDocument/completion',{textDocument:{uri},position:positionValue,context:triggerKind===2?{triggerKind:2,triggerCharacter:'.'}:{triggerKind:1}},30000);
        const items=Array.isArray(result)?result:(result?.items??[]);
        const labels=items.map(i=>i.label);attempts.push(labels);
        if(labels.some(label=>label.includes(expected))&&(!absent||!labels.some(label=>label.includes(absent))))return {labels,attempts};
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw new Error(`Contextual completion missing ${expected}: ${JSON.stringify(attempts)}`);
    }
    summary.completion=await completion(method);
    summary.explicitCompletion=await completion(method,undefined,1);
    if(initialized.capabilities?.diagnosticProvider){
      summary.pullObservation={status:'PASS',result:await rpc.request('textDocument/diagnostic',{textDocument:{uri},identifier:initialized.capabilities.diagnosticProvider.identifier},30000)};
    }else summary.pullObservation={status:'NOT_RUN',reason:'Server did not advertise diagnosticProvider'};
    if(language==='java'&&target===21){
      const d=await rpc.waitFor(diagnosticEvent(uri,ds=>ds.some(d=>/ScopedValue/.test(d.message)&&d.severity===1)),0,90000);
      summary.release21Diagnostic=d; // Same Java25+ API accepted only in the target27 session.
    }else{
      const start=rpc.history.length;text=makeText(method,true);
      rpc.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text}]});
      summary.badDiagnostic=await rpc.waitFor(diagnosticEvent(uri,ds=>ds.some(d=>language==='java'?/convert|mismatch|incompatible/i.test(d.message)&&d.severity===1:/unknown_paircoach_symbol/.test(d.message))),start,90000);
      const correctedAt=rpc.history.length;text=makeText(renamed,false);
      rpc.notify('textDocument/didChange',{textDocument:{uri,version:3},contentChanges:[{text}]});
      summary.renamedCompletion=await completion(renamed,method);
      // Observation ONLY: a quiet ordering barrier is NOT a production version fence.
      summary.clearedDiagnostic=await rpc.waitFor(diagnosticEvent(uri,ds=>!isError(ds)),correctedAt,90000);
    }
    summary.diagnosticVersionFields=rpc.history.filter(e=>e.message.method==='textDocument/publishDiagnostics').map(e=>({sequence:e.sequence,uri:e.message.params.uri,hasVersion:Object.hasOwn(e.message.params,'version'),version:e.message.params.version,diagnostics:e.message.params.diagnostics}));
    await rpc.request('shutdown',null,10000);rpc.notify('exit',null);
    summary.status='PASS';
  }catch(error){failure=error;summary.status='FAIL';summary.error=error.stack;}
  finally{
    summary.diagnosticVersionFields=(rpc?.history??[]).filter(e=>e.message.method==='textDocument/publishDiagnostics').map(e=>({sequence:e.sequence,uri:e.message.params.uri,hasVersion:Object.hasOwn(e.message.params,'version'),version:e.message.params.version,diagnostics:e.message.params.diagnostics}));
    activeRpc=null;
    // Stop actual owned container, inspect state; killing docker-attach is never stop proof.
    const inspected=await command(['inspect',name],{allowFailure:true});
    let state;try{state=JSON.parse(inspected.stdout)[0];}catch{}
    if(state?.State.Running)await command(['stop','--time','3',name],{timeout:15000,allowFailure:true});
    const final=await command(['inspect',name],{allowFailure:true});
    try{summary.finalInspect=JSON.parse(final.stdout)[0];}catch{}
    summary.stopConfirmed=summary.finalInspect?.State.Running===false;
    await command(['logs','--timestamps',name],{allowFailure:true});
    if(language==='java')await command(['cp',`${name}:/work/.jdt-data/.metadata/.log`,join(out,`${kind}-jdt.log`)],{allowFailure:true});
    if(!summary.stopConfirmed){summary.status='FAIL';summary.error=(summary.error??'')+' PROCESS_STOP_UNCONFIRMED';}
    await writeFile(join(out,`${kind}-summary.json`),JSON.stringify(summary,null,2)+'\n');
    // Artifacts and durable summary exist first. Only this nonce-owned, verified stopped name.
    if(summary.stopConfirmed&&summary.finalInspect.Config.Labels['paircoach.owner']===owner&&summary.finalInspect.Config.Labels['paircoach.nonce']===nonce)await command(['rm',name]);
    if(child&&!child.killed){child.stdin.end();child.kill('SIGTERM');}
  }
  if(failure||summary.status!=='PASS')throw failure??new Error(summary.error);
  return summary;
}
async function run(){
  const images=JSON.parse(await readFile(join(out,'prepared-images.json'),'utf8'));
  assert.equal(images.upstreamLockSHA256,hash(await readFile(join(here,'upstream.lock.json'))));
  const results=[];
  for(const [language,target]of [['java',27],['java',21],['python',null]]){
    assert.match(images.images[language].imageId,/^sha256:[a-f0-9]{64}$/);
    results.push(await exercise(language,target,images.images[language].imageId));
  }
  await writeFile(join(out,'summary.json'),JSON.stringify({status:'PASS',scope:'LSP A–B only; not GUI LIVE, runtime or gate approval',results},null,2)+'\n');
}
try{if(mode==='prepare')await prepare();else await run();}
catch(error){await writeFile(join(out,`${mode}-failure.json`),JSON.stringify({status:'FAIL',error:error.stack,utc:new Date().toISOString()},null,2)+'\n');process.exitCode=1;}
