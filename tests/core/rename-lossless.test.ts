import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { WebSocket } from 'ws';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate } from '../../src/server/WriteGate';
import { createPairCoachServer } from '../../src/server/http';

const original = Buffer.from('\ufeffORIGINAL SOURCE\r\n');
const foreign = Buffer.from('EXTERNAL LATEST BYTES\r\n');
const conflict = (e: any) => e.code === 'RENAME_INCOMPLETE' && e.status === 409;
function fixture(t: any) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-lossless-'));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  const source = path.join(root, 'main.ts'), target = path.join(root, 'target.ts');
  fs.writeFileSync(source, original);
  const workspace = new WorkspaceService(root, path.join(parent, 'data'));
  const session = new SessionController(workspace); session.claimLease('tab');
  const gate = new WriteGate(workspace, session);
  const rename = () => gate.mutate({ clientId: 'tab', sessionId: session.state.sessionId, controlEpoch: 0,
    actor: 'STUDENT', operation: 'RENAME', path: 'main.ts', newPath: 'target.ts', baseVersion: 1, content: null });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); session.close(); workspace.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  return { parent, root, source, target, workspace, session, rename };
}
function collect(dir: string): { path: string; bytes: Buffer }[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const file = path.join(dir, e.name);
    return e.isDirectory() ? collect(file) : e.isFile() ? [{ path: file, bytes: fs.readFileSync(file) }] : [];
  });
}
function assertBoth(parent: string) {
  const files = collect(parent);
  assert.ok(files.some(f => f.bytes.equals(original)), 'pre-rename bytes must survive, including recovery');
  assert.ok(files.some(f => f.bytes.equals(foreign)), 'all late external bytes must survive, including recovery');
}

// Port of K final-window probes: same real bytes and assertions, new destructive
// boundary is renameSync(source, privateCapture), NOT unlinkSync(publicSource).
for (const phase of ['BEFORE', 'AFTER'] as const) for (const victim of ['source', 'destination'] as const) {
  test(`RENAME lossless capture ${phase}: ${victim} replacement is retained, never successful ACK`, t => {
    const f = fixture(t), realRename = fs.renameSync; let injected = false;
    t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) !== f.source || injected) return realRename(from, to);
      const replace = () => {
        injected = true;
        const file = victim === 'source' ? f.source : f.target;
        if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.writeFileSync(file, foreign, { flag: 'wx' });
      };
      if (phase === 'BEFORE') replace();
      realRename(from, to);
      if (phase === 'AFTER') replace();
    });
    syncBuiltinESMExports();
    assert.throws(f.rename, conflict); assert.equal(injected, true);
    assertBoth(f.parent);
    assert.deepEqual(fs.readFileSync(victim === 'source' ? f.source : f.target), foreign);
    if (victim === 'destination') assert.deepEqual(fs.readFileSync(f.source), original);
    f.workspace.scanExternal();
    assert.ok(f.workspace.listFiles().some(e => e.path === 'target.ts'));
    assert.ok(f.workspace.listFiles().some(e => e.path === 'main.ts'));
    console.log('CAPTURE_WINDOW ' + JSON.stringify({ phase, victim, injected, outcome: 'RENAME_INCOMPLETE', hasOriginal: true, hasForeign: true }));
  });
}

test('RENAME restoration never overwrites a newly recreated public source', t => {
  const f = fixture(t), realRename = fs.renameSync, realLink = fs.linkSync;
  let captured = false, injected = false;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    const result = realRename(from, to);
    if (String(from) === f.source) { captured = true; fs.unlinkSync(f.target); fs.writeFileSync(f.target, foreign); }
    return result;
  });
  t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (captured && String(to) === f.source) { injected = true; fs.writeFileSync(f.source, foreign, { flag: 'wx' }); }
    return realLink(from, to);
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, conflict); assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(f.source), foreign); assert.deepEqual(fs.readFileSync(f.target), foreign);
  assertBoth(f.parent);
});

test('RENAME uncertain capture syscall result is read back, not replayed against public source', t => {
  const f = fixture(t), realRename = fs.renameSync; let moves = 0;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to);
    if (String(from) === f.source) { moves++; throw Object.assign(Error('result unknown after move'), { code: 'EIO' }); }
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, conflict); assert.equal(moves, 1);
  assert.deepEqual(fs.readFileSync(f.source), original); assert.deepEqual(fs.readFileSync(f.target), original);
});

