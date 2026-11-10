import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { WorkspaceService } from '../../src/server/WorkspaceService';
import { SessionController } from '../../src/server/SessionController';
import { WriteGate, type MutationAuth } from '../../src/server/WriteGate';
import { AppError } from '../../src/server/errors';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(files: Record<string, string | Buffer> = { 'challenge.md': 'Task', 'main.ts': 'let x = 1;\n' }) {
  const parent = fs.mkdtempSync(path.join(process.cwd(), '.paircoach-test-'));
  const root = path.join(parent, 'project');
  fs.mkdirSync(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  const workspace = new WorkspaceService(root, path.join(parent, 'data'));
  const session = new SessionController(workspace);
  const gate = new WriteGate(workspace, session);
  session.claimLease('tab-1');
  const auth = (actor: MutationAuth['actor'] = 'STUDENT'): MutationAuth => ({
    clientId: 'tab-1', sessionId: session.state.sessionId, controlEpoch: session.state.controlEpoch, actor,
  });
  const coach = () => {
    workspace.updateSettings({ ...workspace.settings, aiConsent: true });
    session.setAiStatus('READY');
    session.start(null, true);
  };
  const close = () => { session.close(); workspace.close(); fs.rmSync(parent, { recursive: true, force: true }); };
  return { parent, root, workspace, session, gate, auth, coach, close };
}
function error(code: string, status?: number) {
  return (value: unknown) => value instanceof AppError && value.code === code && (status === undefined || value.status === status);
}
function write(f: ReturnType<typeof fixture>, content: string, relative = 'main.ts', actor: MutationAuth['actor'] = 'STUDENT') {
  return f.gate.write({ ...f.auth(actor), path: relative, baseVersion: f.workspace.getDocument(relative).version, content });
}

test('AC001/002: challenge-only workspace, nested CREATE, file languages, no build tools required', () => {
  const f = fixture({ 'challenge.md': 'Task' });
  try {
    assert.equal(f.session.state.lifecycle, 'READY');
    assert.equal(f.workspace.getProject(f.session.state.sessionId).capabilities.canRunTests, false);
    for (const [extension, language] of Object.entries({ java: 'java', py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescript', md: 'markdown', txt: 'plaintext' })) {
      const relative = `src/main.${extension}`;
      f.gate.mutate({ ...f.auth(), operation: 'CREATE', path: relative, newPath: null, content: 'text\n', baseVersion: null });
      assert.equal(f.workspace.getDocument(relative).languageId, language);
    }
    assert.equal(f.workspace.workspaceVersion, 7);
    assert.ok(f.workspace.listFiles().some(file => file.path === 'src' && file.kind === 'DIRECTORY'));
  } finally { f.close(); }
});

test('AC003: missing, binary, invalid UTF8, >1MiB fail concretely without truncation', () => {
  const large = Buffer.alloc(1048577, 65);
  const f = fixture({ 'challenge.md': 'Task', 'binary.bin': Buffer.from([0, 1, 2]),
    'invalid.txt': Buffer.from([0xff, 0xfe, 0x41]), 'large.txt': large });
  try {
    for (const [relative, code] of [['none.txt', 'FILE_NOT_FOUND'], ['binary.bin', 'UNSUPPORTED_ENCODING'],
      ['invalid.txt', 'UNSUPPORTED_ENCODING'], ['large.txt', 'FILE_TOO_LARGE']]) {
      assert.throws(() => f.workspace.getDocument(relative), error(code));
    }
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'large.txt')), large);
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'invalid.txt')), Buffer.from([0xff, 0xfe, 0x41]));
  } finally { f.close(); }
});

test('AC004: committed writes advance document/global versions; stale version never overwrites', () => {
  const f = fixture();
  try {
    const first = f.workspace.getDocument('main.ts');
    const updated = write(f, 'const saved = 2;\n');
    assert.equal(updated.version, first.version + 1);
    assert.equal(f.workspace.workspaceVersion, 1);
    assert.equal(fs.readFileSync(path.join(f.root, 'main.ts'), 'utf8'), updated.content);
    assert.throws(() => f.gate.write({ ...f.auth(), path: 'main.ts', baseVersion: first.version, content: 'stale' }), error('VERSION_CONFLICT', 409));
    assert.equal(f.workspace.workspaceVersion, 1);
    assert.equal(f.workspace.getDocument('main.ts').content, updated.content);
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.paircoach-write-')), false);
  } finally { f.close(); }
});

