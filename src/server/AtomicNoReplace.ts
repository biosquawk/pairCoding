import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { identity, sameIdentity, sha256, privateRead, privateDirectory, privateWrite, type Identity } from './SnapshotStorage';
import * as childProcess from 'node:child_process';
import { AppError } from './errors';

// Node has no rename-NOREPLACE option. Never emulate it with link+unlink or exists+rename.
// Constant scripts only: paths travel as JSON on stdin, never as shell/script fragments.
const linuxScript = `
import ctypes, errno, json, os, sys
try:
    request = json.load(sys.stdin)
    libc = ctypes.CDLL(None, use_errno=True)
    move = libc.renameat2
    move.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    move.restype = ctypes.c_int
    result = move(-100, os.fsencode(request['from']), -100, os.fsencode(request['to']), 1)
    if result != 0:
        number = ctypes.get_errno()
        print(json.dumps({'ok': False, 'code': errno.errorcode.get(number, 'EIO')}))
        sys.exit(1)
    print('{"ok":true}')
except Exception:
    print('{"ok":false,"code":"ATOMIC_MOVE_UNAVAILABLE"}')
    sys.exit(1)
`;
const windowsCode = String.raw`
using System;
using System.IO;
[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]
public static class PairCoachAtomicMove {
  private static string Extended(string file) {
    if (file.StartsWith(@"\\?\")) return file;
    if (file.StartsWith(@"\\")) return @"\\?\UNC\" + file.Substring(2);
    if (file.Length > 2 && file[1] == ':' && file[2] == '\\') return @"\\?\" + file;
    throw new ArgumentException();
  }

  private static void Reply(string dir, string nonce, int seq, string code) {
    string temp = Path.Combine(dir, "reply-" + seq + ".tmp");
    File.WriteAllText(temp, nonce + "\n" + seq + "\n" + code + "\n", new System.Text.UTF8Encoding(false));
    File.Move(temp, Path.Combine(dir, "response-" + seq));
  }
  private static int Session(string[] args) {
    string mode = args[0], dir = args[1], nonce = args[2];
    string stop = Path.Combine(dir, "STOP");
    if (mode == "barrier" && !File.Exists(stop)) return 2;
    // Lock exists BEFORE launch and is never replaced/unlinked. STOP is permanent:
    // even a delayed worker starting AFTER the barrier must exit without effects.
    DateTime deadline = DateTime.UtcNow.AddSeconds(12);
    FileStream locked = null;
    while (locked == null) {
      try {
        FileStream candidate = new FileStream(Path.Combine(dir, "LOCK"), FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
        try { candidate.Lock(0, 1); locked = candidate; } catch { candidate.Dispose(); throw; }
      }
      catch (IOException) { if (DateTime.UtcNow >= deadline) return 2; System.Threading.Thread.Sleep(2); }
    }
    using (locked) {
      if (mode == "barrier") { Console.WriteLine("{\"ok\":true}"); return 0; }
      if (mode != "serve" || File.Exists(stop)) return 0;
      File.WriteAllText(Path.Combine(dir, "ready.tmp"), nonce, new System.Text.UTF8Encoding(false));
      File.Move(Path.Combine(dir, "ready.tmp"), Path.Combine(dir, "READY"));
      DateTime life = DateTime.UtcNow.AddSeconds(120), idle = DateTime.UtcNow.AddSeconds(10);
      for (int seq = 1; seq <= 2500;) {
        if (File.Exists(stop) || DateTime.UtcNow >= life || DateTime.UtcNow >= idle) return 0;
        string request = Path.Combine(dir, "request-" + seq);
        if (!File.Exists(request)) { System.Threading.Thread.Sleep(1); continue; }
        if (new FileInfo(request).Length > 16384) return 2;
        byte[] raw = new byte[16385]; int length = 0;
        using (FileStream input = new FileStream(request, FileMode.Open, FileAccess.Read, FileShare.Read)) {
          while (length < raw.Length) { int count = input.Read(raw, length, raw.Length - length); if (count == 0) break; length += count; }
        }
        if (length > 16384) return 2;
        string[] lines = new System.Text.UTF8Encoding(false, true).GetString(raw, 0, length).TrimEnd('\n').Split('\n');
        if (lines.Length != 4 || lines[0] != nonce || lines[1] != seq.ToString()) return 2;
        string from = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(lines[2]));
        string to = System.Text.Encoding.UTF8.GetString(Convert.FromBase64String(lines[3]));
        if (File.Exists(stop)) return 0;
        string code = "OK";
        try { File.Move(Extended(from), Extended(to)); }
        catch (Exception e) { int n = e.HResult & 65535; code = n == 80 || n == 183 ? "EEXIST" : n == 2 || n == 3 ? "ENOENT" : n == 5 ? "EACCES" : "EIO"; }
        Reply(dir, nonce, seq, code); seq++; idle = DateTime.UtcNow.AddSeconds(10);
      }
      return 0;
    }
  }
  public static int Main(string[] args) {
    try {
      if (args.Length == 3) return Session(args);
      if (args.Length != 2) throw new ArgumentException();
      File.Move(Extended(args[0]), Extended(args[1]));
      Console.WriteLine("{\"ok\":true}");
      return 0;
    } catch (Exception error) {
      int number = error.HResult & 65535;
      string code = number == 80 || number == 183 ? "EEXIST" :
        number == 2 || number == 3 ? "ENOENT" : number == 5 ? "EACCES" : "EIO";
      Console.WriteLine("{\"ok\":false,\"code\":\"" + code + "\"}");
      return 1;
    }
  }
}
`;
const compileScript = `
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  Add-Type -TypeDefinition ([string]$request.code) -Language CSharp -OutputAssembly ([string]$request.output) -OutputType ConsoleApplication -WarningAction SilentlyContinue | Out-Null
  [Console]::Out.WriteLine('{"ok":true}')
  exit 0
} catch { exit 1 }
`;
type WindowsHelper = { executable: string; directory: string; identity: Identity; hash: string };
let windowsHelper: WindowsHelper | undefined;
const unavailable = () => new AppError(503, 'ATOMIC_MOVE_UNAVAILABLE', 'Atomic no-replace runtime is unavailable or failed verification; no unsafe fallback is permitted.');
function verifyHelper(helper: WindowsHelper): void {
  privateDirectory(helper.directory);
  const stat = fs.lstatSync(helper.executable, {bigint: true});
  if (!sameIdentity(stat, helper.identity) || sha256(privateRead(helper.executable, 2 * 1024 * 1024)) !== helper.hash) throw unavailable();
}
function invoke(executable: string, args: string[], from: string, to: string): void {
  const result = childProcess.spawnSync(executable, args, {
    input: JSON.stringify({from, to}), encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 4096,
  });
  if (!result.error && result.status === 0 && result.stdout.trim() === '{"ok":true}') return;
  let code = 'ATOMIC_MOVE_UNAVAILABLE';
  try {
    const message = JSON.parse(result.stdout ?? '');
    if (message.ok === false && /^[A-Z_]+$/.test(message.code)) code = message.code;
  } catch { /* Unknown result: journal reconciles after the child is joined. */ }
  const failure = new AppError(503, code, 'Atomic no-replace move did not confirm success; preserve and reconcile both paths before retrying.');
  failure.cause = result.error;
  throw failure;
}