test('RENAME fails before publication if recovery cannot be written', t => {
  const f = fixture(t), realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (...args: any[]) => {
    if (String(args[0]).endsWith(path.sep + 'original')) throw Object.assign(Error('full recovery volume'), { code: 'ENOSPC' });
    return (realOpen as any)(...args);
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, (e: any) => e.code === 'ENOSPC');
  assert.deepEqual(fs.readFileSync(f.source), original); assert.equal(fs.existsSync(f.target), false);
  assert.deepEqual(fs.readdirSync(f.root).filter(n => n.startsWith('.paircoach-write-')), []);
});

test('RENAME capture never requires unlink of any public source, keeps recovery independent on success', t => {
  const f = fixture(t), realUnlink = fs.unlinkSync; let publicUnlinks = 0;
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (String(file) === f.source) { publicUnlinks++; assert.fail('public source unlink is forbidden'); }
    return realUnlink(file);
  });
  syncBuiltinESMExports(); f.rename();
  assert.equal(publicUnlinks, 0); assert.equal(fs.existsSync(f.source), false);
  assert.equal(fs.statSync(f.target).nlink, 1); assert.deepEqual(fs.readFileSync(f.target), original);
  const recovery = path.join(f.root, '.paircoach', 'rename-recovery');
  const operation = path.join(recovery, fs.readdirSync(recovery)[0]);
  assert.equal(fs.statSync(path.join(operation, 'source')).nlink, 1);
  fs.writeFileSync(f.target, foreign);
  assert.deepEqual(fs.readFileSync(path.join(operation, 'original')), original);
  assert.deepEqual(fs.readFileSync(path.join(operation, 'source')), original);
  assert.equal(f.workspace.workspaceVersion, 1);
});

