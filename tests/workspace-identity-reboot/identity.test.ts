/** Real factory + immutable e982 fixtures + kernel leases; simulated st_dev only.
 * Not a native WSL reboot, Windows ACL, live GUI, Docker or deployment proof. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRuntimeWorkspace, type RuntimeWorkspace } from '../../src/server/runtime-coordinator/RuntimeWorkspace';
import { DurableWorkspaceVersions } from '../../src/server/runtime-coordinator/WorkspaceVersions';
import { DurableMutationJournal } from '../../src/server/runtime-coordinator/MutationJournal';
import { JournalLease } from '../../src/server/runtime-coordinator/JournalLease';
import { canonical, sha256 } from '../../src/server/runtime-coordinator/storage';
import { deviceSeam } from './dev-seam';
const OLD_DEV = 1000000001n;
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-reboot-'));
  fs.writeFileSync(path.join(root, 'a.ts'), '\ufeffinitial\r\n');
  const cores: RuntimeWorkspace[] = [];
  const open = async () => { const core = await createRuntimeWorkspace({ rootPath: root }); cores.push(core); return core; };
  t.after(() => { cores.forEach(c => c.close()); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, open, file: (p: string) => path.join(root, p), anchor: path.join(root, '.paircoach/workspace-v1.json') };
}
async function seed(root: string, mode = 'lazy', dev = OLD_DEV) {
  const c = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixture-child.ts', import.meta.url)), root, mode, String(dev)], { stdio: ['ignore','pipe','pipe'] });
  let out = '', err = ''; c.stdout.on('data', b => out += b); c.stderr.on('data', b => err += b);
  const result = await new Promise<{code: number|null; signal: string|null}>((resolve, reject) => { c.once('error', reject); c.once('exit', (code, signal) => resolve({code, signal})); });
  if (mode === 'pending') assert.equal(result.signal, 'SIGKILL', err);
  else assert.equal(result.code, 0, err);
  const evidence = JSON.parse(out.trim());
  assert.equal(fs.existsSync(path.join(root, '.paircoach/workspace-v1.json')), mode !== 'lazy', 'genuine e982 lazy vs signed fixture');
  return evidence;
}
function raw(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const walk = (d: string) => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.isFile()) result[path.relative(root, f)] = fs.readFileSync(f).toString('base64'); } };
  if (fs.existsSync(root)) walk(root); return result;
}
function unchanged(root: string, before: Record<string, string>, allowAnchor = false) {
  const after = raw(root);
  for (const [p, bytes] of Object.entries(before)) assert.equal(after[p], bytes, 'preserve raw ' + p);
  if (!allowAnchor) assert.deepEqual(after, before);
}
function auth(c: RuntimeWorkspace) {
  c.session.claimLease('identity-new');
  return { clientId: 'identity-new', sessionId: c.session.state.sessionId, actor: 'STUDENT' as const, controlEpoch: c.session.state.controlEpoch };
}
async function outcomes(c: RuntimeWorkspace, e: any) {
  assert.equal(c.workspace.projectId, e.projectId);
  assert.equal(c.workspace.workspaceVersion, e.workspaceVersion);
  assert.equal(c.workspace.getDocument('a.ts').version, e.version);
  assert.deepEqual(await c.settingsAuthority.reconcile(e.identity, o => o), { state: 'COMMITTED', receipt: e.receipt });
  assert.deepEqual(await c.settingsAuthority.reconcile(e.aborted, o => o), { state: 'ABORTED' });
  const j = new DurableMutationJournal(path.join(c.workspace.dataDir, 'runtime-mutations'));
  try {
    assert.deepEqual(await j.reconcile(e.mutations.committed), { state: 'COMMITTED', result: e.mutations.result });
    assert.deepEqual(await j.reconcile(e.mutations.absent), { state: 'DEFINITIVELY_ABORTED', result: null });
    assert.deepEqual(await j.reconcile(e.mutations.unknown), { state: 'UNKNOWN', result: null });
    let effects = 0;
    assert.deepEqual(await j.execute(e.mutations.unknown, async () => { effects++; throw Error(); }), { state: 'UNKNOWN', result: null });
    assert.equal(effects, 0);
  } finally { await j.close(); }
}
test('unchanged genuine e982 baseline retains exact settings/mutation outcomes and raw history', async t => {
  const f = fixture(t), actual = fs.lstatSync(f.root, {bigint:true}).dev;
  const e = await seed(f.root, 'lazy', actual), before = raw(f.file('.paircoach'));
  const c = await f.open(); await outcomes(c, e); c.close(); unchanged(f.file('.paircoach'), before, true);
});
for (const mode of ['lazy', 'signed']) test('remount genuine e982 ' + mode + ' retains UUID/versions/settings/outcomes/key/MAC bytes and supports current rename/snapshot', async t => {
  const f = fixture(t), e = await seed(f.root, mode), before = raw(f.file('.paircoach'));
  const c = await f.open();
  try {
    await outcomes(c, e); unchanged(f.file('.paircoach'), before, true);
    if (e.snapshotId) assert.equal(c.workspace.listSnapshots().some(s => s.snapshotId === e.snapshotId), true);
    assert.equal(fs.existsSync(f.anchor), true);
    const a = auth(c), snap = c.workspace.createSnapshot('current devices');
    c.gate.write({ ...a, path: 'a.ts', baseVersion: e.version, content: 'new current bytes\n' });
    await c.gate.restoreSnapshot({ ...a, snapshotId: snap.snapshotId, paths: ['a.ts'], expectedWorkspaceVersion: c.workspace.workspaceVersion });
    assert.equal(c.workspace.getDocument('a.ts').content, 'ACK old\n');
    c.gate.mutate({ ...a, operation: 'RENAME', path: 'a.ts', newPath: 'renamed.ts', content: null, baseVersion: c.workspace.getDocument('a.ts').version });
    assert.equal(c.workspace.getDocument('renamed.ts').content, 'ACK old\n');
  } finally { c.close(); }
  const saved = raw(f.file('.paircoach')), restore = deviceSeam(1000000002n);
  try { const again = await f.open(); assert.equal(again.workspace.projectId, e.projectId); again.close(); unchanged(f.file('.paircoach'), saved); }
  finally { restore(); }
});
for (const tombstone of [false, true]) test('new durable ' + (tombstone ? 'tombstone' : 'empty') + ' anchor survives two remounts without stamp evidence', async t => {
  const f = fixture(t); if (!tombstone) fs.unlinkSync(f.file('a.ts'));
  const c = await f.open();
  if (tombstone) c.gate.mutate({ ...auth(c), operation: 'DELETE', path: 'a.ts', baseVersion: 1, content: null, newPath: null });
  const id = c.workspace.projectId, v = c.workspace.workspaceVersion; c.close();
  assert.equal(fs.existsSync(f.anchor), true);
  const before = raw(f.file('.paircoach'));
  for (const d of [1000000003n, 1000000004n]) {
    const restore = deviceSeam(d);
    try { const b = await f.open(); assert.equal(b.workspace.projectId, id); assert.equal(b.workspace.workspaceVersion, v); b.close(); }
    finally { restore(); }
    unchanged(f.file('.paircoach'), before);
  }
});
test('current inode replacement and real content change still increment durable versions', async t => {
  const f = fixture(t), e = await seed(f.root);
  const c = await f.open(); c.close();
  const bytes = fs.readFileSync(f.file('a.ts')); fs.writeFileSync(f.file('replacement'), bytes); fs.renameSync(f.file('replacement'), f.file('a.ts'));
  const b = await f.open(); assert.equal(b.workspace.workspaceVersion, e.workspaceVersion + 1); assert.equal(b.workspace.getDocument('a.ts').version, e.version + 1); b.close();
  fs.writeFileSync(f.file('a.ts'), 'actual offline edit\n');
  const d = await f.open(); assert.equal(d.workspace.workspaceVersion, e.workspaceVersion + 2); assert.equal(d.workspace.getDocument('a.ts').version, e.version + 2); d.close();
});
test('live instance refuses next device switch before source/settings/version effect', async t => {
  const f = fixture(t), c = await f.open(), a = auth(c), before = raw(f.root), restore = deviceSeam(1000000005n);
  try { assert.throws(() => c.gate.write({...a, path:'a.ts', baseVersion:1, content:'MUST NOT WRITE'})); unchanged(f.root, before); }
  finally { restore(); c.close(); }
});
async function rejected(f: ReturnType<typeof fixture>, before = raw(f.file('.paircoach'))) {
  await assert.rejects(f.open()); unchanged(f.file('.paircoach'), before);
  const l = new JournalLease(f.file('.paircoach/workspace-v2/lease.lock')); l.close();
}
function editState(f: ReturnType<typeof fixture>, change: (body: any) => void) {
  const name = f.file('.paircoach/workspace-v2/versions.json'), state = JSON.parse(fs.readFileSync(name,'utf8')); change(state.body);
  fs.writeFileSync(name, canonical({body: state.body, sha256: sha256(canonical(state.body))}));
}
for (const variant of ['foreign-root', 'wrong-id', 'bad-stamp', 'no-evidence', 'corrupt', 'partial', 'missing', 'signed-without-key', 'identity-partial', 'unsafe-mode', 'hardlink']) test('fail closed/no anchor/raw change on lazy ' + variant, async t => {
  const f = fixture(t); await seed(f.root, variant === 'signed-without-key' ? 'signed' : 'lazy');
  if (variant === 'foreign-root') editState(f, b => b.root += '-foreign');
  if (variant === 'wrong-id') editState(f, b => b.projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  if (variant === 'bad-stamp') editState(f, b => b.files[0].stamp = 'ambiguous');
  if (variant === 'no-evidence') editState(f, b => b.files.forEach((x:any) => x.stamp = null));
  if (variant === 'corrupt') fs.writeFileSync(f.file('.paircoach/workspace-v2/versions.json'), '{}');
  if (variant === 'partial') fs.writeFileSync(f.file('.paircoach/workspace-v2/.next-unknown'), 'retain partial');
  if (variant === 'missing') fs.unlinkSync(f.file('.paircoach/workspace-v2/versions.json'));
  if (variant === 'signed-without-key') fs.unlinkSync(f.anchor);
  if (variant === 'identity-partial') fs.writeFileSync(f.file('.paircoach/identity-retained-partial'), 'retain partial');
  if (variant === 'unsafe-mode') fs.chmodSync(f.file('.paircoach/workspace-v2/versions.json'), 0o644);
  if (variant === 'hardlink') fs.linkSync(f.file('.paircoach/workspace-v2/versions.json'), f.file('.paircoach/version-alias'));
  await rejected(f); assert.equal(fs.existsSync(f.anchor), false);
});
for (const variant of ['wrong-binding','key-corrupt','bad-mode','hardlink']) test('existing signed anchor ' + variant + ' is refused unchanged', async t => {
  const f = fixture(t); await seed(f.root, 'signed');
  if (variant === 'wrong-binding' || variant === 'key-corrupt') { const a = JSON.parse(fs.readFileSync(f.anchor,'utf8')); if (variant === 'wrong-binding') a.projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; else a.key = '0'.repeat(64); fs.writeFileSync(f.anchor, JSON.stringify(a)); }
  if (variant === 'bad-mode') fs.chmodSync(f.anchor, 0o644);
  if (variant === 'hardlink') fs.linkSync(f.anchor, f.file('.paircoach/anchor-alias'));
  await rejected(f);
});
for (const variant of ['copy', 'move', 'replacement', 'symlink', 'ancestor-link']) test('ordinary ' + variant + ' root refuses copied authority without reset', async t => {
  const f = fixture(t); await seed(f.root); const before = raw(f.file('.paircoach'));
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-identity-')); t.after(() => fs.rmSync(container,{recursive:true,force:true}));
  let target = path.join(container,'copy');
  if (variant === 'copy') fs.cpSync(f.root, target, {recursive:true});
  if (variant === 'move') fs.renameSync(f.root, target);
  if (variant === 'replacement') { fs.renameSync(f.root,target); fs.cpSync(target,f.root,{recursive:true}); target = f.root; }
  if (variant === 'symlink') fs.symlinkSync(f.root,target,'dir');
  if (variant === 'ancestor-link') { fs.mkdirSync(path.join(container,'real')); fs.cpSync(f.root,path.join(container,'real/project'),{recursive:true}); fs.symlinkSync(path.join(container,'real'),path.join(container,'link'),'dir'); target = path.join(container,'link/project'); }
  await assert.rejects(createRuntimeWorkspace({rootPath:target})); unchanged(path.join(target,'.paircoach'),before);
  if (variant === 'move') fs.renameSync(target,f.root);
  if (variant === 'replacement') { fs.rmSync(f.root,{recursive:true}); fs.renameSync(path.join(container,'copy'),f.root); }
});
test('real child kernel owner refuses remount before identity publication; failed open releases lease', async t => {
  const f = fixture(t); await seed(f.root); const before = raw(f.file('.paircoach'));
  const child = spawn(process.execPath,['--import','tsx',fileURLToPath(new URL('./lease-child.ts',import.meta.url)),f.root],{stdio:['pipe','pipe','pipe']});
  const done = new Promise<number|null>((r,j) => {child.once('exit',r);child.once('error',j);});
  await new Promise<void>((r,j) => {child.stdout.once('data',b => String(b).includes('OWNED')?r():j(Error(String(b))));child.once('error',j);});
  try { await assert.rejects(f.open(), /kernel owner/); unchanged(f.file('.paircoach'),before); assert.equal(fs.existsSync(f.anchor),false); }
  finally { child.stdin.end('close'); assert.equal(await done,0); }
  const c = await f.open(); c.close();
});
test('pending genuine old snapshot remains fail closed, source/history unchanged after remount', async t => {
  const f = fixture(t); await seed(f.root,'pending'); const before = raw(f.root);
  await assert.rejects(f.open(),{code:'RECOVERY_REQUIRED'}); unchanged(f.root,before);
  const l = new JournalLease(f.file('.paircoach/workspace-v2/lease.lock')); l.close();
});
test('scope root validation precedes resolver and detached scope cannot mutate live outcomes/settings state', t => {
  const f = fixture(t), dir = f.file('direct-versions'); let calls = 0;
  // String API remains supported. Resolver is INTERNAL composition, not an adopt/override.
  const a = new DurableWorkspaceVersions(dir, 'original-project', f.root, {workspaceVersion:0,files:[]}); a.close();
  assert.throws(() => new DurableWorkspaceVersions(dir, (() => { calls++; return 'original-project'; }) as any, f.root+'-foreign', {workspaceVersion:0,files:[]}));
  assert.equal(calls,0);
  const b = new DurableWorkspaceVersions(dir, ((scope:any) => {
    calls++; assert.deepEqual(Object.keys(scope).sort(),['files','projectId','root']);
    assert.equal(scope.root,f.root); assert.equal(scope.projectId,'original-project');
    try { scope.files.push({path:'forged',version:5,stamp:null}); } catch {}
    return 'original-project';
  }) as any, f.root, {workspaceVersion:0,files:[]}, {deferDiskReconcile:true});
  try { assert.equal(calls,1); assert.deepEqual(b.snapshot(),{workspaceVersion:0,files:[]}); } finally {b.close();}
});
test('resolver never receives corrupt settings/outcome authority even with valid scope/checksum', async t => {
  const f = fixture(t); await seed(f.root);
  editState(f,b => b.outcomes[0].outcome.receipt.settingsSha256 = 'invalid');
  await rejected(f); assert.equal(fs.existsSync(f.anchor),false);
});
test('signed history MAC corruption refuses startup, retaining exact source/history', async t => {
  const f = fixture(t); await seed(f.root,'signed');
  const dir = f.file('.paircoach/snapshot-journal-v1');
  const transaction = fs.readdirSync(dir).find(n => n.startsWith('transaction-'))!;
  const intent = path.join(dir,transaction,'intent.json'), record = JSON.parse(fs.readFileSync(intent,'utf8'));
  record.mac = 'f'.repeat(64); fs.writeFileSync(intent,JSON.stringify(record));
  const before = raw(f.root); await assert.rejects(f.open(),{code:'RECOVERY_REQUIRED'}); unchanged(f.root,before);
});
test('same-device unsafe owner/version mode and parent mode are refused BEFORE additive write', async t => {
  const f = fixture(t), dev = fs.lstatSync(f.root,{bigint:true}).dev;
  await seed(f.root,'lazy',dev);
  const file = f.file('.paircoach/workspace-v2/versions.json');
  fs.chmodSync(file,0o644); await rejected(f); assert.equal(fs.existsSync(f.anchor),false);
  fs.chmodSync(file,0o600);
  const original = fs.lstatSync;
  (fs as any).lstatSync = (...args:any[]) => { const s = (original as any)(...args); if(String(args[0]) === file) Object.defineProperty(s,'uid',{value:typeof s.uid === 'bigint'?s.uid+1n:s.uid+1}); return s; };
  try { await rejected(f); assert.equal(fs.existsSync(f.anchor),false); } finally { (fs as any).lstatSync = original; }
  fs.chmodSync(f.file('.paircoach'),0o755); await rejected(f); assert.equal(fs.existsSync(f.anchor),false);
});
