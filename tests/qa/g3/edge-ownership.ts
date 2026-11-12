// QA process-ownership predicates, not evidence of native Windows cleanup.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type EdgeProcess = { pid: number; parentPid: number; created: string; executable: string; commandLine: string };
const samePath = (a: string, b: string) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
export function profileArgument(commandLine: string): string | undefined {
  // Accept Windows argv quoting, never a substring/prefix of a different profile.
  const matches = [...commandLine.matchAll(/(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir="([^"]+)"|--user-data-dir=([^\s"]+))(?=\s|$)/gi)];
  return matches.length === 1 ? matches[0][1] ?? matches[0][2] ?? matches[0][3] : undefined;
}
export function selectOwnedEdge(rows: EdgeProcess[], profile: string, executable: string, launcherPid: number, cdpPid?: number): EdgeProcess | undefined {
  const owned = rows.filter(row => {
    const arg = profileArgument(row.commandLine);
    return Number.isSafeInteger(row.pid) && row.pid > 0 && !!row.created && !!arg && samePath(arg, profile)
      && samePath(row.executable, executable) && (row.pid === launcherPid || row.parentPid === launcherPid)
      && !/(?:^|\s)"?--type=/.test(row.commandLine);
  });
  if (owned.length > 1) throw new Error('Ambiguous owned Edge browser processes; retain profile for reconciliation');
  if (cdpPid !== undefined && owned[0]?.pid !== cdpPid) throw new Error('CDP browser PID does not match exact profile/executable/launcher lineage');
  return owned[0];
}
export const sameProcess = (a: EdgeProcess, b: EdgeProcess) => a.pid === b.pid && a.created === b.created
  && a.parentPid === b.parentPid && samePath(a.executable, b.executable) && a.commandLine === b.commandLine;
export function assertLauncherCanPublish(exitCode: number | null, signal: string | null) {
  // Windows Edge may hand off to its de-elevated browser and exit 0 BEFORE the port is written.
  if (signal !== null || (exitCode !== null && exitCode !== 0)) throw new Error(`Owned Edge launcher failed: ${exitCode}/${signal}`);
}
export function cdpBrowserPid(processInfo: { type: string; id: number }[]): number {
  const browsers = processInfo.filter(p => p.type === 'browser');
  if (browsers.length !== 1 || !Number.isSafeInteger(browsers[0].id) || browsers[0].id <= 0) throw new Error('Invalid CDP browser process identity');
  return browsers[0].id;
}
export function ownedEdgeSnapshot(profile: string, observedPid?: number): EdgeProcess[] {
  // Fixed code + environment data, not interpolated command strings. Do not disclose other browser argv.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$p = [regex]::Escape($env:PAIRCOACH_QA_OWNED_EDGE_PROFILE)
$pattern = '(?i)(?:^|\s)(?:"--user-data-dir=' + $p + '"|--user-data-dir="' + $p + '"|--user-data-dir=' + $p + ')(?=\s|$)'
$rows = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object {
  ($_.ProcessId -eq [int]$env:PAIRCOACH_QA_OWNED_EDGE_PID) -or ($_.CommandLine -match $pattern -and $_.CommandLine -notmatch '(?:^|\s)"?--type=')
} | ForEach-Object { [pscustomobject]@{
  pid = [int]$_.ProcessId; parentPid = [int]$_.ParentProcessId
  created = $_.CreationDate.ToUniversalTime().ToString('o')
  executable = $_.ExecutablePath; commandLine = $_.CommandLine
} })
ConvertTo-Json -InputObject $rows -Compress
`;
  const ps = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const result = spawnSync(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
    env: { ...process.env, PAIRCOACH_QA_OWNED_EDGE_PROFILE: profile, PAIRCOACH_QA_OWNED_EDGE_PID: String(observedPid ?? 0) },
  });
  if (result.error || result.status !== 0) throw new Error(`Owned Edge CIM read failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  const rows: unknown = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim());
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.pid !== 'number' || typeof row.parentPid !== 'number'
    || typeof row.created !== 'string' || typeof row.executable !== 'string' || typeof row.commandLine !== 'string')) throw new Error('Malformed owned Edge CIM snapshot');
  return rows as EdgeProcess[];
}

// The same fail-closed release/removal orchestration is used by the real fixture and QA unit controls.
export async function cleanupOwnedEdge(options: {
  profile: string; executable: string; launcherPid: number; actual?: EdgeProcess; gracefulClose: boolean;
  read: (observedPid?: number) => EdgeProcess[]; launcherAlive: () => boolean;
  stop: (process: EdgeProcess) => void; remove: () => void; observed: (process: EdgeProcess) => void;
  wait?: (ms: number) => Promise<unknown>; now?: () => number;
}) {
  const wait = options.wait ?? delay, now = options.now ?? Date.now;
  let actual = options.actual;
  const current = () => {
    const rows = options.read(actual?.pid);
    const owned = selectOwnedEdge(rows, options.profile, options.executable, options.launcherPid);
    if (rows.length && !owned) throw new Error('Profile is in use by an unverified lineage; retain it');
    if (actual && owned && !sameProcess(actual, owned)) throw new Error('Owned Edge identity changed; retain profile');
    return owned;
  };
  let remaining = current();
  const gracefulUntil = now() + 1000;
  while (remaining && options.gracefulClose && now() < gracefulUntil) { await wait(100); remaining = current(); }
  if (remaining) {
    actual ??= remaining; options.observed(actual);
    // Revalidate immediately before the destructive effect, including creation time (PID reuse guard).
    const rechecked = current();
    if (rechecked && sameProcess(actual, rechecked)) options.stop(rechecked);
  }
  let released = false;
  const exitUntil = now() + 5000;
  do {
    const owned = current();
    if (!owned && !options.launcherAlive()) { released = true; break; }
    await wait(100);
  } while (now() < exitUntil);
  if (!released) throw new Error('Owned Edge or launcher is still running; profile retained for reconciliation');
  // Retry lock release only AFTER the actual browser and launcher have exited.
  const removalUntil = now() + 1000;
  for (;;) {
    try { options.remove(); break; }
    catch (error) { if (now() >= removalUntil) throw error; await wait(100); }
  }
  return actual;
}