const token = 'rename-lossless-only-0123456789abcdef0123456789';
for (const persistent of [false, true]) test(`RENAME cleanup ${persistent ? 'persistent' : 'transient'}: REST/tree/WS/recovery agree without opening hardlinks`, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-cleanup-'));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  const source = path.join(root, 'main.ts'), target = path.join(root, 'target.ts'); fs.writeFileSync(source, original);
  const app = createPairCoachServer({ rootPath: root, dataDir: path.join(root, '.paircoach'), port: 0, token });
  const port = await app.listen(), base = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/session`, { origin: base }), messages: any[] = [];
  ws.on('message', raw => messages.push(JSON.parse(String(raw))));
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); ws.terminate(); await app.close(); fs.rmSync(parent, { recursive: true, force: true }); });
  const wait = async (predicate: (m: any) => boolean) => {
    const until = Date.now() + 2000;
    while (Date.now() < until) { const found = messages.find(predicate); if (found) return found; await new Promise(r => setTimeout(r, 5)); }
    assert.fail('Missing WS state: ' + JSON.stringify(messages));
  };
  const request = async (route: string, body?: any) => {
    const res = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  await once(ws, 'open');
  ws.send(JSON.stringify({ protocolVersion: '3.0', messageId: 'hello', clientId: 'tab', sessionId: app.session.state.sessionId, type: 'HELLO', payload: { token, lastServerSeq: 0 } }));
  await wait(m => m.type === 'SESSION_SNAPSHOT');
  const command = { requestId: 'cleanup', clientId: 'tab', sessionId: app.session.state.sessionId, controlEpoch: 0,
    operation: 'RENAME', path: 'main.ts', newPath: 'target.ts', content: null, baseVersion: 1 };
  const realUnlink = fs.unlinkSync, realOpen = fs.openSync; let attempts = 0, targetOpens = 0;
  t.mock.method(fs, 'unlinkSync', (file: fs.PathLike) => {
    if (path.basename(String(file)).startsWith('.paircoach-write-') && (++attempts === 1 || persistent)) {
      throw Object.assign(Error('private link sharing violation'), { code: 'EACCES' });
    }
    return realUnlink(file);
  });
  t.mock.method(fs, 'openSync', (...args: any[]) => {
    if (String(args[0]) === target) targetOpens++;
    return (realOpen as any)(...args);
  });
  syncBuiltinESMExports();
  const reply = await request('/api/file', command);
  assert.equal(reply.status, 409); assert.equal(reply.body.code, 'RENAME_INCOMPLETE');
  assert.equal(reply.body.retryable, false);
  assert.deepEqual(fs.readFileSync(source), original);
  const project = await request('/api/project'), read = await request('/api/file?path=target.ts');
  assert.ok(project.body.files.some((e: any) => e.path === 'target.ts')); assert.equal(project.body.workspaceVersion, 1);
  const event = await wait(m => m.type === 'EXTERNAL_FILE_SYNC' && m.payload.path === 'target.ts');
  assert.equal(event.payload.version, 1); assert.equal(event.payload.workspaceVersion, 1);
  if (persistent) {
    assert.equal(read.status, 403); assert.equal(read.body.code, 'UNSAFE_PATH'); assert.equal(targetOpens, 0);
    assert.equal(event.payload.document, null); assert.equal(attempts, 3);
  } else {
    assert.equal(read.status, 200); assert.equal(read.body.content, 'ORIGINAL SOURCE\n');
    assert.equal(event.payload.document.content, 'ORIGINAL SOURCE\n'); assert.equal(attempts, 2);
    assert.equal(fs.statSync(target).nlink, 1);
  }
  const attemptsBeforeReplay = attempts;
  assert.deepEqual(await request('/api/file', command), reply); assert.equal(attempts, attemptsBeforeReplay);
  assert.equal((await request('/api/file', { ...command, newPath: 'different.ts' })).body.code, 'IDEMPOTENCY_CONFLICT');
  const locator = /Recovery: (.+?)\. Preserve both public paths/.exec(reply.body.message)![1];
  assert.equal(path.dirname(locator), path.join(root, '.paircoach', 'rename-recovery'));
  assert.deepEqual(fs.readFileSync(path.join(locator, 'original')), original);
  const intent = JSON.parse(fs.readFileSync(path.join(locator, 'intent.json'), 'utf8'));
  assert.equal(intent.path, 'main.ts'); assert.equal(intent.newPath, 'target.ts');
  // Follow the actual instruction: copy known recovery bytes to a NEW name,
  // never execute the manifest or overwrite either public path.
  const recovered = path.join(root, 'recovered.ts');
  fs.copyFileSync(path.join(locator, 'original'), recovered, fs.constants.COPYFILE_EXCL);
  assert.deepEqual(fs.readFileSync(recovered), original);
  // A separate, genuinely foreign hardlink is not opened or granted an exception.
  const outside = path.join(parent, 'outside'); fs.writeFileSync(outside, foreign);
  fs.linkSync(outside, path.join(root, 'foreign.ts'));
  assert.equal((await request('/api/file?path=foreign.ts')).status, 403);
  assert.deepEqual(fs.readFileSync(outside), foreign);
  // Release the real durable owner before opening it again; a second legacy
  // WorkspaceService is correctly forbidden while the V2 journal is owned.
  ws.terminate(); await app.close();
  const reopened = createPairCoachServer({rootPath:root,port:0,token});
  const reopenedPort = await reopened.listen();
  const resumed = new WebSocket(`ws://127.0.0.1:${reopenedPort}/ws/session`), resumedMessages:any[]=[];
  resumed.on('message',raw=>resumedMessages.push(JSON.parse(String(raw))));
  try {
    const restarted = reopened.workspace;
    assert.ok(restarted.listFiles().some(e => e.path === 'target.ts'));
    if (persistent) assert.throws(() => restarted.getDocument('target.ts'), (e: any) => e.status === 403);
    else assert.equal(restarted.getDocument('target.ts').content, 'ORIGINAL SOURCE\n');
    await once(resumed,'open');
    resumed.send(JSON.stringify({protocolVersion:'3.0',messageId:'hello-reopened',clientId:'tab-reopened',sessionId:reopened.session.state.sessionId,type:'HELLO',payload:{token,lastServerSeq:0}}));
    const waitResumed=async(predicate:(m:any)=>boolean)=>{
      const deadline=Date.now()+2000;
      while(Date.now()<deadline){const found=resumedMessages.find(predicate);if(found)return found;await new Promise(r=>setTimeout(r,5));}
      assert.fail('Missing reopened WS state: '+JSON.stringify(resumedMessages));
    };
    await waitResumed(m=>m.type==='SESSION_SNAPSHOT');
  if (persistent) {
    // Only after recovery and lifting the injected fault: remove the known
    // retained private alias, then normal scanning makes the target readable.
    t.mock.restoreAll(); syncBuiltinESMExports(); fs.unlinkSync(intent.temporary);
    reopened.workspace.scanExternal();
    const address = reopened.server.address() as {port:number};
    const response = await fetch(`http://127.0.0.1:${address.port}/api/file?path=target.ts`,{headers:{Authorization:`Bearer ${token}`}});
    const restored = {status:response.status,body:await response.json()};
    assert.equal(restored.status, 200); assert.equal(restored.body.content, 'ORIGINAL SOURCE\n');
    assert.ok(reopened.workspace.workspaceVersion > 1);
    await waitResumed(m => m.type === 'EXTERNAL_FILE_SYNC' && m.payload.path === 'target.ts' && m.payload.document !== null);
  }
  } finally {resumed.terminate();await reopened.close();}
  console.log('CLEANUP_RECOVERY ' + JSON.stringify({ persistent, http: reply.status, readStatus: read.status, attempts, recoveryCopied: true, targetInTree: true, workspaceVersion: project.body.workspaceVersion }));
});

