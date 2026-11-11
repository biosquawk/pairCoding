import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { coreFixture } from '../qa/helpers';
import type { AcknowledgedRunInput, InputFile } from '../../src/server/execution/ports';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const auth = (f: Awaited<ReturnType<typeof coreFixture>>) => ({ clientId:f.clientId,sessionId:f.sessionId,controlEpoch:f.session.state.controlEpoch,actor:'STUDENT' as const });
/** UNIT inventory/copy collaborators, not production executor or Docker integration proof. */
const inventory = (root: string) => Promise.resolve(fs.readdirSync(root).filter(f => fs.statSync(path.join(root,f)).isFile()).sort().map(file => {
  const bytes = fs.readFileSync(path.join(root,file)); return {path:file,sha256:hash(bytes),bytes:bytes.length};
}));
const copy = async (o: { runId:string;profileId:string;configurationGeneration:string;runDirectory:string;acknowledgement:{projectId:string;sessionId:string;workspaceVersion:number;files:readonly InputFile[];assertCurrent():Promise<void>} }): Promise<AcknowledgedRunInput> => {
  await o.acknowledgement.assertCurrent();
  return { projectId:o.acknowledgement.projectId,sessionId:o.acknowledgement.sessionId,files:o.acknowledgement.files,
    identity:{runId:o.runId,profileId:o.profileId,configurationGeneration:o.configurationGeneration,workspaceVersion:o.acknowledgement.workspaceVersion,manifestSha256:hash(JSON.stringify(o.acknowledgement.files))},
    immutableDirectory:o.runDirectory+'/input',buildDirectory:o.runDirectory+'/build',artifactsDirectory:o.runDirectory+'/artifacts' };
};
const request = (f: Awaited<ReturnType<typeof coreFixture>>) => ({ ...auth(f),runId:'run1',profileId:'profile1',configurationGeneration:'cfg1',expectedWorkspaceVersion:f.workspace.workspaceVersion,runDirectory:path.join(f.workspace.dataDir,'run1') });

test('UNIT genuine gate capture retains queue order, actual document versions/raw CRLF+BOM and lease until copy', async t => {
  const f = await coreFixture(t, {'main.py':Buffer.from('\ufeffone\r\n'),'dep.json':'{}\n'});
  const old = f.workspace.getDocument('main.py');
  const first = f.gate.writeAsync({...auth(f),path:'main.py',baseVersion:old.version,content:'two\n'});
  const after = await first;
  const input = request(f); let entered!:()=>void, release!:()=>void;
  const inside = new Promise<void>(r => {entered=r;}), wait = new Promise<void>(r => {release=r;});
  let acknowledgement: Parameters<typeof copy>[0]['acknowledgement'];
  const captured = f.gate.captureRun(input,{inventory,copy:async o=>{ acknowledgement=o.acknowledgement;entered();await wait;return copy(o); }});
  await inside;
  assert.throws(()=>f.gate.write({...auth(f),path:'main.py',baseVersion:after.version,content:'unsafe\n'}),{code:'WORKSPACE_BUSY'});
  const later = f.gate.writeAsync({...auth(f),path:'main.py',baseVersion:after.version,content:'later\n'});
  release(); const immutable = await captured; await later;
  const main = immutable.files.find(f=>f.path==='main.py')!;
  assert.equal(main.documentVersion,after.version);
  assert.equal(main.sha256,hash(Buffer.from('\ufefftwo\r\n'))); assert.notEqual(main.sha256,hash(after.content));
  assert.equal(f.workspace.getDocument('main.py').content,'later\n');
  await assert.rejects(acknowledgement!.assertCurrent(),{code:'RUN_INPUT_CHANGED'});
});

test('UNIT pending earlier admitted write settles before capture; expected version cannot be guessed', async t => {
  const f=await coreFixture(t,{'main.py':'one\n'}), old=f.workspace.getDocument('main.py');
  const input=request(f), write=f.gate.writeAsync({...auth(f),path:'main.py',baseVersion:old.version,content:'two\n'});
  const capture=f.gate.captureRun(input,{inventory,copy});
  await write; await assert.rejects(capture,{code:'WORKSPACE_VERSION_CONFLICT'});
});

test('UNIT unobserved external dependency change during awaited copy rejects whole capture',async t=>{
  const f=await coreFixture(t,{'main.py':'one\n','dep.json':'{}\n'});
  await assert.rejects(f.gate.captureRun(request(f),{inventory,copy:async o=>{
    fs.writeFileSync(path.join(f.rootPath,'dep.json'),'{"changed":true}\n');return copy(o);
  }}), e=>['RUN_INPUT_CHANGED','WORKSPACE_VERSION_CONFLICT'].includes((e as any).code));
  assert.equal(f.workspace.getDocument('main.py').content,'one\n');
});

test('UNIT gate refuses mismatched copy identity or fake client document inventory',async t=>{
  const f=await coreFixture(t,{'main.py':'one\n'});
  await assert.rejects(f.gate.captureRun(request(f),{inventory,copy:async o=>({...await copy(o),sessionId:'foreign'})}),{code:'RUN_INPUT_CHANGED'});
  await assert.rejects(f.gate.captureRun(request(f),{inventory:async root=>(await inventory(root)).map(f=>({...f,sha256:'0'.repeat(64)})),copy}),{code:'RUN_INPUT_CHANGED'});
});

test('UNIT admitted queued operation fences synchronous caller BEFORE first microtask, without version leapfrog',async t=>{
  const f=await coreFixture(t,{'main.py':'one\n'}),original=f.workspace.getDocument('main.py');
  const pending=f.gate.writeAsync({...auth(f),path:'main.py',baseVersion:original.version,content:'queued\n'});
  assert.throws(()=>f.gate.write({...auth(f),path:'main.py',baseVersion:original.version,content:'bypass\n'}),{code:'WORKSPACE_BUSY'});
  await pending;assert.equal(f.workspace.getDocument('main.py').content,'queued\n');
});