test('EOL/BOM: API LF, disk CRLF+BOM preserved with exact two-sided bytes', () => {
  const f = fixture({ 'main.ts': Buffer.from('\ufeffconst a = 1;\r\nconst b = 2;\r\n') });
  try {
    const before = f.workspace.getDocument('main.ts');
    assert.equal(before.eol, 'CRLF');
    assert.equal(before.utf8Bom, true);
    assert.equal(before.content, 'const a = 1;\nconst b = 2;\n');
    const after = write(f, 'const a = 3;\nconst b = 4;\n');
    assert.deepEqual(fs.readFileSync(path.join(f.root, 'main.ts')), Buffer.from('\ufeffconst a = 3;\r\nconst b = 4;\r\n'));
    assert.equal(after.eol, 'CRLF'); assert.equal(after.utf8Bom, true);
    assert.equal(after.content.includes('\r'), false);
  } finally { f.close(); }
});

test('Limits: exact 1MiB accepted; UTF8 bytes and CRLF encoded disk bytes enforce limit', () => {
  const f = fixture();
  try {
    assert.equal(write(f, 'x'.repeat(1048576)).content.length, 1048576);
    const version = f.workspace.workspaceVersion;
    assert.throws(() => write(f, 'x'.repeat(1048577)), error('FILE_TOO_LARGE', 413));
    assert.throws(() => write(f, 'ą'.repeat(524289)), error('FILE_TOO_LARGE', 413));
    assert.throws(() => write(f, 'bad\ud800'), error('INVALID_CONTENT', 400));
    assert.equal(f.workspace.workspaceVersion, version);
  } finally { f.close(); }
  const crlf = fixture({ 'main.ts': Buffer.from('\ufeffx\r\n') });
  try { assert.throws(() => write(crlf, '\n'.repeat(524288)), error('FILE_TOO_LARGE', 413)); }
  finally { crlf.close(); }
});

test('AC005: external update before watcher and even same-content mtime change rejects local stale draft', () => {
  const f = fixture();
  try {
    const old = f.workspace.getDocument('main.ts');
    const events: unknown[] = [];
    f.workspace.on('external', event => events.push(event));
    fs.writeFileSync(path.join(f.root, 'main.ts'), 'EXTERNAL\n');
    assert.throws(() => f.gate.write({ ...f.auth(), path: 'main.ts', baseVersion: old.version, content: 'LOCAL DRAFT\n' }), error('DISK_CONFLICT', 409));
    assert.equal(fs.readFileSync(path.join(f.root, 'main.ts'), 'utf8'), 'EXTERNAL\n');
    assert.equal(events.length, 1);
    const current = f.workspace.getDocument('main.ts');
    const stamp = fs.statSync(path.join(f.root, 'main.ts'));
    fs.utimesSync(path.join(f.root, 'main.ts'), stamp.atime, new Date(stamp.mtimeMs + 1000));
    assert.throws(() => f.gate.write({ ...f.auth(), path: 'main.ts', baseVersion: current.version, content: 'LOCAL' }), error('DISK_CONFLICT', 409));
  } finally { f.close(); }
});

test('AC005: real external change between temp write and final rename is detected, temp removed', () => {
  const f = fixture();
  try {
    const internal = f.workspace as unknown as { temp: (absolute: string, bytes: Buffer, mode: number) => string };
    const realTemp = internal.temp.bind(f.workspace);
    internal.temp = (absolute, bytes, mode) => {
      const file = realTemp(absolute, bytes, mode);
      fs.writeFileSync(path.join(f.root, 'main.ts'), 'external at final check');
      return file;
    };
    assert.throws(() => write(f, 'do not overwrite'), error('DISK_CONFLICT', 409));
    assert.equal(fs.readFileSync(path.join(f.root, 'main.ts'), 'utf8'), 'external at final check');
    assert.equal(fs.readdirSync(f.root).some(name => name.startsWith('.paircoach-write-')), false);
  } finally { f.close(); }
});