test('RENAME ambiguous publication is observed and reconciled without replay', t => {
  const f = fixture(t), realLink = fs.linkSync; let publications = 0;
  t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
    realLink(from, to);
    if (String(to) === f.target) { publications++; throw Object.assign(Error('unknown publication result'), { code: 'EIO' }); }
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, conflict); assert.equal(publications, 1);
  assert.deepEqual(fs.readFileSync(f.source), original); assert.deepEqual(fs.readFileSync(f.target), original);
  assert.equal(f.workspace.getDocument('target.ts').content, 'ORIGINAL SOURCE\n');
  assert.equal(f.workspace.workspaceVersion, 1);
});

test('RENAME recovery remains readable if independent source restoration fails', t => {
  const f = fixture(t), realRename = fs.renameSync, realCopy = fs.copyFileSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === f.source) { fs.unlinkSync(f.source); fs.writeFileSync(f.source, foreign, { flag: 'wx' }); }
    return realRename(from, to);
  });
  t.mock.method(fs, 'copyFileSync', (from: fs.PathLike, to: fs.PathLike, mode?: number) => {
    if (path.basename(String(from)) === 'source') throw Object.assign(Error('recovery restore copy full'), { code: 'ENOSPC' });
    return realCopy(from, to, mode);
  });
  syncBuiltinESMExports();
  let reply: any;
  assert.throws(f.rename, (e: any) => { reply = e; return conflict(e); });
  assertBoth(f.parent); assert.equal(fs.existsSync(f.source), false);
  const recovery = /Recovery: (.+?)\. Preserve both public paths/.exec(reply.message)![1];
  assert.deepEqual(fs.readFileSync(path.join(recovery, 'source')), foreign);
  assert.deepEqual(fs.readFileSync(path.join(recovery, 'original')), original);
  fs.writeFileSync(path.join(f.root, 'recovered-foreign.ts'), fs.readFileSync(path.join(recovery, 'source')), { flag: 'wx' });
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'recovered-foreign.ts')), foreign);
});

test('RENAME late symlink capture is retained without opening or changing its outside target', t => {
  const f = fixture(t), realRename = fs.renameSync;
  const outside = path.join(f.parent, 'outside'); fs.writeFileSync(outside, foreign);
  let injected = false;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === f.source) {
      injected = true; fs.unlinkSync(f.source); fs.symlinkSync(outside, f.source, 'file');
    }
    return realRename(from, to);
  });
  syncBuiltinESMExports();
  assert.throws(f.rename, conflict); assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(outside), foreign); assert.deepEqual(fs.readFileSync(f.target), original);
  const operations = path.join(f.root, '.paircoach', 'rename-recovery');
  const capture = path.join(operations, fs.readdirSync(operations)[0], 'source');
  assert.equal(fs.lstatSync(capture).isSymbolicLink(), true); assert.equal(fs.readlinkSync(capture), outside);
});


// Observe actual open/close syscalls: no fake stats, WorkspaceService, or file data.
// The pin (unlike short-lived disk reads) was opened on the private publication
// alias. Windows may settle ctime on this fd's last close. Publishing state first
// is wrong even on filesystems where that close does not change metadata.
function observeRenamePins(t: any, f: ReturnType<typeof fixture>, onTargetClose?: () => void) {
  const realOpen = fs.openSync, realClose = fs.closeSync;
  let targetPin: number | undefined, sourcePin: number | undefined;
  let targetClosed = false, sourceClosed = false;
  t.mock.method(fs, 'openSync', (...args: any[]) => {
    const fd = (realOpen as any)(...args);
    if (typeof args[1] === 'number') {
      if (path.basename(String(args[0])).startsWith('.paircoach-write-')) targetPin = fd;
      if (targetPin !== undefined && sourcePin === undefined && String(args[0]) === f.source) sourcePin = fd;
    }
    return fd;
  });
  t.mock.method(fs, 'closeSync', (fd: number) => {
    realClose(fd);
    if (fd === targetPin && !targetClosed) { targetClosed = true; onTargetClose?.(); }
    if (fd === sourcePin && !sourceClosed) sourceClosed = true;
  });
  syncBuiltinESMExports();
  return () => ({ targetOpened: targetPin !== undefined, sourceOpened: sourcePin !== undefined,
    targetClosed, sourceClosed });
}

