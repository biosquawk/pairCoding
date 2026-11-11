// Only TEST016/017: native visibility needs ordinary Edge, not Playwright's emulated focus.
// Evidence: HUMAN512177e6 / diagnostic-visibility/external.log. NOT a product browser receipt.
import { chromium, expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertLauncherCanPublish, cdpBrowserPid, ownedEdgeSnapshot, cleanupOwnedEdge, selectOwnedEdge, type EdgeProcess } from './edge-ownership';

export const edgeArguments = (profile: string) => [
  '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile,
  '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-networking',
  '--window-size=1600,1000', 'about:blank',
];
export function debugEndpoint(portFile: string) {
  const first = portFile.split(/\r?\n/)[0];
  if (!/^\d{1,5}$/.test(first) || Number(first) < 1 || Number(first) > 65535) throw new Error('Invalid owned Edge debugging port');
  return 'http://127.0.0.1:' + Number(first); // never accept an address from the file
}
export async function externalEdgePage(use: (page: Page) => Promise<void>, info: TestInfo) {
  if (process.platform !== 'win32') throw new Error('NOT_RUN: TEST016/017 require native Windows Edge; no synthetic visibility fallback');
  const executable = process.env.PAIRCOACH_QA_BROWSER;
  if (!executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'msedge.exe' || !fs.statSync(executable).isFile()) {
    throw new Error('Set PAIRCOACH_QA_BROWSER to the native msedge.exe used in the receipt');
  }
  fs.mkdirSync(info.outputDir, { recursive: true });
  // Do not nest Chromium's long profile paths below the already-long per-test title directory.
  const profiles = path.resolve('artifacts/g3/edge-profiles'); fs.mkdirSync(profiles, { recursive: true });
  const profile = fs.mkdtempSync(path.join(profiles, 'owned-'));
  let child: ReturnType<typeof spawn> | undefined, browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined;
  let setupFailed = false;
  let tracing = false, requestTracing = false, launchError: Error | undefined, endpoint: string | undefined;
  let actual: EdgeProcess | undefined;
  let verifiedCDP = false;
  const cleanupErrors: unknown[] = [];
  const provenance: Record<string, unknown> = { platform: process.platform, node: process.version, executable, profile,
    arguments: edgeArguments(profile), transport: 'ordinary Edge + connectOverCDP(noDefaults:true), default context; only TEST016/017',
    recordedViewport: 'ordinary normal bounds 0/0/1600/1000; no emulated viewport/focus',
    recording: { owner: 'externalEdgePage', trace: 'on (browser + API requests)', screenshot: 'only-on-failure', runnerRecorder: 'off only for016/017 to prevent double-start' }, revision: process.env.PAIRCOACH_QA_REVISION ?? 'UNSPECIFIED' };
  try {
    child = spawn(executable, edgeArguments(profile), { shell: false, windowsHide: false, stdio: 'ignore' });
    child.once('error', error => { launchError = error; });
    provenance.pid = child.pid; provenance.launcherPid = child.pid;
    const portFile = path.join(profile, 'DevToolsActivePort');
    await expect.poll(() => {
      if (launchError) throw launchError;
      assertLauncherCanPublish(child!.exitCode, child!.signalCode);
      return fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').length > 0;
    }, { message: 'Ordinary owned Edge publishes its loopback debugging port' }).toBe(true);
    endpoint = debugEndpoint(fs.readFileSync(portFile, 'utf8'));
    browser = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5000 });
    const identity = await browser.newBrowserCDPSession();
    try {
      const pid = cdpBrowserPid((await identity.send('SystemInfo.getProcessInfo')).processInfo);
      actual = selectOwnedEdge(ownedEdgeSnapshot(profile, pid), profile, executable, child.pid!, pid);
      if (!actual) throw new Error('No verified owned Edge browser');
      verifiedCDP = true; provenance.browserPid = pid; provenance.browserProcess = actual;
    } finally { await identity.detach(); }
    context = browser.contexts()[0]; if (!context) throw new Error('No ordinary Edge default context');
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); tracing = true;
    await context.request.tracing.start({ sources: true }); requestTracing = true;
    page = context.pages()[0] ?? await context.newPage();
    // G3 has no action/navigation override; preserve that (runner test guard is still 25s).
    context.setDefaultTimeout(0); context.setDefaultNavigationTimeout(0);
    provenance.version = browser.version(); provenance.endpoint = endpoint;
    // ROOT b5377f09: force the REAL ordinary window onscreen before app navigation/initial WINDOW_STATE.
    const window = await context.newCDPSession(page);
    try {
      const { windowId } = await window.send('Browser.getWindowForTarget');
      await window.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await window.send('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: 1600, height: 1000 } });
      await page.bringToFront();
      provenance.initialWindow = (await window.send('Browser.getWindowBounds', { windowId })).bounds;
      await expect.poll(() => page!.evaluate(() => document.visibilityState)).toBe('visible');
      await expect.poll(() => page!.evaluate(() => document.hasFocus())).toBe(true);
    } finally { await window.detach(); }
    await use(page);
  } catch (error) { setupFailed = true; provenance.setupOrTestError = String(error); throw error; } finally {
    // All paths, including partial setup failure, pass through owned-process cleanup.
    if (page && (setupFailed || info.status !== info.expectedStatus)) {
      try {
        const screenshot = info.outputPath('test-failed-1.png');
        await page.screenshot({ path: screenshot, timeout: 5000 });
        await info.attach('screenshot', { path: screenshot, contentType: 'image/png' });
      } catch (error) { cleanupErrors.push(error); }
    }
    if (context && tracing) {
      try {
        const trace = info.outputPath('trace.zip'); await context.tracing.stop({ path: trace });
        await info.attach('trace', { path: trace, contentType: 'application/zip' });
      } catch (error) { cleanupErrors.push(error); }
    }
    if (context && requestTracing) {
      try {
        const trace = info.outputPath('request-trace.zip'); await context.request.tracing.stop({ path: trace });
        await info.attach('request-trace', { path: trace, contentType: 'application/zip' });
      } catch (error) { cleanupErrors.push(error); }
    }
    if (verifiedCDP && browser?.isConnected()) {
      try { await Promise.race([(async () => { const cdp = await browser!.newBrowserCDPSession(); await cdp.send('Browser.close'); })(), delay(1000)]); }
      catch { /* Browser.close can disconnect before its reply. CIM, not launcher exit, proves exit below. */ }
    }
    let released = false;
    try {
      if (child?.pid) {
        actual = await cleanupOwnedEdge({
          profile, executable, launcherPid: child.pid, actual, gracefulClose: verifiedCDP,
          read: observedPid => ownedEdgeSnapshot(profile, observedPid),
          launcherAlive: () => child!.exitCode === null && child!.signalCode === null && !launchError,
          observed: process => { provenance.browserPid = process.pid; provenance.browserProcess = process; },
          stop: ownedProcess => {
            // Only the revalidated actual PID/tree, never a process-name kill or a de-elevation override.
            const taskkill = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'taskkill.exe');
            const killed = spawnSync(taskkill, ['/PID', String(ownedProcess.pid), '/T', '/F'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 5000 });
            provenance.forcedTreeStop = { pid: ownedProcess.pid, status: killed.status, error: killed.error?.message };
          },
          remove: () => fs.rmSync(profile, { recursive: true, force: true }),
        });
      } else { fs.rmSync(profile, { recursive: true, force: true }); } // spawn never created a process
      released = true;
    } catch (error) { cleanupErrors.push(error); }
    if (verifiedCDP && browser) { try { await browser.close(); } catch (error) { cleanupErrors.push(error); } }
    Object.assign(provenance, { exitCode: child?.exitCode, signal: child?.signalCode, launcherExitCode: child?.exitCode, launcherSignal: child?.signalCode, actualProcessReleased: released, profileRemoved: !fs.existsSync(profile), cleanupErrors: cleanupErrors.map(String) });
    await info.attach('owned-edge-environment-and-teardown', { body: Buffer.from(JSON.stringify(provenance, null, 2)), contentType: 'application/json' });
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'External Edge evidence/teardown failed');
  }
}
