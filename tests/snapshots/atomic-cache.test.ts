import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { atomicNoReplace, prepareAtomicNoReplace } from '../../src/server/AtomicNoReplace';
import { fixture } from './helpers';

test('Windows fresh compiled helper is never trusted after cached executable tampering', {skip: process.platform !== 'win32' && 'Windows-only compiled helper; native operator run required'}, t => {
  const f = fixture(t); let compiled = '';
  const real = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', (exe: any, args: any, options: any) => {
    const request = JSON.parse(options.input);
    if (request.output) compiled = request.output;
    return real(exe, args, options);
  }); syncBuiltinESMExports();
  prepareAtomicNoReplace(); assert.ok(compiled, 'fresh compile, never a project-supplied cache');
  fs.appendFileSync(compiled, 'FOREIGN EXE SUFFIX');
  const target = path.join(f.parent, 'target');
  assert.throws(() => atomicNoReplace(f.file('a.ts'), target), (e: any) => e.code === 'ATOMIC_MOVE_UNAVAILABLE');
  assert.equal(f.bytes('a.ts').toString(), 'SNAP A\n'); assert.equal(fs.existsSync(target), false);
});
