/** Actual private identity publication faults, with immutable original e982 lazy authority. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRuntimeWorkspace, type RuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { JournalLease } from '../../src/server/runtime-coordinator/JournalLease';
function raw(root:string): Record<string,string> {
  const result:Record<string,string> = {};
  const walk = (dir:string) => { for(const e of fs.readdirSync(dir,{withFileTypes:true})) { const f=path.join(dir,e.name); if(e.isDirectory()) walk(f); else if(e.isFile()) result[path.relative(root,f)]=fs.readFileSync(f).toString('base64'); } }; walk(root); return result;
}
for(const boundary of ['link','directory-flush']) test('identity publication '+boundary+' fault retains partial material and never repairs/reset/replays on retry',async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'identity-publication-')), cores:RuntimeWorkspace[]=[];
  t.after(()=>{cores.forEach(c=>c.close());fs.rmSync(root,{recursive:true,force:true});});
  fs.writeFileSync(path.join(root,'a.ts'),'initial\n');
  const c=spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./fixture-child.ts',import.meta.url)),root,'lazy',String(fs.lstatSync(root,{bigint:true}).dev)],{stdio:['ignore','pipe','pipe']});
  let err='';c.stderr.on('data',b=>err+=b);c.stdout.resume();
  assert.equal(await new Promise((r,j)=>{c.once('exit',r);c.once('error',j);}),0,err);
  const before=raw(root), anchor=path.join(root,'.paircoach/workspace-v1.json');
  const link=fs.linkSync, flush=fs.fsyncSync;let publication=false;
  (fs as any).linkSync=(...args:any[])=>{if(String(args[1])===anchor){publication=true;if(boundary==='link')throw Error('injected identity link failure');}return (link as any)(...args);};
  fs.fsyncSync=(fd:number)=>{if(publication && boundary==='directory-flush' && fs.fstatSync(fd).isDirectory())throw Error('injected identity directory flush failure');return flush(fd);};
  syncBuiltinESMExports();
  const open=async()=>{const core=await createRuntimeWorkspace({rootPath:root});cores.push(core);return core;};
  try{await assert.rejects(open(),/injected identity/);}finally{fs.linkSync=link;fs.fsyncSync=flush;syncBuiltinESMExports();}
  const partial=raw(root);
  for(const [p,bytes] of Object.entries(before))assert.equal(partial[p],bytes,'original raw '+p);
  assert.equal(Object.keys(partial).some(n=>/\.paircoach\/identity-/.test(n)),true);
  assert.equal(fs.existsSync(anchor),boundary==='directory-flush');
  await assert.rejects(open());assert.deepEqual(raw(root),partial);
  const lease=new JournalLease(path.join(root,'.paircoach/workspace-v2/lease.lock'));lease.close();
});