/** Compile once per backend process in a FRESH private OS-temp directory, never load an
 * executable supplied by a project/datadir. Identity and digest remain in memory, and are
 * checked before EVERY launch. Self-test real absent/occupied Unicode paths before use.
 * All code is constant, output path is JSON data, no shell expansion or path interpolation.
 */
export function prepareAtomicNoReplace(): void {
  if (process.platform === 'linux') return;
  if (process.platform !== 'win32' || !process.env.SystemRoot || !path.isAbsolute(process.env.SystemRoot)) throw unavailable();
  if (windowsHelper) { verifyHelper(windowsHelper); return; }
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paircoach-atomic-')));
  privateDirectory(directory);
  const executable = path.join(directory, 'AtomicMove.exe');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const build = childProcess.spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', compileScript], {
    input: JSON.stringify({code: windowsCode, output: executable}), encoding: 'utf8', shell: false, windowsHide: true,
    timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 4096,
  });
  if (build.error || build.status !== 0 || build.stdout.trim() !== '{"ok":true}') throw unavailable();
  const candidate = {executable, directory, identity: identity(fs.lstatSync(executable, {bigint: true})), hash: sha256(privateRead(executable, 2 * 1024 * 1024))};
  verifyHelper(candidate);
  const from = path.join(directory, "test ż '&$.txt"), to = path.join(directory, "taken ą '&$.txt");
  fs.writeFileSync(from, 'FIRST', {flag: 'wx'}); invoke(executable, [from, to], from, to);
  if (fs.existsSync(from) || fs.readFileSync(to, 'utf8') !== 'FIRST') throw unavailable();
  fs.writeFileSync(from, 'SECOND', {flag: 'wx'});
  let refused = false;
  try { invoke(executable, [from, to], from, to); } catch (e) { refused = (e as AppError).code === 'EEXIST'; }
  if (!refused || fs.readFileSync(from, 'utf8') !== 'SECOND' || fs.readFileSync(to, 'utf8') !== 'FIRST') throw unavailable();
  verifyHelper(candidate);
  // Retain this private temporary directory until the backend exits. Never recursively
  // delete potentially foreign files; these contain test bytes/code only, no task content.
  windowsHelper = candidate;
}

