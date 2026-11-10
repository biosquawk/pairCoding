import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { identity, sameIdentity, sha256, privateRead, privateDirectory, type Identity } from './SnapshotStorage';
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
const windowsCode = `
using System;
using System.IO;
public static class PairCoachAtomicMove {
  public static int Main(string[] args) {
    try {
      if (args.Length != 2) throw new ArgumentException();
      File.Move(args[0], args[1]);
      Console.WriteLine("{\\"ok\\":true}");
      return 0;
    } catch (Exception error) {
      int number = error.HResult & 65535;
      string code = number == 80 || number == 183 ? "EEXIST" :
        number == 2 || number == 3 ? "ENOENT" : number == 5 ? "EACCES" : "EIO";
      Console.WriteLine("{\\"ok\\":false,\\"code\\":\\"" + code + "\\"}");
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
