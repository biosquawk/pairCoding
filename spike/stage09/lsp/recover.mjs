// Operator fallback after an outer timeout. Exact known nonce names only; never broad cleanup.
import {spawnSync} from 'node:child_process';
import {readFileSync,appendFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,join} from 'node:path';
const [out]=process.argv.slice(2);
if(!out||!isAbsolute(out))throw new Error('Usage: node recover.mjs /absolute/owned-spike-output');
const {nonce}=JSON.parse(readFileSync(join(out,'prepared-images.json'),'utf8'));
if(!/^[a-f0-9]{12}$/.test(nonce))throw new Error('Invalid nonce');
const owner='paircoach-seq09-ab-lsp';
function docker(args){
  const startedUTC=new Date().toISOString(),start=Date.now();
  const result=spawnSync('docker',args,{encoding:'utf8',shell:false,timeout:8000,killSignal:'SIGKILL',maxBuffer:10*1024*1024});
  const record={argv:['docker',...args],startedUTC,endedUTC:new Date().toISOString(),wallMs:Date.now()-start,exit:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr};
  appendFileSync(join(out,'recovery-commands.jsonl'),JSON.stringify(record)+'\n');return record;
}
let failed=false;
for(const kind of ['java27','java21','python']){
  const name=`paircoach-spike-p1-2-lsp-${nonce}-${kind}`;
  const first=docker(['inspect',name]);
  if(first.exit!==0){failed=true;continue;} // absent vs daemon unavailable: recorded, never claimed stopped
  const [container]=JSON.parse(first.stdout);
  if(container.Config.Labels?.['paircoach.owner']!==owner||container.Config.Labels?.['paircoach.nonce']!==nonce)throw new Error('Foreign resource; STOP recovery');
  if(container.State.Running)docker(['stop','--time','3',name]);
  const final=docker(['inspect',name]);
  let stopped=false;try{stopped=JSON.parse(final.stdout)[0].State.Running===false;}catch{}
  docker(['logs','--timestamps',name]);
  if(kind.startsWith('java'))docker(['cp',`${name}:/work/.jdt-data/.metadata/.log`,join(out,`${kind}-recovered-jdt.log`)]);
  writeFileSync(join(out,`recovery-${kind}.json`),JSON.stringify({name,stopConfirmed:stopped,status:stopped?'PASS':'BLOCKED',scope:'Owned LSP recovery only; NOT completion/diagnostics proof',containerRetained:true},null,2)+'\n');
  if(!stopped)failed=true;
}
// Does not rm: operator verifies collected evidence and explicitly removes only confirmed stopped names.
process.exitCode=failed?2:0;