test('AC005: actual FileWatcher emits creation/update/delete once, ignores own writes', async () => {
  const f = fixture();
  try {
    const events: { operation: string; path: string; document: unknown }[] = [];
    f.workspace.on('external', event => events.push(event));
    const until = async (n: number) => {
      const end = performance.now() + 2500;
      while (events.length < n && performance.now() < end) await sleep(25);
      assert.equal(events.length, n);
    };
    fs.writeFileSync(path.join(f.root, 'new.py'), 'print(1)\n'); await until(1);
    assert.equal(events[0].operation, 'CREATED');
    fs.writeFileSync(path.join(f.root, 'new.py'), 'print(2)\n'); await until(2);
    assert.equal(events[1].operation, 'UPDATED');
    fs.unlinkSync(path.join(f.root, 'new.py')); await until(3);
    assert.equal(events[2].operation, 'DELETED'); assert.equal(events[2].document, null);
    write(f, 'own write');
    await sleep(600);
    assert.equal(events.length, 3);
  } finally { f.close(); }
});

test('Lease/session/owner/epoch validation is strict; reconnect does not resurrect coach authority', () => {
  const f = fixture();
  try {
    const doc = f.workspace.getDocument('main.ts');
    const input = { ...f.auth(), path: 'main.ts', baseVersion: doc.version, content: 'x' };
    assert.equal(f.session.claimLease('tab-2'), false);
    assert.throws(() => f.gate.write({ ...input, clientId: 'tab-2' }), error('LEASE_REQUIRED', 403));
    assert.throws(() => f.gate.write({ ...input, sessionId: 'other' }), error('SESSION_MISMATCH', 409));
    assert.throws(() => f.gate.write({ ...input, controlEpoch: -1 }), error('STALE_EPOCH', 409));
    assert.throws(() => f.gate.write({ ...input, controlEpoch: 1 }), error('STALE_EPOCH', 409));
    assert.throws(() => f.gate.write({ ...input, controlEpoch: 0.5 }), error('STALE_EPOCH', 409));
    assert.throws(() => f.gate.write({ ...input, actor: 'COACH' }), error('WRITE_OWNER_CONFLICT', 409));
    f.coach(); f.session.acquireCoach('show-1');
    assert.throws(() => f.gate.write({ ...input, ...f.auth() }), error('WRITE_OWNER_CONFLICT', 409));
    const oldEpoch = f.session.state.controlEpoch;
    f.session.releaseLease('tab-1');
    assert.ok(f.session.state.controlEpoch > oldEpoch);
    assert.equal(f.session.state.writeOwner, 'STUDENT');
    assert.equal(f.session.claimLease('tab-2'), true);
    assert.equal(f.session.canCoach(), true);
    assert.throws(() => f.gate.write({ ...input, controlEpoch: oldEpoch, actor: 'COACH' }), error('LEASE_REQUIRED', 403));
  } finally { f.close(); }
});

test('AC010/011: 100 real cutoff trials <50ms, no stale queued writes after veto, new student text retained', async () => {
  const f = fixture();
  const timings: number[] = [];
  try {
    f.coach();
    for (let n = 0; n < 100; n++) {
      f.session.noteNewFact('CHAT');
      const epoch = f.session.acquireCoach(`show-${n}`);
      const before = write(f, `coach pre-cutoff ${n}`, 'main.ts', 'COACH');
      const stale = { ...f.auth('COACH'), path: 'main.ts', baseVersion: before.version, content: 'STALE STEP' };
      const cutoff = performance.now();
      const vetoed = f.session.veto();
      timings.push(performance.now() - cutoff);
      assert.ok(vetoed.controlEpoch > epoch);
      assert.equal(vetoed.writeOwner, 'STUDENT');
      assert.equal(vetoed.cooldownAfterVeto, true);
      const version = f.workspace.workspaceVersion;
      const repeated = f.session.veto();
      assert.equal(repeated.controlEpoch, vetoed.controlEpoch);
      assert.equal(f.workspace.workspaceVersion, version);
      // A pending event-loop task delivers the old epoch after the cutoff.
      await new Promise<void>(resolve => setImmediate(() => {
        assert.throws(() => f.gate.write(stale), error('STALE_EPOCH', 409));
        resolve();
      }));
      write(f, `student owns text ${n}`);
      assert.throws(() => f.gate.write(stale), error('STALE_EPOCH', 409));
      assert.equal(fs.readFileSync(path.join(f.root, 'main.ts'), 'utf8'), `student owns text ${n}`);
    }
    assert.ok(timings.every(ms => ms < 50), `max=${Math.max(...timings)}`);
    const sorted = [...timings].sort((a, b) => a - b);
    console.log(JSON.stringify({ metric: 'core-veto-only-Linux', trials: timings.length, p95Ms: sorted[94], maxMs: sorted[99], staleAccepted: 0 }));
  } finally { f.close(); }
});

