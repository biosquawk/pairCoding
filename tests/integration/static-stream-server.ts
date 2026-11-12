/** Real product listener in an expendable child. Only target-file open/read is faulted. */
import fs from 'node:fs';
import path from 'node:path';
import { errorMonitor } from 'node:events';
import { createPairCoachServer } from '../../src/server/http';

const [base, token] = process.argv.slice(2);
const staticDir = path.join(base, 'static');
const originalCreate = fs.createReadStream;
const streams = new Map<string, fs.ReadStream>();
const pending = new Map<string, () => void>();
const released = new Set<string>();
const created: string[] = [];
function notify(event: string, values: Record<string, unknown> = {}) {
  const record = { event, ...values };
  process.stdout.write('STATIC_STREAM_EVENT ' + JSON.stringify(record) + '\n');
  process.send?.(record);
}
function eio() { return Object.assign(new Error('QA target-file EIO'), { code: 'EIO' }); }

fs.createReadStream = ((file: fs.PathLike, options?: any) => {
  if (path.dirname(String(file)) !== staticDir) return originalCreate(file, options);
  const name = path.basename(String(file));
  created.push(name);
  let reads = 0;
  const faulted = ['open-fail.js', 'mid-fail.js', 'disconnect.js'].includes(name);
  const io = {
    open: name === 'open-fail.js'
      ? (...args: any[]) => process.nextTick(() => {
        notify('injected-open-error', { name });
        args.at(-1)(eio());
      }) : fs.open,
    close: fs.close,
    read: (fd: number, buffer: Buffer, offset: number, length: number, position: number, callback: any) => {
      reads++;
      if (reads === 1) {
        // A real file descriptor and real bytes precede the mid-read failure/disconnect.
        fs.read(fd, buffer, offset, length, position, (error, count, data) => {
          notify('real-read', { name, count, error: error?.code ?? null });
          callback(error, count, data);
        });
        return;
      }
      const release = () => {
        pending.delete(name);
        if (name === 'mid-fail.js') {
          notify('injected-read-error', { name });
          callback(eio(), 0, buffer);
        } else {
          // Complete the outstanding real read so destroy can close its descriptor.
          fs.read(fd, buffer, offset, length, position, callback);
        }
      };
      if (released.has(name)) release();
      else { pending.set(name, release); notify('read-blocked', { name }); }
    },
  };
  const stream = originalCreate(file, faulted ? { ...options, highWaterMark: 1024, fs: io as any } : options);
  streams.set(name, stream);
  // errorMonitor observes but DOES NOT handle/suppress an unhandled source error.
  stream.on(errorMonitor, error => notify('stream-error', { name, code: (error as NodeJS.ErrnoException).code }));
  stream.once('close', () => notify('stream-close', { name, destroyed: stream.destroyed, closed: stream.closed }));
  notify('stream-created', { name });
  return stream;
}) as typeof fs.createReadStream;

const app = createPairCoachServer({ rootPath: path.join(base, 'workspace'), dataDir: path.join(base, 'data'),
  staticDir, token, port: 0, devBootstrap: false, enableCoach: false, enableExecution: false });
app.server.on('request', (req, res) => {
  const name = path.basename((req.url || '').split('?')[0]);
  res.once('close', () => {
    // Observe after all product close handlers, not before their registration order.
    setImmediate(() => notify('response-close', { name, destroyed: streams.get(name)?.destroyed ?? null }));
  });
});
process.on('message', (message: any) => {
  if (message.command === 'release-read') {
    released.add(message.name);
    pending.get(message.name)?.();
  } else if (message.command === 'inspect') {
    notify('inspection', { id: message.id, created, streams: [...streams].map(([name, stream]) =>
      ({ name, destroyed: stream.destroyed, closed: stream.closed })) });
  } else if (message.command === 'close') {
    void app.close().then(() => { fs.createReadStream = originalCreate; process.disconnect?.(); });
  }
});
const port = await app.listen();
notify('ready', { port });
