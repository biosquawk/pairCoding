import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import { WorkspaceService } from '../../src/server/WorkspaceService.ts';
import { SessionController } from '../../src/server/SessionController.ts';
import { WriteGate } from '../../src/server/WriteGate.ts';
function fixture(t:any){
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'k-g3-'));
 const root=path.join(parent,'root'), data=path.join(parent,'data');fs.mkdirSync(root);
 fs.writeFileSync(path.join(root,'a.ts'),'SOURCE-A');fs.writeFileSync(path.join(root,'b.ts'),'SOURCE-B');
 const w=new WorkspaceService(root,data),s=new SessionController(w),g=new WriteGate(w,s);s.claimLease('K');
 const auth=()=>({clientId:'K',sessionId:s.state.sessionId,controlEpoch:s.state.controlEpoch,actor:'STUDENT' as const});
 const write=(p:string,v:string)=>g.write({...auth(),path:p,content:v,baseVersion:w.getDocument(p).version});
 const snap=w.createSnapshot('Ksource');write('a.ts','WORK-A');write('b.ts','WORK-B');
 t.after(()=>{s.close();w.close();fs.rmSync(parent,{recursive:true,force:true});});
 return {root,data,w,s,g,auth,write,snap,read:(p:string)=>fs.readFileSync(path.join(root,p),'utf8'),restore:()=>g.restoreSnapshot({...auth(),snapshotId:snap.snapshotId,paths:['a.ts','b.ts'],expectedWorkspaceVersion:w.workspaceVersion})};
}

for (const phase of ['capture','rollback']) test(`K independent ${phase}: syscall destination retains late foreign bytes`, async t =>{
 const f=fixture(t); let slot='',error:any=null;
 if(phase==='rollback') f.w.on('snapshotCheckpoint',e=>{if(e.phase==='PUBLISHED'&&e.index===1)throw Error('force rollback');});
 f.w.on('snapshotCheckpoint',e=>{
   if(!slot&&e.phase===(phase==='capture'?'CAPTURE_MOVE_ARMED':'UNDO_MOVE_ARMED')&&e.index===0){
     const base=path.join(f.root,'.paircoach','snapshot-journal-v1');
     const directory=path.join(base,fs.readdirSync(base).find(n=>n.startsWith('transaction-'))!);
     slot=path.join(directory,phase==='capture'?'0.captured':'0.undone');
     fs.writeFileSync(slot,'K UNIQUE FOREIGN '+phase,{flag:'wx'});
   }
 });
 try{await f.restore();}catch(e){error=e;}
 const found=slot&&fs.existsSync(slot)?fs.readFileSync(slot,'utf8'):null;
 console.log(JSON.stringify({phase,slot,found,publicA:f.read('a.ts'),error:error?.code??null}));
 assert.ok(slot);assert.equal(found,'K UNIQUE FOREIGN '+phase);
});