test('AC010: epoch revoked before abort listener; veto during final write check prevents rename', () => {
  const f = fixture();
  try {
    f.coach(); const epoch = f.session.acquireCoach('show');
    f.session.on('veto', () => assert.ok(f.session.state.controlEpoch > epoch));
    const internal = f.workspace as unknown as { temp: (absolute: string, bytes: Buffer, mode: number) => string };
    const realTemp = internal.temp.bind(f.workspace);
    internal.temp = (absolute, bytes, mode) => { const file = realTemp(absolute, bytes, mode); f.session.veto(); return file; };
    assert.throws(() => write(f, 'stale', 'main.ts', 'COACH'), error('STALE_EPOCH', 409));
    assert.equal(f.workspace.getDocument('main.ts').content, 'let x = 1;\n');
  } finally { f.close(); }
});

test('AC012: waiting/whitespace do not unlock; current differing code + >=2s pause does', async () => {
  const f = fixture();
  try {
    f.coach(); f.session.veto();
    f.session.setPresence('BLURRED'); f.session.setPresence('FOCUSED');
    await sleep(2050);
    assert.equal(f.session.state.cooldownAfterVeto, true);
    write(f, '  let x=1;\n\n');
    await sleep(2050);
    assert.equal(f.session.state.cooldownAfterVeto, true);
    write(f, 'let x = 2;\n');
    await sleep(1100);
    assert.equal(f.session.state.cooldownAfterVeto, true);
    write(f, 'let x = 3;\n'); // Pause is measured since last confirmed edit, not the first.
    await sleep(1100);
    assert.equal(f.session.state.cooldownAfterVeto, true);
    await sleep(1000);
    assert.equal(f.session.state.cooldownAfterVeto, false);
    assert.equal(f.session.canCoach(), true);
  } finally { f.close(); }
});

test('AC012: edit then undo to baseline does not unlock; explicit chat/run do, but manual mute remains', async () => {
  const f = fixture();
  try {
    f.coach(); f.session.veto();
    write(f, 'let x=2;'); write(f, 'let x = 1;\n');
    await sleep(2050);
    assert.equal(f.session.state.cooldownAfterVeto, true);
    f.session.mute(null);
    f.session.noteNewFact('CHAT');
    assert.equal(f.session.state.cooldownAfterVeto, false);
    assert.equal(f.session.canCoach(), false);
    assert.equal(f.session.getSession().coachMode, 'MUTED_MANUAL');
    f.session.veto(); f.session.noteNewFact('RUN');
    assert.equal(f.session.state.cooldownAfterVeto, false);
    assert.equal(f.session.canCoach(), false);
  } finally { f.close(); }
});

