import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate } from '../../src/server/WriteGate';
import { AppError } from '../../src/server/errors';

// Only scheduling/fault injection is mocked; all data and publication use real disk.
function fixture(t: any, mode?: number) {
  const parent = fs.mkdtempSync(path.join(process.cwd(), '.paircoach-test-rename-'));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  const original = Buffer.from('\ufeffconst n = 1;\r\n');
  const source = path.join(root, 'main.ts'), target = path.join(root, 'target.ts');
  fs.writeFileSync(source, original);
  if (mode !== undefined) fs.chmodSync(source, mode);
  const workspace = new WorkspaceService(root, path.join(parent, 'data'));
  const session = new SessionController(workspace); session.claimLease('tab-1');
  const gate = new WriteGate(workspace, session);
  const rename = () => gate.mutate({ clientId: 'tab-1', sessionId: session.state.sessionId,
    controlEpoch: session.state.controlEpoch, actor: 'STUDENT', operation: 'RENAME',
    path: 'main.ts', newPath: 'target.ts', baseVersion: 1, content: null });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); session.close(); workspace.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  return { parent, root, source, target, original, workspace, session, gate, rename };
}
const isError = (code: string) => (e: unknown) => e instanceof AppError && e.status === 409 && e.code === code;
const foreign = Buffer.from('EXTERNAL UNSAVED WORK\r\n');
function onFresh(f: ReturnType<typeof fixture>, count: number, action: () => void) {
  const real = f.workspace._fresh.bind(f.workspace); let calls = 0;
  f.workspace._fresh = (...args) => { const result = real(...args); if (++calls === count) action(); return result; };
}
function noTemps(f: ReturnType<typeof fixture>) {
  assert.deepEqual(fs.readdirSync(f.root).filter(name => name.startsWith('.paircoach-write-')), []);
}

test('RENAME P5 regression: target appears during second _fresh -> 409, both exact byte arrays survive', t => {
  const f = fixture(t);
  onFresh(f, 2, () => fs.writeFileSync(f.target, foreign, { flag: 'wx' }));
  assert.throws(f.rename, isError('FILE_EXISTS'));
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.deepEqual(fs.readFileSync(f.target), foreign);
  noTemps(f);
});

test('RENAME no-clobber is atomic: target appears inside actual linkSync, not just before existence check', t => {
  const f = fixture(t), realLink = fs.linkSync;
  t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.target) fs.writeFileSync(f.target, foreign, { flag: 'wx' });
    return realLink(from, to);
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, isError('FILE_EXISTS'));
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.deepEqual(fs.readFileSync(f.target), foreign);
  noTemps(f);
});

test('RENAME successful: exact CRLF/BOM, mode, single link and monotonic identities; no watcher duplicate', async t => {
  const f = fixture(t, 0o777), mode = fs.statSync(f.source).mode & 0o777;
  const events: unknown[] = []; f.workspace.on('external', e => events.push(e));
  f.rename();
  assert.equal(fs.existsSync(f.source), false);
  assert.deepEqual(fs.readFileSync(f.target), f.original);
  assert.equal(fs.statSync(f.target).nlink, 1);
  assert.equal(fs.statSync(f.target).mode & 0o777, mode);
  assert.equal(f.workspace.workspaceVersion, 1);
  const doc = f.workspace.getDocument('target.ts');
  assert.equal(doc.eol, 'CRLF'); assert.equal(doc.utf8Bom, true);
  assert.equal(doc.content, 'const n = 1;\n');
  assert.equal(f.workspace.listFiles().some(file => file.path === 'main.ts'), false);
  f.workspace.scanExternal(); assert.deepEqual(events, []);
  f.gate.mutate({ clientId: 'tab-1', sessionId: f.session.state.sessionId, controlEpoch: 0,
    actor: 'STUDENT', operation: 'RENAME', path: 'target.ts', newPath: 'main.ts', baseVersion: doc.version, content: null });
  assert.ok(f.workspace.getDocument('main.ts').version > 1);
  assert.equal(f.workspace.workspaceVersion, 2);
  noTemps(f);
});

