import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { atomicNoReplace } from '../../src/server/AtomicNoReplace';
import { fixture, code } from './helpers';

test('1000 real in-process atomic no-replace moves have complete public readback', t => {
  const f = fixture(t); for(let i=0;i<1000;i++) fs.writeFileSync(path.join(f.parent, `source-${i}`), `SOURCE ${i}`);
  const start = performance.now();
  for(let i=0;i<1000;i++) atomicNoReplace(path.join(f.parent, `source-${i}`), path.join(f.parent, `target-${i}`));
  const moveMs = performance.now() - start;
  for(let i=0;i<1000;i++) { assert.equal(fs.existsSync(path.join(f.parent, `source-${i}`)), false); assert.equal(fs.readFileSync(path.join(f.parent, `target-${i}`), 'utf8'), `SOURCE ${i}`); }
  console.log('INPROCESS_1000_REAL ' + JSON.stringify({platform: process.platform, node: process.version, count:1000, moveMs, readback: 'all SOURCE'}));
});

test('gate reauthorizes after ARMED checkpoint; revoked lease never executes native effect', t => {
  const f = fixture(t), snapshot = f.workspace.createSnapshot('Original'); f.write('a.ts', 'WORK');
  f.workspace.on('snapshotCheckpoint', e => { if(e.phase === 'CAPTURE_MOVE_ARMED') f.session.releaseLease('tab'); });
  assert.throws(() => f.restore(snapshot.snapshotId, ['a.ts']), code('RESTORE_INCOMPLETE'));
  assert.equal(f.bytes('a.ts').toString(), 'WORK');
  const base = f.file('.paircoach/snapshot-journal-v1'), directory = path.join(base,fs.readdirSync(base).find(n=>n.startsWith('transaction-'))!);
  assert.equal(fs.existsSync(path.join(directory, '0.captured')), false);
});

test('project DTO uses existing registry: NOT_INSTALLED plus approved profile flags', t => {
  const f = fixture(t), project = () => f.workspace.getProject(f.session.state.sessionId);
  assert.deepEqual(project().capabilities, {canRunMain:false,canRunTests:false,docs:'NOT_INSTALLED',autocomplete:'NOT_INSTALLED'});
  f.workspace.updateSettings({...f.workspace.settings,runProfiles:[{kind:'RUN_TESTS',executable:'node',args:['--test'],cwd:'.',timeoutMs:5000,testReportFormat:'NONE',testReportGlob:null}]});
  assert.deepEqual(project().capabilities, {canRunMain:false,canRunTests:true,docs:'NOT_INSTALLED',autocomplete:'NOT_INSTALLED'});
});