/** One OS atomic move, no overwrite and no copy/delete fallback. Outcome must be read back
 * by the caller, including timeout/unknown result; a failed helper is NEVER replayed here.
 * Linux prerequisite: /usr/bin/python3 + glibc renameat2 + kernel/filesystem NOREPLACE.
 * Windows prerequisite: system Windows PowerShell + .NET File.Move(src,dst) (no overwrite).
 */
export function atomicNoReplace(from: string, to: string): void {
  if (process.platform === 'linux') {
    invoke('/usr/bin/python3', ['-I', '-S', '-c', linuxScript], from, to);
  } else {
    prepareAtomicNoReplace();
    verifyHelper(windowsHelper!);
    invoke(windowsHelper!.executable, [from, to], from, to);
  }
}


// Transaction-scoped worker protocol. One request at a time, no authorized batch. Data
// is UTF8/base64, never source code. Replies are bounded and tied to nonce + sequence.
const linuxSessionScript = String.raw`
import os, sys, time, fcntl, base64, ctypes, errno
mode, directory, nonce = sys.argv[1:]
stop = os.path.join(directory, 'STOP')
if mode == 'barrier' and not os.path.exists(stop): sys.exit(2)
fd = os.open(os.path.join(directory, 'LOCK'), os.O_RDWR | os.O_NOFOLLOW)
deadline = time.monotonic() + 12
while True:
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline: sys.exit(2)
        time.sleep(.002)
if mode == 'barrier':
    print('{"ok":true}')
    sys.exit(0)
if mode != 'serve' or os.path.exists(stop): sys.exit(0)
with open(os.path.join(directory, 'ready.tmp'), 'x') as ready: ready.write(nonce)
os.rename(os.path.join(directory, 'ready.tmp'), os.path.join(directory, 'READY'))
libc = ctypes.CDLL(None, use_errno=True)
move = libc.renameat2
move.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
move.restype = ctypes.c_int
life, idle, seq = time.monotonic() + 120, time.monotonic() + 10, 1
while seq <= 2500:
    if os.path.exists(stop) or time.monotonic() >= life or time.monotonic() >= idle: break
    request = os.path.join(directory, 'request-' + str(seq))
    if not os.path.exists(request):
        time.sleep(.001)
        continue
    with open(request, 'rb') as source: raw = source.read(16385)
    if len(raw) > 16384: sys.exit(2)
    lines = raw.decode('utf8').splitlines()
    if len(lines) != 4 or lines[0] != nonce or lines[1] != str(seq): sys.exit(2)
    source, target = [base64.b64decode(v, validate=True).decode('utf8') for v in lines[2:]]
    if not os.path.isabs(source) or not os.path.isabs(target) or '\x00' in source + target: sys.exit(2)
    if os.path.exists(stop): break
    result = move(-100, os.fsencode(source), -100, os.fsencode(target), 1)
    code = 'OK' if result == 0 else errno.errorcode.get(ctypes.get_errno(), 'EIO')
    temporary = os.path.join(directory, 'reply-' + str(seq) + '.tmp')
    with open(temporary, 'x') as reply: reply.write(nonce + '\n' + str(seq) + '\n' + code + '\n')
    os.rename(temporary, os.path.join(directory, 'response-' + str(seq)))
    seq += 1
    idle = time.monotonic() + 10
`;
export type AtomicSessionIdentity = { nonce: string; directoryId: Identity; lockId: Identity };
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const pause = () => Atomics.wait(sleepCell, 0, 0, 1);

export function prepareAtomicSession(directory: string, nonce: string): AtomicSessionIdentity {
  privateDirectory(directory, true);
  const lockId = privateWrite(path.join(directory, 'LOCK'), Buffer.from(nonce));
  return {nonce, directoryId: identity(fs.lstatSync(directory, {bigint: true})), lockId};
}

