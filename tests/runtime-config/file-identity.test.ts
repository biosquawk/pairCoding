import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRuntimeConfiguration } from '../../src/server/runtime-config';

// Flag-semantic emulation on real WSL files; no claim of native Windows execution.
function fixture(t: TestContext, target: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = {
    'config.json': { schemaVersion: 1, activeProfile: 'node', workspaceRoot: '.', runtimeCatalog: './catalog.json', imageLock: './lock.json', languageFeatures: { completion: true, diagnostics: true }, execution: { backend: 'docker', pullPolicy: 'never' } },
    'catalog.json': { schemaVersion: 1, profiles: [{ id: 'node', label: 'Node', adapterFamily: 'node', imageLockKey: 'node', expectedTools: [{ name: 'node', version: '22.22.0' }], compilerRelease: null, analysis: { languageLevel: 'es2022', preview: false }, language: { provider: 'builtin', imageLockKey: null, serverJvm: null }, taskFields: [] }] },
    'lock.json': { schemaVersion: 1, images: [{ key: 'node', image: 'paircoach/runtime-node:22-v1', imageId: 'sha256:' + 'a'.repeat(64), digest: 'sha256:' + 'b'.repeat(64), tools: [{ name: 'node', version: '22.22.0' }] }] },
  };
  for (const [name, value] of Object.entries(data)) fs.writeFileSync(path.join(root, name), JSON.stringify(value));
  const file = path.join(root, target), original = fs.readFileSync(file), retained = path.join(root, 'retained.json');
  return { file, original, retained, load: () => loadRuntimeConfiguration({ configPath: path.join(root, 'config.json') }) };
}
function withoutNoFollow(t: TestContext, file: string, around?: (open: () => number) => number) {
  const open = fs.openSync;
  t.mock.method(fs, 'openSync', (p: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    const invoke = () => open(p, typeof flags === 'number' ? flags & ~(fs.constants.O_NOFOLLOW ?? 0) : flags, mode);
    return p === file && typeof flags === 'number' && (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0 && around ? around(invoke) : invoke();
  });
}
function denied(f: ReturnType<typeof fixture>) {
  const result = f.load(); assert.equal(result.resolved, null); assert.equal(result.problem?.code, 'RUNTIME_CONFIG_INVALID');
  assert.ok(!JSON.stringify(result).includes(f.file));
}
for (const target of ['config.json', 'catalog.json', 'lock.json']) {
  test(`${target}: regular read succeeds; missing input fails safely without O_NOFOLLOW`, t => {
    const f = fixture(t, target); withoutNoFollow(t, f.file);
    assert.ok(f.load().resolved); assert.deepEqual(fs.readFileSync(f.file), f.original);
    fs.unlinkSync(f.file); denied(f);
  });
  for (const dangling of [false, true]) test(`${target}: reject ${dangling ? 'dangling' : 'real'} final symlink without O_NOFOLLOW`, t => {
    const f = fixture(t, target); fs.renameSync(f.file, f.retained); fs.symlinkSync(dangling ? f.retained + '-missing' : f.retained, f.file);
    withoutNoFollow(t, f.file); denied(f); assert.deepEqual(fs.readFileSync(f.retained), f.original);
  });
  for (const stage of ['before-open', 'after-open', 'during-read'] as const) for (const replacement of ['regular', 'symlink'] as const) {
    test(`${target}: reject ${replacement} substitution ${stage} with identical bytes`, t => {
      const f = fixture(t, target);
      const swap = () => { fs.renameSync(f.file, f.retained); if (replacement === 'symlink') fs.symlinkSync(f.retained, f.file); else fs.writeFileSync(f.file, f.original); };
      let fd: number | undefined;
      withoutNoFollow(t, f.file, open => { if (stage === 'before-open') swap(); fd = open(); if (stage === 'after-open') swap(); return fd; });
      if (stage === 'during-read') {
        const read = fs.readSync; let fired = false;
        t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => { const count = Reflect.apply(read, fs, args); if (args[0] === fd && !fired) { fired = true; swap(); } return count; });
      }
      denied(f); assert.deepEqual(fs.readFileSync(f.retained), f.original);
    });
  }
  for (const field of ['dev', 'ino'] as const) for (const phase of ['opened', 'post-read'] as const) {
    test(`${target}: reject adjacent bigint ${field} mismatch ${phase}`, t => {
      const f = fixture(t, target); let fd: number | undefined; withoutNoFollow(t, f.file, open => (fd = open()));
      const lstat = fs.lstatSync, fstat = fs.fstatSync; let calls = 0; const options: boolean[] = [], base = 2n ** 60n;
      t.mock.method(fs, 'lstatSync', (...args: Parameters<typeof fs.lstatSync>) => {
        const s = Reflect.apply(lstat, fs, args);
        if (args[0] === f.file) { options.push((args[1] as { bigint?: boolean })?.bigint === true); return Object.assign(Object.create(s!), { [field]: base }); }
        return s;
      });
      t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
        const s = Reflect.apply(fstat, fs, args);
        if (args[0] !== fd) return s;
        options.push((args[1] as { bigint?: boolean })?.bigint === true); calls++;
        return Object.assign(Object.create(s!), { [field]: base + (phase === 'opened' || calls > 1 ? 1n : 0n) });
      });
      denied(f); assert.ok(options.length >= 2 && options.every(Boolean)); assert.deepEqual(fs.readFileSync(f.file), f.original);
    });
  }
}
for (const target of ['config.json', 'catalog.json', 'lock.json']) {
  test(`${target}: short regular reads succeed without O_NOFOLLOW`, t => {
    const f = fixture(t, target); let fd: number | undefined; withoutNoFollow(t, f.file, open => (fd = open()));
    const read = fs.readSync;
    t.mock.method(fs, 'readSync', (handle: number, buffer: Buffer, offset: number, length: number, position: number | null) => read(handle, buffer, offset, handle === fd ? Math.min(length, 7) : length, position));
    assert.ok(f.load().resolved);
  });
  test(`${target}: growth during read is rejected with IO bounded to observed size + one`, t => {
    const f = fixture(t, target); let fd: number | undefined; withoutNoFollow(t, f.file, open => (fd = open()));
    const read = fs.readSync; let fired = false, requested = 0;
    t.mock.method(fs, 'readSync', (handle: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      if (handle === fd) { requested += length; if (!fired) { fired = true; fs.appendFileSync(f.file, ' '.repeat(4 * 1024 * 1024)); } }
      return read(handle, buffer, offset, length, position);
    });
    denied(f); assert.equal(fired, true); assert.ok(requested <= f.original.length + 1);
  });
}