test('AC016/017: HIDDEN revokes coach, timer policy/manual/cooldown survive focus return', async () => {
  const f = fixture();
  try {
    f.coach(); f.session.acquireCoach('show');
    const epoch = f.session.state.controlEpoch;
    f.session.setPresence('HIDDEN');
    assert.ok(f.session.state.controlEpoch > epoch);
    assert.equal(f.session.state.writeOwner, 'STUDENT');
    const paused = f.session.getSession().timer.elapsedMs;
    await sleep(100);
    assert.equal(f.session.getSession().timer.elapsedMs, paused);
    assert.equal(f.session.getSession().timer.status, 'PAUSED');
    assert.equal(f.session.canCoach(), false);
    f.session.setPresence('FOCUSED'); f.session.veto();
    f.session.timerAction('PAUSE');
    f.session.setPresence('HIDDEN'); f.session.setPresence('FOCUSED');
    assert.equal(f.session.state.cooldownAfterVeto, true);
    assert.equal(f.session.getSession().timer.manualPaused, true);
    assert.equal(f.session.getSession().timer.status, 'PAUSED');
    f.session.timerAction('RESUME');
    f.session.timerAction('SET_HIDDEN_POLICY', false);
    f.session.setPresence('HIDDEN');
    const running = f.session.getSession().timer.elapsedMs;
    await sleep(100);
    assert.ok(f.session.getSession().timer.elapsedMs >= running + 80);
    assert.equal(f.session.canCoach(), false);
    assert.equal(f.session.getSession().coachMode, 'MUTED_WINDOW_HIDDEN');
  } finally { f.close(); }
});

test('AC018/022: OVERTIME once, no auto finish; FINISHED still permits manual edits', async () => {
  const f = fixture();
  try {
    let overtime = 0;
    f.session.on('overtime', () => overtime++);
    f.session.start(1000, false);
    await sleep(1350);
    assert.equal(f.session.getSession().timer.status, 'OVERTIME');
    assert.equal(overtime, 1);
    assert.equal(f.session.state.lifecycle, 'RUNNING');
    write(f, 'still editable');
    f.session.finish();
    assert.equal(f.session.state.lifecycle, 'FINISHED');
    const elapsed = f.session.getSession().timer.elapsedMs;
    await sleep(50);
    assert.equal(f.session.getSession().timer.elapsedMs, elapsed);
    assert.equal(f.session.canCoach(), false);
    write(f, 'manual after finish');
  } finally { f.close(); }
});

test('AI status THINKING never steals ownership; consent/settings change invalidates active coach', () => {
  const f = fixture();
  try {
    f.coach(); f.session.setAiStatus('THINKING');
    assert.equal(f.session.canCoach(), true);
    assert.equal(f.session.state.writeOwner, 'STUDENT');
    f.session.acquireCoach('show');
    f.workspace.updateSettings({ ...f.workspace.settings, aiConsent: false });
    assert.equal(f.session.state.writeOwner, 'STUDENT');
    assert.equal(f.session.canCoach(), false);
  } finally { f.close(); }
});

test('AC021/026: coach cannot edit task/tests/config/secrets; CODE_REVIEW notes only', () => {
  const protectedFiles = ['challenge.md', 'tests/main.ts', 'main.test.ts', 'MainTest.java', 'vite.config.ts', 'config/main.ts', '.env.ts', 'private.key'];
  const f = fixture(Object.fromEntries(['main.ts', 'review.md', ...protectedFiles].map(file => [file, 'original'])));
  try {
    f.coach(); f.session.acquireCoach('show');
    for (const relative of protectedFiles) {
      assert.throws(() => write(f, 'bad', relative, 'COACH'), error('COACH_PATH_FORBIDDEN', 403));
      assert.equal(fs.readFileSync(path.join(f.root, relative), 'utf8'), 'original');
    }
    write(f, 'allowed source', 'main.ts', 'COACH');
    f.session.releaseCoach();
    f.workspace.updateSettings({ ...f.workspace.settings, taskMode: 'CODE_REVIEW' });
    f.session.acquireCoach('review');
    assert.throws(() => write(f, 'not allowed', 'main.ts', 'COACH'), error('COACH_REVIEW_ONLY', 403));
    write(f, 'notes only', 'review.md', 'COACH');
    assert.throws(() => f.gate.mutate({ ...f.auth('COACH'), operation: 'DELETE', path: 'review.md', baseVersion: f.workspace.getDocument('review.md').version, newPath: null, content: null }), error('COACH_MUTATION_FORBIDDEN', 403));
  } finally { f.close(); }
});

