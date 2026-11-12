/** Test-only simulated volume number. All bytes/inodes/leases/metadata remain real FS.
 * No production environment flag or UUID override. Restore only AFTER closing all owners. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
export function deviceSeam(dev: bigint) {
  const originals = { lstatSync: fs.lstatSync, statSync: fs.statSync, fstatSync: fs.fstatSync };
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    (fs as any)[name] = (...args: any[]) => {
      const stat = (originals[name] as any)(...args);
      Object.defineProperty(stat, 'dev', { value: typeof stat.dev === 'bigint' ? dev : Number(dev), configurable: true });
      return stat;
    };
  }
  syncBuiltinESMExports();
  return () => { Object.assign(fs, originals); syncBuiltinESMExports(); };
}
