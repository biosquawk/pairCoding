// Deterministic test-only scheduling seam, ALWAYS forwards real native IO to canonical readRegular.
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { register } from 'tsx/esm/api';
register();
const { readRegular } = await import('../../src/server/language/LanguageProcessJournal.ts');
const { file, schedule } = workerData;
const parent = path.dirname(file), moved = parent + '-moved';
const events = [];
let fired = false, fdOpen = 0;
const io = {
  lstat: p => fs.lstatSync(p, { bigint: true }),
  realpath: p => {
    events.push(['prefix', p]);
    if (schedule === 'ancestor-alias-restored' && !fired && p === parent) {
      fired = true; fs.renameSync(parent, moved); fs.symlinkSync(moved, parent, 'dir');
    }
    return fs.realpathSync.native(p);
  },
  open: (p, flags) => {
    const fd = fs.openSync(p, flags); fdOpen++; events.push(['opened']);
    if (!fired && schedule === 'opened-stamp') { fired = true; fs.writeFileSync(file, 'changed stamp and size'); }
    if (!fired && schedule === 'leaf-replace') { fired = true; fs.renameSync(file, file + '-old'); fs.writeFileSync(file, 'abcdef'); }
    if (!fired && schedule === 'parent-replace') { fired = true; fs.renameSync(parent, moved); fs.mkdirSync(parent); fs.writeFileSync(file, 'abcdef'); }
    return fd;
  },
  stat: fd => fs.fstatSync(fd, { bigint: true }),
  read: (fd, buffer, offset, length, position) => {
    const n = fs.readSync(fd, buffer, offset, length, position); events.push(['read', n]);
    if (schedule === 'native-read-error') { fired = true; throw new Error('Scheduled native read failure after forwarded read'); }
    if (!fired && schedule === 'grow') { fired = true; fs.appendFileSync(file, 'GROW'); }
    return n;
  },
  close: fd => { fs.closeSync(fd); fdOpen--; events.push(['closed']); if (schedule === 'reported-close-error') { fired = true; throw new Error('Scheduled close callback failure after actual close'); } },
};
let result;
try { const bytes = readRegular(file, 16, io); result = { ok: true, bytes: bytes.toString() }; }
catch (error) { result = { ok: false, reason: String(error.message) }; }
finally {
  if (schedule === 'ancestor-alias-restored' && fired) { fs.unlinkSync(parent); fs.renameSync(moved, parent); events.push(['restored']); }
}
parentPort.postMessage({ ...result, events, fired, fdOpen });
parentPort.close();