for (const ambiguous of [false, true]) test(`RENAME last-close ordering: ${ambiguous ? 'ambiguous publication' : 'success'} tracks final metadata only after both real pins close`, t => {
  const f = fixture(t), pins = observeRenamePins(t, f);
  const tracked: ReturnType<typeof pins>[] = [], stamped: ReturnType<typeof pins>[] = [];
  const realStat = fs.lstatSync;
  let lastMetadataRead: ReturnType<typeof pins> | undefined;
  t.mock.method(fs, 'lstatSync', (...args: any[]) => {
    const result = (realStat as any)(...args);
    if (String(args[0]) === f.target && args[1]?.bigint) lastMetadataRead = pins();
    return result;
  });
  syncBuiltinESMExports();
  f.workspace.on(ambiguous ? 'external' : 'changed', (e: any) => {
    if (e.path === 'target.ts') { tracked.push(pins()); stamped.push(lastMetadataRead!); }
  });
  if (ambiguous) {
    const realLink = fs.linkSync;
    t.mock.method(fs, 'linkSync', (from: fs.PathLike, to: fs.PathLike) => {
      realLink(from, to);
      if (String(to) === f.target) throw Object.assign(Error('published but result unknown'), { code: 'EIO' });
    });
    syncBuiltinESMExports();
    assert.throws(f.rename, conflict);
  } else f.rename();
  assert.deepEqual(tracked, [{ targetOpened: true, sourceOpened: true, targetClosed: true, sourceClosed: true }]);
  assert.deepEqual(stamped, tracked, 'the actual stamp read, not just the event, must follow last close');
  // The tracked metadata is the real post-close metadata: reads/scans must not
  // manufacture another document/workspace version or external event.
  const events: any[] = []; f.workspace.on('external', e => events.push(e));
  assert.equal(f.workspace.getDocument('target.ts').version, 1);
  f.workspace.scanExternal();
  assert.equal(f.workspace.workspaceVersion, 1); assert.deepEqual(events, []);
  assert.deepEqual(fs.readFileSync(f.target), original);
});

for (const victim of ['source', 'destination', 'destination-in-place'] as const) test(`RENAME last-close validation never absorbs a real foreign ${victim} replacement as own success`, t => {
  const f = fixture(t);
  const pins = observeRenamePins(t, f, () => {
    const file = victim === 'source' ? f.source : f.target;
    if (victim === 'destination-in-place') fs.writeFileSync(file, foreign);
    else {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.writeFileSync(file, foreign, { flag: 'wx' });
    }
  });
  assert.throws(f.rename, conflict);
  assert.equal(pins().targetClosed, true); assert.equal(pins().sourceClosed, true);
  assertBoth(f.parent);
  assert.deepEqual(fs.readFileSync(victim === 'source' ? f.source : f.target), foreign);
  const events: any[] = []; f.workspace.on('external', e => events.push(e));
  f.workspace.scanExternal(); assert.deepEqual(events, [], 'catch must reconcile after all own handles close');
  if (victim !== 'source') assert.equal(f.workspace.getDocument('target.ts').content, 'EXTERNAL LATEST BYTES\n');
});

test('RENAME retains ctime-only external change detection after successful final-close tracking', t => {
  const f = fixture(t); f.rename();
  const events: any[] = []; f.workspace.on('external', e => events.push(e));
  // A real, completed external hardlink cycle changes only ctime: the final
  // inode/bytes/mtime/mode/nlink are unchanged. No stat or clock is fabricated.
  const before = fs.statSync(f.target, { bigint: true });
  const alias = path.join(f.root, '.paircoach-write-external-metadata');
  // Cross a real kernel timestamp tick before the external syscall. Without
  // this scheduling gap, a metadata-only syscall may retain the same ctime.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  fs.linkSync(f.target, alias); fs.unlinkSync(alias);
  const after = fs.statSync(f.target, { bigint: true });
  assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.mode, before.mode); assert.equal(after.nlink, before.nlink);
  assert.deepEqual(fs.readFileSync(f.target), original);
  assert.notEqual(after.ctimeNs, before.ctimeNs, 'real external alias cycle must change ctime');
  const doc = f.workspace.getDocument('target.ts');
  assert.equal(doc.version, 2); assert.equal(f.workspace.workspaceVersion, 2);
  assert.equal(events.length, 1); assert.equal(events[0].operation, 'UPDATED');
});