test('AC026: path traversal/ADS/Windows devices/aliases/excluded dirs rejected without effects', () => {
  const f = fixture({ 'main.ts': 'code', 'Case.ts': 'case' });
  try {
    for (const relative of ['../outside.ts', '/tmp/outside.ts', 'C:/x.ts', 'x\\y.ts', 'a/../x.ts', 'a//x.ts', './main.ts',
      'CON', 'NUL.txt', 'PRN.ts', 'AUX.py', 'COM1.java', 'LPT9.ts', 'com¹.txt', 'a.ts:secret', 'x. ', 'x.',
      'a/<x>.ts', 'case.ts', '.git/config', 'node_modules/x.ts', 'dist/x.ts', '.paircoach/x.ts']) {
      assert.throws(() => f.workspace.getDocument(relative), (value: unknown) => value instanceof AppError && value.status === 403, relative);
      assert.throws(() => f.gate.mutate({ ...f.auth(), operation: 'CREATE', path: relative, content: 'bad', newPath: null, baseVersion: null }),
        (value: unknown) => value instanceof AppError && value.status === 403, relative);
    }
    assert.equal(f.workspace.workspaceVersion, 0);
    assert.deepEqual(fs.readdirSync(f.root).sort(), ['Case.ts', 'main.ts']);
  } finally { f.close(); }
});

test('AC026: actual directory symlink/junction and file symlink are never followed; no outside writes', () => {
  const f = fixture();
  try {
    const outside = path.join(f.parent, 'outside'); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'secret.ts'), 'outside');
    fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    f.workspace.scanExternal();
    assert.equal(f.workspace.listFiles().some(file => file.path.startsWith('linked')), false);
    assert.throws(() => f.workspace.getDocument('linked/secret.ts'), error('UNSAFE_PATH', 403));
    assert.throws(() => f.gate.mutate({ ...f.auth(), operation: 'CREATE', path: 'linked/new.ts', newPath: null, content: 'bad', baseVersion: null }), error('UNSAFE_PATH', 403));
    assert.equal(fs.existsSync(path.join(outside, 'new.ts')), false);
    assert.equal(fs.readFileSync(path.join(outside, 'secret.ts'), 'utf8'), 'outside');
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(outside, 'secret.ts'), path.join(f.root, 'file.ts'));
      assert.throws(() => f.workspace.getDocument('file.ts'), error('UNSAFE_PATH', 403));
    }
  } finally { f.close(); }
});

test('Versions monotonic across DELETE/CREATE/RENAME; delete retains durable private safety copy', () => {
  const f = fixture();
  try {
    const initial = f.workspace.getDocument('main.ts');
    f.gate.mutate({ ...f.auth(), operation: 'DELETE', path: 'main.ts', newPath: null, content: null, baseVersion: initial.version });
    const backups = fs.readdirSync(path.join(f.workspace.dataDir, 'trash'));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(f.workspace.dataDir, 'trash', backups[0]), 'utf8'));
    assert.equal(Buffer.from(backup.rawBase64, 'base64').toString(), initial.content);
    assert.equal(backup.path, 'main.ts');
    f.gate.mutate({ ...f.auth(), operation: 'CREATE', path: 'main.ts', newPath: null, content: 'new incarnation', baseVersion: null });
    const recreated = f.workspace.getDocument('main.ts');
    assert.ok(recreated.version > initial.version);
    f.gate.mutate({ ...f.auth(), operation: 'RENAME', path: 'main.ts', newPath: 'renamed.ts', content: null, baseVersion: recreated.version });
    assert.equal(f.workspace.getDocument('renamed.ts').content, 'new incarnation');
    assert.equal(f.workspace.workspaceVersion, 3);
    assert.throws(() => f.workspace.getDocument('main.ts'), error('FILE_NOT_FOUND', 404));
    assert.equal(f.workspace.listFiles().some(file => file.path.includes('trash')), false);
  } finally { f.close(); }
});

test('Mutation validation never clobbers existing destinations or permits UPDATE endpoint bypass', () => {
  const f = fixture();
  try {
    assert.throws(() => f.gate.mutate({ ...f.auth(), operation: 'CREATE', path: 'main.ts', content: 'overwrite', newPath: null, baseVersion: null }), error('FILE_EXISTS', 409));
    assert.throws(() => f.gate.mutate({ ...f.auth(), operation: 'RENAME', path: 'main.ts', content: null, newPath: 'challenge.md', baseVersion: 1 }), error('FILE_EXISTS', 409));
    assert.throws(() => f.gate.mutate({ ...f.auth(), operation: 'UPDATE' as 'CREATE', path: 'main.ts', content: 'bypass', newPath: null, baseVersion: null }), error('INVALID_MUTATION', 400));
    assert.equal(fs.readFileSync(path.join(f.root, 'main.ts'), 'utf8'), 'let x = 1;\n');
    assert.equal(f.workspace.workspaceVersion, 0);
    assert.throws(() => f.workspace.createSnapshot('not implemented'), error('SNAPSHOTS_NOT_READY', 503));
    assert.throws(() => f.workspace.restoreSnapshot('id', ['main.ts'], f.auth()), error('SNAPSHOTS_NOT_READY', 503));
  } finally { f.close(); }
});