/** STOP + OS lock acquisition is a barrier against an orphan, not a PID heuristic.
 * A worker holds LOCK from BEFORE READY until exit, checks permanent STOP before
 * every request, and has bounded idle/lifetime. A late launch also observes STOP.
 * No startup rollback is allowed unless the barrier completes and identities match.
 */
export class AtomicMoveSession {
  private seq = 0;
  private closed = false;
  constructor(readonly directory: string, readonly descriptor: AtomicSessionIdentity) {}
  private verify(): void {
    const d = this.descriptor;
    if (!/^[a-f0-9-]{36}$/.test(d.nonce)) throw unavailable();
    privateDirectory(this.directory);
    const lock = fs.lstatSync(path.join(this.directory, 'LOCK'), {bigint: true});
    if (!sameIdentity(fs.lstatSync(this.directory, {bigint: true}), d.directoryId) ||
        !lock.isFile() || lock.isSymbolicLink() || lock.nlink !== 1n || lock.size !== 36n ||
        !sameIdentity(lock, d.lockId)) throw unavailable();
  }
  private command(mode: 'serve' | 'barrier'): {executable: string; args: string[]} {
    prepareAtomicNoReplace();
    if (process.platform === 'linux') return {executable: '/usr/bin/python3', args: ['-I', '-S', '-c', linuxSessionScript, mode, this.directory, this.descriptor.nonce]};
    verifyHelper(windowsHelper!);
    return {executable: windowsHelper!.executable, args: [mode, this.directory, this.descriptor.nonce]};
  }
  start(): void {
    if (this.closed || fs.existsSync(path.join(this.directory, 'STOP'))) throw unavailable();
    this.verify();
    const {executable, args} = this.command('serve');
    const child = childProcess.spawn(executable, args, {stdio: 'ignore', shell: false, windowsHide: true});
    // Synchronous callers cannot service event callbacks. All results use the bounded
    // private protocol; ENOENT/exit become READY timeout with no public effects.
    child.on('error', () => {}); child.unref();
    const deadline = Date.now() + 10000, ready = path.join(this.directory, 'READY');
    while (!fs.existsSync(ready) && Date.now() < deadline) pause();
    this.verify();
    if (!fs.existsSync(ready) || privateRead(ready, 100).toString() !== this.descriptor.nonce) throw unavailable();
  }
  move(from: string, to: string): void {
    if (this.closed) throw unavailable();
    this.verify();
    if (fs.existsSync(path.join(this.directory, 'STOP')) || ++this.seq > 2500) throw unavailable();
    const seq = this.seq;
    const body = `${this.descriptor.nonce}\n${seq}\n${Buffer.from(from).toString('base64')}\n${Buffer.from(to).toString('base64')}\n`;
    if (Buffer.byteLength(body) > 16384) throw unavailable();
    const temporary = path.join(this.directory, `request-${seq}.tmp`), request = path.join(this.directory, `request-${seq}`);
    // IPC need not survive power loss: SIGNED move-pending is durable before this
    // method, and restart first quiesces then inspects actual inodes/bytes.
    fs.writeFileSync(temporary, body, {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, request);
    const response = path.join(this.directory, `response-${seq}`), deadline = Date.now() + 10000;
    while (!fs.existsSync(response) && Date.now() < deadline) pause();
    this.verify();
    if (!fs.existsSync(response)) throw unavailable();
    const reply = privateRead(response, 128).toString().split('\n');
    if (reply.length !== 4 || reply[0] !== this.descriptor.nonce || reply[1] !== String(seq) || !/^[A-Z_]+$/.test(reply[2]) || reply[3] !== '') throw unavailable();
    if (reply[2] !== 'OK') throw new AppError(503, reply[2], 'Atomic no-replace refused the move; reconcile both paths before retrying.');
  }
  assertStopped(): void {
    this.verify();
    if (privateRead(path.join(this.directory, 'STOP'), 100).toString() !== this.descriptor.nonce) throw unavailable();
  }
  close(): void {
    if (this.closed) return;
    this.verify();
    const stop = path.join(this.directory, 'STOP');
    try { privateWrite(stop, Buffer.from(this.descriptor.nonce)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    if (privateRead(stop, 100).toString() !== this.descriptor.nonce) throw unavailable();
    const {executable, args} = this.command('barrier');
    const result = childProcess.spawnSync(executable, args, {encoding: 'utf8', shell: false, windowsHide: true, timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 4096});
    this.verify();
    if (result.error || result.status !== 0 || result.stdout.trim() !== '{"ok":true}') throw unavailable();
    this.closed = true;
  }
}
