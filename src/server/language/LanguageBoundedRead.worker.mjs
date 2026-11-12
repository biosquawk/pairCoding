// Source-only Node22/tsx worker entry. No filesystem algorithm is duplicated here.
import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
const { readRegular } = await import('./LanguageProcessJournal.ts');
if (!parentPort) throw new Error('Private language read worker requires a parent');
parentPort.on('message', message => {
  if (message?.type === 'STOP') { parentPort.close(); return; }
  try {
    if (message?.type !== 'READ' || !Number.isSafeInteger(message.id)) throw new Error('Invalid private read job');
    // Native DEFAULT IO, including both ALL-prefix guards and finally-close.
    const bytes = readRegular(message.path, message.limit);
    // readRegular allocates its OWN checked-size + one sentinel buffer, never a pooled slab.
    // Transfer ownership of that allocation, not a structured-clone payload copy.
    parentPort.postMessage({ id: message.id, bytes: bytes.length, offset: bytes.byteOffset, data: bytes.buffer }, [bytes.buffer]);
  } catch (error) {
    parentPort.postMessage({ id: message?.id, error: {
      name: String(error?.name ?? 'Error').slice(0, 80),
      message: String(error?.message ?? 'Language read failed').slice(0, 1024),
      code: typeof error?.code === 'string' ? error.code.slice(0, 64) : undefined,
    } });
  }
});
