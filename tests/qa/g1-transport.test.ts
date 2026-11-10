import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { assertApiError, assertDocument, connected, id, Peer, serverFixture } from './helpers';

const command = (f: Awaited<ReturnType<typeof serverFixture>>) => ({ requestId: id(), clientId: f.clientId, sessionId: f.sessionId });

test('AC-026 TEST-026: HTTP bearer, Host and Origin are enforced on the actual listener', { timeout: 12000 }, async t => {
  const f = await serverFixture(t);
  for (const auth of ['', 'Bearer invalid-fixture-token']) {
    const reply = await f.http('GET', '/api/project', undefined, { Authorization: auth });
    assert.equal(reply.status, 401); assertApiError(reply.body);
  }
  const forbiddenHeaders: Record<string, string>[] = [{ Origin: 'https://untrusted.example' }, { Host: 'untrusted.example' }];
  for (const headers of forbiddenHeaders) {
    const reply = await f.rawHttp('/api/project', headers);
    assert.equal(reply.status, 403); assertApiError(reply.body);
  }
  const good = await f.http('GET', '/api/project'); assert.equal(good.status, 200);
  assert.equal(good.body.rootPath, f.rootPath);
});

test('AC-003 TEST-003: real GET returns full 1MiB file; missing/oversize are explicit without rewriting', { timeout: 12000 }, async t => {
  const max = 'x'.repeat(1048576), large = 'y'.repeat(1048577);
  const f = await serverFixture(t, { 'limit.txt': max, 'large.txt': large });
  const exact = await f.http('GET', '/api/file?path=limit.txt');
  assert.equal(exact.status, 200); assertDocument(exact.body); assert.equal(exact.body.content, max);
  const missing = await f.http('GET', '/api/file?path=absent.txt');
  assert.equal(missing.status, 404); assertApiError(missing.body);
  const oversized = await f.http('GET', '/api/file?path=large.txt');
  assert.equal(oversized.status, 413); assertApiError(oversized.body);
  assert.equal(await readFile(path.join(f.rootPath, 'large.txt'), 'utf8'), large);
});

test('AC-004 TEST-004: CODE_CHANGED real disk ACK, WS duplicate and changed-ID-payload rejection', { timeout: 12000 }, async t => {
  const f = await serverFixture(t, { 'main.py': 'initial\n' }); const peer = await connected(t, f);
  const before = await f.http('GET', '/api/file?path=main.py'); assert.equal(before.status, 200);
  const state = (await f.http('GET', '/api/session')).body;
  const payload = { path: 'main.py', baseVersion: before.body.version, controlEpoch: state.controlEpoch,
    content: 'confirmed student edit\n', editKind: 'TYPING' };
  const messageId = peer.send('CODE_CHANGED', payload);
  const ack = (await peer.ack(messageId)).payload;
  assert.equal(ack.status, 'OK'); assert.equal(ack.error, null);
  assert.equal(ack.documentVersion, before.body.version + 1); assert.equal(ack.workspaceVersion, state.workspaceVersion + 1);
  assert.equal(await readFile(path.join(f.rootPath, 'main.py'), 'utf8'), payload.content, 'ACK requires committed disk bytes');
  peer.send('CODE_CHANGED', payload, messageId);
  const duplicate = (await peer.ack(messageId)).payload;
  assert.equal(duplicate.status, 'DUPLICATE'); assert.equal(duplicate.documentVersion, ack.documentVersion);
  assert.equal(duplicate.workspaceVersion, ack.workspaceVersion);
  peer.send('CODE_CHANGED', { ...payload, content: 'forbidden altered retry\n' }, messageId);
  const rejected = (await peer.ack(messageId)).payload;
  assert.equal(rejected.status, 'REJECTED'); assertApiError(rejected.error);
  assert.equal(rejected.error.code, 'IDEMPOTENCY_CONFLICT');
  const doc = (await f.http('GET', '/api/file?path=main.py')).body; assertDocument(doc);
  assert.equal(doc.content, payload.content); assert.equal(doc.version, ack.documentVersion);
  peer.assertProtocol();
});

test('AC-004 TEST-004: HTTP CREATE dedup uses same requestId and never duplicates effects', { timeout: 12000 }, async t => {
  const f = await serverFixture(t); const peer = await connected(t, f);
  const state = (await f.http('GET', '/api/session')).body;
  const body = { ...command(f), operation: 'CREATE', path: 'new.py', newPath: null,
    content: 'created once\n', baseVersion: null, controlEpoch: state.controlEpoch };
  const first = await f.http('POST', '/api/file', body); assert.equal(first.status, 200);
  const second = await f.http('POST', '/api/file', body); assert.equal(second.status, 200);
  assert.deepEqual(second.body, first.body);
  const conflict = await f.http('POST', '/api/file', { ...body, content: 'different\n' });
  assert.equal(conflict.status, 409); assertApiError(conflict.body); assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await readFile(path.join(f.rootPath, 'new.py'), 'utf8'), 'created once\n');
  assert.equal((await f.http('GET', '/api/session')).body.workspaceVersion, first.body.workspaceVersion);
  peer.assertProtocol();
});

