import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { LanguageReadIO } from '../../src/server/language/LanguageProcessJournal';

/** REJECTED hypothesis, tests only. Never imported by production. Not a Windows equivalence claim. */
export function proposedFinalOnly(path: string, io: Pick<LanguageReadIO, 'lstat' | 'realpath'>): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Directory must be absolute/canonical');
  let current = parse(path).root;
  const check = (): void => {
    const stat = io.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe directory/link');
  };
  check();
  for (const segment of relative(current, path).split(sep).filter(Boolean)) { current = join(current, segment); check(); }
  if (io.realpath(path) !== path) throw new Error('Unsafe directory canonical alias');
}
