import type { TestContext } from 'node:test';
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync, type BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, relative, sep } from 'node:path';
import type { LanguageReadIO } from '../../src/server/language/LanguageProcessJournal';

export function fixture(t: TestContext): string {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'directory-proof-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
export function deep(root: string): string {
  const path = join(root, 'middle', 'child', 'deep', 'canonical');
  mkdirSync(path, { recursive: true }); return path;
}
export function nativeIO(): LanguageReadIO {
  return { lstat: p => lstatSync(p, { bigint: true }), realpath: p => realpathSync.native(p),
    open: openSync, stat: fd => fstatSync(fd, { bigint: true }), read: readSync, close: closeSync };
}
export function ancestors(path: string): string[] {
  let current = parse(path).root; const result = [current];
  for (const part of relative(current, path).split(sep).filter(Boolean)) { current = join(current, part); result.push(current); }
  return result;
}
/** Explicit UNIT metadata seam, not an actual root replacement or native Windows junction. */
export function directoryKind(stat: BigIntStats, directory: boolean, link: boolean): BigIntStats {
  return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat,
    { isDirectory: () => directory, isSymbolicLink: () => link });
}
