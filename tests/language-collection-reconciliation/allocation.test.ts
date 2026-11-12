import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRegular, type LanguageReadIO } from '../../src/server/language/LanguageProcessJournal';

function fixture(t: TestContext, bytes: string) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'bounded-allocation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'small'); writeFileSync(path, bytes); return path;
}
function native(): LanguageReadIO {
  return { lstat: p => lstatSync(p, { bigint: true }), realpath: p => realpathSync.native(p),
    open: openSync, stat: fd => fstatSync(fd, { bigint: true }), read: readSync, close: closeSync };
}
// Native real files/FDs, IO seam only observes allocation and forces a precise post-open race.
// Buffer length is allocation evidence, NOT peak/resident RAM or a production timing benchmark.
test('actual empty/small/exact-limit files allocate only before.size + EOF sentinel, not caller ceiling', t => {
  for (const text of ['', 'abc', 'Zażółć 😀']) {
    const path = fixture(t, text), bytes = Buffer.from(text);
    for (const limit of [bytes.length, 256 * 1024 * 1024]) {
      const io = native(); let reads = 0;
      io.read = (fd, buffer, offset, length, position) => {
        reads++; assert.equal(buffer.length, bytes.length + 1);
        assert.ok(length > 0, 'must read sentinel/EOF, not a zero-length pseudo-EOF');
        return readSync(fd, buffer, offset, length, position);
      };
      assert.deepEqual(readRegular(path, limit, io), bytes); assert.ok(reads >= 1);
    }
  }
});
test('initial size over budget is rejected before opening or allocating read storage', t => {
  const path = fixture(t, 'abc'), io = native(); let opened = 0, reads = 0;
  io.open = (...args) => { opened++; return openSync(...args); };
  io.read = (...args) => { reads++; return readSync(...args); };
  assert.throws(() => readRegular(path, 2, io), /Unsafe\/oversize/);
  assert.equal(opened, 0); assert.equal(reads, 0);
});
test('post-open actual growth within caller ceiling still fails and closes FD; sentinel stays bounded', t => {
  for (const after of ['abcd', 'abc' + 'x'.repeat(200)]) {
    const path = fixture(t, 'abc'), io = native(); let first = true, closed = 0, maximumRead = 0;
    io.read = (fd, buffer, offset, length, position) => {
      if (first) { first = false; writeFileSync(path, after); }
      maximumRead = Math.max(maximumRead, buffer.length);
      return readSync(fd, buffer, offset, length, position);
    };
    io.close = fd => { closed++; closeSync(fd); };
    assert.throws(() => readRegular(path, 1024, io), /changed|oversize/);
    assert.equal(maximumRead, 4); assert.equal(closed, 1);
    assert.equal(lstatSync(path).size, Buffer.byteLength(after));
  }
});
test('post-open actual shrink, empty-to-growth and read failure all close FD and fail closed', t => {
  for (const [before, after] of [['abc', 'a'], ['', 'x']]) {
    const path = fixture(t, before), io = native(); let first = true, closed = 0;
    io.read = (fd, b, o, n, p) => {
      if (first) { first = false; writeFileSync(path, after); }
      return readSync(fd, b, o, n, p);
    };
    io.close = fd => { closed++; closeSync(fd); };
    assert.throws(() => readRegular(path, 1024, io), /changed|oversize/); assert.equal(closed, 1);
  }
  const path = fixture(t, 'abc'), io = native(); let closed = 0;
  io.read = () => { throw new Error('injected read EIO'); };
  io.close = fd => { closed++; closeSync(fd); };
  assert.throws(() => readRegular(path, 1024, io), /read EIO/); assert.equal(closed, 1);
});
test('sentinel rejects growth independently when UNIT metadata seam hides actual changed stats', t => {
  const path = fixture(t, 'abc'), original = lstatSync(path, { bigint: true }), io = native(); let first = true;
  const ls = io.lstat;
  io.lstat = p => p === path ? original : ls(p); io.stat = () => original;
  io.read = (fd, b, o, n, p) => {
    if (first) { first = false; writeFileSync(path, 'abcd'); }
    assert.equal(b.length, 4); return readSync(fd, b, o, n, p);
  };
  assert.throws(() => readRegular(path, 1024, io), /changed|oversize/);
});
