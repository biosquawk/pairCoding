// Pure QA setup controls. No browser is launched and no native visibility/teardown PASS is implied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debugEndpoint, edgeArguments } from './external-edge';

test('QA external Edge arguments use one unique profile, ephemeral loopback debugger and no focus/headless/remote overrides', () => {
  const profile = 'C:\\QA fixtures\\owned-edge-UNIQUE';
  const args = edgeArguments(profile);
  assert.ok(args.includes('--remote-debugging-port=0'));
  assert.ok(args.includes('--remote-debugging-address=127.0.0.1'));
  assert.deepEqual(args.filter(a => a.startsWith('--user-data-dir=')), ['--user-data-dir=' + profile]);
  assert.equal(args.at(-1), 'about:blank');
  assert.equal(args.some(a => /headless|focus|no-sandbox|disable-web-security|remote-allow-origins/.test(a)), false);
  assert.ok(!args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(!args.includes('--disable-renderer-backgrounding'));
  assert.notDeepEqual(edgeArguments('OTHER_PROFILE'), args);
});

test('QA debugger endpoint accepts only a port, never an external URL/address/argv from the owned file', () => {
  assert.equal(debugEndpoint('43827\r\n/devtools/browser/id\r\n'), 'http://127.0.0.1:43827');
  assert.equal(debugEndpoint('1\n/path'), 'http://127.0.0.1:1');
  assert.equal(debugEndpoint('65535\n/path'), 'http://127.0.0.1:65535');
  for (const invalid of ['', '0', '-1', '65536', '70000', '123456', '12.5', ' 43827', '43827 ', 'https://elsewhere:1', '123;command', '1 2']) {
    assert.throws(() => debugEndpoint(invalid), /Invalid owned Edge debugging port/);
  }
});

import { assertLauncherCanPublish, cdpBrowserPid, profileArgument, sameProcess, selectOwnedEdge, type EdgeProcess } from './edge-ownership';
const profile = 'C:\\QA fixtures\\owned-UNIQUE';
const executable = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const launcherPid = 41808;
const handedOff: EdgeProcess = { pid: 49128, parentPid: launcherPid, created: '2026-11-11T01:12:00.0000000Z', executable,
  commandLine: `"${executable}" "--user-data-dir=${profile}" --remote-debugging-port=0 --do-not-de-elevate about:blank` };

test('QA launcher exit0 continues port discovery; nonzero or signal does not', () => {
  assert.doesNotThrow(() => assertLauncherCanPublish(null, null));
  assert.doesNotThrow(() => assertLauncherCanPublish(0, null));
  assert.throws(() => assertLauncherCanPublish(1, null), /launcher failed/);
  assert.throws(() => assertLauncherCanPublish(null, 'SIGTERM'), /launcher failed/);
});

test('QA ownership binds actual CDP browser PID to exact unique profile/executable and launcher lineage', () => {
  assert.equal(cdpBrowserPid([{ type: 'renderer', id: 11 }, { type: 'browser', id: 49128 }]), 49128);
  assert.equal(selectOwnedEdge([handedOff], profile, executable, launcherPid, 49128), handedOff);
  assert.equal(selectOwnedEdge([{ ...handedOff, pid: launcherPid, parentPid: 999 }], profile, executable, launcherPid)?.pid, launcherPid);
  assert.equal(selectOwnedEdge([], profile, executable, launcherPid), undefined);
  for (const row of [
    { ...handedOff, commandLine: handedOff.commandLine.replace('owned-UNIQUE', 'owned-UNIQUE-other') },
    { ...handedOff, parentPid: 999 },
    { ...handedOff, executable: 'C:\\OTHER\\msedge.exe' },
    { ...handedOff, commandLine: handedOff.commandLine + ' --type=renderer' },
    { ...handedOff, created: '' },
  ]) {
    assert.equal(selectOwnedEdge([row], profile, executable, launcherPid), undefined);
    assert.throws(() => selectOwnedEdge([row], profile, executable, launcherPid, 49128), /does not match/);
  }
  assert.throws(() => selectOwnedEdge([handedOff], profile, executable, launcherPid, launcherPid), /does not match/);
  assert.throws(() => selectOwnedEdge([handedOff, { ...handedOff, pid: 32012 }], profile, executable, launcherPid), /Ambiguous/);
  for (const info of [[], [{ type: 'browser', id: -1 }], [{ type: 'browser', id: 1 }, { type: 'browser', id: 2 }]]) {
    assert.throws(() => cdpBrowserPid(info), /Invalid CDP/);
  }
});

test('QA exact profile argument handles native argv quotes but rejects substring and ambiguous duplicates', () => {
  assert.equal(profileArgument(`msedge.exe "--user-data-dir=${profile}" about:blank`), profile);
  assert.equal(profileArgument(`msedge.exe --user-data-dir="${profile}" about:blank`), profile);
  assert.equal(profileArgument('msedge.exe --user-data-dir=C:\\QA\\owned-one'), 'C:\\QA\\owned-one');
  assert.equal(profileArgument(`msedge.exe --different="--user-data-dir=${profile}"`), undefined);
  assert.equal(profileArgument(`msedge.exe "--user-data-dir=${profile}" "--user-data-dir=${profile}"`), undefined);
});

test('QA fallback revalidation refuses reused PID, changed lineage or command line', () => {
  assert.equal(sameProcess(handedOff, { ...handedOff }), true);
  for (const replacement of [
    { ...handedOff, created: 'later creation' }, { ...handedOff, parentPid: 999 },
    { ...handedOff, pid: 32012 }, { ...handedOff, commandLine: handedOff.commandLine + ' changed' },
    { ...handedOff, executable: 'C:\\OTHER\\msedge.exe' },
  ]) assert.equal(sameProcess(handedOff, replacement), false);
});

import { cleanupOwnedEdge } from './edge-ownership';
function cleanupControl(overrides: Partial<Parameters<typeof cleanupOwnedEdge>[0]> = {}) {
  let clock = 0, running = true, removals = 0;
  const stopped: number[] = [];
  const options: Parameters<typeof cleanupOwnedEdge>[0] = {
    profile, executable, launcherPid, gracefulClose: false,
    read: () => running ? [handedOff] : [], launcherAlive: () => false,
    stop: process => { stopped.push(process.pid); running = false; },
    remove: () => { removals++; }, observed: () => {},
    wait: async ms => { clock += ms; }, now: () => clock, ...overrides,
  };
  return { options, stopped, removals: () => removals };
}

test('QA partial setup failure finds the handed-off actual PID, rechecks it, stops it and only then removes profile', async () => {
  const control = cleanupControl();
  const actual = await cleanupOwnedEdge(control.options); // no CDP/actual identity yet, launcher already exit0
  assert.equal(actual?.pid, 49128);
  assert.deepEqual(control.stopped, [49128]);
  assert.equal(control.removals(), 1);
});

test('QA successful Browser.close waits actual exit, does not kill launcher PID and retries released profile lock', async () => {
  let reads = 0, removed = 0;
  const control = cleanupControl({ actual: handedOff, gracefulClose: true,
    read: () => ++reads === 1 ? [handedOff] : [],
    remove: () => { if (++removed === 1) throw new Error('EPERM profile lock'); },
  });
  await cleanupOwnedEdge(control.options);
  assert.deepEqual(control.stopped, []);
  assert.equal(removed, 2);
  assert.ok(reads >= 3);
});

test('QA setup cleanup never removes a live or unverifiable profile (ambiguous CIM, foreign lineage, failed CIM, reused PID)', async () => {
  for (const override of [
    { read: () => [handedOff], stop: () => {} }, // actual browser survives fallback
    { read: () => [], launcherAlive: () => true }, // launcher still alive
    { read: () => [handedOff, { ...handedOff, pid: 32012 }] },
    { read: () => [{ ...handedOff, parentPid: 999 }] },
    { read: () => { throw new Error('CIM access denied'); } },
    { actual: handedOff, read: () => [{ ...handedOff, created: 'PID reused' }] },
  ]) {
    const control = cleanupControl(override);
    await assert.rejects(cleanupOwnedEdge(control.options));
    assert.equal(control.removals(), 0);
    assert.deepEqual(control.stopped, []);
  }
});

test('QA setup fallback refuses a process replacement between initial discovery and kill', async () => {
  let reads = 0;
  const control = cleanupControl({ read: () => [++reads === 1 ? handedOff : { ...handedOff, created: 'new process' }] });
  await assert.rejects(cleanupOwnedEdge(control.options), /identity changed/);
  assert.deepEqual(control.stopped, []);
  assert.equal(control.removals(), 0);
});
