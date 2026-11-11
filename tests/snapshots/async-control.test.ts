import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import childProcess from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { fixture, code } from './helpers';

// Diagnostic transport ONLY: not the product HTTP/ledger integration owned by P6.
test('separate-process GET/VETO interrupts real multi-file restore; BUSY, old-auth cutoff, rollback, one backup', async t => {
  const files = Object.fromEntries(Array.from({length:100}, (_, i) => [`f${i}.ts`, 'SNAPSHOT']));
  const f = fixture(t, files), paths = Object.keys(files);
  const source = await f.workspace.createSnapshotAsync('Before');
  for (const p of paths) fs.writeFileSync(f.file(p), 'WORK');
  f.workspace.scanExternal();
  let terminal = false, cutoff = false, forwardAfterCutoff = 0, acknowledgedBeforeEnd = false, initiated = false, journalSettled = false;
  const phases: string[] = [], publicEvents: any[] = [];
  f.workspace.on('external', e => {
    assert.ok(journalSettled, 'watch/poll must not expose partially captured/published state');
    assert.equal(e.operation, 'UPDATED'); assert.equal(e.document?.content, 'WORK');
    publicEvents.push(e);
  });
  const server = http.createServer(async (req, res) => {
    const received = performance.now();
    try {
      let body: any;
      switch (req.url) {
        case '/document': body = f.workspace.getDocument(paths[0]); break;
        case '/settings': f.workspace.updateSettings({...f.workspace.settings}); break;
        case '/write': f.gate.write({...f.auth(), path:paths[0], baseVersion:1, content:'BAD'}); break;
        case '/capture': body = await f.workspace.createSnapshotAsync('Must be BUSY'); break;
        case '/restore': body = await f.restore(source.snapshotId, paths); break;
        case '/veto': {
          const epoch = f.session.state.controlEpoch;
          f.session.veto(); cutoff = true;
          acknowledgedBeforeEnd = !terminal;
          body = {epochBefore: epoch, epochAfter:f.session.state.controlEpoch, terminal, handlingMs:performance.now()-received};
          break;
        }
        default: throw Error('Unexpected request');
      }
      res.setHeader('content-type','application/json'); res.end(JSON.stringify(body ?? {}));
    } catch (error: any) {
      res.statusCode = error.status ?? 500; res.setHeader('content-type','application/json'); res.end(JSON.stringify({code:error.code}));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = childProcess.fork(fileURLToPath(new URL('./async-control-client.ts', import.meta.url)), [], {stdio:['ignore','pipe','pipe','ipc']});
  t.after(async () => { child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const received = (kind: string) => new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', onMessage); reject(Error('Diagnostic client timeout')); }, 20000);
    function onMessage(message: any) {
      if (message.kind !== kind && message.kind !== 'ERROR') return;
      clearTimeout(timer); child.off('message', onMessage);
      if (message.kind === 'ERROR') reject(Error(message.message)); else resolve(message);
    }
    child.on('message', onMessage);
  });
  await received('READY');
  const clientResult = received('RESULT');
  f.workspace.on('snapshotCheckpoint', e => {
    if (cutoff && ['CAPTURE_MOVE_RETURNED','PUBLISHED','COMMITTED'].includes(e.phase)) forwardAfterCutoff++;
    phases.push(e.phase);
    if (e.phase === 'ROLLED_BACK') journalSettled = true;
    if (e.phase === 'PUBLISHED' && e.index === 0 && !initiated) {
      initiated = true;
      child.send({kind:'GO', url:`http://127.0.0.1:${(server.address() as any).port}`});
    }
  });
  const version = f.workspace.workspaceVersion;
  await assert.rejects(f.restore(source.snapshotId, paths, version).finally(() => { terminal = true; }), code('RESTORE_INCOMPLETE'));
  const result = await clientResult;
  assert.ok(initiated); assert.ok(acknowledgedBeforeEnd); assert.ok(cutoff);
  assert.equal(result.veto.status, 200); assert.equal(result.veto.body.epochAfter, result.veto.body.epochBefore + 1);
  assert.equal(result.veto.body.terminal, false); assert.ok(result.veto.body.handlingMs < 50);
  assert.equal(forwardAfterCutoff, 0); assert.ok(phases.includes('ROLLED_BACK')); assert.ok(!phases.includes('COMMITTED'));
  assert.deepEqual(result.busy.map((r: any) => [r.status,r.body.code]), paths.slice(0,5).map(() => [409,'WORKSPACE_BUSY']));
  assert.equal(publicEvents.length, paths.length, 'post-rollback rescan publishes only settled WORK with new inode stamps');
  assert.equal(f.workspace.listSnapshots().length, 2, 'one source, exactly one backup');
  const backup = f.workspace.listSnapshots().find(s => s.snapshotId !== source.snapshotId)!;
  assert.ok(f.workspace.readSnapshot(backup.snapshotId).files.every(b => Buffer.from(b.rawBase64!, 'base64').toString() === 'WORK'));
  for (const p of paths) assert.equal(fs.readFileSync(f.file(p),'utf8'), 'WORK');
  f.gate.write({...f.auth(),path:paths[0],baseVersion:f.workspace.getDocument(paths[0]).version,content:'AFTER'});
  console.log('ASYNC_CONTROL ' + JSON.stringify({platform:process.platform,node:process.version,count:paths.length,version,forwardAfterCutoff,acknowledgedBeforeEnd,...result}));
});

test('async capture/restore hold root guard across await and release after resolve/reject; original DTO is frozen', async t => {
  const f = fixture(t), source = f.workspace.createSnapshot('Source');
  const other = new WorkspaceService(f.root, f.data); t.after(() => other.close());
  const capturing = f.workspace.createSnapshotAsync('Async');
  assert.throws(() => f.workspace.createSnapshot('BUSY'), code('WORKSPACE_BUSY'));
  assert.throws(() => other.getDocument('a.ts'), code('WORKSPACE_BUSY'));
  assert.throws(() => new WorkspaceService(f.root,f.data), code('WORKSPACE_BUSY'));
  await assert.rejects(other.createSnapshotAsync('BUSY'), code('WORKSPACE_BUSY'));
  await capturing;
  f.write('a.ts','WORK');
  const accepted = {...f.auth(), snapshotId:source.snapshotId, paths:['a.ts'], expectedWorkspaceVersion:f.workspace.workspaceVersion};
  const restoring = f.gate.restoreSnapshot(accepted);
  accepted.paths[0] = 'b.ts'; accepted.controlEpoch = -1;
  assert.throws(() => other._withMutation(() => assert.fail('must not run')), code('WORKSPACE_BUSY'));
  const backup = await restoring;
  assert.deepEqual(backup.paths,['a.ts']); assert.equal(f.bytes('a.ts').toString(),'SNAP A\n');
  await assert.rejects(f.workspace.createSnapshotAsync('bad', ['../outside']), code('RECOVERY_REQUIRED'));
  f.workspace.createSnapshot('Guard released');
  // Mutating the caller's epoch to the new value cannot refresh accepted authority after a yield.
  const stale = {...f.auth(), snapshotId:source.snapshotId, paths:['a.ts'], expectedWorkspaceVersion:f.workspace.workspaceVersion};
  const pending = f.gate.restoreSnapshot(stale);
  f.session.veto(); stale.controlEpoch = f.session.state.controlEpoch;
  await assert.rejects(pending, code('STALE_EPOCH'));
  f.workspace.createSnapshot('Guard released after stale epoch');
});

test('yieldable capture preserves whole-tree validation after private store writes', async t => {
  const f = fixture(t); let injected = false;
  f.workspace.on('snapshotCheckpoint', e => {
    if (e.phase === 'SNAPSHOT_FILE_CAPTURED' && e.index === 1 && !injected) {
      injected = true; setImmediate(() => fs.writeFileSync(f.file('a.ts'),'FOREIGN AFTER YIELD'));
    }
  });
  await assert.rejects(f.workspace.createSnapshotAsync('Must not publish'), code('DISK_CONFLICT'));
  assert.ok(injected); assert.equal(f.workspace.listSnapshots().length,0); assert.equal(f.bytes('a.ts').toString(),'FOREIGN AFTER YIELD');
});
