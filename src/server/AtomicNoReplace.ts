import * as path from 'node:path';
import { createRequire } from 'node:module';
import { AppError } from './errors';

const require = createRequire(import.meta.url);
type NativeMove = (from: string, to: string) => {ok: boolean; code: string};
let nativeMove: NativeMove | undefined;
const unavailable = (cause?: unknown) => {
  const error = new AppError(503, 'ATOMIC_MOVE_UNAVAILABLE', 'Native atomic no-replace is unavailable; no overwrite/copy-delete fallback is permitted.');
  error.cause = cause; return error;
};

/** Pinned koffi is a normal application dependency, not code from workspace/datadir.
 * Only synchronous in-process calls: no child, worker thread, shell, compile/cache or
 * late orphan effect. A killed backend cannot later launch/complete a child move.
 */
export function prepareAtomicNoReplace(): void {
  if (nativeMove) return;
  try {
    const koffi = require('koffi');
    if (process.platform === 'linux') {
      const libc = koffi.load('libc.so.6');
      const move = libc.func('int renameat2(int, str, int, str, uint)');
      nativeMove = (from, to) => {
        const result = move(-100, from, -100, to, 1); // AT_FDCWD, RENAME_NOREPLACE, no fallback
        const number = result === 0 ? 0 : koffi.errno();
        const code = Object.entries(koffi.os.errno).find(([, value]) => value === number)?.[0] ?? 'EIO';
        return {ok: result === 0, code};
      };
    } else if (process.platform === 'win32') {
      if (!process.env.SystemRoot || !path.isAbsolute(process.env.SystemRoot)) throw unavailable();
      const kernel = koffi.load(path.join(process.env.SystemRoot, 'System32', 'kernel32.dll'));
      const move = kernel.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint32']);
      const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', []);
      nativeMove = (from, to) => {
        // Validation belongs to WorkspaceService/Journal; namespace conversion is
        // internal and retains UTF16/long paths. Flags0 forbids replace AND copy.
        const result = move(path.toNamespacedPath(from), path.toNamespacedPath(to), 0);
        const number = result !== 0 ? 0 : lastError();
        const code = number === 80 || number === 183 ? 'EEXIST' : number === 2 || number === 3 ? 'ENOENT' : number === 5 ? 'EACCES' : 'EIO';
        return {ok: result !== 0, code};
      };
    } else throw unavailable();
  } catch (error) { nativeMove = undefined; throw unavailable(error); }
}

/** Exactly one native atomic no-replace syscall. A failed/unknown result is NOT
 * retried here: journal reconciles actual public/captured inode+bytes first.
 */
export function atomicNoReplace(from: string, to: string): void {
  if (!path.isAbsolute(from) || !path.isAbsolute(to) || from.includes('\0') || to.includes('\0')) throw unavailable();
  prepareAtomicNoReplace();
  let result: {ok: boolean; code: string};
  try { result = nativeMove!(from, to); }
  catch (error) { throw unavailable(error); }
  if (!result.ok) throw new AppError(503, result.code, 'Native no-replace refused the move; preserve and reconcile both paths before retrying.');
}
