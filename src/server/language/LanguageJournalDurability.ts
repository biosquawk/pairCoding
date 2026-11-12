import { closeSync, constants, fsyncSync, openSync } from 'node:fs';

export interface LanguageJournalDurability {
  readonly policy: 'FILE_AND_DIRECTORY_FSYNC' | 'WIN32_FILE_FSYNC_RENAME_READBACK';
  /** MUST propagate ALL regular-file flush errors, including Win32 EPERM. fd must be writable. */
  file(fd: number): void;
  directory(path: string): void;
}
export interface JournalSyncIO {
  open(path: string, flags: number): number; sync(fd: number): void; close(fd: number): void;
}
const nodeIO: JournalSyncIO = { open: openSync, sync: fsyncSync, close: closeSync };
/**
 * Mirrors the existing SnapshotStorage directory policy. Node on Win32 does not expose directory
 * fsync. Only that specific unavailable primitive is tolerated; files are flushed through WRITABLE
 * handles and never get a platform catch. Atomic rename + exact readback is mandatory in the journal.
 * This is NOT a guarantee against loss of the most recent directory entry on Windows power failure.
 * platform/io seams are trusted developer-test injection only; production uses the actual defaults.
 */
export class NodeLanguageJournalDurability implements LanguageJournalDurability {
  readonly policy: LanguageJournalDurability['policy'];
  constructor(private readonly assertDirectory: (path: string) => void, private readonly platform: NodeJS.Platform = process.platform, private readonly io: JournalSyncIO = nodeIO) {
    this.policy = platform === 'win32' ? 'WIN32_FILE_FSYNC_RENAME_READBACK' : 'FILE_AND_DIRECTORY_FSYNC';
  }
  file(fd: number): void { this.io.sync(fd); }
  directory(path: string): void {
    this.assertDirectory(path); let fd: number | undefined;
    try { fd = this.io.open(path, constants.O_RDONLY); this.io.sync(fd); }
    catch (error) {
      if (this.platform !== 'win32' || !['EPERM','EACCES','EINVAL','EISDIR','EBADF'].includes((error as NodeJS.ErrnoException)?.code ?? '')) throw error;
    } finally { if (fd !== undefined) this.io.close(fd); }
    this.assertDirectory(path);
  }
}
