/** Real process/FS helper. Parent kills only after a real Journal callback holds exclusion. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DurableRunJournal } from '../../src/server/execution/DurableRunJournal';
import type { JournalRecord } from '../../src/server/execution/DurableRunJournal';
const request = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const journal = new DurableRunJournal(request.directory, request.installationId);
const hold = async () => {
  process.send!({ event: 'HELD', pid: process.pid });
  await new Promise<void>(resolve => process.once('message', () => resolve()));
};
try {
  if (request.operation === 'reserve') {
    if (request.where === 'after') {
      const read = journal.read.bind(journal);
      journal.read = async id => { const row = await read(id); await hold(); return row; };
    } else {
      const list = journal.list.bind(journal);
      journal.list = async () => { const rows = await list(); await hold(); return rows; };
    }
    await journal.reserve(request.record as JournalRecord);
  } else {
    if (request.where === 'after') {
      const rename = fs.rename.bind(fs);
      fs.rename = async (from, to) => { await rename(from, to); if (String(to).endsWith('/run1.json')) await hold(); };
      syncBuiltinESMExports();
    } else {
      const read = journal.read.bind(journal);
      journal.read = async id => { const row = await read(id); await hold(); return row; };
    }
    await journal.update(request.record as JournalRecord);
  }
  process.send!({ event: 'DONE' });
} catch (error: any) {
  process.send!({ event: 'ERROR', code: error.code, message: error.message });
  process.exitCode = 1;
} finally { process.disconnect!(); }