test('AC-010 TEST-010: WS veto + HTTP fallback share identity and only invalidate once', { timeout: 12000 }, async t => {
  const f = await serverFixture(t); const peer = await connected(t, f);
  const start = await f.http('POST', '/api/session/start', { ...command(f), limitMs: null, pauseOnHidden: true });
  assert.equal(start.status, 200);
  const before = (await f.http('GET', '/api/session')).body;
  const messageId = id();
  const payload = { controlEpoch: before.controlEpoch, activeInterventionId: before.interventionId, lastAppliedSeq: before.lastServerSeq };
  peer.send('VETO_ESCAPE', payload, messageId);
  const ack = (await peer.ack(messageId)).payload; assert.equal(ack.status, 'OK');
  assert.equal(ack.controlEpoch, before.controlEpoch + 1);
  const rest = await f.http('POST', '/api/session/veto', { ...command(f), requestId: messageId, ...payload });
  assert.equal(rest.status, 200); assert.equal(rest.body.controlEpoch, ack.controlEpoch);
  peer.send('VETO_ESCAPE', payload, messageId);
  const dup = (await peer.ack(messageId)).payload; assert.equal(dup.status, 'DUPLICATE');
  const after = (await f.http('GET', '/api/session')).body;
  assert.equal(after.controlEpoch, ack.controlEpoch); assert.equal(after.writeOwner, 'STUDENT');
  assert.equal(after.cooldownAfterVeto, true); peer.assertProtocol();
});

test('AC-005 TEST-005: actual watcher emits external content and rejects obsolete baseVersion', { timeout: 12000 }, async t => {
  const f = await serverFixture(t, { 'main.py': 'before\n' }); const peer = await connected(t, f);
  const before = (await f.http('GET', '/api/file?path=main.py')).body;
  const session = (await f.http('GET', '/api/session')).body;
  await writeFile(path.join(f.rootPath, 'main.py'), 'external editor\n');
  // Intentionally do NOT call scanExternal: this is the actual file watcher integration.
  const event = (await peer.take(frame => frame.type === 'EXTERNAL_FILE_SYNC' && frame.payload.path === 'main.py')).payload;
  assert.equal(event.operation, 'UPDATED'); assert(event.version > before.version);
  assert.equal(event.document.content, 'external editor\n'); assertDocument(event.document);
  const ack = (await peer.ack(peer.send('CODE_CHANGED', { path: 'main.py', baseVersion: before.version,
    controlEpoch: session.controlEpoch, content: 'unconfirmed local draft\n', editKind: 'TYPING' }))).payload;
  assert.equal(ack.status, 'REJECTED'); assertApiError(ack.error);
  assert.equal(await readFile(path.join(f.rootPath, 'main.py'), 'utf8'), 'external editor\n');
  peer.assertProtocol();
});

test('AC-026 TEST-026: traversal, Windows device/ADS and real outward symlink are denied', { timeout: 12000 }, async t => {
  const f = await serverFixture(t, { 'main.py': 'safe\n' }); const peer = await connected(t, f);
  await writeFile(path.join(f.base, 'outside.txt'), 'outside fixture must stay private\n');
  await symlink(path.join(f.base, 'outside.txt'), path.join(f.rootPath, 'outward.txt'));
  for (const target of ['../outside.txt', '/outside.txt', 'C:/outside.txt', 'CON', 'aux.txt', 'NUL', 'COM1', 'LPT9', 'main.py:stream', 'outward.txt']) {
    const reply = await f.http('GET', '/api/file?path=' + encodeURIComponent(target));
    assert.equal(reply.status, 403, target); assertApiError(reply.body);
  }
  assert.equal(await readFile(path.join(f.base, 'outside.txt'), 'utf8'), 'outside fixture must stay private\n');
  assert.equal(await readFile(path.join(f.rootPath, 'main.py'), 'utf8'), 'safe\n'); peer.assertProtocol();
});

test('AC-004 TEST-004: reconnect same client resyncs confirmed bytes, not a second edit', { timeout: 12000 }, async t => {
  const f = await serverFixture(t, { 'main.py': 'initial\n' }); const peer = await connected(t, f);
  const doc = (await f.http('GET', '/api/file?path=main.py')).body;
  const state = (await f.http('GET', '/api/session')).body;
  const ack = (await peer.ack(peer.send('CODE_CHANGED', { path: 'main.py', baseVersion: doc.version,
    controlEpoch: state.controlEpoch, content: 'saved across reconnect\n', editKind: 'TYPING' }))).payload;
  assert.equal(ack.status, 'OK');
  const seq = (await f.http('GET', '/api/session')).body.lastServerSeq;
  const closed = new Promise<void>(resolve => peer.socket.once('close', () => resolve())); peer.close(); await closed;
  const resumed = new Peer(f); t.after(() => resumed.close());
  const snapshot = (await resumed.connect(seq)).payload;
  assert.equal(snapshot.session.sessionId, f.sessionId);
  const current = (await f.http('GET', '/api/file?path=main.py')).body;
  assert.equal(current.content, 'saved across reconnect\n'); assert.equal(current.version, ack.documentVersion);
  assert.equal(snapshot.session.writeOwner, 'STUDENT');
  peer.assertProtocol(); resumed.assertProtocol();
});