test('RENAME source capture fails after publication: 409, two independent copies retained, records reconciled', t => {
  const f = fixture(t), realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (file: fs.PathLike, to: fs.PathLike) => {
    if (String(file) === f.source) throw Object.assign(new Error('injected source sharing violation'), { code: 'EACCES' });
    return realRename(file, to);
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, isError('RENAME_INCOMPLETE'));
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.deepEqual(fs.readFileSync(f.target), f.original);
  assert.equal(fs.statSync(f.source).nlink, 1); assert.equal(fs.statSync(f.target).nlink, 1);
  assert.equal(f.workspace.getDocument('main.ts').content, 'const n = 1;\n');
  assert.equal(f.workspace.getDocument('target.ts').content, 'const n = 1;\n');
  fs.writeFileSync(f.target, foreign);
  assert.deepEqual(fs.readFileSync(f.source), f.original, 'failed rename must not introduce a hardlink alias');
  noTemps(f);
});

test('RENAME rollback never unlinks a foreign destination replacement made at source-capture failure', t => {
  const f = fixture(t), realUnlink = fs.unlinkSync, realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (file: fs.PathLike, to: fs.PathLike) => {
    if (String(file) === f.source) {
      realUnlink(f.target); fs.writeFileSync(f.target, foreign, { flag: 'wx' });
      throw Object.assign(new Error('source is busy after foreign target replacement'), { code: 'EBUSY' });
    }
    return realRename(file, to);
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, isError('RENAME_INCOMPLETE'));
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.deepEqual(fs.readFileSync(f.target), foreign);
  assert.equal(f.workspace.getDocument('target.ts').content, 'EXTERNAL UNSAVED WORK\n');
  assert.ok(f.workspace.listFiles().some(file => file.path === 'target.ts'));
  noTemps(f);
});

test('RENAME source changed after publication: retain new source and published old bytes without deleting either', t => {
  const f = fixture(t), realUnlink = fs.unlinkSync; let injected = false;
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    const result = realUnlink(file);
    if (!injected && String(file).includes('.paircoach-write-')) {
      injected = true; fs.writeFileSync(f.source, foreign);
    }
    return result;
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, isError('RENAME_INCOMPLETE'));
  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(f.source), foreign);
  assert.deepEqual(fs.readFileSync(f.target), f.original);
  assert.equal(f.workspace.getDocument('main.ts').content, 'EXTERNAL UNSAVED WORK\n');
  noTemps(f);
});

test('RENAME destination swapped after publication: retain source, never roll back replacement', t => {
  const f = fixture(t);
  onFresh(f, 3, () => { fs.unlinkSync(f.target); fs.writeFileSync(f.target, foreign, { flag: 'wx' }); });
  syncBuiltinESMExports();
  assert.throws(f.rename, isError('RENAME_INCOMPLETE'));
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.deepEqual(fs.readFileSync(f.target), foreign);
  noTemps(f);
});

test('RENAME final authority revoked after publication: retain source and destination, no success', t => {
  const f = fixture(t);
  onFresh(f, 3, () => f.session.releaseLease('tab-1'));
  syncBuiltinESMExports();
  assert.throws(f.rename, isError('RENAME_INCOMPLETE'));
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.deepEqual(fs.readFileSync(f.target), f.original);
  noTemps(f);
});


test('RENAME same-byte destination replacement still retains source (identity, not just content)', t => {
  const f = fixture(t);
  onFresh(f, 3, () => { fs.unlinkSync(f.target); fs.writeFileSync(f.target, f.original, { flag: 'wx' }); });
  assert.throws(f.rename, isError('RENAME_INCOMPLETE'));
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.deepEqual(fs.readFileSync(f.target), f.original);
  noTemps(f);
});

test('RENAME unsupported publication fails closed; no clobbering fallback or source removal', t => {
  const f = fixture(t);
  t.mock.method(fs, 'linkSync', () => { throw Object.assign(new Error('unsupported filesystem'), { code: 'ENOTSUP' }); });
  syncBuiltinESMExports();
  assert.throws(f.rename, (e: any) => e.code === 'ENOTSUP');
  assert.deepEqual(fs.readFileSync(f.source), f.original);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(f.workspace.workspaceVersion, 0);
  noTemps(f);
});