test('Settings validation is atomic; no timers/watchers remain after idempotent close', () => {
  const f = fixture();
  try {
    const settings = structuredClone(f.workspace.settings);
    assert.throws(() => f.workspace.updateSettings({ ...settings, taskFilePath: '../bad' }), error('UNSAFE_PATH', 403));
    assert.throws(() => f.workspace.updateSettings({ ...settings, runProfiles: [{ kind: 'RUN_MAIN', executable: 'node', args: [], cwd: '.', timeoutMs: 999, testReportFormat: 'NONE', testReportGlob: null }] }), error('INVALID_SETTINGS', 400));
    assert.deepEqual(f.workspace.settings, settings);
    assert.equal(f.workspace.workspaceVersion, 0);
    f.coach(); f.session.veto(); write(f, 'different code'); f.session.mute(1);
    f.session.close(); f.session.close(); f.workspace.close(); f.workspace.close();
    assert.equal(f.session.leaseClientId, null);
    assert.equal(f.session.state.writeOwner, 'STUDENT');
    assert.equal(f.session.canCoach(), false);
    assert.equal(f.workspace.listenerCount('changed'), 0);
  } finally { f.close(); }
});

test('Workspace count limit: exactly 1000 files opens, next CREATE and 1001-file open reject', () => {
  const parent = fs.mkdtempSync(path.join(process.cwd(), '.paircoach-test-'));
  const root = path.join(parent, 'project'); fs.mkdirSync(root);
  let workspace: WorkspaceService | null = null;
  let session: SessionController | null = null;
  try {
    for (let n = 0; n < 1000; n++) fs.writeFileSync(path.join(root, `f${n}.ts`), 'x');
    workspace = new WorkspaceService(root, path.join(parent, 'data'));
    session = new SessionController(workspace); session.claimLease('tab-1');
    assert.equal(workspace.listFiles().length, 1000);
    const gate = new WriteGate(workspace, session);
    assert.throws(() => gate.mutate({ clientId: 'tab-1', sessionId: session!.state.sessionId, controlEpoch: 0, actor: 'STUDENT',
      operation: 'CREATE', path: 'over-limit.ts', content: 'x', newPath: null, baseVersion: null }), error('TOO_MANY_FILES', 413));
    assert.equal(fs.existsSync(path.join(root, 'over-limit.ts')), false);
    session.close(); workspace.close();
    fs.writeFileSync(path.join(root, 'over-limit.ts'), 'x');
    assert.throws(() => new WorkspaceService(root), error('TOO_MANY_FILES', 413));
  } finally {
    session?.close(); workspace?.close(); fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('DELETE safety backup failure blocks deletion; dataDir symlink/junction is rejected', () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.workspace.dataDir, 'not a directory');
    const mutation = { ...f.auth(), operation: 'DELETE' as const, path: 'main.ts', newPath: null, content: null, baseVersion: 1 };
    assert.throws(() => f.gate.mutate(mutation), error('UNSAFE_DATA_DIR', 403));
    assert.equal(f.workspace.getDocument('main.ts').content, 'let x = 1;\n');
    fs.unlinkSync(f.workspace.dataDir);
    const outside = path.join(f.parent, 'foreign-data'); fs.mkdirSync(outside);
    fs.symlinkSync(outside, f.workspace.dataDir, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.gate.mutate(mutation), error('UNSAFE_DATA_DIR', 403));
    assert.equal(fs.readdirSync(outside).length, 0);
    assert.equal(f.workspace.workspaceVersion, 0);
  } finally { f.close(); }
});
